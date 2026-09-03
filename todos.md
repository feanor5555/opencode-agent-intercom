# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending


- `specs/nested-delegation.md` is broadly stale on line references (~50, the `src/childwait.js` ones short by about 11); sweep the whole file against the current source.
- The header comment of `test/child-waiter.test.js` claims nothing registers a child waiter in production; `registerChildWaiter` in `src/tools.js` does. Correct the comment.
- Establish whether a message part streamed just before `abortSession` is persisted by the time `session.messages` is read, which bounds how much of a timed-out subagent's text `timeoutSubagent` can rescue.
- Last commit: d8be38a fix: keep a busy subagent alive and hand back its work on timeout
