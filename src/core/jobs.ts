import fs from "node:fs";
import path from "node:path";
import { FREE_MODEL, openCodeAdapter } from "../adapters/opencode.js";
import { isJobId, jobDir, newJobId, nowIso, runtimeLimits } from "./config.js";
import {
  createJob,
  listJobs,
  readEvents,
  readJob,
  readResult,
  updateJob,
  writeResult,
  writeUserPrompt,
} from "./jobstore.js";
import { isAlive } from "./proc.js";
import { getPreference, savePreference } from "./prefs.js";
import { redact } from "./redact.js";
import { readSecrets } from "./secrets.js";
import { spawnDetachedRunner } from "./spawn.js";
import { atomicWriteText } from "./store.js";
import { recentLines } from "./summarize.js";
import {
  err,
  isTerminal,
  ok,
  type CodehandError,
  type Job,
  type Mode,
  type Preference,
  type Result,
  type TaskResult,
} from "./types.js";
import { computeDiff, createWorktree, resolveRepo, withRepoLock, worktreePath } from "./workspace.js";

export interface StartInput {
  prompt: string;
  repo: string;
  mode?: Mode;
  model?: string;
  baseBranch?: string;
  checks?: string[];
  remember?: boolean;
  delegate?: string;
  waitSeconds?: number;
}

export interface TaskView {
  kind: "task";
  job: Job;
  result?: TaskResult;
  recent: string[];
}

export type StartOutcome = { kind: "preference"; preference: Preference } | TaskView;

export interface TaskSummary {
  id: string;
  status: Job["status"];
  repo: string;
  prompt: string;
  updatedAt: string;
}

function clampWait(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(45, Math.max(0, Math.floor(value)));
}

function validateTask(input: {
  prompt: string;
  repo: string;
  mode?: Mode;
  checks?: string[];
}): CodehandError | null {
  if (!input.prompt?.trim() || input.prompt.length > 20_000) {
    return { kind: "bad_input", message: "Prompt must be between 1 and 20000 characters." };
  }
  if (!input.repo?.trim()) return { kind: "bad_input", message: "A repo path or git URL is required." };
  if (input.mode && input.mode !== "plan" && input.mode !== "edit") {
    return { kind: "bad_input", message: "Mode must be plan or edit." };
  }
  if (input.checks && input.checks.length > 3)
    return { kind: "bad_input", message: "At most 3 check commands." };
  for (const cmd of input.checks ?? []) {
    if (!cmd.trim() || cmd.length > 200 || /[\r\n]/.test(cmd)) {
      return { kind: "bad_input", message: "Each check command must be one line under 200 characters." };
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeTerminalResult(job: Job, status: "failed" | "cancelled", summary: string): void {
  if (readResult(job.id)) return;
  writeResult(job.id, {
    status,
    summary,
    filesChanged: [],
    blockedActions: [],
    durationS: 0,
    branch: job.branch,
  });
}

export async function reconcile(id: string): Promise<Job | null> {
  const job = readJob(id);
  if (job?.status !== "running") return job;
  const crashMs = runtimeLimits().crashMs;
  const beat = job.heartbeatAt ? Date.parse(job.heartbeatAt) : 0;
  const age = Date.now() - beat;
  const stale = age > crashMs;
  const hung = age > crashMs * 5;
  if (!stale) return job;
  if (isAlive(job.pid) && !hung) return job;
  const updated = await updateJob(id, (current) => {
    if (current.status !== "running") return current;
    const endedAt = nowIso();
    if (current.cancelRequested) return { ...current, status: "cancelled", endedAt, pid: undefined };
    return {
      ...current,
      status: "failed",
      endedAt,
      pid: undefined,
      error: { kind: "crashed", message: "The runner stopped without finishing." },
    };
  });
  if (updated.status === "failed") {
    writeTerminalResult(updated, "failed", updated.error?.message ?? "The runner stopped without finishing.");
  } else if (updated.status === "cancelled") {
    writeTerminalResult(updated, "cancelled", "Cancelled.");
  }
  return updated;
}

export async function pumpQueue(): Promise<void> {
  const { withFileLock } = await import("./store.js");
  const { codehandHome } = await import("./config.js");
  await withFileLock(path.join(codehandHome(), "queue.lock"), async () => {
    const running = listJobs().filter((job) => job.status === "running").length;
    const slots = runtimeLimits().maxRunning - running;
    if (slots <= 0) return;
    const queued = listJobs()
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of queued.slice(0, slots)) {
      const updated = await updateJob(job.id, (current) => {
        if (current.status !== "queued") return current;
        return {
          ...current,
          status: "running",
          startedAt: current.startedAt ?? nowIso(),
          heartbeatAt: nowIso(),
        };
      });
      if (updated.status === "running" && updated.pid === undefined) spawnDetachedRunner(job.id, job.turn);
    }
  });
}

async function view(id: string): Promise<TaskView> {
  const job = (await reconcile(id)) ?? readJob(id);
  if (!job) throw new Error(`Task ${id} not found.`);
  const result = isTerminal(job.status) ? (readResult(id) ?? undefined) : undefined;
  return { kind: "task", job, result, recent: recentLines(readEvents(id, job.turn)) };
}

async function waitFor(id: string, waitSeconds: number): Promise<TaskView> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = await view(id);
  while (Date.now() < deadline && !isTerminal(current.job.status)) {
    await sleep(300);
    current = await view(id);
  }
  return current;
}

async function ensureAgent(): Promise<CodehandError | null> {
  const detected = await openCodeAdapter.detect();
  if (!detected.installed) {
    return {
      kind: "not_installed",
      message: "OpenCode is not installed. Ask the user before installing it.",
    };
  }
  return null;
}

export async function startTask(input: StartInput): Promise<Result<StartOutcome>> {
  if (input.delegate && input.delegate !== "opencode" && input.delegate !== "self") {
    return err("bad_input", "Delegate must be opencode or self.");
  }
  if (input.delegate !== "self") {
    const invalid = validateTask(input);
    if (invalid) return err(invalid.kind, invalid.message);
  }
  if (input.remember) {
    savePreference({
      delegate: input.delegate === "self" ? "self" : "opencode",
      model: input.model,
      savedAt: nowIso(),
    });
  }
  if (input.delegate === "self") {
    const preference = getPreference();
    if (!preference) return err("bad_input", "No preference was saved.");
    return ok({ kind: "preference", preference });
  }
  const agentError = await ensureAgent();
  if (agentError) return err(agentError.kind, agentError.message);

  const pref = getPreference();
  const model = input.model ?? pref?.model ?? FREE_MODEL;

  const repo = await resolveRepo(input.repo, input.baseBranch);
  if (!repo.ok) return repo;
  const id = newJobId();
  const stamp = nowIso();
  const detected = await openCodeAdapter.detect();
  createJob({
    id,
    agent: "opencode",
    mode: input.mode ?? "edit",
    model,
    promptPreview: redact(input.prompt.trim().slice(0, 80)),
    checks: input.checks,
    repo: { ...repo.value, input: redact(repo.value.input) },
    workdir: worktreePath(id),
    branch: `codehand/${id}`,
    status: "queued",
    turn: 1,
    createdAt: stamp,
    updatedAt: stamp,
    agentVersion: detected.version,
  });
  writeUserPrompt(id, 1, input.prompt);
  const tree = await withRepoLock(repo.value.root, () =>
    createWorktree(repo.value.root, id, `codehand/${id}`, repo.value.baseCommit),
  );
  if (!tree.ok) {
    await updateJob(id, (job) => ({ ...job, status: "failed", endedAt: nowIso(), error: tree.error }));
    return tree;
  }
  await updateJob(id, (job) => ({ ...job, workdir: tree.value }));
  await pumpQueue();
  return ok(await waitFor(id, clampWait(input.waitSeconds, 20)));
}

export async function checkTask(input: {
  taskId?: string;
  waitSeconds?: number;
}): Promise<Result<TaskView | { kind: "list"; tasks: TaskSummary[] }>> {
  if (!input.taskId) {
    await pumpQueue();
    const jobs = listJobs();
    for (const job of jobs) {
      if (job.status === "running") await reconcile(job.id);
    }
    const tasks = listJobs()
      .slice(0, 10)
      .map((job) => ({
        id: job.id,
        status: job.status,
        repo: job.repo.input,
        prompt: job.promptPreview,
        updatedAt: job.updatedAt,
      }));
    return ok({ kind: "list", tasks });
  }
  if (!isJobId(input.taskId) || !readJob(input.taskId))
    return err("bad_input", `Unknown task ${input.taskId ?? ""}.`);
  await pumpQueue();
  return ok(await waitFor(input.taskId, clampWait(input.waitSeconds, 30)));
}

export async function replyTask(input: {
  taskId: string;
  message: string;
  waitSeconds?: number;
  model?: string;
}): Promise<Result<TaskView>> {
  if (!isJobId(input.taskId)) return err("bad_input", "Unknown task id.");
  const job = readJob(input.taskId);
  if (!job) return err("bad_input", `Unknown task ${input.taskId}.`);
  if (!input.message?.trim() || input.message.length > 20_000) {
    return err("bad_input", "Reply must be between 1 and 20000 characters.");
  }
  let rejectedReason: string | undefined;
  await updateJob(job.id, (current) => {
    if (current.status !== "needs_input" && current.status !== "done" && current.status !== "failed") {
      rejectedReason = `Cannot reply while the task is ${current.status}.`;
      return current;
    }
    if (!current.sessionId) {
      rejectedReason = "This task has no OpenCode session to continue.";
      return current;
    }
    if (current.cleaned || !fs.existsSync(current.workdir)) {
      rejectedReason = "Cannot reply because this task's worktree was discarded.";
      return current;
    }
    const turn = current.turn + 1;
    writeUserPrompt(current.id, turn, input.message);
    return {
      ...current,
      status: "queued",
      turn,
      pid: undefined,
      opencodePid: undefined,
      endedAt: undefined,
      startedAt: undefined,
      heartbeatAt: undefined,
      error: undefined,
      cancelRequested: undefined,
      model: input.model ?? current.model,
      promptPreview: redact(input.message.trim().slice(0, 80)),
    };
  });
  if (rejectedReason) return err("bad_input", rejectedReason);
  await pumpQueue();
  return ok(await waitFor(job.id, clampWait(input.waitSeconds, 20)));
}

export async function getOutput(input: {
  taskId: string;
  what: "diff" | "log" | "message";
  path?: string;
  offset?: number;
  maxChars?: number;
}): Promise<Result<{ content: string; offset: number; nextOffset: number | null; totalChars: number }>> {
  if (!isJobId(input.taskId)) return err("bad_input", "Unknown task id.");
  const job = readJob(input.taskId);
  if (!job) return err("bad_input", `Unknown task ${input.taskId}.`);
  if (input.offset !== undefined && (!Number.isFinite(input.offset) || input.offset < 0)) {
    return err("bad_input", "offset must be a non-negative number.");
  }
  if (input.maxChars !== undefined && (!Number.isFinite(input.maxChars) || input.maxChars < 1)) {
    return err("bad_input", "maxChars must be a positive number.");
  }
  const maxChars = Math.min(input.maxChars ?? 8000, 20_000);
  const offset = Math.max(0, input.offset ?? 0);
  let full = "";
  if (input.what === "diff") {
    const patchFile = path.join(jobDir(job.id), "diff.patch");
    if (!input.path && isTerminal(job.status) && fs.existsSync(patchFile)) {
      full = fs.readFileSync(patchFile, "utf8");
    } else {
      readSecrets();
      const diff = await computeDiff(job.workdir, job.repo.baseCommit, input.path);
      if (!diff.ok) return diff;
      full = redact(diff.value.patch);
      if (!input.path) atomicWriteText(patchFile, full);
    }
  } else if (input.what === "log") {
    full = readEvents(job.id)
      .map((item) => `${item.ts} ${JSON.stringify(item.event)}`)
      .join("\n");
  } else {
    const latest = readEvents(job.id, job.turn);
    const texts = latest.filter((item) => item.event.t === "text");
    const last = texts.at(-1);
    if (last && last.event.t === "text") {
      full = last.event.text;
    } else if (
      job.status === "failed" ||
      (latest.some((item) => item.event.t === "error") && texts.length === 0)
    ) {
      full = readResult(job.id)?.summary ?? job.error?.message ?? "";
    } else {
      const allTexts = readEvents(job.id).filter((item) => item.event.t === "text");
      const allLast = allTexts.at(-1);
      full = allLast && allLast.event.t === "text" ? allLast.event.text : (readResult(job.id)?.summary ?? "");
    }
  }
  full = redact(full);
  const content = full.slice(offset, offset + maxChars);
  const next = offset + maxChars < full.length ? offset + maxChars : null;
  return ok({ content, offset, nextOffset: next, totalChars: full.length });
}
