# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- The server-scoped route move (`serverIdentity`, `url:<base url>` else `pid:<pid>`) has no live run behind it: it is pinned by unit tests only, and the case it was built for — two TUIs on one machine, only the watching one moved — has not been exercised against a running `opencode serve`.
- A subagent that polls is never reaped by either watchdog window. `watchdogLimit` in `src/watchdog.js` measures the tool-call window from the start of the call currently open (`src/watchdog.js:172`, `limit.since ?? entry.lastActivityAt ?? entry.spawnedAt`), so a subagent making back-to-back short tool calls restarts its own clock at every call and no finite `maxSubagentToolCallMs` ever expires against it; `maxSubagentAgeMs` never applies either, because the entry is never silent. Observed live: a subagent polling for a file in repeated bash waits ran on unreaped until the run was killed. Open is whether a cumulative ceiling over one uninterrupted run of tool calls should exist beside the per-call one, and what it would have to be so that legitimate long tool work is not cut.
- The end-to-end driver for the run ceiling is not written: `test/e2e/run-ceiling-task.sh`, as `concepts/subagent-run-ceiling.md` specifies it — three phases (a poller with a `neither-old` criterion proving neither existing window could have fired, a control phase in which a single long call is NOT cut, and a hand-back phase that records `NOT ASSERTED` when the model ignores the wrap-up band), with its own server on `RUN_CEILING_PORT` and `OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1` so the injected band can be asserted without touching the session. It has to be wired into `run-all.sh` after `context-bands-task.sh` and its model audit needs the new key in the isolated `agent-intercom.json`.
- The run ceiling has no live end-to-end run behind it at all — it is pinned by unit tests only.
- `CLAUDE.md` does not yet describe the run ceiling: the third watchdog window `maxSubagentRunMs` (default 2640000) with the per-type `agentRunMs`, the per-run stamp `entry.runStartedAt` that nothing the subagent does renews (re-seeded on `reuse` but not moved by activity, unlike `lastActivityAt`), and the wrap-up band at three quarters of the ceiling naming the two moves the subagent has (hand back with a `Blocked:` line, or `ask` the caller). `CLAUDE.md` is untracked, so this is an edit to make in place.
