import fs from "node:fs";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_OC_SCENARIO ?? "done";
const version = process.env.FAKE_OC_VERSION ?? "2.4.1";

if (process.env.FAKE_OC_RECORD) {
  fs.appendFileSync(process.env.FAKE_OC_RECORD, `${JSON.stringify(args)}\n`);
}

if (args.includes("--version")) {
  process.stdout.write(`opencode v${version}\n`);
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "list") {
  process.stdout.write(
    process.env.FAKE_OC_AUTH ??
      '[{"id":"openai","name":"OpenAI","connections":[{"type":"credential","method":"oauth"}]}]\n',
  );
  process.exit(0);
}

if (args[0] === "models") {
  if (process.env.FAKE_OC_MODELS !== undefined) {
    const custom = process.env.FAKE_OC_MODELS;
    process.stdout.write(custom.endsWith("\n") ? custom : `${custom}\n`);
  } else {
    process.stdout.write("openai/gpt-test\nopenai/gpt-test-mini\n");
  }
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Open https://auth.openai.com/codex/device\nEnter code: ABCD-1234\n");
  process.exit(0);
}

if (args[0] !== "run") {
  process.stderr.write(`unexpected args ${args.join(" ")}\n`);
  process.exit(2);
}

const sessionFlag = args.indexOf("--session");
const session = sessionFlag >= 0 ? args[sessionFlag + 1] : "ses_test";

function emit(type, extra = {}) {
  process.stdout.write(`${JSON.stringify({ type, timestamp: Date.now(), sessionID: session, ...extra })}\n`);
}

function trackStart() {
  const file = process.env.FAKE_OC_CONCURRENCY_FILE;
  if (!file) return () => {};
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { current: 0, max: 0 };
  current.current += 1;
  current.max = Math.max(current.max, current.current);
  fs.writeFileSync(file, JSON.stringify(current));
  return () => {
    const latest = JSON.parse(fs.readFileSync(file, "utf8"));
    latest.current = Math.max(0, latest.current - 1);
    fs.writeFileSync(file, JSON.stringify(latest));
  };
}

function finishDone(summary = "SUMMARY:\n- Added hello") {
  fs.writeFileSync("hello.ts", 'export function hello() {\n  return "hello";\n}\n');
  emit("step_start");
  emit("tool_use", { part: { tool: "write", state: { status: "completed", input: { filePath: "hello.ts" } } } });
  emit("text", { part: { text: summary } });
  emit("step_finish", { part: { tokens: { input: 12, output: 6 }, cost: 0.01 } });
}

/** OpenCode 2.4.1 can report provider failures as JSON on stdout with an empty stderr. */
function failOnStdout(error) {
  emit("error", { error });
  process.exitCode = 1;
}

const stop = trackStart();
try {
  if (scenario === "needs_input") {
    emit("step_start");
    emit("text", { part: { text: "NEEDS_INPUT: Should hello be async?" } });
    emit("step_finish", { part: { tokens: { input: 4, output: 2 } } });
  } else if (scenario === "error_auth") {
    emit("error", { error: { name: "Unauthorized", data: { message: "401 unauthorized" } } });
    process.stderr.write("401 unauthorized\n");
    process.exitCode = 1;
  } else if (scenario === "error_rate") {
    process.stderr.write("429 rate limit exceeded\n");
    process.exitCode = 1;
  } else if (scenario === "error_quota") {
    process.stderr.write("usage limit exceeded\n");
    process.exitCode = 1;
  } else if (scenario === "error_quota_stdout") {
    failOnStdout({ type: "provider.free-limit" });
  } else if (scenario === "model_unavailable") {
    failOnStdout({ type: "provider.model", message: "Model unavailable" });
  } else if (scenario === "late_free_limit") {
    const stamp = new Date().toISOString();
    fs.writeFileSync("late.ts", `export const late = ${JSON.stringify(`edited at ${stamp}`)};\n`);
    emit("step_start");
    emit("tool_use", {
      part: { tool: "write", state: { status: "completed", input: { filePath: "late.ts" } } },
    });
    emit("text", { part: { text: "Inspecting files..." } });
    failOnStdout({ type: "provider.free-limit" });
  } else if (scenario === "large_diff") {
    const body = Array.from({ length: 90 }, (_, index) => `export const line${index + 1} = "value ${index + 1}";`);
    fs.writeFileSync("large.ts", `${body.join("\n")}\n`);
    emit("step_start");
    emit("tool_use", {
      part: { tool: "write", state: { status: "completed", input: { filePath: "large.ts" } } },
    });
    emit("text", { part: { text: "SUMMARY:\n- Added a large file" } });
    emit("step_finish", { part: { tokens: { input: 30, output: 10 }, cost: 0.02 } });
  } else if (scenario === "hang") {
    emit("step_start");
    await new Promise(() => {
      setInterval(() => {}, 1_000_000);
    });
  } else if (scenario === "crash") {
    emit("step_start");
    process.exit(137);
  } else if (scenario === "slow") {
    for (let i = 0; i < 10; i++) {
      emit("text", { part: { text: `working ${i}` } });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    finishDone();
  } else if (scenario === "pulse") {
    emit("step_start");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    finishDone();
  } else if (scenario === "permission") {
    process.stderr.write("permission requested: bash (git push); auto-rejecting\n");
    finishDone("SUMMARY:\n- Tried a blocked command");
  } else if (scenario === "leak") {
    const secret = process.env.FAKE_OC_SECRET ?? "sk-abcdefghijklmnopqrstuv";
    emit("text", { part: { text: `SUMMARY:\n- token ${secret}` } });
  } else {
    finishDone();
  }
} finally {
  stop();
}
