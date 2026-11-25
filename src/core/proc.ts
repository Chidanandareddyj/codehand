import { spawn as nativeSpawn, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  keepTail?: boolean;
}

function takeChunk(current: string, chunk: Buffer, maxBytes: number, keepTail: boolean): string {
  const next = current + chunk.toString("utf8");
  if (next.length <= maxBytes) return next;
  return keepTail ? next.slice(-maxBytes) : next.slice(0, maxBytes);
}

function captureChild(child: ChildProcess, opts: RunOptions): Promise<Captured> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const keepTail = Boolean(opts.keepTail);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = takeChunk(stdout, chunk, maxBytes, keepTail);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = takeChunk(stderr, chunk, maxBytes, keepTail);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      hardKill = setTimeout(() => {
        killTreeHard(child.pid);
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.unref();
        } catch {
          /* already detached from the event loop */
        }
        finish(child.exitCode ?? null);
      }, 500);
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export function runCaptured(cmd: string, args: string[], opts: RunOptions = {}): Promise<Captured> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return captureChild(child, opts);
}

/** Run a shell command string. On Windows this uses cmd.exe without cross-spawn quote mangling. */
export function runShellCommand(cmd: string, opts: RunOptions = {}): Promise<Captured> {
  const env = opts.env ?? process.env;
  const child =
    process.platform === "win32"
      ? nativeSpawn("cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], {
          cwd: opts.cwd,
          env,
          windowsVerbatimArguments: true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : nativeSpawn("sh", ["-c", cmd], {
          cwd: opts.cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
  return captureChild(child, opts);
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
}

export function killTreeHard(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    killTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}
