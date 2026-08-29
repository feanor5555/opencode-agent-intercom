# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Rework the roles' permission maps along two rules: a role does not search the web itself but obtains the result through the `researcher` role, and a subagent may spawn a subagent of its own for token-heavy preparation such as summarising documentation. Today `SUBAGENT_NO_DELEGATION` (`src/agents.js:131-133`) denies `spawn`, `task`, `abort` and `list` to every role, while `planner`, `coder`, `debugger`, `documenter` and `designer` all keep the web tools (`src/agents.js:156-204`). The concept is being written to `concepts/role-delegation-and-web-access.md`; it has to settle first whether the wake machinery carries a nested spawn.

