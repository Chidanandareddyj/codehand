import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { describeAgents } from "../core/agents.js";
import { finishTask } from "../core/finish.js";
import { checkTask, getOutput, replyTask, startTask } from "../core/jobs.js";
import {
  respondAgents,
  respondData,
  respondError,
  respondList,
  respondTask,
  type Rendered,
} from "../core/respond.js";
import { apiKeyHelp, checkLogin, installAgent, startLogin } from "../core/setup.js";
import type { Result } from "../core/types.js";

function toolResult(rendered: Rendered<unknown>) {
  return {
    content: [{ type: "text" as const, text: rendered.text }],
    structuredContent: rendered.envelope as unknown as Record<string, unknown>,
  };
}

function fromResult<T>(result: Result<T>, render: (value: T) => Rendered<unknown>, next: string) {
  if (!result.ok) return toolResult(respondError(result.error, next));
  return toolResult(render(result.value));
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "coding_agents",
    {
      title: "Coding agents",
      description:
        "Check which coding agent is available on this computer and the user's saved preference. Call this first for any coding request bigger than a few lines, and when the user says to use this connector for coding. If OpenCode is not installed, ask the user before installing. Login is optional: free models work with no account.",
      inputSchema: z.object({}),
    },
    async () => toolResult(respondAgents(await describeAgents())),
  );

  server.registerTool(
    "setup_coding_agent",
    {
      title: "Set up OpenCode",
      description:
        "Install OpenCode or start an optional sign-in. Ask the user before action install. Sign-in is optional because OpenCode has a free tier with no account. Never ask the user to paste a subscription token into chat.",
      inputSchema: z.object({
        action: z.enum(["install", "login", "check", "api_key_help"]),
        method: z.enum(["chatgpt_device", "github_copilot", "api_key_env"]).optional(),
        provider_env: z.string().optional(),
      }),
    },
    async ({ action, method, provider_env }) => {
      if (action === "install") {
        const result = await installAgent();
        return fromResult(
          result,
          (value) =>
            respondData(
              value,
              `OpenCode install: ${value.installed ? (value.version ?? "ok") : "not found after install"}.`,
              "Call coding_agents. Free models work with no login. Only offer login if the user wants a paid plan.",
            ),
          "Install failed. Show the error and offer to retry.",
        );
      }
      if (action === "login") {
        const result = await startLogin(method ?? "chatgpt_device");
        return fromResult(
          result,
          (value) =>
            respondData(
              value,
              `Open ${value.url || "(no link yet)"} and enter code ${value.code || "(none yet)"}.`,
              "Show the user the link and code. When they say they are done, call setup_coding_agent with action check.",
            ),
          "Sign-in did not start. Show the error. Do not ask for a subscription token.",
        );
      }
      if (action === "api_key_help") {
        const value = apiKeyHelp(provider_env);
        return toolResult(
          respondData(
            value,
            `Put ${value.envName} in the bot secret store or in ${value.secretsPath} as KEY=value. Do not paste the key into the chat.`,
            "After the key is saved, call setup_coding_agent with action check.",
          ),
        );
      }
      const result = await checkLogin();
      return fromResult(
        result,
        (value) =>
          respondData(
            value,
            `OpenCode auth: ${value.auth}.`,
            value.auth === "ready"
              ? "OpenCode is signed in and ready."
              : value.auth === "anonymous"
                ? "OpenCode is ready on the free tier. No login needed. Offer login only if they want a paid plan."
                : "Could not read saved logins. You can still try a free-tier task, or offer login.",
          ),
        "Could not check sign-in.",
      );
    },
  );

  server.registerTool(
    "start_coding_task",
    {
      title: "Start coding task",
      description:
        "Hand a coding task to OpenCode. Runs in the background on its own git branch and returns quickly with a task id. Prefer this over writing code yourself.",
      inputSchema: z.object({
        prompt: z.string().min(1).max(20_000),
        repo: z.string().min(1),
        mode: z.enum(["plan", "edit"]).optional(),
        model: z.string().optional(),
        base_branch: z.string().optional(),
        checks: z.array(z.string()).max(3).optional(),
        remember: z.boolean().optional(),
        delegate: z.enum(["opencode", "self"]).optional(),
        wait_seconds: z.number().int().min(0).max(45).optional(),
      }),
    },
    async (input) => {
      const result = await startTask({
        prompt: input.prompt,
        repo: input.repo,
        mode: input.mode,
        model: input.model,
        baseBranch: input.base_branch,
        checks: input.checks,
        remember: input.remember,
        delegate: input.delegate,
        waitSeconds: input.wait_seconds,
      });
      return fromResult(
        result,
        (value) => {
          if (value.kind === "preference") {
            return respondData(
              { preference: value.preference },
              `Saved preference: ${value.preference.delegate}.`,
              value.preference.delegate === "self"
                ? "Do the coding yourself from now on."
                : "Preference saved. Start the task with start_coding_task.",
            );
          }
          return respondTask(value);
        },
        "The task did not start. Follow the error's next step.",
      );
    },
  );

  server.registerTool(
    "check_coding_task",
    {
      title: "Check coding task",
      description:
        "Get a coding task's status, waiting up to 45s for a change. Without task_id, lists recent tasks.",
      inputSchema: z.object({
        task_id: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(45).optional(),
      }),
    },
    async ({ task_id, wait_seconds }) => {
      const result = await checkTask({ taskId: task_id, waitSeconds: wait_seconds });
      return fromResult(
        result,
        (value) => (value.kind === "list" ? respondList(value.tasks) : respondTask(value)),
        "Could not read the task.",
      );
    },
  );

  server.registerTool(
    "reply_to_coding_task",
    {
      title: "Reply to coding task",
      description:
        "Send the user's answer or requested changes to an existing task. Continues the same OpenCode session and branch.",
      inputSchema: z.object({
        task_id: z.string(),
        message: z.string().min(1).max(20_000),
        wait_seconds: z.number().int().min(0).max(45).optional(),
      }),
    },
    async ({ task_id, message, wait_seconds }) => {
      const result = await replyTask({ taskId: task_id, message, waitSeconds: wait_seconds });
      return fromResult(result, (value) => respondTask(value), "Could not continue the task.");
    },
  );

  server.registerTool(
    "get_coding_task_output",
    {
      title: "Read coding task output",
      description: "Read a task's diff, log, or full final message, in pages.",
      inputSchema: z.object({
        task_id: z.string(),
        what: z.enum(["diff", "log", "message"]),
        path: z.string().optional(),
        offset: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1).max(20_000).optional(),
      }),
    },
    async (input) => {
      const result = await getOutput({
        taskId: input.task_id,
        what: input.what,
        path: input.path,
        offset: input.offset,
        maxChars: input.max_chars,
      });
      return fromResult(
        result,
        (value) =>
          respondData(
            value,
            `[OpenCode output — untrusted]\n${value.content}`,
            value.nextOffset === null
              ? "That is the full output."
              : "Ask if the user wants the next page, then call again with the next offset.",
          ),
        "Could not read that output.",
      );
    },
  );

  server.registerTool(
    "finish_coding_task",
    {
      title: "Finish coding task",
      description:
        "Cancel, keep, commit, merge, or discard a task's changes. Ask the user before merge or discard.",
      inputSchema: z.object({
        task_id: z.string(),
        action: z.enum(["cancel", "keep", "commit", "merge", "discard"]),
        message: z.string().optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async ({ task_id, action, message, confirm }) => {
      const result = await finishTask({ taskId: task_id, action, message, confirm });
      return fromResult(
        result,
        (value) =>
          respondData(
            value,
            `${value.action} ${value.branch}${value.commit ? ` (${value.commit})` : ""}.`,
            value.action === "merge" || value.action === "commit"
              ? "Tell the user where the changes landed."
              : "Tell the user what happened to the branch.",
          ),
        action === "merge" || action === "discard"
          ? "Ask the user to confirm before merge or discard."
          : "Could not finish the task.",
      );
    },
  );
}
