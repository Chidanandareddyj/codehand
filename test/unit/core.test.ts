import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine } from "../../src/adapters/opencode.js";
import { buildResult, recentLines } from "../../src/core/summarize.js";
import { canTransition } from "../../src/core/types.js";
import { redact, setSecretValues } from "../../src/core/redact.js";

describe("status transitions", () => {
  it("allows the task lifecycle and blocks illegal jumps", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("running", "needs_input")).toBe(true);
    expect(canTransition("needs_input", "queued")).toBe(true);
    expect(canTransition("done", "queued")).toBe(true);
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
});
