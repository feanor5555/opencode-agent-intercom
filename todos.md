# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Run the full test suite once: `npm test`, `npm run check`, and a `tui/` build. Each per-agent ceiling change ran only its own test files; the full sweep is now due.
- Make `test/e2e/server-lifecycle.sh` detect and refuse being called from a subshell rather than relying on its header comment. A `tee` pipeline around `e2e_server_start` has orphaned a server twice in separate runs; in the second case the operator had read the header warning and piped it anyway, so the comment is not sufficient. `e2e_server_start` should fail loudly when it finds it is not running in the caller's shell.
- Priced decision awaiting the user: opencode writes Anthropic's `{ type: "ephemeral" }` cache marker with no `ttl`, i.e. the five-minute default, and the orchestrator's spawn-wait-wake rhythm routinely exceeds that, so a prompt-caching fix buys hits only for turns closer together than five minutes. The one-hour TTL would address it but costs twice the base input price per cache write, and whether opencode merges a plugin-supplied `providerOptions` is unverified. Do not implement without the user's answer.
- Deal with the untracked directory `work/e2e-lifecycle-live-check-captures.oqzpaR/` (a `mktemp` random suffix, deliberately kept out of every commit). Decide whether to keep its contents under a proper name or delete it.
- Correct three documents that still describe the state before the work-package sizing change: `specs/hideable-agent-chatter.md:39` still says `spawn-size` where the label is now `run-size`, and its `src/hooks.js:670-674` reference is stale since the call site moved to roughly `:815`; `specs/per-agent-token-ceiling.md:204-216` shows the limits block as it looked before headroom was added to it.
- Decide whether the spawn gate should keep refusing opencode's own built-in agent names — `general`, `plan`, `build` — where the project does not declare them in its `config.agent`. The accepted set is currently the plugin's own `AGENTS` keys plus the project's declared agents. Nothing in the tree spawns such a name today, so this is a latent restriction rather than a live fault.
