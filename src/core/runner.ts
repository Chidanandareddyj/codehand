import spawn from "cross-spawn";
import path from "node:path";
import { clearAdapterCache, openCodeAdapter } from "../adapters/opencode.js";
import {
  clearFreeQuotaExhausted,
  clearUnavailableModel,
  recordFreeQuotaExhausted,
  recordUnavailableModel,
} from "./agentstate.js";
import { isJobId, jobDir, nowIso, runtimeLimits } from "./config.js";
import {
  acquireRunnerLock,
  appendEvent,
  logFile,
  promptPath,
  readEvents,
  readJob,
  readUserPrompt,
  releaseRunnerLock,
  updateJob,
  writeResult,
} from "./jobstore.js";
import { pumpQueue } from "./jobs.js";
import { log } from "./log.js";
import { killTree, killTreeHard, runShellCommand } from "./proc.js";
import { redact } from "./redact.js";
import { buildChildEnv } from "./secrets.js";
import { appendLine, atomicWriteText } from "./store.js";
import { buildResult } from "./summarize.js";
import type {
  CheckResult,
  ErrorKind,
  NormalizedEvent,
  StoredEvent,
  TaskResult,
  WorktreeState,
} from "./types.js";
import { computeDiff, hasChanges } from "./workspace.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChecks(commands: string[] | undefined, cwd: string): Promise<CheckResult[]> {
  if (!commands?.length) return [];
  const results: CheckResult[] = [];
  for (const cmd of commands) {
    const result = await runShellCommand(cmd, {
      cwd,
      timeoutMs: 300_000,
      maxBytes: 20_000,
      keepTail: true,
    });
    const tail = redact(`${result.stdout}\n${result.stderr}`).trim().slice(-600);
    results.push({ cmd, ok: result.code === 0 && !result.timedOut, tail });
  }
  return results;
}

export async function runTurn(jobId: string, turn: number): Promise<number> {
  if (!isJobId(jobId) || !Number.isInteger(turn) || turn < 1) return 1;
  const existing = readJob(jobId);
  if (!existing) return 1;
  if (!acquireRunnerLock(jobId)) {
    log("info", `runner lock busy for ${jobId}`);
    return 0;
  }
  try {
    await executeTurn(jobId, turn);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", `runner ${jobId} crashed: ${message}`);
    await updateJob(jobId, (current) => {
      if (current.status !== "running" && current.status !== "queued") return current;
      return {
        ...current,
        status: "failed",
        endedAt: nowIso(),
        pid: undefined,
        opencodePid: undefined,
        error: { kind: "crashed", message: message.slice(0, 500) },
      };
    }).catch(() => undefined);
    return 1;
  } finally {
    releaseRunnerLock(jobId);
    await pumpQueue().catch((error: unknown) => {
      log("error", `queue pump failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function executeTurn(jobId: string, turn: number): Promise<void> {
  let job = readJob(jobId);
  if (!job || (job.status !== "running" && job.status !== "queued")) return;
  const userText = readUserPrompt(jobId, turn);
  const fullPrompt = `${openCodeAdapter.preamble(job.workdir, job.branch)}${userText}`;
  const file = promptPath(jobId, turn);
  atomicWriteText(file, fullPrompt);

  const detected = await openCodeAdapter.detect();
  job = await updateJob(jobId, (current) => ({
    ...current,
    status: current.status === "queued" ? "running" : current.status,
    pid: process.pid,
    startedAt: current.startedAt ?? nowIso(),
    heartbeatAt: nowIso(),
    agentVersion: detected.version ?? current.agentVersion,
    endedAt: undefined,
    error: undefined,
  }));
  if (job.status !== "running") return;

  const beforeDiff = await computeDiff(job.workdir, job.repo.baseCommit).catch(() => null);
  const beforePatch = beforeDiff?.ok ? beforeDiff.value.patch : "";

  const built = openCodeAdapter.buildRun({
    message: fullPrompt,
    cwd: job.workdir,
    mode: job.mode,
    model: job.model,
    sessionId: job.sessionId,
    promptPath: file,
  });
  const child = spawn(built.cmd, built.args, {
    cwd: job.workdir,
    env: buildChildEnv(built.env),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await updateJob(jobId, (current) => ({ ...current, opencodePid: child.pid })).catch(() => undefined);

  const limits = runtimeLimits();
  let lastOutput = Date.now();
  let lastBeat = Date.now();
  let stderrTail = "";
  let sawSession = Boolean(job.sessionId);
  let appendedSession = false;
  let stop: ErrorKind | "cancel" | null = null;
  let spawnErrorCode: string | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const onLine = (channel: "stdout" | "stderr", line: string) => {
    lastOutput = Date.now();
    const redacted = redact(line);
    appendLine(logFile(jobId, turn, channel), redacted);
    if (channel === "stderr") stderrTail = `${stderrTail}\n${redacted}`.slice(-4000);
    for (const event of openCodeAdapter.parseLine(redacted)) {
      if (event.t === "session") {
        if (appendedSession) continue;
        appendedSession = true;
        appendEvent(jobId, turn, event);
        if (!sawSession) {
          sawSession = true;
          updateJob(jobId, (current) => ({
            ...current,
            sessionId: current.sessionId ?? event.sessionId,
          })).catch(() => undefined);
        }
        continue;
      }
      appendEvent(jobId, turn, event);
    }
  };

  const stdoutDone = attach(child.stdout, (line) => onLine("stdout", line));
  const stderrDone = attach(child.stderr, (line) => onLine("stderr", line));

  const finished = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code;
      settle();
    });
    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      settle();
    });
  });
  let done = false;
  const closed = finished.then(() => {
    done = true;
  });

  while (!done && !stop) {
    await Promise.race([closed, sleep(400)]);
    if (done) break;
    const latest = readJob(jobId);
    if (latest?.cancelRequested) stop = "cancel";
    else if (Date.now() - lastOutput > limits.idleMs) stop = "idle_timeout";
    else if (job.startedAt && Date.now() - Date.parse(job.startedAt) > limits.totalMs) stop = "timeout";
    if (Date.now() - lastBeat > limits.heartbeatMs) {
      lastBeat = Date.now();
      await updateJob(jobId, (current) => ({
        ...current,
        heartbeatAt: nowIso(),
        pid: process.pid,
      })).catch(() => undefined);
    }
  }

  if (stop) {
    killTree(child.pid);
    await Promise.race([closed, sleep(limits.killGraceMs)]);
    if (!done) killTreeHard(child.pid);
    await Promise.race([closed, sleep(1000)]);
  } else {
    await closed;
  }
  await Promise.race([Promise.all([stdoutDone, stderrDone]), sleep(1000)]);

  const events = readEvents(jobId, turn);
  let diff = await computeDiff(job.workdir, job.repo.baseCommit).catch(() => null);
  const wroteThisTurn = wroteFilesThisTurn(events);
  if (wroteThisTurn && !(diff?.ok && diff.value.files.length > 0)) {
    await sleep(50);
    diff = await computeDiff(job.workdir, job.repo.baseCommit).catch(() => null);
  }
  const files = diff?.ok ? diff.value.files : [];
  const patch = diff?.ok ? diff.value.patch : "";
  atomicWriteText(path.join(jobDir(jobId), "diff.patch"), patch);
  const turnEditedFiles = (files.length > 0 && patch !== beforePatch) || wroteThisTurn;

  const errorEvents = events
    .map((item) => item.event)
    .filter((event): event is Extract<NormalizedEvent, { t: "error" }> => event.t === "error");
  const lastErrorIdx = events.reduce((idx, item, i) => (item.event.t === "error" ? i : idx), -1);
  const lastStepFinishIdx = events.reduce((idx, item, i) => {
    if (item.event.t === "step" && item.event.phase === "finish") return i;
    if (item.event.t === "text" && item.event.text.includes("SUMMARY:")) return i;
    return idx;
  }, -1);
  const unresolvedError = errorEvents.length > 0 && (exitCode !== 0 || lastErrorIdx > lastStepFinishIdx);

  let status: TaskResult["status"] = "done";
  let errorKind: ErrorKind | undefined;
  let errorMessage = "";
  let warning: string | undefined;
  if (stop === "cancel" || readJob(jobId)?.cancelRequested) {
    status = "cancelled";
    errorMessage = "Cancelled.";
  } else if (stop === "idle_timeout") {
    status = "failed";
    errorKind = "idle_timeout";
    errorMessage = "OpenCode produced no output before the idle limit.";
  } else if (stop === "timeout") {
    status = "failed";
    errorKind = "timeout";
    errorMessage = "OpenCode hit the total time limit.";
  } else if (!stop && (exitCode !== 0 || unresolvedError || spawnErrorCode || exitSignal)) {
    const failure = openCodeAdapter.classifyFailure({
      exitCode,
      signal: exitSignal,
      spawnErrorCode,
      stderrTail,
      errorEvents,
    });
    if (failure.kind === "quota" && openCodeAdapter.isFreeModel?.(job.model)) {
      recordFreeQuotaExhausted("opencode", failure.message);
      clearAdapterCache();
    }
    if (failure.kind === "model_unavailable" && job.model) {
      recordUnavailableModel("opencode", job.model, failure.message);
      clearAdapterCache();
    }
    if (failure.isProviderError && turnEditedFiles) {
      status = "done";
      warning = `Provider limit reached after edits were made (${failure.message}). Review the diff and check results carefully.`;
    } else {
      status = "failed";
      errorKind = failure.kind;
      errorMessage = failure.message;
    }
  }

  if (status === "done" && !warning) {
    if (openCodeAdapter.isFreeModel?.(job.model)) clearFreeQuotaExhausted("opencode");
    if (job.model) clearUnavailableModel("opencode", job.model);
  }

  const checks = status === "done" ? await runChecks(job.checks, job.workdir) : undefined;
  const worktreeState: WorktreeState =
    files.length === 0 ? "clean" : (await hasChanges(job.workdir)) ? "uncommitted" : "committed";
  const endedAt = nowIso();
  const current = readJob(jobId) ?? job;
  const result = buildResult({
    events,
    files,
    checks,
    branch: current.branch,
    startedAt: current.startedAt,
    endedAt,
    status,
    fallbackSummary: errorMessage,
    warning,
    workdir: job.workdir,
    worktreeState,
  });
  result.task_id = jobId;
  writeResult(jobId, result);

  await updateJob(jobId, (latest) => {
    if (latest.status !== "running" && latest.status !== "queued") return latest;
    const finalStatus = result.status;
    return {
      ...latest,
      status: finalStatus,
      endedAt,
      pid: undefined,
      opencodePid: undefined,
      error:
        finalStatus === "failed"
          ? { kind: errorKind ?? "unknown", message: errorMessage || result.summary }
          : undefined,
    };
  });
}

function wroteFilesThisTurn(events: StoredEvent[]): boolean {
  return events.some((item) => {
    if (item.event.t !== "tool" || item.event.status !== "completed") return false;
    const name = item.event.name.toLowerCase();
    return (
      name.includes("write") || name.includes("edit") || name.includes("apply") || name.includes("patch")
    );
  });
}

function attach(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (buffer) onLine(buffer);
      buffer = "";
      resolve();
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    });
    stream.on("end", finish);
    stream.on("close", finish);
  });
}
