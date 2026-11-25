import fs from "node:fs";
import path from "node:path";
import { jobDir, jobsDir, nowIso } from "./config.js";
import { isAlive } from "./proc.js";
import { appendLine, atomicWriteJson, readJson, withFileLock } from "./store.js";
import { canTransition, type Job, type StoredEvent, type TaskResult } from "./types.js";

const RUNNER_LOCK_ANCIENT_MS = 5 * 60_000;

export function readJob(id: string): Job | null {
  return readJson<Job>(path.join(jobDir(id), "job.json"));
}

export function listJobs(): Job[] {
  const root = jobsDir();
  if (!fs.existsSync(root)) return [];
  const jobs: Job[] = [];
  for (const name of fs.readdirSync(root)) {
    const job = readJson<Job>(path.join(root, name, "job.json"));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateJob(id: string, change: (job: Job) => Job): Promise<Job> {
  return withFileLock(path.join(jobDir(id), "job.json.lock"), async () => {
    const current = readJob(id);
    if (!current) throw new Error(`Task ${id} disappeared.`);
    const next = change(current);
    if (next.status !== current.status && !canTransition(current.status, next.status)) return current;
    next.updatedAt = nowIso();
    atomicWriteJson(path.join(jobDir(id), "job.json"), next);
    return next;
  });
}

export function createJob(job: Job): void {
  fs.mkdirSync(jobDir(job.id), { recursive: true });
  atomicWriteJson(path.join(jobDir(job.id), "job.json"), job);
}

export function userPromptPath(id: string, turn: number): string {
  return path.join(jobDir(id), "turns", String(turn), "user.md");
}

export function promptPath(id: string, turn: number): string {
  return path.join(jobDir(id), "turns", String(turn), "prompt.md");
}

export function eventsPath(id: string, turn: number): string {
  return path.join(jobDir(id), "turns", String(turn), "events.jsonl");
}

export function logFile(id: string, turn: number, which: "stdout" | "stderr"): string {
  return path.join(jobDir(id), "turns", String(turn), `${which}.log`);
}

export function writeUserPrompt(id: string, turn: number, prompt: string): void {
  const file = userPromptPath(id, turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prompt);
}

export function readUserPrompt(id: string, turn: number): string {
  try {
    return fs.readFileSync(userPromptPath(id, turn), "utf8");
  } catch {
    return "";
  }
}

export function appendEvent(id: string, turn: number, event: StoredEvent["event"]): void {
  const stored: StoredEvent = { ts: nowIso(), turn, event };
  appendLine(eventsPath(id, turn), JSON.stringify(stored));
}

export function readEvents(id: string, turn?: number): StoredEvent[] {
  const turns = turn
    ? [turn]
    : fs.existsSync(path.join(jobDir(id), "turns"))
      ? fs.readdirSync(path.join(jobDir(id), "turns")).sort((a, b) => Number(a) - Number(b))
      : [];
  const events: StoredEvent[] = [];
  for (const item of turns) {
    const file = eventsPath(id, Number(item));
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as StoredEvent);
      } catch {
        /* skip a torn line */
      }
    }
  }
  return events;
}

export function writeResult(id: string, result: TaskResult): void {
  atomicWriteJson(path.join(jobDir(id), "result.json"), result);
}

export function readResult(id: string): TaskResult | null {
  return readJson<TaskResult>(path.join(jobDir(id), "result.json"));
}

export function acquireRunnerLock(id: string): boolean {
  const lock = path.join(jobDir(id), "lock");
  const token = `${process.pid}:${Date.now()}`;
  try {
    fs.writeFileSync(lock, token, { flag: "wx" });
    return true;
  } catch {
    let contents = "";
    try {
      contents = fs.readFileSync(lock, "utf8");
    } catch {
      return false;
    }
    const [pidPart, atPart] = contents.split(":");
    const owner = Number(pidPart);
    const at = Number(atPart);
    const age = Number.isFinite(at) && at > 0 ? Date.now() - at : Number.POSITIVE_INFINITY;
    if (isAlive(owner) && age <= RUNNER_LOCK_ANCIENT_MS) return false;
    fs.rmSync(lock, { force: true });
    try {
      fs.writeFileSync(lock, token, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function releaseRunnerLock(id: string): void {
  const lock = path.join(jobDir(id), "lock");
  try {
    const owner = Number(fs.readFileSync(lock, "utf8").split(":")[0]);
    if (owner === process.pid) fs.rmSync(lock, { force: true });
  } catch {
    /* already gone */
  }
}
