import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codehandHome, workRoot } from "./config.js";
import { runCaptured } from "./proc.js";
import { redact } from "./redact.js";
import { withFileLock } from "./store.js";
import { err, ok, type FileChange, type Result } from "./types.js";

async function git(args: string[], cwd?: string, timeoutMs = 60_000): Promise<Result<string>> {
  const result = await runCaptured("git", args, {
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.timedOut) return err("timeout", `git ${args[0]} timed out`);
  if (result.code !== 0) {
    return err("git", (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return ok(result.stdout);
}

function urlDirName(input: string): string {
  const name = path.basename(input).replace(/\.git$/, "") || "repo";
  const hash8 = createHash("sha1").update(input).digest("hex").slice(0, 8);
  return `${name}-${hash8}`;
}

export async function resolveRepo(
  input: string,
  baseBranch?: string,
): Promise<Result<{ input: string; root: string; baseBranch: string; baseCommit: string }>> {
  const isUrl = /^(git@|https?:\/\/|ssh:\/\/)/.test(input) || input.endsWith(".git");
  let root: string;
  if (isUrl) {
    root = path.join(workRoot(), urlDirName(input));
    const gitDir = path.join(root, ".git");
    if (fs.existsSync(gitDir)) {
      const hasHead = await git(["rev-parse", "HEAD"], root);
      if (hasHead.ok) {
        await git(["fetch", "--all", "--prune"], root);
      } else {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    if (!fs.existsSync(gitDir)) {
      fs.mkdirSync(workRoot(), { recursive: true });
      const cloned = await git(["clone", "--", input, root], undefined, 40_000);
      if (!cloned.ok) return cloned;
    }
  } else {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) return err("bad_input", `Repo path does not exist: ${abs}`);
    const top = await git(["rev-parse", "--show-toplevel"], abs);
    if (!top.ok) return err("git", `Not a git repository: ${abs}`);
    root = top.value.trim();
  }

  const hasCommit = await git(["rev-parse", "HEAD"], root);
  if (!hasCommit.ok) return err("git", "The repository has no commits yet.");

  let branch = baseBranch?.trim() ?? "";
  if (!branch) {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    if (!head.ok) return head;
    branch = head.value.trim();
    if (branch === "HEAD") {
      const origin = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
      branch = origin.ok ? origin.value.trim().replace(/^origin\//, "") : "main";
    }
  }
  const commit = await git(["rev-parse", branch], root);
  if (!commit.ok) return err("git", `Base branch not found: ${branch}`);
  return ok({ input, root, baseBranch: branch, baseCommit: commit.value.trim() });
}

export function worktreePath(jobId: string): string {
  return path.join(workRoot(), "wt", jobId);
}

export async function createWorktree(
  root: string,
  jobId: string,
  branch: string,
  baseCommit: string,
): Promise<Result<string>> {
  const dir = worktreePath(jobId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(path.join(dir, ".git"))) return ok(dir);
  const created = await git(["worktree", "add", "-b", branch, dir, baseCommit], root);
  if (created.ok) return ok(dir);
  const reused = await git(["worktree", "add", dir, branch], root);
  if (!reused.ok) return created;
  return ok(dir);
}

export async function computeDiff(
  workdir: string,
  baseCommit: string,
  onlyPath?: string,
): Promise<Result<{ files: FileChange[]; patch: string }>> {
  const added = await git(["add", "-A"], workdir);
  if (!added.ok) return added;
  const nameArgs = ["diff", "--cached", "--name-status", baseCommit];
  const numArgs = ["diff", "--cached", "--numstat", baseCommit];
  const patchArgs = ["diff", "--cached", baseCommit];
  if (onlyPath) {
    for (const args of [nameArgs, numArgs, patchArgs]) args.push("--", onlyPath);
  }
  const names = await git(nameArgs, workdir);
  if (!names.ok) return names;
  const nums = await git(numArgs, workdir);
  if (!nums.ok) return nums;
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of nums.value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addedLines, removedLines, ...rest] = line.split("\t");
    counts.set(rest.join("\t"), {
      added: addedLines === "-" ? 0 : Number(addedLines) || 0,
      removed: removedLines === "-" ? 0 : Number(removedLines) || 0,
    });
  }
  const files: FileChange[] = [];
  for (const line of names.value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const letter = parts[0]?.[0] ?? "M";
    const status: FileChange["status"] = letter === "A" || letter === "D" || letter === "R" ? letter : "M";
    const file = status === "R" ? (parts[2] ?? parts[1] ?? "") : (parts[1] ?? "");
    const count = counts.get(file) ?? { added: 0, removed: 0 };
    if (file) files.push({ path: file, added: count.added, removed: count.removed, status });
  }
  const patch = await git(patchArgs, workdir);
  if (!patch.ok) return patch;
  let text = redact(patch.value);
  if (text.length > 2_000_000) text = `${text.slice(0, 2_000_000)}\n[diff truncated]\n`;
  return ok({ files, patch: text });
}

export async function hasChanges(workdir: string): Promise<boolean> {
  const status = await git(["status", "--porcelain"], workdir);
  return status.ok && status.value.trim().length > 0;
}

export async function commitWorktree(workdir: string, message: string): Promise<Result<string>> {
  const name = await git(["config", "user.name"], workdir);
  const email = await git(["config", "user.email"], workdir);
  if (!name.ok || !name.value.trim() || !email.ok || !email.value.trim()) {
    return err("git", "Git user.name and user.email are not set, so codehand cannot commit.");
  }
  const staged = await git(["add", "-A"], workdir);
  if (!staged.ok) return staged;
  const committed = await git(["commit", "-m", message], workdir);
  if (!committed.ok) {
    if (/nothing to commit/i.test(committed.error.message))
      return err("bad_input", "There is nothing to commit.");
    return committed;
  }
  const rev = await git(["rev-parse", "--short", "HEAD"], workdir);
  return ok(rev.ok ? rev.value.trim() : "committed");
}

export async function mergeBranch(
  root: string,
  branch: string,
  message: string,
  baseBranch?: string,
): Promise<Result<string>> {
  if (baseBranch) {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);
    if (!head.ok) return head;
    const current = head.value.trim();
    if (current !== baseBranch) {
      return err(
        "git",
        `Base repo is on '${current}' instead of '${baseBranch}'. Switch to '${baseBranch}' before merging.`,
      );
    }
  }
  if (await hasChanges(root)) {
    return err("git", "Base repository has uncommitted changes. Commit or stash them before merging.");
  }
  const merged = await git(["merge", "--no-ff", "-m", message, branch], root);
  if (merged.ok) return ok(merged.value.trim() || "merged");
  if (/conflict/i.test(merged.error.message)) {
    await git(["merge", "--abort"], root);
    return err("git", `Merge conflict. Branch ${branch} was kept and the base checkout was left unchanged.`);
  }
  return merged;
}

export async function removeWorktree(root: string, workdir: string, branch: string): Promise<Result<string>> {
  if (fs.existsSync(workdir)) {
    const removed = await git(["worktree", "remove", "--force", workdir], root);
    if (!removed.ok) {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return err("git", removed.error.message || detail);
      }
      await git(["worktree", "prune"], root);
      if (fs.existsSync(workdir)) return removed;
    }
  }
  const deleted = await git(["branch", "-D", branch], root);
  if (!deleted.ok && !/not found/i.test(deleted.error.message)) return deleted;
  return ok("removed");
}

export async function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  let key = path.resolve(root);
  if (process.platform === "win32") key = key.toLowerCase();
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return withFileLock(path.join(codehandHome(), "locks", `repo-${hash}.lock`), fn);
}
