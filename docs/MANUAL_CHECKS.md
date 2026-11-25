# Manual checks

Automated coverage is in `test/`. These are the cases from the plan that still need a person, or a real OpenCode login.

| Situation | Where it is covered |
| --- | --- |
| OpenCode is not installed | `refuses to start when OpenCode is missing` |
| OpenCode is not signed in | Unsigned starts on the free tier (`auth: anonymous`). Paid-plan failures are in `reports auth, rate limit, and permission failures` |
| OpenCode asks a question | `finishes an edit, then continues the same session` |
| Rate limit | same test, with the fake |
| A permission was rejected | same test |
| The chat is closed mid-task | state is on disk; `check` reads it. Not a separate UI test |
| Two tasks on one repo | `keeps two tasks in separate worktrees and merges one` |
| Private repo | Not automated. Needs `gh` or git credentials on that computer |
| Huge diff or log | paging is in `getOutput` (8000 characters, max 20000). No giant-fixture test |
| Runs too long or goes silent | `cancels a hung run and times out an idle one` |
| Runner dies | `marks a dead runner as crashed` |
| Computer was wiped | setup is safe to repeat. Not simulated |
| A question about the code | `uses plan mode without auto-approve` |
| Real OpenCode edits a repo | Not run. It would spend a signed-in provider. Do this once before trusting a bot with it |
| Grok Bot add-by-command | Not run from this machine |
