export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled";

export type Mode = "plan" | "edit";

export type ErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "model_unavailable"
  | "network"
  | "timeout"
  | "idle_timeout"
  | "crashed"
  | "bad_input"
  | "not_installed"
  | "git"
  | "unknown";

export type AuthState = "ready" | "env_only" | "anonymous" | "unknown";

export type WorktreeState = "uncommitted" | "committed" | "clean";

export interface CodehandError {
  kind: ErrorKind;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: CodehandError };

export interface Preference {
  delegate: "opencode" | "self";
  model?: string;
  savedAt: string;
}

export interface Limits {
  idleMin: number;
  totalMin: number;
  maxRunning: number;
}

export interface ConfigFile {
  version: 1;
  preference: Preference | null;
  limits: Limits;
}

export interface Job {
  id: string;
  agent: "opencode";
  mode: Mode;
  model?: string;
  promptPreview: string;
  checks?: string[];
  repo: { input: string; root: string; baseBranch: string; baseCommit: string };
  workdir: string;
  branch: string;
  sessionId?: string;
  status: JobStatus;
  turn: number;
  pid?: number;
  opencodePid?: number;
  heartbeatAt?: string;
  cancelRequested?: boolean;
  cleaned?: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: { kind: ErrorKind; message: string };
  agentVersion?: string;
}

export type NormalizedEvent =
  | { t: "session"; sessionId: string }
  | {
      t: "step";
      phase: "start" | "finish";
      tokens?: { input?: number; output?: number };
      costUsd?: number;
    }
  | { t: "text"; text: string }
  | { t: "tool"; name: string; status: "completed" | "error"; summary: string; path?: string }
  | { t: "permission_rejected"; permission: string; detail: string }
  | { t: "error"; kind: ErrorKind; message: string };

export interface StoredEvent {
  ts: string;
  turn: number;
  event: NormalizedEvent;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  status: "A" | "M" | "D" | "R";
}

export interface CheckResult {
  cmd: string;
  ok: boolean;
  tail: string;
}

export interface TaskResult {
  status: "done" | "needs_input" | "failed" | "cancelled";
  summary: string;
  question?: string;
  warning?: string;
  filesChanged: FileChange[];
  checks?: CheckResult[];
  blockedActions: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  durationS: number;
  branch: string;
  workdir?: string;
  worktreeState?: WorktreeState;
  task_id?: string;
}

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { kind: ErrorKind; message: string };
  next: string;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(kind: ErrorKind, message: string): Result<T> {
  return { ok: false, error: { kind, message } };
}

export function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "needs_input" || status === "failed" || status === "cancelled";
}

const transitions: Record<JobStatus, JobStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["needs_input", "done", "failed", "cancelled"],
  needs_input: ["queued", "cancelled"],
  done: ["queued"],
  failed: ["queued"],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].includes(to);
}
