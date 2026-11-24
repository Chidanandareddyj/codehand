import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, readJson } from "./store.js";
import type { ConfigFile, Limits, Preference } from "./types.js";

const DEFAULT_LIMITS: Limits = { idleMin: 10, totalMin: 45, maxRunning: 2 };
const JOB_ID = /^t_[a-z2-7]{8}$/;

export function codehandHome(): string {
  return process.env.CODEHAND_HOME || path.join(os.homedir(), ".codehand");
}

export function workRoot(): string {
  return process.env.CODEHAND_WORK || path.join(os.homedir(), "codehand-work");
}

export function jobsDir(): string {
  return path.join(codehandHome(), "jobs");
}

export function isJobId(id: string): boolean {
  return JOB_ID.test(id);
}

export function jobDir(id: string): string {
  if (!isJobId(id)) throw new Error(`Invalid task id: ${id}`);
  return path.join(jobsDir(), id);
}

export function secretsPath(): string {
  return path.join(codehandHome(), "secrets.env");
}

export function logPath(): string {
  return path.join(codehandHome(), "codehand.log");
}

export function configPath(): string {
  return path.join(codehandHome(), "config.json");
}

export function ensureHome(): void {
  fs.mkdirSync(jobsDir(), { recursive: true });
  fs.mkdirSync(workRoot(), { recursive: true });
  fs.mkdirSync(path.join(codehandHome(), "logins"), { recursive: true });
  fs.mkdirSync(path.join(codehandHome(), "locks"), { recursive: true });
}

export function loadConfig(): ConfigFile {
  ensureHome();
  const existing = readJson<ConfigFile>(configPath());
  if (!existing) {
    const fresh: ConfigFile = { version: 1, preference: null, limits: { ...DEFAULT_LIMITS } };
    atomicWriteJson(configPath(), fresh);
    return fresh;
  }
  return {
    version: 1,
    preference: existing.preference ?? null,
    limits: { ...DEFAULT_LIMITS, ...(existing.limits ?? {}) },
  };
}

export function savePreference(preference: Preference): Preference {
  const cfg = loadConfig();
  cfg.preference = preference;
  atomicWriteJson(configPath(), cfg);
  return preference;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newJobId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(8);
  let id = "t_";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

function positive(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined || envValue === "") return fallback;
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function runtimeLimits(): {
  idleMs: number;
  totalMs: number;
  maxRunning: number;
  heartbeatMs: number;
  crashMs: number;
  killGraceMs: number;
} {
  const limits = loadConfig().limits;
  return {
    idleMs: positive(process.env.CODEHAND_IDLE_MS, limits.idleMin * 60_000),
    totalMs: positive(process.env.CODEHAND_TOTAL_MS, limits.totalMin * 60_000),
    maxRunning: positive(process.env.CODEHAND_MAX_RUNNING, limits.maxRunning),
    heartbeatMs: positive(process.env.CODEHAND_HEARTBEAT_MS, 10_000),
    crashMs: positive(process.env.CODEHAND_CRASH_MS, 60_000),
    killGraceMs: positive(process.env.CODEHAND_KILL_GRACE_MS, 5_000),
  };
}
