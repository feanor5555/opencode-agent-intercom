# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `/home/user/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Embed the open todos into the endless kickoff. The orchestrator cannot read the todo file: `PRIMARY_TOOLS` (`src/hooks.js:129`) allows only `spawn`, `abort`, `list` and `reuse`, and the todo tools are admitted on the subagent branch only. The endless kickoff (`endlessKickoffBlock`, `src/endless.js`) names the file and the new task ids but never its contents, so a cycle in which every point was dropped as a duplicate hands the fresh orchestrator nothing concrete to work on. The plugin must read the open todos after the write-and-confirm step and put them into the kickoff message.
- A cycle that saves zero new points because all of them are duplicates still replaces the primary; only the no-progress bound catches it, on the second such cycle. Decide whether that is the wanted behaviour.
- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Its name has never been captured; capture it next time the suite fails.

