import spawn from "cross-spawn";
import path from "node:path";
import { openCodeAdapter } from "../adapters/opencode.js";
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
import { log } from "./log.js";
import { pumpQueue } from "./jobs.js";
import { killTree, killTreeHard, runCaptured } from "./proc.js";
import { redact } from "./redact.js";
import { buildChildEnv } from "./secrets.js";
import { appendLine, atomicWriteText } from "./store.js";
import { buildResult } from "./summarize.js";
import type { CheckResult, ErrorKind, TaskResult } from "./types.js";
import { computeDiff } from "./workspace.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChecks(commands: string[] | undefined, cwd: string): Promise<CheckResult[]> {
  if (!commands?.length) return [];
  const results: CheckResult[] = [];
  for (const cmd of commands) {
    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    const result = await runCaptured(shell, args, { cwd, timeoutMs: 300_000, maxBytes: 20_000 });
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
  await updateJob(jobId, (current) => ({ ...current, opencodePid: child.pid }));

  const limits = runtimeLimits();
  let lastOutput = Date.now();
  let lastBeat = Date.now();
  let stderrTail = "";
  let sawSession = Boolean(job.sessionId);
  let stop: ErrorKind | "cancel" | null = null;

  const onLine = (channel: "stdout" | "stderr", line: string) => {
    lastOutput = Date.now();
    const redacted = redact(line);
    appendLine(logFile(jobId, turn, channel), redacted);
    if (channel === "stderr") stderrTail = `${stderrTail}\n${redacted}`.slice(-4000);
    for (const event of openCodeAdapter.parseLine(redacted)) {
      appendEvent(jobId, turn, event);
      if (!sawSession && event.t === "session") {
        sawSession = true;
        void updateJob(jobId, (current) => ({ ...current, sessionId: current.sessionId ?? event.sessionId }));
      }
    }
  };

  attach(child.stdout, (line) => onLine("stdout", line));
  attach(child.stderr, (line) => onLine("stderr", line));

  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code));
  });
  let exitCode: number | null = null;
  let done = false;
  const finished = exited.then((code) => {
    exitCode = code;
    done = true;
  });

  while (!done && !stop) {
    await Promise.race([finished, sleep(400)]);
    if (done) break;
    const latest = readJob(jobId);
    if (latest?.cancelRequested) stop = "cancel";
    else if (Date.now() - lastOutput > limits.idleMs) stop = "idle_timeout";
    else if (job.startedAt && Date.now() - Date.parse(job.startedAt) > limits.totalMs) stop = "timeout";
    if (Date.now() - lastBeat > limits.heartbeatMs) {
      lastBeat = Date.now();
      await updateJob(jobId, (current) => ({ ...current, heartbeatAt: nowIso(), pid: process.pid }));
    }
  }

  if (stop) {
    killTree(child.pid);
    await Promise.race([finished, sleep(limits.killGraceMs)]);
    if (!done) killTreeHard(child.pid);
    await Promise.race([finished, sleep(1000)]);
  }

  const events = readEvents(jobId, turn);
  const sawError = events.some((item) => item.event.t === "error");
  let status: TaskResult["status"] = "done";
  let errorKind: ErrorKind | undefined;
  let errorMessage = "";
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
  } else if (exitCode === null) {
    status = "failed";
    errorKind = "not_installed";
    errorMessage = "OpenCode could not be started. Is it installed and on PATH?";
  } else if (exitCode !== 0 || sawError) {
    status = "failed";
    errorKind = openCodeAdapter.classifyFailure(exitCode, stderrTail);
    errorMessage = redact(stderrTail).trim().slice(-500) || `OpenCode exited with code ${exitCode}.`;
  }

  const diff = await computeDiff(job.workdir, job.repo.baseCommit).catch(() => null);
  const files = diff?.ok ? diff.value.files : [];
  const patch = diff?.ok ? diff.value.patch : "";
  atomicWriteText(path.join(jobDir(jobId), "diff.patch"), patch);

  const checks = status === "done" ? await runChecks(job.checks, job.workdir) : undefined;
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

function attach(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
  });
}
