# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring, and `/home/user/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Cause unknown.
- No e2e driver checks the TUI half: `e2e_plugin_wired` covers only the server plugin, so a setup with the server wired but `~/.config/opencode/tui.json` missing still passes the precondition and shows no sidebar.
