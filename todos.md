# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- The nested-spawn guard in `reapRows` (`tui/src/tui.tsx`) contradicts its own comment: `onSessionCreated` marks the parent polled in the same block that creates the row, so a nested row is reapable from birth. Correcting it changes `SubagentEntry`.

- Establish whether a message part streamed just before `abortSession` is persisted by the time `session.messages` is read, which bounds how much of a timed-out subagent's text `timeoutSubagent` can rescue.
- `concepts/reusable-subagent-sessions.md` (around line 272) describes retention capacity only as eviction after a retention; the watchdog sweep now also trims the held set to a lowered capacity. Complete that section.
- A retained entry whose session is deleted from outside is dropped silently and the orchestrator is never told (`src/hooks.js:1613-1625`). Give that drop a notice path to the parent.
