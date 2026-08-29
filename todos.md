# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Priced decision awaiting the user: opencode writes Anthropic's `{ type: "ephemeral" }` cache marker with no `ttl`, i.e. the five-minute default, and the orchestrator's spawn-wait-wake rhythm routinely exceeds that, so a prompt-caching fix buys hits only for turns closer together than five minutes. The one-hour TTL would address it but costs twice the base input price per cache write, and whether opencode merges a plugin-supplied `providerOptions` is unverified. Do not implement without the user's answer.
- Strip the orchestration tools from every spawnable agent, not only from the plugin's own roles. `installAgents` (`src/agents.js:130`) applies the strip over its own roles, so a spawned `general` — or a project agent like `scribe` — still carries `spawn`, `abort` and `list` in its schema and is refused only at runtime by `src/tools.js:200`. Pre-existing, but more reachable since the spawn gate accepts the server's spawnable agents.
