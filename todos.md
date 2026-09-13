# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- Decide O4 in `specs/nested-delegation.md` (a project can open `permission.spawn` on a role through the config but cannot give it a target, because `NESTED_SPAWN_TARGETS` has no runtime counterpart).
- Verify whether `tool.execute.after` fires for MCP tools; if it does not, a subagent whose only work is an MCP call keeps the wide watchdog window instead of the silence one. The live end-to-end run that proved `after` fires could not cover the MCP case because no MCP server was reachable from that instance.
- Concurrent end-to-end suite runs share one machine's `test/e2e/out` directory, one plugin project directory, and one process-global `debug.log`. Two suites at once can have their captures interleaved, file the audit reads overwritten with the other's, and their debug-log slices overlap; every driver would need to coordinate on a per-run out dir and a per-run slice window before this can run in parallel again.
- The pre-delete route move escapes the view for any live route writer whose fresh sample names the dying session, so with two TUIs attached to one server the second is navigated too. Closing it needs the panel to publish which server it is attached to.
- Who issued the abort of the `coder` subagent on 2026-09-12 at ≈20:48:27.78 is not formally settled, though the plugin's own log shows the sidebar was focused and being keyed 100 tokens at a time from 20:45:09 to 20:45:58, which fits an abort from the panel (`x`/`d` twice on the focused row). The panel now logs `tui abort issued` with target, handle and trigger, so a repeat decides it.
- The server-scoped route move (`serverIdentity`, `url:<base url>` else `pid:<pid>`) has no live run behind it: it is pinned by unit tests only, and the case it was built for — two TUIs on one machine, only the watching one moved — has not been exercised against a running `opencode serve`.
- A subagent that polls is never reaped by either watchdog window. `watchdogLimit` in `src/watchdog.js` measures the tool-call window from the start of the call currently open (`src/watchdog.js:172`, `limit.since ?? entry.lastActivityAt ?? entry.spawnedAt`), so a subagent making back-to-back short tool calls restarts its own clock at every call and no finite `maxSubagentToolCallMs` ever expires against it; `maxSubagentAgeMs` never applies either, because the entry is never silent. Observed live: a subagent polling for a file in repeated bash waits ran on unreaped until the run was killed. Open is whether a cumulative ceiling over one uninterrupted run of tool calls should exist beside the per-call one, and what it would have to be so that legitimate long tool work is not cut.
