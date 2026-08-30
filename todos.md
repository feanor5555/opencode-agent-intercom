# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- A held TUI sidebar row can linger for up to one poll where the plugin refuses the retention (over the reuse ceiling, a `Blocked:` result, a nested child, a `session.error` ending, or retention switched on after plugin load while the tool-map latch has it off) before the next poll withdraws it.
- A TUI-side drop on a held row leaves the plugin's registry entry standing until the TTL reap or a `reuse` sees the session is gone; the panel's action and the plugin's state are briefly apart.

