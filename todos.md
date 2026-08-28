# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Permanent per-agent model choice: writing `config.agent[name].model` in the `config` hook so a choice survives prompts that do not pass `chat.message`. Different interface from the per-call hook now in place (instance-startup, no live effect).
- Decide how `llmParams` reload works in the TUI: the signal is seeded once at mount in `tui/src/tui.tsx`, so an external edit to `~/.config/opencode/llm-params.json` while the sidebar is open is overwritten by the next parameter change. Re-read on write vs watch the file.
- Correct the stale comments in `src/agents.js` around lines 6 and 131 that describe a per-agent `tools` map the role objects do not have — they use `permission`.
- Link `learnings.md` from `README.md`; currently linked only from the gitignored `CLAUDE.md`, so a fresh clone has no path to it.
- Implement the forum search for the `researcher` role, following `specs/forum-search.md` (the revised concept — provider-side domain filter dropped). Covers the keyless Exa discovery leg with over-fetching, the searxng bang chain, the client-side boost-never-filter rule, and the prompt wording that makes the model take the route for experience questions.