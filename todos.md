# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The wiring into `/home/user/testopencode` is gone: neither `opencode.json` nor `.opencode/tui.json` exists there any more. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Cause unknown.
- The wiring of the plugin into `/home/user/testopencode` is gone: neither `opencode.json` nor `.opencode/tui.json` exists there any more. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path.
