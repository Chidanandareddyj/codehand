import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJob } from "../../src/core/jobstore.js";
import { checkTask, replyTask, startTask } from "../../src/core/jobs.js";
import { finishTask } from "../../src/core/finish.js";
import { installSkill } from "../../src/core/skill.js";
import { nowIso } from "../../src/core/config.js";
import { initRepo, isolate, stopJobs, useFake } from "../support.js";

afterEach(() => {
  stopJobs();
  delete process.env.CODEHAND_IDLE_MS;
  delete process.env.CODEHAND_MAX_RUNNING;
  delete process.env.CODEHAND_CRASH_MS;
  delete process.env.FAKE_OC_AUTH;
  delete process.env.FAKE_OC_CONCURRENCY_FILE;
});

async function repo(): Promise<string> {
  const { root } = isolate();
  const dir = path.join(root, "repo");
  initRepo(dir);
  useFake("done");
  process.env.FAKE_OC_RECORD = path.join(root, "argv.jsonl");
  return dir;
}

describe("task lifecycle", () => {
  it("finishes an edit, then continues the same session", async () => {
    const dir = await repo();
    const started = await startTask({ prompt: "add a hello helper", repo: dir, waitSeconds: 25 });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.kind !== "task") throw new Error("expected a task");
    expect(started.value.job.status).toBe("done");
    expect(started.value.result?.filesChanged.some((file) => file.path === "hello.ts")).toBe(true);
    expect(fs.existsSync(path.join(started.value.job.workdir, "hello.ts"))).toBe(true);

    process.env.FAKE_OC_SCENARIO = "needs_input";
    const asked = await replyTask({
      taskId: started.value.job.id,
      message: "make it smaller",
      waitSeconds: 25,
    });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.value.job.status).toBe("needs_input");
    expect(asked.value.result?.question).toContain("async");

    process.env.FAKE_OC_SCENARIO = "done";
    const again = await replyTask({
      taskId: started.value.job.id,
      message: "yes, keep it sync",
      waitSeconds: 25,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.job.status).toBe("done");
    const recorded = fs.readFileSync(process.env.FAKE_OC_RECORD ?? "", "utf8");
    expect(recorded).toContain("ses_test");
    expect(recorded).toContain("--auto");
  }, 60_000);

  it("uses plan mode without auto-approve", async () => {
    const dir = await repo();
    const started = await startTask({
      prompt: "what is in the readme?",
      repo: dir,
      mode: "plan",
      waitSeconds: 25,
    });
    expect(started.ok).toBe(true);
    const recorded = fs.readFileSync(process.env.FAKE_OC_RECORD ?? "", "utf8");
    expect(recorded).toContain('"plan"');
    expect(recorded).not.toContain("--auto");
  }, 40_000);

  it("reports auth, rate limit, and permission failures", async () => {
    const dir = await repo();
    process.env.FAKE_OC_AUTH = "[]";
    const unsigned = await startTask({ prompt: "edit", repo: dir, waitSeconds: 5 });
    expect(unsigned.ok).toBe(false);
    if (!unsigned.ok) expect(unsigned.error.kind).toBe("auth");

    delete process.env.FAKE_OC_AUTH;
    process.env.FAKE_OC_SCENARIO = "error_rate";
    const limited = await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 });
    expect(limited.ok).toBe(true);
    if (limited.ok && limited.value.kind === "task") {
      expect(limited.value.job.status).toBe("failed");
      expect(limited.value.job.error?.kind).toBe("rate_limit");
    }

    process.env.FAKE_OC_SCENARIO = "permission";
    const blocked = await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 });
    expect(blocked.ok).toBe(true);
    if (blocked.ok && blocked.value.kind === "task") {
      expect(blocked.value.result?.blockedActions.some((item) => item.includes("bash"))).toBe(true);
    }
  }, 60_000);

  it("cancels a hung run and times out an idle one", async () => {
    const dir = await repo();
    process.env.FAKE_OC_SCENARIO = "hang";
    const hung = await startTask({ prompt: "wait", repo: dir, waitSeconds: 0 });
    expect(hung.ok).toBe(true);
    if (!hung.ok || hung.value.kind !== "task") return;
    const cancelled = await finishTask({ taskId: hung.value.job.id, action: "cancel" });
    expect(cancelled.ok).toBe(true);
    const checked = await checkTask({ taskId: hung.value.job.id, waitSeconds: 5 });
    expect(checked.ok).toBe(true);
    if (checked.ok && checked.value.kind === "task") expect(checked.value.job.status).toBe("cancelled");

    process.env.CODEHAND_IDLE_MS = "800";
    process.env.FAKE_OC_SCENARIO = "hang";
    const idle = await startTask({ prompt: "idle", repo: dir, waitSeconds: 15 });
    expect(idle.ok).toBe(true);
    if (idle.ok && idle.value.kind === "task") expect(idle.value.job.error?.kind).toBe("idle_timeout");
  }, 40_000);

  it("keeps two tasks in separate worktrees and merges one", async () => {
    const dir = await repo();
    process.env.CODEHAND_MAX_RUNNING = "2";
    const first = await startTask({ prompt: "one", repo: dir, waitSeconds: 25 });
    const second = await startTask({ prompt: "two", repo: dir, waitSeconds: 25 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.value.kind !== "task" || second.value.kind !== "task") return;
    expect(first.value.job.workdir).not.toBe(second.value.job.workdir);
    const merged = await finishTask({
      taskId: first.value.job.id,
      action: "merge",
      confirm: true,
      message: "add hello",
    });
    expect(merged.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "hello.ts"), "utf8")).toContain("hello");
    const discarded = await finishTask({ taskId: second.value.job.id, action: "discard", confirm: false });
    expect(discarded.ok).toBe(false);
    const gone = await finishTask({ taskId: second.value.job.id, action: "discard", confirm: true });
    expect(gone.ok).toBe(true);
  }, 60_000);

  it("queues a second task while one is running", async () => {
    const dir = await repo();
    process.env.CODEHAND_MAX_RUNNING = "1";
    process.env.FAKE_OC_SCENARIO = "hang";
    const first = await startTask({ prompt: "one", repo: dir, waitSeconds: 0 });
    const second = await startTask({ prompt: "two", repo: dir, waitSeconds: 0 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok || first.value.kind !== "task" || second.value.kind !== "task") return;
    const deadline = Date.now() + 10_000;
    let leader = first.value.job;
    while (Date.now() < deadline && leader.status === "queued") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const viewed = await checkTask({ taskId: first.value.job.id, waitSeconds: 0 });
      if (viewed.ok && viewed.value.kind === "task") leader = viewed.value.job;
    }
    const follower = await checkTask({ taskId: second.value.job.id, waitSeconds: 0 });
    expect(leader.status).toBe("running");
    if (follower.ok && follower.value.kind === "task") expect(follower.value.job.status).toBe("queued");
    await finishTask({ taskId: first.value.job.id, action: "cancel" });
    await finishTask({ taskId: second.value.job.id, action: "cancel" });
  }, 40_000);

  it("marks a dead runner as crashed", async () => {
    const { root } = isolate();
    const dir = path.join(root, "repo");
    initRepo(dir);
    const id = "t_crashmex";
    const stamp = new Date(Date.now() - 120_000).toISOString();
    createJob({
      id,
      agent: "opencode",
      mode: "edit",
      promptPreview: "crash",
      repo: { input: dir, root: dir, baseBranch: "main", baseCommit: "abc" },
      workdir: path.join(root, "missing"),
      branch: `codehand/${id}`,
      status: "running",
      turn: 1,
      pid: 2_100_000_000,
      heartbeatAt: stamp,
      createdAt: stamp,
      updatedAt: stamp,
    });
    process.env.CODEHAND_CRASH_MS = "1000";
    const checked = await checkTask({ taskId: id, waitSeconds: 0 });
    expect(checked.ok).toBe(true);
    if (checked.ok && checked.value.kind === "task") {
      expect(checked.value.job.status).toBe("failed");
      expect(checked.value.job.error?.kind).toBe("crashed");
    }
  });

  it("redacts secrets from saved events and installs the skill", async () => {
    const dir = await repo();
    fs.writeFileSync(
      path.join(process.env.CODEHAND_HOME ?? "", "secrets.env"),
      "LEAK_KEY=sk-abcdefghijklmnopqrstuv\n",
      { mode: 0o600 },
    );
    process.env.FAKE_OC_SCENARIO = "leak";
    const started = await startTask({ prompt: "leak", repo: dir, waitSeconds: 25 });
    expect(started.ok).toBe(true);
    if (started.ok && started.value.kind === "task") {
      const events = fs.readFileSync(
        path.join(
          process.env.CODEHAND_HOME ?? "",
          "jobs",
          started.value.job.id,
          "turns",
          "1",
          "events.jsonl",
        ),
        "utf8",
      );
      expect(events).not.toContain("sk-abcdefghijklmnopqrstuv");
      expect(events).toContain("[redacted]");
    }
    const skillDir = path.join(dir, "skill");
    const installed = installSkill(skillDir);
    expect(installed.ok).toBe(true);
    if (installed.ok) expect(fs.existsSync(path.join(skillDir, "AGENTS.md"))).toBe(true);
    expect(nowIso()).toContain("T");
  }, 40_000);

  it("refuses to start when OpenCode is missing", async () => {
    const { root } = isolate();
    const dir = path.join(root, "repo");
    initRepo(dir);
    process.env.CODEHAND_OPENCODE_BIN = path.join(root, "missing-opencode");
    delete process.env.CODEHAND_OPENCODE_PRE_ARGS;
    const started = await startTask({ prompt: "edit", repo: dir, waitSeconds: 1 });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error.kind).toBe("not_installed");
  });
});
