# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Change the subagent label to three parts in this order: the agent name first (e.g. `Researcher`), then the topic it is working on (e.g. `Searching for latest Spring API`), then the model in parentheses (e.g. `(Luna)`).
- Make sure prompt caching is not degraded by the system-prompt injection this plugin performs.
- Check whether the orchestrator respects the maximum context size of a subagent and does not cut work packages that are too large for it.
