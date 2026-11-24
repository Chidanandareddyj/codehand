import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listJobs } from "../src/core/jobstore.js";
import { killTree } from "../src/core/proc.js";

const fake = fileURLToPath(new URL("./fake-opencode.mjs", import.meta.url));

export function isolate(): { root: string; home: string; work: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codehand-"));
  const home = path.join(root, "state");
  const work = path.join(root, "work");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  process.env.CODEHAND_HOME = home;
  process.env.CODEHAND_WORK = work;
  return { root, home, work };
}

export function useFake(scenario = "done"): void {
  process.env.CODEHAND_OPENCODE_BIN = process.execPath;
  process.env.CODEHAND_OPENCODE_PRE_ARGS = fake;
  process.env.FAKE_OC_SCENARIO = scenario;
}

export function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "codehand@example.com"]);
  git(["config", "user.name", "codehand"]);
  fs.writeFileSync(path.join(dir, "README.md"), "sample\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
}

export function stopJobs(): void {
  if (!process.env.CODEHAND_HOME) return;
  try {
    for (const job of listJobs()) {
      killTree(job.pid);
      killTree(job.opencodePid);
    }
  } catch {
    /* home may already be gone */
  }
}
