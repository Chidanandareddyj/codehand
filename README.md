# codehand

Hand coding work from an AI bot to [OpenCode](https://opencode.ai) on the same computer, instead of spending the bot's tokens. OpenCode 2.3.x and 2.4.x are supported.

OpenCode's free models work with no account. Signing in is optional. Node 20+ is required on the computer the bot uses.

## Prompt to give your bot

Copy one of these into chat with the bot that should do the coding.

### Bots that can add a local MCP server

Grok Bot, Cursor, Claude Code, Codex, and similar:

```text
Add a local MCP server named codehand that runs exactly:

npx -y codehand

After it connects, use it for all coding work bigger than a few lines.

- If OpenCode is not installed, ask me before installing it.
- Use OpenCode's free models with no login unless I ask to sign in.
- Remember that I want OpenCode for coding from now on.
- Start each task on a separate git branch, check on it, and ask me before merge or discard.
```

That is the whole setup. The bot adds the connector, then asks you before it installs OpenCode.

### Cursor config (optional)

If you prefer to add it yourself, put this in `.cursor/mcp.json` (project) or your Cursor MCP settings:

```json
{
  "mcpServers": {
    "codehand": {
      "command": "npx",
      "args": ["-y", "codehand"]
    }
  }
}
```

Then send the same prompt as above, starting from "After it connects…".

Claude Code:

```text
claude mcp add codehand -- npx -y codehand
```

### Terminal-only bots

Claude Duet, ChatGPT dots, Meta Muse, and anything with a shell but no local MCP:

```text
Run `npx -y codehand install-skill` in this project, then follow CODEHAND.md for all coding work bigger than a few lines.

- If OpenCode is not installed, ask me before installing it.
- Use OpenCode's free models with no login unless I ask to sign in.
- Remember that I want OpenCode for coding from now on.
- Start each task on a separate git branch, check on it, and ask me before merge or discard.
```

## What the bot should do

1. Call `coding_agents`.
2. If OpenCode is missing, ask before `setup_coding_agent install`.
3. Use the free tier when nobody is signed in. Offer login only for ChatGPT, Copilot, or an API key.
4. Start a task on a separate git branch, check on it, and ask before merge or discard.

## Commands

npm’s site shows `npm i codehand`. That only *installs* the package. An MCP bot needs a command that *runs* it, so the prompt uses `npx -y codehand` (downloads if needed, then starts the server). `npm i -g codehand` is optional; after that the command can be just `codehand`.

```text
npx -y codehand
npx -y codehand agents --json
npx -y codehand setup install
npx -y codehand setup check
npx -y codehand start --repo ./app --prompt "..." --json
```

Running `codehand` with no arguments starts the MCP server.

## Troubleshooting

### Free-tier quota reached (`provider.free-limit`)

OpenCode's free tier has a rolling usage cap. codehand reports the real quota error in task status (and marks `freeTier` exhausted in `coding_agents` until it resets or a free run succeeds). Wait for quota reset, pick another model, or sign in via `setup_coding_agent login`. If files were already edited before the limit hit, codehand marks the task `done` with a warning and still runs checks.

### Model unavailable

Some models listed by `opencode models` may be temporarily unavailable. codehand reports `model_unavailable`, remembers unavailable models temporarily, and lets you retry/continue the same session with another model via `reply_to_coding_task`.

### Why `git log` on the task branch looks empty

OpenCode edits files in a separate git worktree (`~/codehand-work/wt/<task-id>`) and leaves committing to you. Changes stay uncommitted in the worktree until you run `finish_coding_task` with `commit` or `merge`.

### Environment API keys vs signed-in accounts

Having an environment API key (such as `PARALLEL_API_KEY` or `OPENAI_API_KEY`) does not count as being signed into OpenCode (`auth: "env_only"`). codehand defaults to OpenCode's free model (`opencode/big-pickle`) unless you explicitly choose a model or save a preferred model.

### Continuing a failed task

If a task failed mid-way and has an OpenCode session, you can continue or retry it on the same branch with `reply_to_coding_task` (optionally passing a different `model`).

## Policy

Use your own OpenCode install, for your own use. codehand never reads or stores a subscription token. API keys, if you use them, go in the bot's secret store or in `~/.codehand/secrets.env`.

## Develop

```text
npm install
npm run build
npm test
```

Notes on the OpenCode flags this was built against are in [docs/DECISIONS.md](docs/DECISIONS.md).
