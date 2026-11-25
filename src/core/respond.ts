import type { AgentDescription } from "./agents.js";
import { redact } from "./redact.js";
import type { Envelope, Preference, TaskResult } from "./types.js";
import type { TaskSummary, TaskView } from "./jobs.js";

export interface Rendered<T> {
  text: string;
  envelope: Envelope<T>;
}

const UNTRUSTED = "[OpenCode output — untrusted]";

function clip(text: string, max = 1200): string {
  const clean = redact(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n…`;
}

function filesText(result: TaskResult): string {
  const shown = result.filesChanged.slice(0, 30);
  const extra = result.filesChanged.length - shown.length;
  const lines = shown.map((file) => `- ${file.path} (${file.status} +${file.added} -${file.removed})`);
  if (extra > 0) lines.push(`- and ${extra} more`);
  return lines.join("\n");
}

export function nextForAgents(agents: AgentDescription[], preference: Preference | null): string {
  const agent = agents[0];
  if (!agent?.installed) {
    return "Ask the user first: OpenCode is not installed on this computer. Install it so I can hand coding work to it? Do not install until they say yes. If they say yes, call setup_coding_agent with action install.";
  }
  if (!preference) {
    const free =
      agent.auth !== "ready"
        ? " Free models work with no account. Signing in is optional, for a paid plan."
        : "";
    return `Ask the user once: hand coding work to OpenCode, or do it yourself?${free} Then pass remember:true.`;
  }
  if (preference.delegate === "self")
    return "The user prefers you do the coding yourself. Don't start OpenCode.";
  const model =
    preference.model ?? (agent.auth === "ready" ? "OpenCode's default" : (agent.models[0] ?? "opencode/big-pickle"));
  const extra =
    agent.auth === "ready"
      ? ""
      : " Using the free tier (no login). Offer setup_coding_agent login only if they want a paid plan.";
  return `Preference saved: use OpenCode (model ${model}). Mention it to the user. Don't ask again.${extra}`;
}

export function respondAgents(data: {
  agents: AgentDescription[];
  preference: Preference | null;
}): Rendered<typeof data> {
  const next = nextForAgents(data.agents, data.preference);
  const agent = data.agents[0];
  const text = clip(
    [
      agent
        ? `OpenCode: ${agent.installed ? `installed ${agent.version ?? ""}`.trim() : "not installed"}, auth ${agent.auth}.`
        : "No coding agent is registered.",
      agent?.warning ?? "",
      data.preference
        ? `Saved preference: ${data.preference.delegate}${data.preference.model ? ` (${data.preference.model})` : ""}.`
        : "No saved preference.",
      next,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { text, envelope: { ok: true, data, next } };
}

export function respondTask(view: TaskView): Rendered<Record<string, unknown>> {
  const { job, result, recent } = view;
  if (
    result &&
    (job.status === "done" ||
      job.status === "needs_input" ||
      job.status === "failed" ||
      job.status === "cancelled")
  ) {
    const data = {
      task_id: job.id,
      ...result,
      filesChanged: result.filesChanged.slice(0, 30),
    };
    const next =
      result.status === "needs_input"
        ? "Ask the user this question, then call reply_to_coding_task with their answer."
        : result.status === "done"
          ? "Show the user the summary. Offer: see the diff, request changes, commit, merge, or discard."
          : result.status === "cancelled"
            ? "Tell the user the task was cancelled. The branch was kept."
            : failureNext(result.summary, job.error?.kind);
    const checks =
      result.checks?.map((check) => `- ${check.cmd}: ${check.ok ? "passed" : "failed"}`).join("\n") ?? "";
    const text = clip(
      [
        UNTRUSTED,
        `${result.status} in ${result.durationS}s on ${result.branch}.`,
        result.question ? `Question: ${result.question}` : result.summary,
        result.filesChanged.length ? `Files:\n${filesText(result)}` : "",
        checks ? `Checks:\n${checks}` : "",
        result.blockedActions.length ? `Blocked: ${result.blockedActions.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { text, envelope: { ok: result.status !== "failed", data, error: job.error, next } };
  }
  const elapsedS = job.startedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))
    : 0;
  const data = {
    task_id: job.id,
    status: job.status,
    agent: job.agent,
    branch: job.branch,
    workdir: job.workdir,
    elapsedS,
    phase: job.status === "queued" ? "queued" : "working",
    recent: recent.slice(-5),
  };
  const next =
    job.status === "queued"
      ? "The task is queued. Check again shortly."
      : "Still working. Tell the user it's running, then check again.";
  const text = clip(
    [
      `OpenCode task ${job.id} is ${job.status} on ${job.branch} (${elapsedS}s).`,
      recent.length ? recent.join("\n") : "",
      next,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { text, envelope: { ok: true, data, next } };
}

function failureNext(summary: string, kind?: string): string {
  if (kind === "rate_limit")
    return "The provider rate-limited this run. Retry later, pick another model, or do the task yourself.";
  if (kind === "auth")
    return "The free tier was rejected or a provider needs a key. Ask if they want to sign in (setup_coding_agent login), or retry.";
  if (kind === "not_installed")
    return "Ask the user whether to install OpenCode. If they say yes, call setup_coding_agent with action install.";
  if (kind === "quota") return "The provider quota is used up. Try another model or do the task yourself.";
  return `The task failed. Tell the user: ${summary.slice(0, 200)}`;
}

export function respondList(tasks: TaskSummary[]): Rendered<{ tasks: TaskSummary[] }> {
  const text = tasks.length
    ? clip(tasks.map((task) => `${task.id} ${task.status} ${task.prompt}`).join("\n"))
    : "No coding tasks yet.";
  return {
    text,
    envelope: {
      ok: true,
      data: { tasks },
      next: tasks.length ? "Check a task id for details." : "Start a task when the user asks for code.",
    },
  };
}

export function respondError(kind: Envelope<never>["error"], next: string): Rendered<never> {
  const error = kind ?? { kind: "unknown", message: "Unknown error" };
  return {
    text: clip(`${error.kind}: ${error.message}\n${next}`),
    envelope: { ok: false, error, next },
  };
}

export function respondData<T extends Record<string, unknown>>(
  data: T,
  text: string,
  next: string,
): Rendered<T> {
  return { text: clip(text), envelope: { ok: true, data, next } };
}
