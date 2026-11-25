import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import type { LoginMethod } from "../adapters/types.js";
import { openCodeAdapter } from "../adapters/opencode.js";
import { codehandHome, newJobId, secretsPath } from "./config.js";
import { runCaptured } from "./proc.js";
import { buildChildEnv } from "./secrets.js";
import { type AuthState, err, ok, type Result } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function installAgent(): Promise<
  Result<{ installed: boolean; version?: string; pending?: boolean }>
> {
  const command = openCodeAdapter.installCommand();
  const cmd = process.env.CODEHAND_INSTALL_BIN || command.cmd;
  const prefix = (process.env.CODEHAND_INSTALL_PRE_ARGS ?? "").split("|").filter(Boolean);
  const result = await runCaptured(cmd, [...prefix, ...command.args], { timeoutMs: 45_000 });
  if (result.timedOut) {
    return err("timeout", "Install took longer than 45s and was stopped. Run it again.");
  }
  if (result.code !== 0) {
    return err("unknown", (result.stderr || result.stdout || "Install failed.").trim().slice(0, 500));
  }
  const { clearAdapterCache } = await import("../adapters/opencode.js");
  clearAdapterCache();
  const detected = await openCodeAdapter.detect();
  return ok({ installed: detected.installed, version: detected.version });
}

export async function startLogin(
  method: LoginMethod,
): Promise<Result<{ url: string; code: string; loginId: string; detail?: string }>> {
  const command = openCodeAdapter.loginCommand(method);
  if (!command) {
    return err("bad_input", "API key sign-in does not use a browser flow. Use api_key_help.");
  }
  const loginId = `login_${newJobId()}`;
  const dir = path.join(codehandHome(), "logins");
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${loginId}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(command.cmd, command.args, {
    detached: process.platform !== "win32",
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: buildChildEnv(),
  });
  const spawnState: { error: Error | null } = { error: null };
  child.on("error", (error) => {
    spawnState.error = error;
  });
  child.unref();
  fs.closeSync(fd);

  const deadline = Date.now() + 30_000;
  let url = "";
  let code = "";
  while (Date.now() < deadline) {
    if (spawnState.error) break;
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    url = text.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.]+$/, "") ?? url;
    code = text.match(/(?:code|Code)\s*[:：]\s*([A-Z0-9-]{4,})/)?.[1] ?? code;
    if (url && code) break;
    if (child.exitCode !== null && text.trim()) break;
    await sleep(400);
  }
  if (spawnState.error && !url && !code) {
    const errno = (spawnState.error as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      return err("not_installed", "OpenCode could not be started. Is it installed and on PATH?");
    }
    return err("crashed", `Failed to start OpenCode login (${spawnState.error.message}).`);
  }
  fs.writeFileSync(
    path.join(dir, `${loginId}.json`),
    JSON.stringify({ pid: child.pid, method, url, code }, null, 2),
  );
  if (!url && !code) {
    const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().slice(-500) : "";
    return err("auth", tail || "Sign-in did not print a link or code.");
  }
  return ok({
    url,
    code,
    loginId,
    detail: code ? undefined : "A code was not printed yet. Show the link and check again.",
  });
}

export async function checkLogin(): Promise<
  Result<{
    auth: AuthState;
    providers: string[];
    signedInProviders: string[];
    envProviders: string[];
    detail?: string;
  }>
> {
  const { clearAdapterCache } = await import("../adapters/opencode.js");
  clearAdapterCache();
  const auth = await openCodeAdapter.authStatus();
  return ok({
    auth: auth.state,
    providers: auth.providers,
    signedInProviders: auth.signedInProviders,
    envProviders: auth.envProviders,
    ...(auth.detail ? { detail: auth.detail } : {}),
  });
}

export function apiKeyHelp(providerEnv?: string): { envName: string; secretsPath: string } {
  return {
    envName: providerEnv?.trim() || "ANTHROPIC_API_KEY",
    secretsPath: secretsPath(),
  };
}
