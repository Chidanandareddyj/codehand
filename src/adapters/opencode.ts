import { getUnavailableModels } from "../core/agentstate.js";
import { runCaptured } from "../core/proc.js";
import { redact } from "../core/redact.js";
import { buildChildEnv } from "../core/secrets.js";
import type { ErrorKind, NormalizedEvent } from "../core/types.js";
import type {
  AdapterAuthStatus,
  AdapterFailure,
  AdapterFailureInput,
  AgentAdapter,
  LoginMethod,
} from "./types.js";

const PROVIDER_ENVS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
];

const TESTED_MINORS = ["2.3", "2.4"];
export const FREE_MODEL = "opencode/big-pickle";

interface CacheEntry<T> {
  at: number;
  value: T;
}

let detectCache: CacheEntry<Awaited<ReturnType<AgentAdapter["detect"]>>> | null = null;
let authCache: CacheEntry<AdapterAuthStatus> | null = null;
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
  if (!TESTED_MINORS.some((minor) => version.startsWith(`${minor}.`))) {
    return `OpenCode ${version} is outside the tested 2.3.x–2.4.x range. It may still work.`;
  }
  return undefined;
}

/** Classify raw error or stderr text into a normalized ErrorKind. */
export function classifyTextError(text: string): ErrorKind {
  const lower = text.toLowerCase();
  if (/provider\.free-limit|free[-_ ]limit|quota|insufficient|billing|usage limit/.test(lower)) {
    return "quota";
  }
  if (
    /model unavailable|model_unavailable|model not found|unknown model|invalid model|model is not available/.test(
      lower,
    )
  ) {
    return "model_unavailable";
  }
  if (/429|rate[-_ ]limit|too many requests/.test(lower)) {
    return "rate_limit";
  }
  if (/401|403|unauthorized|not authenticated|no provider|missing api key|invalid api key/.test(lower)) {
    return "auth";
  }
  if (/enotfound|econnreset|etimedout|network|fetch failed|econnrefused/.test(lower)) {
    return "network";
  }
  if (/session not found/.test(lower)) {
    return "bad_input";
  }
  return "unknown";
}

/** Classify a failed OpenCode run from error events, spawn/signal status, and stderr tail. */
export function classifyFailure(input: AdapterFailureInput): AdapterFailure {
  const lastError = input.errorEvents.at(-1);
  if (lastError) {
    const kind = lastError.kind;
    return {
      kind,
      message: redact(lastError.message).trim().slice(-500) || "OpenCode error.",
      isProviderError: kind === "quota" || kind === "rate_limit",
    };
  }
  if (input.spawnErrorCode === "ENOENT") {
    return {
      kind: "not_installed",
      message: "OpenCode could not be started. Is it installed and on PATH?",
    };
  }
  if (input.spawnErrorCode) {
    return {
      kind: "crashed",
      message: `Failed to start OpenCode (${input.spawnErrorCode}).`,
    };
  }
  if (input.signal) {
    return {
      kind: "crashed",
      message: `OpenCode was terminated by signal ${input.signal}.`,
    };
  }
  const text = `${input.stderrTail}\nexit:${input.exitCode ?? ""}`;
  const kind = classifyTextError(text);
  const message =
    redact(input.stderrTail).trim().slice(-500) ||
    `OpenCode exited with code ${input.exitCode ?? "unknown"}.`;
  return {
    kind,
    message,
    isProviderError: kind === "quota" || kind === "rate_limit",
  };
}

/** Return true if the given model (or default omitted model) is a free-tier model. */
export function isFreeModel(model?: string): boolean {
  if (!model) return true;
  return (
    model === FREE_MODEL || model.endsWith("-free") || model.endsWith(":free") || model.endsWith("/free")
  );
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
  if (!trimmed.startsWith("{")) {
    const permission = trimmed.match(/^permission requested:\s*([^\s(]+)\s*(?:\(([^)]*)\))?/i);
    if (permission) {
      return [
        {
          t: "permission_rejected",
          permission: permission[1] ?? "unknown",
          detail: permission[2] ?? "",
        },
      ];
    }
    return [];
  }
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
    const text = textOf(part?.text ?? parsed.text).slice(-20_000);
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
    const errorType = textOf(error?.type ?? error?.code ?? error?.name);
    const rawMessage = textOf(
      data?.message ??
        data?.error ??
        error?.message ??
        parsed.message ??
        (typeof parsed.error === "string" ? parsed.error : ""),
    );
    let message = rawMessage.trim();
    if (!message) {
      if (errorType === "provider.free-limit") {
        message = "Free tier quota limit reached (provider.free-limit).";
      } else if (errorType) {
        message = errorType;
      } else {
        message = "OpenCode error";
      }
    } else if (errorType && !message.toLowerCase().includes(errorType.toLowerCase())) {
      message = `${message} (${errorType})`;
    }
    const classifySource = `${errorType} ${rawMessage} ${message}`.trim();
    events.push({
      t: "error",
      kind: classifyTextError(classifySource),
      message: message.slice(0, 500),
    });
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

function buildAuthStatus(
  signedInProviders: string[],
  envProviders: string[],
  diagnostic?: string,
): AdapterAuthStatus {
  const signedIn = [...new Set(signedInProviders)];
  const envOnly = [...new Set(envProviders)];
  if (signedIn.length > 0) {
    return {
      state: "ready",
      providers: [...signedIn, ...envOnly.map((e) => `${e} (env)`)],
      signedInProviders: signedIn,
      envProviders: envOnly,
      ...(diagnostic ? { detail: diagnostic.slice(0, 300) } : {}),
    };
  }
  if (envOnly.length > 0) {
    const baseDetail = `Environment API key(s) detected (${envOnly.join(", ")}), not a saved login. Free models such as ${FREE_MODEL} are used by default unless you pick a model.`;
    return {
      state: "env_only",
      providers: envOnly.map((e) => `${e} (env)`),
      signedInProviders: [],
      envProviders: envOnly,
      detail: diagnostic ? `${baseDetail} (${diagnostic.slice(0, 100)})` : baseDetail,
    };
  }
  const baseDetail = `No login saved. Free models such as ${FREE_MODEL} work without an account.`;
  return {
    state: "anonymous",
    providers: ["opencode (free, no account)"],
    signedInProviders: [],
    envProviders: [],
    detail: diagnostic ? `${baseDetail} (${diagnostic.slice(0, 120)})` : baseDetail,
  };
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
      const value = buildAuthStatus([], fromEnv, listed.stderr.trim() || "opencode auth list failed");
      authCache = { at: Date.now(), value };
      return value;
    }
    const signedInProviders: string[] = [];
    const envProviders: string[] = [...fromEnv];
    try {
      const parsed = JSON.parse(listed.stdout) as unknown;
      if (!Array.isArray(parsed)) {
        const value = buildAuthStatus([], fromEnv, "opencode auth list did not return a JSON array");
        authCache = { at: Date.now(), value };
        return value;
      }
      for (const entry of parsed) {
        const record = asRecord(entry);
        const connections = record?.connections;
        if (!record || !Array.isArray(connections) || connections.length === 0) continue;
        const providerId = textOf(record.id || record.name);
        for (const rawConn of connections) {
          const conn = asRecord(rawConn);
          if (!conn) continue;
          const connType = textOf(conn.type).toLowerCase();
          if (connType === "env" || connType === "environment") {
            const envName = textOf(conn.name) || providerId;
            if (envName) envProviders.push(envName);
          } else if (connType === "credential" || connType === "") {
            if (providerId) signedInProviders.push(providerId);
          } else {
            if (providerId) signedInProviders.push(providerId);
          }
        }
      }
    } catch {
      const value = buildAuthStatus([], fromEnv, "opencode auth list did not return JSON");
      authCache = { at: Date.now(), value };
      return value;
    }
    const value = buildAuthStatus(signedInProviders, envProviders);
    authCache = { at: Date.now(), value };
    return value;
  },

  async listModels() {
    const ttl = cacheTtl();
    const unavailable = getUnavailableModels("opencode");
    let rawModels: string[];
    if (modelCache && Date.now() - modelCache.at < ttl) {
      rawModels = modelCache.value;
    } else {
      const listed = await opencode(["models", "--standalone", "--log-level", "error"], 25_000);
      const parsed: string[] = [];
      const seen = new Set<string>();
      for (const rawLine of listed.stdout.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const id = parts[0] ?? "";
        if (!id.includes("/")) continue;
        const rest = parts.slice(1).join(" ").toLowerCase();
        if (/\b(unavailable|deprecated|disabled)\b/.test(rest)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        parsed.push(id);
      }
      rawModels = parsed;
      modelCache = { at: Date.now(), value: rawModels };
    }
    const filtered = rawModels.filter((model) => !(model in unavailable));
    if (!(FREE_MODEL in unavailable) && !filtered.includes(FREE_MODEL)) {
      filtered.unshift(FREE_MODEL);
    }
    return filtered.slice(0, 15);
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
  isFreeModel,
};

export function clearAdapterCache(): void {
  detectCache = null;
  authCache = null;
  modelCache = null;
}
