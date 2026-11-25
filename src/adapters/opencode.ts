import { runCaptured } from "../core/proc.js";
import { buildChildEnv } from "../core/secrets.js";
import type { ErrorKind, NormalizedEvent } from "../core/types.js";
import type { AgentAdapter, LoginMethod } from "./types.js";

const PROVIDER_ENVS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
];

const TESTED_MINOR = "2.3";
export const FREE_MODEL = "opencode/big-pickle";

interface CacheEntry<T> {
  at: number;
  value: T;
}

let detectCache: CacheEntry<Awaited<ReturnType<AgentAdapter["detect"]>>> | null = null;
let authCache: CacheEntry<Awaited<ReturnType<AgentAdapter["authStatus"]>>> | null = null;
let modelCache: CacheEntry<string[]> | null = null;

function cacheTtl(): number {
  if (process.env.CODEHAND_CACHE_MS !== undefined) return Number(process.env.CODEHAND_CACHE_MS) || 0;
  return 60_000;
}

function bin(): { cmd: string; base: string[] } {
  if (process.env.CODEHAND_OPENCODE_BIN) {
    const pre = process.env.CODEHAND_OPENCODE_PRE_ARGS ?? "";
    return { cmd: process.env.CODEHAND_OPENCODE_BIN, base: pre.split("|").filter(Boolean) };
  }
  return { cmd: "opencode", base: [] };
}

function versionWarning(version: string | undefined): string | undefined {
  if (!version) return "OpenCode is installed, but its version could not be read.";
  if (!version.startsWith(`${TESTED_MINOR}.`)) {
    return `OpenCode ${version} is outside the tested ${TESTED_MINOR}.x range. It may still work.`;
  }
  return undefined;
}

export function classifyFailure(exitCode: number | null, stderrTail: string): ErrorKind {
  const text = `${stderrTail}\nexit:${exitCode ?? ""}`.toLowerCase();
  if (/401|unauthorized|not authenticated|no provider|missing api key|invalid api key/.test(text))
    return "auth";
  if (/429|rate limit/.test(text)) return "rate_limit";
  if (/quota|insufficient|billing|usage limit/.test(text)) return "quota";
  if (/enotfound|econnreset|etimedout|network|fetch failed/.test(text)) return "network";
  if (/session not found/.test(text)) return "bad_input";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseLine(line: string): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const permission = trimmed.match(/permission requested:\s*([^\s(]+)\s*(?:\(([^)]*)\))?/i);
  if (permission) {
    return [
      {
        t: "permission_rejected",
        permission: permission[1] ?? "unknown",
        detail: permission[2] ?? "",
      },
    ];
  }
  if (!trimmed.startsWith("{")) return [];
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed) as unknown;
    const record = asRecord(value);
    if (!record) return [];
    parsed = record;
  } catch {
    return [];
  }
  const events: NormalizedEvent[] = [];
  const sessionId = textOf(parsed.sessionID || parsed.sessionId);
  if (sessionId) events.push({ t: "session", sessionId });
  const type = textOf(parsed.type);
  const part = asRecord(parsed.part);
  if (type === "step_start") events.push({ t: "step", phase: "start" });
  if (type === "step_finish") {
    const tokens = asRecord(part?.tokens) ?? asRecord(parsed.tokens);
    const input = numberOf(tokens?.input ?? tokens?.inputTokens);
    const output = numberOf(tokens?.output ?? tokens?.outputTokens);
    const cost = numberOf(part?.cost ?? parsed.cost);
    events.push({
      t: "step",
      phase: "finish",
      tokens: input !== undefined || output !== undefined ? { input, output } : undefined,
      costUsd: cost,
    });
  }
  if (type === "text") {
    const text = textOf(part?.text ?? parsed.text).slice(0, 20_000);
    if (text.trim()) events.push({ t: "text", text });
  }
  if (type === "tool_use" || type === "tool") {
    const state = asRecord(part?.state);
    const name = textOf(part?.tool ?? parsed.tool ?? "tool");
    const statusText = textOf(state?.status ?? parsed.status);
    const input = asRecord(state?.input) ?? asRecord(parsed.input);
    const summary = toolSummary(input).slice(0, 120);
    const file = textOf(input?.filePath ?? input?.file ?? input?.path);
    events.push({
      t: "tool",
      name,
      status: statusText === "error" ? "error" : "completed",
      summary,
      path: file || undefined,
    });
  }
  if (type === "error") {
    const error = asRecord(parsed.error);
    const data = asRecord(error?.data);
    const message =
      textOf(data?.message ?? error?.message ?? error?.name ?? parsed.error) || "OpenCode error";
    events.push({ t: "error", kind: classifyFailure(null, message), message: message.slice(0, 500) });
  }
  return events;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolSummary(input: Record<string, unknown> | null): string {
  if (!input) return "";
  const file = textOf(input.filePath ?? input.file ?? input.path);
  const command = textOf(input.command ?? input.cmd);
  return file || command || "";
}

async function opencode(
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { cmd, base } = bin();
  return runCaptured(cmd, [...base, ...args], { timeoutMs, env: buildChildEnv() });
}

export const openCodeAdapter: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",

  async detect() {
    const ttl = cacheTtl();
    if (detectCache && Date.now() - detectCache.at < ttl) return detectCache.value;
    const result = await opencode(["--version"], 15_000);
    const match = `${result.stdout}\n${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
    const value =
      result.code === 0 || match
        ? {
            installed: true,
            version: match?.[1],
            path: bin().cmd,
            warning: versionWarning(match?.[1]),
          }
        : { installed: false as const };
    detectCache = { at: Date.now(), value };
    return value;
  },

  async authStatus() {
    const ttl = cacheTtl();
    if (authCache && Date.now() - authCache.at < ttl) return authCache.value;
    const env = buildChildEnv();
    const fromEnv = PROVIDER_ENVS.filter((name) => Boolean(env[name]));
    const listed = await opencode(
      ["auth", "list", "--format", "json", "--standalone", "--log-level", "error"],
      25_000,
    );
    if (listed.code !== 0 && !listed.stdout.trim()) {
      const value = fromEnv.length
        ? {
            state: "ready" as const,
            providers: fromEnv.map((name) => `${name} (env)`),
            detail: (listed.stderr || "opencode auth list failed").slice(0, 300),
          }
        : {
            state: "anonymous" as const,
            providers: ["opencode (free, no account)"],
            detail: (listed.stderr || `No login saved. Free models such as ${FREE_MODEL} work without an account.`).slice(
              0,
              300,
            ),
          };
      authCache = { at: Date.now(), value };
      return value;
    }
    let providers: string[] = [];
    try {
      const parsed = JSON.parse(listed.stdout) as unknown;
      if (Array.isArray(parsed)) {
        providers = parsed
          .map((entry) => {
            const record = asRecord(entry);
            const connections = record?.connections;
            if (!record || !Array.isArray(connections) || connections.length === 0) return "";
            return textOf(record.id || record.name);
          })
          .filter(Boolean);
      }
    } catch {
      const value = fromEnv.length
        ? { state: "ready" as const, providers: fromEnv, detail: "opencode auth list did not return JSON." }
        : {
            state: "anonymous" as const,
            providers: ["opencode (free, no account)"],
            detail: "opencode auth list did not return JSON. Free models still work with no account.",
          };
      authCache = { at: Date.now(), value };
      return value;
    }
    const all = [...providers, ...fromEnv.map((name) => `${name} (env)`)];
    const value = all.length
      ? { state: "ready" as const, providers: all }
      : {
          state: "anonymous" as const,
          providers: ["opencode (free, no account)"],
          detail: `No login saved. Free models such as ${FREE_MODEL} work without an account.`,
        };
    authCache = { at: Date.now(), value };
    return value;
  },

  async listModels() {
    const ttl = cacheTtl();
    if (modelCache && Date.now() - modelCache.at < ttl) return modelCache.value;
    const listed = await opencode(["models", "--standalone", "--log-level", "error"], 25_000);
    const models = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter((line) => line.includes("/"));
    if (!models.includes(FREE_MODEL)) models.unshift(FREE_MODEL);
    const value = models.slice(0, 15);
    modelCache = { at: Date.now(), value };
    return value;
  },

  installCommand() {
    return { cmd: "npm", args: ["i", "-g", "@opencode/cli"] };
  },

  loginCommand(method: LoginMethod) {
    const { cmd, base } = bin();
    if (method === "chatgpt_device") {
      return {
        cmd,
        args: [...base, "auth", "login", "openai", "--method", "chatgpt-headless", "--standalone"],
      };
    }
    if (method === "github_copilot") {
      return { cmd, args: [...base, "auth", "login", "github-copilot", "--standalone"] };
    }
    return null;
  },

  preamble(workdir: string, branch: string) {
    return [
      `You are working in a git worktree at ${workdir} on branch ${branch}. Edit files only inside it.`,
      "Leave committing to the user. When you finish, end your reply with:",
      "SUMMARY:",
      "- 3 to 6 short lines on what you changed and why",
      "If you need a decision from the user before you can continue, stop and end your reply with one line:",
      "NEEDS_INPUT: <your question>",
      "Task:",
      "",
    ].join("\n");
  },

  buildRun(opts) {
    const { cmd, base } = bin();
    const args = [
      ...base,
      "run",
      "--format",
      "json",
      "--standalone",
      "--log-level",
      "error",
      "--agent",
      opts.mode === "plan" ? "plan" : "build",
    ];
    if (opts.sessionId) args.push("--session", opts.sessionId);
    else args.push("--archived");
    if (opts.model) args.push("--model", opts.model);
    if (opts.mode === "edit") args.push("--auto");
    const tooLong = opts.message.length > 7000;
    if (tooLong) {
      args.push("--file", opts.promptPath, "Follow the attached file. It is the full task.");
    } else {
      args.push(opts.message);
    }
    return { cmd, args, env: {} };
  },

  parseLine,
  classifyFailure,
};

export function clearAdapterCache(): void {
  detectCache = null;
  authCache = null;
  modelCache = null;
}
