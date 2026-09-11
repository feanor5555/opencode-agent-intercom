# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- Decide O2 in `specs/nested-delegation.md` (the open assumption that `maxSubagents` bounds the orchestrator's attention rather than a provider rate limit or a host resource).
- Decide O4 in `specs/nested-delegation.md` (a project can open `permission.spawn` on a role through the config but cannot give it a target, because `NESTED_SPAWN_TARGETS` has no runtime counterpart).
- Verify whether `tool.execute.after` fires for MCP tools; if it does not, a subagent whose only work is an MCP call keeps the wide watchdog window instead of the silence one. The live end-to-end run that proved `after` fires could not cover the MCP case because no MCP server was reachable from that instance.
- Clarify the precedence between the `agentMode` key in `~/.config/opencode/agent-intercom.json` and the environment variable `OPENCODE_AGENT_INTERCOM_AGENT_MODE`, and make the project `CLAUDE.md` say which wins. Observed in a live isolated TUI run: the settings file's `agentMode: "solo"` took effect — the sidebar's `mode` row rendered `[solo]` and no per-agent rows appeared — although the TUI process had `OPENCODE_AGENT_INTERCOM_AGENT_MODE=orchestrator` explicitly exported in its environment. Setting the isolated copy's file to `orchestrator` then produced an orchestrator TUI. The project `CLAUDE.md` currently names the file key and the environment variable side by side as the mode's source without stating a precedence, so it is open whether the file winning is the intended rule that only needs documenting, or whether the environment variable no longer takes effect at all.

Last commit: e08ac33 fix: show endless-mode pause as [paused] with the stop cause beneath
