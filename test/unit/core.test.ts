import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFailure, parseLine } from "../../src/adapters/opencode.js";
import { gc } from "../../src/core/finish.js";
import { appendEvent, readEvents } from "../../src/core/jobstore.js";
import { runShellCommand } from "../../src/core/proc.js";
import { redact, redactDeep, setSecretValues } from "../../src/core/redact.js";
import { buildResult, recentLines } from "../../src/core/summarize.js";
import { canTransition } from "../../src/core/types.js";
import type { NormalizedEvent } from "../../src/core/types.js";
import { isolate } from "../support.js";

function errorEvents(events: NormalizedEvent[]): Extract<NormalizedEvent, { t: "error" }>[] {
  return events.filter((event): event is Extract<NormalizedEvent, { t: "error" }> => event.t === "error");
}

describe("status transitions", () => {
  it("allows the task lifecycle and blocks illegal jumps", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "needs_input")).toBe(true);
    expect(canTransition("needs_input", "queued")).toBe(true);
    expect(canTransition("done", "queued")).toBe(true);
    expect(canTransition("failed", "queued")).toBe(true);
    expect(canTransition("failed", "running")).toBe(false);
    expect(canTransition("cancelled", "done")).toBe(false);
  });
});

describe("OpenCode output parser", () => {
  it("normalizes a recorded jsonl turn", () => {
    const lines = fs.readFileSync(path.resolve("test/fixtures/opencode/text.jsonl"), "utf8").split(/\r?\n/);
    const events = lines.flatMap((line) => parseLine(line));
    expect(events.some((event) => event.t === "session" && event.sessionId === "ses_abc")).toBe(true);
    expect(events.some((event) => event.t === "tool" && event.path === "src/a.ts")).toBe(true);
    expect(events.some((event) => event.t === "text" && event.text.includes("SUMMARY:"))).toBe(true);
    const finish = events.find((event) => event.t === "step" && event.phase === "finish");
    expect(finish && finish.t === "step" ? finish.tokens : undefined).toEqual({ input: 20, output: 8 });
  });

  it("captures auto-rejected permissions", () => {
    const line = fs.readFileSync(path.resolve("test/fixtures/opencode/permission.txt"), "utf8");
    const [event] = parseLine(line);
    expect(event).toMatchObject({ t: "permission_rejected", permission: "bash", detail: "git push" });
  });

  it("classifies an OpenCode 2.4.1 stdout provider.free-limit error as quota", () => {
    const events = parseLine('{"type":"error","error":{"type":"provider.free-limit"}}');
    const [error] = errorEvents(events);
    expect(error?.kind).toBe("quota");
    expect(error?.message.toLowerCase()).toMatch(/free|quota/);
    expect(error?.message).not.toBe("OpenCode error");

    const failure = classifyFailure({
      exitCode: 1,
      stderrTail: "",
      errorEvents: errorEvents(events),
    });
    expect(failure.kind).toBe("quota");
    expect(failure.isProviderError).toBe(true);
    expect(failure.message.toLowerCase()).toMatch(/free|quota/);
    expect(failure.message).not.toContain("exited with code 1");
  });

  it("classifies an unavailable model reported on stdout", () => {
    const events = parseLine(
      '{"type":"error","error":{"type":"provider.model","message":"Model unavailable"}}',
    );
    const [error] = errorEvents(events);
    expect(error?.kind).toBe("model_unavailable");

    const failure = classifyFailure({ exitCode: 1, stderrTail: "", errorEvents: errorEvents(events) });
    expect(failure.kind).toBe("model_unavailable");
    expect(failure.message).toContain("Model unavailable");
  });

  it("keeps SUMMARY when a long text event is tail-truncated", () => {
    const longText = `${"a".repeat(25_000)}\nSUMMARY:\n- kept the ending`;
    const [event] = parseLine(JSON.stringify({ type: "text", part: { text: longText } }));
    expect(event?.t).toBe("text");
    const text = event?.t === "text" ? event.text : "";
    expect(text.length).toBe(20_000);
    expect(text).toContain("SUMMARY:");
    expect(text.endsWith("SUMMARY:\n- kept the ending")).toBe(true);
  });
});

describe("summaries", () => {
  it("keeps the SUMMARY block and a NEEDS_INPUT question", () => {
    const result = buildResult({
      events: [
        {
          ts: "t",
          turn: 1,
          event: { t: "text", text: "SUMMARY:\n- Added hello\nNEEDS_INPUT: Async or not?" },
        },
      ],
      files: [{ path: "hello.ts", added: 2, removed: 0, status: "A" }],
      branch: "codehand/t_test",
      endedAt: "2026-01-01T00:00:02.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "done",
    });
    expect(result.status).toBe("needs_input");
    expect(result.summary).toContain("Added hello");
    expect(result.question).toBe("Async or not?");
    expect(result.durationS).toBe(2);
    expect(
      recentLines(
        result
          ? [
              {
                ts: "t",
                turn: 1,
                event: { t: "tool", name: "write", status: "completed", summary: "hello.ts" },
              },
            ]
          : [],
      )[0],
    ).toContain("Edited");
  });

  it("does not let mid-run text overwrite the error summary of a failed task", () => {
    const failureMessage = "Free tier quota limit reached (provider.free-limit).";
    const result = buildResult({
      events: [
        { ts: "t1", turn: 1, event: { t: "text", text: "Inspecting files..." } },
        { ts: "t2", turn: 1, event: { t: "error", kind: "quota", message: failureMessage } },
        { ts: "t3", turn: 1, event: { t: "text", text: "Giving up now." } },
      ],
      files: [],
      branch: "codehand/t_failed",
      endedAt: "2026-01-01T00:00:02.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "failed",
      fallbackSummary: failureMessage,
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toBe(failureMessage);
    expect(result.summary).not.toBe("Giving up now.");
  });

  it("describes edited files when a warning arrives without a SUMMARY block", () => {
    const result = buildResult({
      events: [{ ts: "t1", turn: 1, event: { t: "text", text: "Inspecting files..." } }],
      files: [{ path: "late.ts", added: 3, removed: 0, status: "A" }],
      branch: "codehand/t_warned",
      endedAt: "2026-01-01T00:00:02.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "done",
      warning: "Provider limit reached after edits were made (free limit).",
    });
    expect(result.status).toBe("done");
    expect(result.warning).toBeTruthy();
    expect(result.summary).not.toBe("Inspecting files...");
    expect(result.summary).toContain("Edited 1 file(s)");
    expect(result.summary).toContain("late.ts");
  });
});

describe("redaction", () => {
  it("hides keys, tokens, and saved secret values", () => {
    setSecretValues(["super-secret-value"]);
    const text = redact(
      "sk-abcdefghijklmnopqrstuv Bearer abcdefghijklmnopqrstuvwxyz postgres://user:pass@localhost/db super-secret-value",
    );
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain("Bearer abc");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("[redacted]");
  });

  it("redacts GitHub, Slack, and URL credential tokens", () => {
    // Built at runtime so the source file does not contain scanner-looking token literals.
    const githubPat = ["github", "pat", "A".repeat(30)].join("_");
    const slackToken = ["xoxb", "exampletokenvalue"].join("-");
    const text = redact(`gh ${githubPat} slack ${slackToken} url https://user:secret@example.com/repo.git`);
    expect(text).not.toContain(githubPat);
    expect(text).not.toContain(slackToken);
    expect(text).not.toContain("user:secret");
    expect(text).toContain("[REDACTED]@example.com/repo.git");
  });

  it("redacts nested object and array strings deeply", () => {
    setSecretValues([]);
    const githubPat = ["github", "pat", "B".repeat(30)].join("_");
    const slackToken = ["xoxb", "exampletokenvalue"].join("-");
    const deep = redactDeep({
      note: `token ${githubPat}`,
      count: 2,
      nested: {
        url: "https://user:secret@example.com/repo.git",
        list: [`slack ${slackToken}`],
      },
    });
    expect(deep.count).toBe(2);
    expect(deep.note).not.toContain(githubPat);
    expect(deep.note).toContain("[redacted]");
    expect(deep.nested.url).not.toContain("user:secret");
    expect(deep.nested.list[0]).not.toContain("xoxb-");
  });
});

describe("job storage", () => {
  it("orders turns numerically so turn 10 comes last", () => {
    isolate();
    const id = "t_abcdefgh";
    for (const turn of [1, 2, 10]) {
      appendEvent(id, turn, { t: "text", text: `turn-${turn}` });
    }
    const events = readEvents(id);
    expect(events.map((item) => item.turn)).toEqual([1, 2, 10]);
    const last = events.at(-1)?.event;
    expect(last?.t).toBe("text");
    expect(last?.t === "text" ? last.text : "").toBe("turn-10");
  });
});

describe("process helpers", () => {
  it("runs a quoted shell command on this platform", async () => {
    const result = await runShellCommand('node -e "console.log(42)"', { timeoutMs: 20_000 });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("42");
    expect(result.stderr.trim()).toBe("");
    expect(result.timedOut).toBe(false);
  }, 30_000);
});

describe("garbage collection", () => {
  it("rejects invalid day counts", async () => {
    isolate();
    await expect(gc(Number.NaN)).rejects.toThrow(RangeError);
    await expect(gc(0)).rejects.toThrow(RangeError);
    await expect(gc(-5)).rejects.toThrow(RangeError);
  });
});
