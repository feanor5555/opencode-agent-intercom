# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- `CLAUDE.md` does not yet describe the run ceiling: the third watchdog window `maxSubagentRunMs` (default 2640000) with the per-type `agentRunMs`, the per-run stamp `entry.runStartedAt` that nothing the subagent does renews (re-seeded on `reuse` but not moved by activity, unlike `lastActivityAt`), and the wrap-up band at three quarters of the ceiling naming the two moves the subagent has (hand back with a `Blocked:` line, or `ask` the caller). `CLAUDE.md` is untracked, so this is an edit to make in place.
