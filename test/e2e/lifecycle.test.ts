import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearAdapterCache, FREE_MODEL } from "../../src/adapters/opencode.js";
import { describeAgents } from "../../src/core/agents.js";
import { nowIso, savePreference } from "../../src/core/config.js";
import { finishTask } from "../../src/core/finish.js";
import { checkTask, replyTask, startTask, type StartOutcome, type TaskView } from "../../src/core/jobs.js";
import { createJob } from "../../src/core/jobstore.js";
import { respondTask } from "../../src/core/respond.js";
import { checkLogin } from "../../src/core/setup.js";
import { installSkill } from "../../src/core/skill.js";
import type { Result } from "../../src/core/types.js";
import { initRepo, isolate, stopJobs, useFake } from "../support.js";

afterEach(() => {
  stopJobs();
  delete process.env.CODEHAND_IDLE_MS;
  delete process.env.CODEHAND_MAX_RUNNING;
  delete process.env.CODEHAND_CRASH_MS;
  delete process.env.FAKE_OC_AUTH;
  delete process.env.FAKE_OC_CONCURRENCY_FILE;
  delete process.env.FAKE_OC_MODELS;
  delete process.env.FAKE_OC_SCENARIO;
  delete process.env.FAKE_OC_SECRET;
  delete process.env.FAKE_OC_VERSION;
});

async function repo(): Promise<string> {
  const { root } = isolate();
  const dir = path.join(root, "repo");
  initRepo(dir);
  useFake("done");
  process.env.FAKE_OC_RECORD = path.join(root, "argv.jsonl");
  return dir;
}

function taskOf(result: Result<StartOutcome> | Result<TaskView>): TaskView {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}: ${result.error.message}`);
  if (result.value.kind !== "task") throw new Error("expected a task, got a preference");
  return result.value;
}

describe("task lifecycle", () => {
  it("finishes an edit, then continues the same session", async () => {
    const dir = await repo();
    const started = await startTask({ prompt: "add a hello helper", repo: dir, waitSeconds: 25 });
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.kind !== "task") throw new Error("expected a task");
    expect(started.value.job.status).toBe("done");
    expect(started.value.result?.filesChanged.some((file) => file.path === "hello.ts")).toBe(true);
    expect(started.value.result?.worktreeState).toBe("uncommitted");
    expect(started.value.result?.workdir).toBeTruthy();
    expect(respondTask(started.value).text).toContain("uncommitted");
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

  it("retains successful check results when a late free limit arrives", async () => {
    const dir = await repo();
    process.env.FAKE_OC_SCENARIO = "late_free_limit";
    clearAdapterCache();
    const task = await startTask({
      prompt: "edit and check",
      repo: dir,
      checks: ["node -e \"console.log('ok')\""],
      waitSeconds: 25,
    });
    expect(task.ok).toBe(true);
    if (task.ok && task.value.kind === "task") {
      expect(task.value.job.status).toBe("done");
      expect(task.value.result?.warning).toBeTruthy();
      expect(task.value.result?.checks?.[0]?.ok).toBe(true);
      expect(task.value.result?.summary).not.toBe("Inspecting files...");
    }
  }, 40_000);

  it("does not reuse previous turn files when a retry fails", async () => {
    const dir = await repo();
    const first = await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 });
    if (!first.ok || first.value.kind !== "task") throw new Error("start failed");
    expect(first.value.job.status).toBe("done");
    process.env.FAKE_OC_SCENARIO = "error_quota_stdout";
    clearAdapterCache();
    const next = await replyTask({ taskId: first.value.job.id, message: "try again", waitSeconds: 25 });
    expect(next.ok).toBe(true);
    if (next.ok && next.value.kind === "task") expect(next.value.job.status).toBe("failed");
  }, 50_000);

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
    const unsigned = await describeAgents();
    expect(unsigned.agents[0]?.auth).toBe("anonymous");
    expect(unsigned.agents[0]?.freeTier).toBe(true);
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

  it("classifies quota errors from stdout and exposes free tier exhaustion", async () => {
    const dir = await repo();
    process.env.FAKE_OC_SCENARIO = "error_quota_stdout";
    clearAdapterCache();
    const failed = await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 });
    expect(failed.ok).toBe(true);
    if (!failed.ok || failed.value.kind !== "task") return;
    expect(failed.value.job.status).toBe("failed");
    expect(failed.value.job.error?.kind).toBe("quota");
    expect(failed.value.job.error?.message.toLowerCase()).toMatch(/free|quota/);
    expect(respondTask(failed.value).envelope.next.toLowerCase()).toMatch(/quota|free/);
    const agent = (await describeAgents()).agents[0];
    expect(agent?.freeTier).toBe(false);
    expect(agent?.freeTierStatus).toBe("exhausted");
    process.env.FAKE_OC_SCENARIO = "done";
    clearAdapterCache();
    await startTask({ prompt: "edit", repo: dir, model: FREE_MODEL, waitSeconds: 25 });
    const recovered = (await describeAgents()).agents[0];
    expect(recovered?.freeTier).toBe(true);
    expect(recovered?.freeTierStatus).toBe("available");
  }, 60_000);

  it("continues a failed session and rejects replies after discard", async () => {
    const dir = await repo();
    process.env.FAKE_OC_SCENARIO = "error_quota_stdout";
    clearAdapterCache();
    const failed = await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 });
    if (!failed.ok || failed.value.kind !== "task") throw new Error("expected failed task");
    expect(failed.value.job.status).toBe("failed");
    expect(failed.value.job.sessionId).toBeTruthy();
    process.env.FAKE_OC_SCENARIO = "done";
    clearAdapterCache();
    const continued = await replyTask({
      taskId: failed.value.job.id,
      message: "continue",
      model: "openai/gpt-test",
      waitSeconds: 25,
    });
    expect(continued.ok).toBe(true);
    expect(fs.readFileSync(process.env.FAKE_OC_RECORD ?? "", "utf8")).toContain("--session");
    const discarded = await finishTask({ taskId: failed.value.job.id, action: "discard", confirm: true });
    expect(discarded.ok).toBe(true);
    const replyAfter = await replyTask({ taskId: failed.value.job.id, message: "again" });
    expect(replyAfter.ok).toBe(false);
    if (!replyAfter.ok) expect(replyAfter.error.kind).toBe("bad_input");
  }, 60_000);

  it("keeps unavailable models out of available models", async () => {
    const dir = await repo();
    process.env.FAKE_OC_SCENARIO = "model_unavailable";
    clearAdapterCache();
    const failed = await startTask({ prompt: "edit", repo: dir, model: "openai/gpt-test", waitSeconds: 25 });
    expect(failed.ok).toBe(true);
    if (failed.ok && failed.value.kind === "task")
      expect(failed.value.job.error?.kind).toBe("model_unavailable");
    process.env.FAKE_OC_MODELS = "openai/gpt-test,openai/gpt-test-mini";
    clearAdapterCache();
    const agent = (await describeAgents()).agents[0];
    expect(agent?.models).not.toContain("openai/gpt-test");
    expect(agent?.unavailableModels).toContain("openai/gpt-test");
  });

  it("uses free defaults for environment-only auth and saved preferences", async () => {
    const dir = await repo();
    process.env.FAKE_OC_AUTH =
      '[{"id":"parallel","name":"Parallel","connections":[{"type":"env","name":"PARALLEL_API_KEY"}]}]';
    clearAdapterCache();
    expect((await describeAgents()).agents[0]?.auth).toBe("env_only");
    const login = await checkLogin();
    expect(login.ok && login.value.auth).toBe("env_only");
    await startTask({ prompt: "free", repo: dir, waitSeconds: 25 });
    const firstArgs = fs
      .readFileSync(process.env.FAKE_OC_RECORD ?? "", "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    const firstRun = firstArgs.find((args) => args[0] === "run") ?? [];
    expect(firstRun.slice(firstRun.indexOf("--model"), firstRun.indexOf("--model") + 2)).toEqual([
      "--model",
      FREE_MODEL,
    ]);
    await savePreference({ delegate: "opencode", model: "openai/gpt-test-mini", savedAt: nowIso() });
    await startTask({ prompt: "preferred", repo: dir, waitSeconds: 25 });
    expect(fs.readFileSync(process.env.FAKE_OC_RECORD ?? "", "utf8")).toContain("openai/gpt-test-mini");
  }, 60_000);

  it("warns for unsupported OpenCode versions", async () => {
    await repo();
    process.env.FAKE_OC_VERSION = "2.4.1";
    clearAdapterCache();
    expect((await describeAgents()).agents[0]?.warning).toBeFalsy();
    process.env.FAKE_OC_VERSION = "2.5.0";
    clearAdapterCache();
    const warning = (await describeAgents()).agents[0]?.warning ?? "";
    expect(warning).toMatch(/2\.3\.x.+2\.4\.x/);
  });

  it("cancels a queued task without reporting it as working", async () => {
    const dir = await repo();
    process.env.CODEHAND_MAX_RUNNING = "1";
    process.env.FAKE_OC_SCENARIO = "hang";
    const first = taskOf(await startTask({ prompt: "first", repo: dir, waitSeconds: 0 }));
    const second = taskOf(await startTask({ prompt: "second", repo: dir, waitSeconds: 0 }));
    const cancelled = await finishTask({ taskId: second.job.id, action: "cancel" });
    expect(cancelled.ok).toBe(true);
    const viewed = await checkTask({ taskId: second.job.id, waitSeconds: 0 });
    expect(viewed.ok).toBe(true);
    if (viewed.ok && viewed.value.kind === "task") {
      expect(viewed.value.job.status).toBe("cancelled");
      expect(respondTask(viewed.value).text).not.toContain("Still working");
    }
    await finishTask({ taskId: first.job.id, action: "cancel" });
  }, 40_000);

  it("rejects merging when the base branch changed", async () => {
    const dir = await repo();
    const task = taskOf(await startTask({ prompt: "edit", repo: dir, waitSeconds: 25 }));
    execFileSync("git", ["checkout", "-b", "other"], { cwd: dir });
    const result = await finishTask({ taskId: task.job.id, action: "merge", confirm: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("git");
      expect(result.error.message).toContain(task.job.repo.baseBranch);
    }
  }, 40_000);

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
