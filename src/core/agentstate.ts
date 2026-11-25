import path from "node:path";
import { codehandHome } from "./config.js";
import { atomicWriteJson, readJson } from "./store.js";

export const DEFAULT_FREE_QUOTA_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_UNAVAILABLE_MODEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface AgentHealthEntry {
  at: string;
  reason: string;
  expiresAt: string;
}

export interface AgentHealthState {
  freeQuotaExhausted?: AgentHealthEntry;
  unavailableModels?: Record<string, AgentHealthEntry>;
}

interface AgentStateFile {
  version: 1;
  agents: Record<string, AgentHealthState>;
}

export function agentStatePath(): string {
  return path.join(codehandHome(), "agent-state.json");
}

function isActiveEntry(entry: unknown, nowMs: number): entry is AgentHealthEntry {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (
    typeof record.at !== "string" ||
    typeof record.reason !== "string" ||
    typeof record.expiresAt !== "string"
  ) {
    return false;
  }
  const expiresMs = Date.parse(record.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > nowMs;
}

function readAgentStateFile(): AgentStateFile {
  const raw = readJson<unknown>(agentStatePath());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 1, agents: {} };
  }
  const record = raw as Record<string, unknown>;
  const rawAgents = record.agents;
  if (!rawAgents || typeof rawAgents !== "object" || Array.isArray(rawAgents)) {
    return { version: 1, agents: {} };
  }
  const agents: Record<string, AgentHealthState> = {};
  for (const [agentKey, value] of Object.entries(rawAgents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const state = value as Record<string, unknown>;
    const normalized: AgentHealthState = {};
    if (state.freeQuotaExhausted && typeof state.freeQuotaExhausted === "object") {
      normalized.freeQuotaExhausted = state.freeQuotaExhausted as AgentHealthEntry;
    }
    if (
      state.unavailableModels &&
      typeof state.unavailableModels === "object" &&
      !Array.isArray(state.unavailableModels)
    ) {
      normalized.unavailableModels = {
        ...(state.unavailableModels as Record<string, AgentHealthEntry>),
      };
    }
    agents[agentKey] = normalized;
  }
  return { version: 1, agents };
}

function writeAgentStateFile(state: AgentStateFile): void {
  atomicWriteJson(agentStatePath(), state);
}

function createHealthEntry(reason: string, ttlMs: number): AgentHealthEntry {
  const now = Date.now();
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  return {
    at: new Date(now).toISOString(),
    reason,
    expiresAt: new Date(now + safeTtl).toISOString(),
  };
}

/** Record that an agent's free tier quota is temporarily exhausted. */
export function recordFreeQuotaExhausted(
  agent: string,
  reason: string,
  ttlMs = DEFAULT_FREE_QUOTA_TTL_MS,
): AgentHealthEntry {
  const state = readAgentStateFile();
  const entry = createHealthEntry(reason, ttlMs);
  const current = state.agents[agent] ?? {};
  state.agents[agent] = { ...current, freeQuotaExhausted: entry };
  writeAgentStateFile(state);
  return entry;
}

/** Clear the recorded free tier quota exhaustion for an agent. */
export function clearFreeQuotaExhausted(agent: string): void {
  const state = readAgentStateFile();
  const current = state.agents[agent];
  if (!current?.freeQuotaExhausted) return;
  const { freeQuotaExhausted: _, ...rest } = current;
  state.agents[agent] = rest;
  writeAgentStateFile(state);
}

/** Return the active free tier quota exhaustion entry for an agent, or null if missing or expired. */
export function getFreeQuotaExhausted(agent: string): AgentHealthEntry | null {
  const state = readAgentStateFile();
  const entry = state.agents[agent]?.freeQuotaExhausted;
  if (!isActiveEntry(entry, Date.now())) return null;
  return entry;
}

/** Record that a specific model is temporarily unavailable for an agent. */
export function recordUnavailableModel(
  agent: string,
  model: string,
  reason: string,
  ttlMs = DEFAULT_UNAVAILABLE_MODEL_TTL_MS,
): AgentHealthEntry {
  const state = readAgentStateFile();
  const entry = createHealthEntry(reason, ttlMs);
  const current = state.agents[agent] ?? {};
  const unavailableModels = { ...(current.unavailableModels ?? {}), [model]: entry };
  state.agents[agent] = { ...current, unavailableModels };
  writeAgentStateFile(state);
  return entry;
}

/** Clear a recorded unavailable model for an agent. */
export function clearUnavailableModel(agent: string, model: string): void {
  const state = readAgentStateFile();
  const current = state.agents[agent];
  if (!current?.unavailableModels || !(model in current.unavailableModels)) return;
  const { [model]: _, ...remaining } = current.unavailableModels;
  state.agents[agent] = { ...current, unavailableModels: remaining };
  writeAgentStateFile(state);
}

/** Return active (non-expired) unavailable model entries keyed by model id for an agent. */
export function getUnavailableModels(agent: string): Record<string, AgentHealthEntry> {
  const state = readAgentStateFile();
  const models = state.agents[agent]?.unavailableModels;
  if (!models) return {};
  const now = Date.now();
  const active: Record<string, AgentHealthEntry> = {};
  for (const [model, entry] of Object.entries(models)) {
    if (isActiveEntry(entry, now)) {
      active[model] = entry;
    }
  }
  return active;
}

/** No-op cache reset helper (state is read directly from disk to stay isolated per CODEHAND_HOME). */
export function clearAgentStateCache(): void {}
