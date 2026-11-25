# Decisions

Checked against OpenCode 2.3.x and 2.4.x (verified against 2.3.2 and 2.4.1, Nov 2026). When the installed CLI and the plan disagreed, the CLI won.

## OpenCode

- The npm package is `@opencode/cli`, not `opencode-ai`. Install with `npm i -g @opencode/cli`.
- Headless flags that exist: `--format json`, `--auto` (this is the auto-approve flag; `--dangerously-skip-permissions` is gone), `--session`, `--agent`, `--model`, `--archived`, `--standalone`, `--log-level`.
- Every run passes `--standalone` so provider environment variables reach that run instead of a shared background service. Runs also pass `--log-level error` so stderr stays parseable, and `--archived` on a new session so scripted runs stay out of the inbox.
- `--file` attaches a file. Prompts longer than 7000 characters are attached that way, with a short message telling OpenCode to follow the file.
- `opencode auth list --format json` returns an array of `{ id, name, connections }`. Connections have `type: "credential"` (signed-in) vs `type: "env"` (env-only); env-only keys report `auth: "env_only"`, never "signed in". codehand never calls `auth export`.
- OpenCode 2.4.1 emits structured errors on stdout JSON (e.g. `{"type":"error","error":{"type":"provider.free-limit"}}`). Adapters return a uniform `{ kind, message, isProviderError }` failure shape so future adapters (Codex, Claude Code) share one error contract.
- ChatGPT device login is `opencode auth login openai --method chatgpt-headless`. The method id comes from OpenCode's provider source. It was not executed here, because that starts a real login.
- A live `opencode run` was not captured. The signed-in providers on this machine would have been billed. Parser fixtures in `test/fixtures/opencode` are reconstructed from the CLI's JSON emitter. The end-to-end tests use `test/fake-opencode.mjs`.
- Versions outside 2.3.x and 2.4.x get a warning on `coding_agents`. Verified against 2.3.2 and 2.4.1.

## Not verified here

- Grok Bot's tool-call timeout. The design still returns within 45 seconds, which is under the 60–240 second limits documented for other clients.
- Signing in through the real device-code or Copilot flow.
- `opencode models` line shape. The parser keeps the first token of each line that contains `/`.

## Product choices inside v1

- OpenCode free models need no account (opencode.ai: "use the free models. No account needed."). If nothing is signed in, codehand starts anyway and passes `--model opencode/big-pickle`.
- Default model policy: codehand always defaults to `opencode/big-pickle` unless the user explicitly passes `--model` / `model` or saves a preferred model, preventing surprise spend on paid env keys.
- Installing OpenCode is never automatic. `coding_agents` tells the bot to ask the user first.
- Pull requests are still out of v1. If a signed-in provider exists, `--model` is omitted so OpenCode picks. If not, the free model above is used.
- The npm package name is unscoped `codehand` (confirmed free on the registry, 25 Nov 2026). The connector command is `npx -y codehand`.
- On Windows, runners, OpenCode children, and login processes use `windowsHide: true` and do **not** set `detached: true`. Node treats detached Windows processes as a new console window.
- Worktrees live in `~/codehand-work/wt/<task-id>`, not inside the user's repo. Uncommitted worktree state is explicitly reported (`workdir`, `worktreeState`) so callers know why `git log` on the branch has not moved yet.
- `merge` commits any uncommitted worktree changes first, then `git merge --no-ff`. Otherwise the branch would still point at the base commit, because OpenCode is told not to commit.
- An install that exceeds 45 seconds is stopped and reported as a timeout, instead of being left running in the background.
- Destructive finish actions (`merge`, `discard`) require `confirm: true`.

## Extra fields

The plan's job record gained `promptPreview`, `checks`, `cancelRequested`, `opencodePid`, and `cleaned`. They are how the queue, cancel, and cleanup work without a second database. Task responses also include `task_id`.

## Test-only environment

`CODEHAND_HOME`, `CODEHAND_WORK`, `CODEHAND_USE_TSX`, `CODEHAND_OPENCODE_BIN`, `CODEHAND_IDLE_MS`, `CODEHAND_MAX_RUNNING`, and `CODEHAND_CACHE_MS` exist so tests do not touch the real home directory or a real OpenCode login. Production ignores them unless they are set.
