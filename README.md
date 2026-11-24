# codehand

codehand lets an AI bot hand a coding task to [OpenCode](https://opencode.ai) on the same computer, using the login already on that computer, instead of spending the bot's own tokens.

It has two doors over one core:

- an MCP server, for bots that can add a connector from a command (Grok Bot, Cursor, Claude Code)
- a CLI plus `skill/CODEHAND.md`, for bots that only have a terminal (Claude Duet, ChatGPT dots, Meta Muse)

v1 talks to OpenCode only. It does not open pull requests, does not choose a model for you, and is not published yet.

## Add it to a bot

From a built checkout:

```text
node dist/cli/main.js
```

Grok Bot: ask it to add an MCP server named codehand that runs that command. After this is published, the command becomes `npx -y codehand`.

Cursor: add the same command under MCP servers.

A terminal-only bot:

```text
node dist/cli/main.js install-skill
```

Then tell the bot to follow `CODEHAND.md` for coding tasks.

## What the bot does

1. `coding_agents` shows whether OpenCode is installed and signed in, and whether you already chose to use it.
2. The first time, the bot asks once: OpenCode, or do the work itself? It remembers the answer.
3. `start_coding_task` runs OpenCode on a new branch in its own git worktree and returns a task id.
4. `check_coding_task` waits up to 45 seconds. If OpenCode ends with `NEEDS_INPUT:`, the bot asks you and continues with `reply_to_coding_task`.
5. `finish_coding_task` can keep the branch, commit, merge, or discard. Merge and discard wait for a confirmation.

Sign-in goes through OpenCode's own login. codehand never reads or stores a subscription token. API keys can live in `~/.codehand/secrets.env` (`KEY=value`, mode 0600 where the OS allows it).

## Commands

```text
codehand agents --json
codehand setup install
codehand setup login --method chatgpt_device
codehand setup check
codehand start --repo ./app --prompt "..." --json
codehand check <task_id> --wait 30 --json
codehand reply <task_id> "..." --json
codehand output <task_id> --diff
codehand finish <task_id> --merge --confirm
codehand gc
codehand install-skill
```

Running `codehand` with no arguments starts the MCP server.

## Develop

Node 20 or newer.

```text
npm install
npm test
npm run build
```

Tests use a fake OpenCode, so they do not call a model. Notes on what was checked against the real CLI are in [docs/DECISIONS.md](docs/DECISIONS.md). The scenario list is in [docs/MANUAL_CHECKS.md](docs/MANUAL_CHECKS.md).
