# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- A repaired prompt file clears its stale-file finding only on the next opencode process: the prompt-file scan is once per directory per process, so a mid-session edit is reported as stale until the next restart. The trade-off is the stability of the block in the orchestrator's cached system prompt; the cure is either a rescan trigger on edit (loses byte-stability) or a per-file re-evaluation that re-issues the finding instead of patching the block in place.
