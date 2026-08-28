# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- [in progress] Per-agent model selection in the sidebar — a model row per agent, the choice persisted per agent, applied through a `chat.message` hook that sets `output.message.model = {providerID, modelID}`. Drop this entry once it lands.
- [running, result not back] Per-agent model selection implementation: sidebar model row, per-agent persistence, `chat.message` hook setting `output.message.model = {providerID, modelID}`, removal of the dead `fallback: 0.3` at `tui/src/tui.tsx:90`, and a TUI rebuild. Outcome unknown — after restart, check the working tree and `git status` for what landed before continuing.
- [running, result not back] Revision of `specs/forum-search.md` dropping the provider-side domain filter. Read the file after the restart rather than trusting any description of it.
- Commit and push anything the two running tasks produced (last commit `51f62e7`); their output is uncommitted.
- Implement the forum search for the `researcher` role, following `specs/forum-search.md` (the revised concept — provider-side domain filter dropped). Covers the keyless Exa discovery leg with over-fetching, the searxng bang chain, the client-side boost-never-filter rule, and the prompt wording that makes the model take the route for experience questions.
- Decide how `llmParams` reload works in the TUI: the signal is seeded once at mount in `tui/src/tui.tsx`, so an external edit to `~/.config/opencode/llm-params.json` while the sidebar is open is overwritten by the next parameter change. Re-read on write vs watch the file.
- Correct the stale comments in `src/agents.js` around lines 6 and 131 that describe a per-agent `tools` map the role objects do not have — they use `permission`.
- Link `learnings.md` from `README.md`; currently linked only from the gitignored `CLAUDE.md`, so a fresh clone has no path to it.
