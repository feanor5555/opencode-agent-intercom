# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- A repaired prompt file clears its stale-file finding only on the next opencode process: the prompt-file scan is once per directory per process, so a mid-session edit is reported as stale until the next restart. The trade-off is the stability of the block in the orchestrator's cached system prompt; the cure is either a rescan trigger on edit (loses byte-stability) or a per-file re-evaluation that re-issues the finding instead of patching the block in place.
- Prompt contract stamp: implement `concepts/prompt-contract-stamp.md`. `PROMPT_CONTRACT` stays a hand-edited integer in `src/prompts.js`; the rendered text of the four covered elements (`Blocked:` report, `DONE: T<n>` marker, orchestrator `spawn` protocol, delegation block) is pinned in a generated fixture so any rewording turns the suite red until a human bumps the stamp. Helper script `scripts/pin-prompt-contract.js` and `pin:contract` npm script per the concept. A cosmetic rewording does NOT count as a contract change on its own, and the wake sentence in `src/prompts.js` is NOT a fifth element.
- Tidy-up: `tui/src/settings-file.ts` carries the TUI half's role lists (`AGENT_NAMES`, the prompt-file set, the spawnable set, the per-type budget table) although its header describes it as the on-disk settings store. A dedicated `tui/src/agent-roles.ts` would fit better — move the role lists there and keep `settings-file.ts` to settings I/O.
