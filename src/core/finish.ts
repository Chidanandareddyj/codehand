import fs from "node:fs";
import { jobDir, nowIso } from "./config.js";
import { listJobs, readJob, updateJob } from "./jobstore.js";
import { reconcile } from "./jobs.js";
import { killTree } from "./proc.js";
import { err, isTerminal, ok, type Result } from "./types.js";
import { commitWorktree, hasChanges, mergeBranch, removeWorktree, withRepoLock } from "./workspace.js";

export type FinishAction = "cancel" | "keep" | "commit" | "merge" | "discard";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function finishTask(input: {
  taskId: string;
  action: FinishAction;
  message?: string;
  confirm?: boolean;
}): Promise<Result<{ action: FinishAction; branch: string; commit?: string }>> {
  const job = readJob(input.taskId);
  if (!job) return err("bad_input", `Unknown task ${input.taskId}.`);
  if ((input.action === "merge" || input.action === "discard") && input.confirm !== true) {
    return err("bad_input", `Ask the user to confirm before ${input.action}.`);
  }

  if (input.action === "cancel") {
    if (job.status !== "running" && job.status !== "queued" && job.status !== "needs_input") {
      return err("bad_input", `Cannot cancel a task that is ${job.status}.`);
    }
    await updateJob(job.id, (current) => ({ ...current, cancelRequested: true }));
    if (job.status === "queued" || job.status === "needs_input") {
      await updateJob(job.id, (current) => ({
        ...current,
        status: "cancelled",
        endedAt: nowIso(),
        pid: undefined,
      }));
      return ok({ action: "cancel", branch: job.branch });
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = readJob(job.id);
      if (current && isTerminal(current.status)) return ok({ action: "cancel", branch: job.branch });
      await sleep(200);
    }
    const latest = readJob(job.id);
    killTree(latest?.pid);
    killTree(latest?.opencodePid);
    await updateJob(job.id, (current) => {
      if (isTerminal(current.status)) return current;
      return {
        ...current,
        status: "cancelled",
        endedAt: nowIso(),
        pid: undefined,
        error: { kind: "unknown", message: "Cancelled." },
      };
    });
    return ok({ action: "cancel", branch: job.branch });
  }

  if (input.action === "keep") return ok({ action: "keep", branch: job.branch });

  const message = input.message?.trim() || `codehand: ${job.promptPreview}`;
  if (input.action === "commit") {
    const commit = await commitWorktree(job.workdir, message);
    if (!commit.ok) return commit;
    return ok({ action: "commit", branch: job.branch, commit: commit.value });
  }

  if (input.action === "merge") {
    return withRepoLock(job.repo.root, async () => {
      if (await hasChanges(job.workdir)) {
        const commit = await commitWorktree(job.workdir, message);
        if (!commit.ok) return commit;
      }
      const merged = await mergeBranch(job.repo.root, job.branch, message);
      if (!merged.ok) return merged;
      return ok({ action: "merge" as const, branch: job.branch });
    });
  }

  if (job.status === "running" || job.status === "queued") {
    await finishTask({ ...input, action: "cancel", confirm: true });
  }
  const removed = await removeWorktree(job.repo.root, job.workdir, job.branch);
  if (!removed.ok) return removed;
  await updateJob(job.id, (current) => ({ ...current, cleaned: true }));
  return ok({ action: "discard", branch: job.branch });
}

export async function gc(days = 7): Promise<{ removed: string[] }> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const job of listJobs()) {
    await reconcile(job.id);
    const current = readJob(job.id);
    if (!current || !isTerminal(current.status) || current.cleaned) continue;
    const ended = Date.parse(current.endedAt ?? current.updatedAt);
    if (Number.isNaN(ended) || ended > cutoff) continue;
    await removeWorktree(current.repo.root, current.workdir, current.branch);
    fs.rmSync(jobDir(current.id), { recursive: true, force: true });
    removed.push(current.id);
  }
  return { removed };
}
