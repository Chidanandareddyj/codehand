import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { nowIso } from "./config.js";
import { readResult, updateJob, writeResult } from "./jobstore.js";
import { log } from "./log.js";

export function runnerCommand(jobId: string, turn: number): string[] {
  if (process.env.CODEHAND_USE_TSX === "1") {
    const require = createRequire(import.meta.url);
    const tsx = require.resolve("tsx/cli");
    const script = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
    return [process.execPath, tsx, script, "__run", jobId, String(turn)];
  }
  const script = fileURLToPath(new URL("../cli/main.js", import.meta.url));
  return [process.execPath, script, "__run", jobId, String(turn)];
}

export function spawnDetachedRunner(jobId: string, turn: number): number | undefined {
  const argv = runnerCommand(jobId, turn);
  const command = argv[0];
  if (!command) throw new Error("Runner command is empty.");
  const child = spawn(command, argv.slice(1), {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const errno = (error as NodeJS.ErrnoException).code;
    log("error", `runner spawn failed job=${jobId} turn=${turn}: ${message}`);
    const kind = errno === "ENOENT" ? "not_installed" : "crashed";
    void updateJob(jobId, (current) => {
      if (current.status !== "running" && current.status !== "queued") return current;
      return {
        ...current,
        status: "failed",
        endedAt: nowIso(),
        pid: undefined,
        opencodePid: undefined,
        error: { kind, message: message.slice(0, 500) },
      };
    })
      .then((updated) => {
        if (updated.status === "failed" && !readResult(jobId)) {
          writeResult(jobId, {
            status: "failed",
            summary: message.slice(0, 500),
            filesChanged: [],
            blockedActions: [],
            durationS: 0,
            branch: updated.branch,
          });
        }
      })
      .catch(() => undefined);
  });
  child.unref();
  log("info", `spawned runner pid=${child.pid ?? "unknown"} job=${jobId} turn=${turn}`);
  return child.pid;
}
