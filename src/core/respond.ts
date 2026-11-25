import { FREE_MODEL } from "../adapters/opencode.js";
import type { AgentDescription } from "./agents.js";
import type { TaskSummary, TaskView } from "./jobs.js";
import { redact } from "./redact.js";
import { isTerminal, type Envelope, type Preference, type TaskResult } from "./types.js";

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

function authHint(auth: AgentDescription["auth"]): string {
  if (auth === "env_only") {
    return " Environment API key(s) are present, but OpenCode is not signed in. Free models are used by default unless you pick a model. Signing in is optional, for a paid plan.";
  }
  if (auth === "anonymous") {
    return " Free models work with no account. Signing in is optional, for a paid plan.";
  }
  if (auth === "unknown") {
    return " Could not read saved logins. You can still try a free-tier task, or offer login.";
  }
  return "";
}

export function nextForAgents(agents: AgentDescription[], preference: Preference | null): string {
  const agent = agents[0];
  if (!agent?.installed) {
    return "Ask the user first: OpenCode is not installed on this computer. Install it so I can hand coding work to it? Do not install until they say yes. If they say yes, call setup_coding_agent with action install.";
  }
  if (!preference) {
    return `Ask the user once: hand coding work to OpenCode, or do it yourself?${authHint(agent.auth)} Then pass remember:true.`;
  }
  if (preference.delegate === "self")
    return "The user prefers you do the coding yourself. Don't start OpenCode.";
  const model = preference.model ?? FREE_MODEL;
  const parts: string[] = [];
  if (agent.freeTierStatus === "exhausted") {
    parts.push(
      `Free tier is exhausted${agent.freeTierDetail ? ` (${agent.freeTierDetail})` : ""}. Wait for reset, pick another model, or sign in (setup_coding_agent login).`,
    );
  } else if (agent.auth === "env_only") {
    parts.push(
      "Environment API key(s) detected, not signed in. Using the free model by default unless a model is picked. Offer login only if they want a paid plan.",
    );
  } else if (agent.auth === "anonymous") {
    parts.push(
      "Using the free tier (no login). Offer setup_coding_agent login only if they want a paid plan.",
    );
  } else if (agent.auth === "unknown") {
    parts.push("Could not read saved logins. You can still try a free-tier task, or offer login.");
  }
  if (agent.unavailableModels?.length) {
    parts.push(`Unavailable models: ${agent.unavailableModels.join(", ")}.`);
  }
  const extra = parts.length ? ` ${parts.join(" ")}` : "";
  return `Preference saved: use OpenCode (model ${model}). Mention it to the user. Don't ask again.${extra}`;
}

export function respondAgents(data: {
  agents: AgentDescription[];
  preference: Preference | null;
}): Rendered<typeof data> {
  const next = nextForAgents(data.agents, data.preference);
  const agent = data.agents[0];
  const freeTierLine =
    agent?.freeTierStatus === "exhausted"
      ? `Free tier exhausted${agent.freeTierDetail ? `: ${agent.freeTierDetail}` : "."}`
      : agent?.freeTierDetail && agent.auth !== "ready"
        ? agent.freeTierDetail
        : "";
  const text = clip(
    [
      agent
        ? `OpenCode: ${agent.installed ? `installed ${agent.version ?? ""}`.trim() : "not installed"}, auth ${agent.auth}.`
        : "No coding agent is registered.",
      agent?.freeTier === false && agent.freeTierStatus === "exhausted" ? "freeTier: false" : "",
      freeTierLine,
      agent?.unavailableModels?.length ? `Unavailable models: ${agent.unavailableModels.join(", ")}.` : "",
      agent?.warning ?? "",
      data.preference
        ? `Saved preference: ${data.preference.delegate} (model ${data.preference.model ?? FREE_MODEL}).`
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
  const hasSession = Boolean(job.sessionId);
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
          ? result.warning
            ? "Show the user the summary and the warning. Review the diff and check results carefully. Then offer: see the diff, request changes, commit, merge, or discard."
            : "Show the user the summary. Offer: see the diff, request changes, commit, merge, or discard."
          : result.status === "cancelled"
            ? "Tell the user the task was cancelled. The branch was kept."
            : failureNext(result.summary, job.error?.kind, hasSession);
    const checks =
      result.checks?.map((check) => `- ${check.cmd}: ${check.ok ? "passed" : "failed"}`).join("\n") ?? "";
    const uncommitted =
      result.status === "done" && result.filesChanged.length > 0 && result.worktreeState === "uncommitted"
        ? `Worktree: uncommitted changes in ${result.workdir ?? job.workdir} on ${result.branch} (not yet committed; git log on ${result.branch} stays at base until commit or merge).`
        : "";
    const text = clip(
      [
        UNTRUSTED,
        `${result.status} in ${result.durationS}s on ${result.branch}.`,
        result.question ? `Question: ${result.question}` : result.summary,
        job.status === "failed" && job.error ? `Error (${job.error.kind}): ${job.error.message}` : "",
        result.warning ? `Warning: ${result.warning}` : "",
        uncommitted,
        result.filesChanged.length ? `Files:\n${filesText(result)}` : "",
        checks ? `Checks:\n${checks}` : "",
        result.blockedActions.length ? `Blocked: ${result.blockedActions.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return { text, envelope: { ok: result.status !== "failed", data, error: job.error, next } };
  }
  if (isTerminal(job.status) && !result) {
    const next =
      job.status === "needs_input"
        ? "Ask the user this question, then call reply_to_coding_task with their answer."
        : job.status === "done"
          ? "Show the user the summary. Offer: see the diff, request changes, commit, merge, or discard."
          : job.status === "cancelled"
            ? "Tell the user the task was cancelled. The branch was kept."
            : failureNext(job.error?.message ?? "The task failed.", job.error?.kind, hasSession);
    const text = clip(
      [
        `Task ${job.id} is ${job.status} on ${job.branch}.`,
        job.error ? `Error (${job.error.kind}): ${job.error.message}` : "",
        next,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return {
      text,
      envelope: {
        ok: job.status !== "failed",
        data: {
          task_id: job.id,
          status: job.status,
          error: job.error,
          branch: job.branch,
          workdir: job.workdir,
        },
        error: job.error,
        next,
      },
    };
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

function failureNext(summary: string, kind?: string, hasSession?: boolean): string {
  const retry = hasSession
    ? " You can call reply_to_coding_task with another model to continue this session."
    : "";
  if (kind === "quota") {
    return `The provider quota/free limit is used up. Wait for reset, try another model, sign in (setup_coding_agent login), or do the task yourself.${hasSession ? retry : ""}`;
  }
  if (kind === "model_unavailable") {
    return `That model is unavailable. Pick another model from coding_agents and retry.${hasSession ? retry : ""}`;
  }
  if (kind === "rate_limit") {
    return `The provider rate-limited this run. Retry later, pick another model, or do the task yourself.${retry}`;
  }
  if (kind === "auth") {
    return `The free tier was rejected or a provider needs a key. Ask if they want to sign in (setup_coding_agent login), or retry.${retry}`;
  }
  if (kind === "not_installed") {
    return `Ask the user whether to install OpenCode. If they say yes, call setup_coding_agent with action install.${retry}`;
  }
  return `The task failed. Tell the user: ${summary.slice(0, 200)}${retry}`;
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
  opts?: { unclipped?: boolean; max?: number },
): Rendered<T> {
  const rendered = opts?.unclipped ? redact(text) : clip(text, opts?.max);
  return { text: rendered, envelope: { ok: true, data, next } };
}
