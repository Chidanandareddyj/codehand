import type { CheckResult, FileChange, StoredEvent, TaskResult } from "./types.js";

export function buildResult(input: {
  events: StoredEvent[];
  files: FileChange[];
  checks?: CheckResult[];
  branch: string;
  startedAt?: string;
  endedAt: string;
  status: TaskResult["status"];
  fallbackSummary?: string;
}): TaskResult {
  const texts = input.events
    .filter((item) => item.event.t === "text")
    .map((item) => (item.event.t === "text" ? item.event.text : ""));
  const lastText = texts.at(-1) ?? "";
  const questionMatch = lastText.match(/^NEEDS_INPUT:\s*(.+)$/m);
  let summary = input.fallbackSummary ?? "";
  const summaryAt = lastText.indexOf("SUMMARY:");
  if (summaryAt >= 0) {
    summary = lastText
      .slice(summaryAt + "SUMMARY:".length)
      .replace(/^NEEDS_INPUT:.*$/gm, "")
      .trim();
  } else if (lastText.trim()) {
    summary = lastText.trim();
  }
  summary = summary.slice(0, 1500);

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  for (const item of input.events) {
    if (item.event.t !== "step" || item.event.phase !== "finish") continue;
    if (item.event.tokens?.input) {
      inputTokens += item.event.tokens.input;
      sawUsage = true;
    }
    if (item.event.tokens?.output) {
      outputTokens += item.event.tokens.output;
      sawUsage = true;
    }
    if (item.event.costUsd) {
      costUsd += item.event.costUsd;
      sawUsage = true;
    }
  }

  const blocked = input.events
    .filter((item) => item.event.t === "permission_rejected")
    .map((item) =>
      item.event.t === "permission_rejected" ? `${item.event.permission} ${item.event.detail}`.trim() : "",
    )
    .filter(Boolean);

  const started = input.startedAt ? Date.parse(input.startedAt) : Date.parse(input.endedAt);
  const durationS = Math.max(0, Math.round((Date.parse(input.endedAt) - started) / 1000));

  return {
    status:
      questionMatch && input.status !== "failed" && input.status !== "cancelled"
        ? "needs_input"
        : input.status,
    summary: summary || input.fallbackSummary || "OpenCode finished without a summary.",
    question: questionMatch?.[1]?.trim(),
    filesChanged: input.files,
    checks: input.checks,
    blockedActions: blocked.slice(0, 5),
    usage: sawUsage ? { inputTokens, outputTokens, costUsd } : undefined,
    durationS,
    branch: input.branch,
  };
}

export function recentLines(events: StoredEvent[]): string[] {
  const lines: string[] = [];
  for (const item of events) {
    const event = item.event;
    if (event.t === "tool") {
      const summary = event.summary || event.path || "";
      const name = event.name.toLowerCase();
      let line = `${event.name} ${summary}`.trim();
      if (name.includes("bash") || name.includes("shell") || name === "run")
        line = `Ran ${summary || event.name}`;
      else if (name.includes("write") || name.includes("edit") || name.includes("apply"))
        line = `Edited ${summary || event.path || event.name}`;
      else if (name.includes("read")) line = `Read ${summary || event.path || event.name}`;
      lines.push(line.replace(/\s+/g, " ").slice(0, 120));
    } else if (event.t === "text") {
      const first = event.text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("SUMMARY:"));
      if (first) lines.push(first.trim().slice(0, 120));
    }
  }
  return lines.slice(-5);
}

export function phaseOf(events: StoredEvent[]): string {
  const lastTool = [...events].reverse().find((item) => item.event.t === "tool");
  if (lastTool?.event.t !== "tool") return events.length ? "working" : "starting";
  const name = lastTool.event.name.toLowerCase();
  if (name.includes("write") || name.includes("edit")) return "editing files";
  if (name.includes("bash") || name.includes("shell")) return "running commands";
  return "working";
}
