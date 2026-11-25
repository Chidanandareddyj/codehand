import { Command } from "commander";
import { describeAgents } from "../core/agents.js";
import { finishTask, gc, type FinishAction } from "../core/finish.js";
import { checkTask, getOutput, replyTask, startTask } from "../core/jobs.js";
import {
  respondAgents,
  respondData,
  respondError,
  respondList,
  respondTask,
  type Rendered,
} from "../core/respond.js";
import { installSkill } from "../core/skill.js";
import { apiKeyHelp, checkLogin, installAgent, startLogin } from "../core/setup.js";
import type { LoginMethod } from "../adapters/types.js";
import type { Result } from "../core/types.js";

function emit(rendered: Rendered<unknown>, json: boolean): void {
  process.stdout.write(`${json ? JSON.stringify(rendered.envelope, null, 2) : rendered.text}\n`);
  if (!rendered.envelope.ok) process.exitCode = 1;
}

function emitResult<T>(
  result: Result<T>,
  json: boolean,
  render: (value: T) => Rendered<unknown>,
  next: string,
): void {
  emit(result.ok ? render(result.value) : respondError(result.error, next), json);
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = new Command();
  program
    .name("codehand")
    .description("Hand coding tasks to OpenCode on this computer.")
    .showHelpAfterError();

  program
    .command("agents")
    .option("--json")
    .action(async (opts: { json?: boolean }) => {
      emit(respondAgents(await describeAgents()), Boolean(opts.json));
    });

  program
    .command("setup")
    .argument("<action>", "install, login, check, or api-key-help")
    .option("--method <method>", "chatgpt_device, github_copilot, or api_key_env")
    .option("--provider <name>", "environment variable for an API key", "ANTHROPIC_API_KEY")
    .option("--json")
    .action(async (action: string, opts: { method?: string; provider?: string; json?: boolean }) => {
      const json = Boolean(opts.json);
      if (action === "install") {
        emitResult(
          await installAgent(),
          json,
          (value) =>
            respondData(
              value,
              `Installed: ${value.installed}`,
              "Free models work with no login. Offer login only if they want a paid plan.",
            ),
          "Install failed.",
        );
        return;
      }
      if (action === "login") {
        emitResult(
          await startLogin((opts.method as LoginMethod | undefined) ?? "chatgpt_device"),
          json,
          (value) =>
            respondData(
              value,
              `Open ${value.url} and enter ${value.code}.`,
              "Check again after the user approves.",
            ),
          "Sign-in failed.",
        );
        return;
      }
      if (action === "api-key-help" || action === "api_key_help") {
        const value = apiKeyHelp(opts.provider);
        emit(
          respondData(
            value,
            `Write ${value.envName}=... to ${value.secretsPath}`,
            "Then run codehand setup check.",
          ),
          json,
        );
        return;
      }
      emitResult(
        await checkLogin(),
        json,
        (value) =>
          respondData(
            value,
            `Auth: ${value.auth}`,
            value.auth === "anonymous"
              ? "Ready on the free tier. Login is optional."
              : "Continue when you want to start a task.",
          ),
        "Could not check auth.",
      );
    });

  program
    .command("start")
    .requiredOption("--repo <repo>")
    .requiredOption("--prompt <prompt>")
    .option("--mode <mode>", "plan or edit", "edit")
    .option("--model <model>")
    .option("--base-branch <branch>")
    .option(
      "--check <cmd>",
      "command to run after a successful edit",
      (value: string, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option("--remember")
    .option("--delegate <delegate>", "opencode or self")
    .option("--wait <seconds>", "20")
    .option("--json")
    .action(async (opts) => {
      const result = await startTask({
        prompt: opts.prompt,
        repo: opts.repo,
        mode: opts.mode === "plan" ? "plan" : "edit",
        model: opts.model,
        baseBranch: opts.baseBranch,
        checks: opts.check,
        remember: Boolean(opts.remember),
        delegate: opts.delegate,
        waitSeconds: Number(opts.wait),
      });
      emitResult(
        result,
        Boolean(opts.json),
        (value) =>
          value.kind === "preference"
            ? respondData(
                { preference: value.preference },
                "Preference saved.",
                "Start a task when you are ready.",
              )
            : respondTask(value),
        "Could not start the task.",
      );
    });

  program
    .command("check")
    .argument("[taskId]")
    .option("--wait <seconds>", "30")
    .option("--json")
    .action(async (taskId: string | undefined, opts: { wait?: string; json?: boolean }) => {
      const result = await checkTask({ taskId, waitSeconds: Number(opts.wait) });
      emitResult(
        result,
        Boolean(opts.json),
        (value) => (value.kind === "list" ? respondList(value.tasks) : respondTask(value)),
        "Could not check the task.",
      );
    });

  program
    .command("reply")
    .argument("<taskId>")
    .argument("<message>")
    .option("--wait <seconds>", "20")
    .option("--json")
    .action(async (taskId: string, message: string, opts: { wait?: string; json?: boolean }) => {
      emitResult(
        await replyTask({ taskId, message, waitSeconds: Number(opts.wait) }),
        Boolean(opts.json),
        (value) => respondTask(value),
        "Could not reply.",
      );
    });

  program
    .command("output")
    .argument("<taskId>")
    .option("--diff")
    .option("--log")
    .option("--message")
    .option("--path <path>")
    .option("--offset <n>", "0")
    .option("--max-chars <n>", "8000")
    .option("--json")
    .action(async (taskId: string, opts) => {
      const what = opts.log ? "log" : opts.message ? "message" : "diff";
      emitResult(
        await getOutput({
          taskId,
          what,
          path: opts.path,
          offset: Number(opts.offset),
          maxChars: Number(opts.maxChars),
        }),
        Boolean(opts.json),
        (value) =>
          respondData(
            value,
            value.content,
            value.nextOffset === null ? "End of output." : "Pass --offset to continue.",
          ),
        "Could not read output.",
      );
    });

  program
    .command("finish")
    .argument("<taskId>")
    .option("--cancel")
    .option("--keep")
    .option("--commit")
    .option("--merge")
    .option("--discard")
    .option("-m, --message <message>")
    .option("--confirm")
    .option("--json")
    .action(async (taskId: string, opts) => {
      const action: FinishAction = opts.cancel
        ? "cancel"
        : opts.keep
          ? "keep"
          : opts.merge
            ? "merge"
            : opts.discard
              ? "discard"
              : "commit";
      emitResult(
        await finishTask({ taskId, action, message: opts.message, confirm: Boolean(opts.confirm) }),
        Boolean(opts.json),
        (value) => respondData(value, `${value.action} ${value.branch}`, "Done."),
        "Could not finish.",
      );
    });

  program
    .command("gc")
    .option("--days <days>", "7")
    .option("--json")
    .action(async (opts: { days?: string; json?: boolean }) => {
      const removed = await gc(Number(opts.days));
      emit(
        respondData(removed, `Removed ${removed.removed.length} old task(s).`, "Nothing else to clean."),
        Boolean(opts.json),
      );
    });

  program
    .command("install-skill")
    .option("--target <dir>")
    .option("--json")
    .action((opts: { target?: string; json?: boolean }) => {
      emitResult(
        installSkill(opts.target),
        Boolean(opts.json),
        (value) => respondData(value, value.files.join("\n"), "Follow CODEHAND.md for coding tasks."),
        "Could not install the skill.",
      );
    });

  await program.parseAsync(argv);
}
