# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.
- `main` is at `f1a6b59`, which carries the endless keep-working change set. Standing uncommitted in the working tree: the instance-restart reconcile (`src/instancerestart.js`, wired through `src/index.js`, `src/client.js`, `src/hooks.js`, `src/notices.js`, `src/noticejournal.js`, `src/state.js`, pinned by `test/instance-restart.test.js`, described in `README.md` and `specs/sidebar-liveness.md`) and the refreshed `src/…` line citations in `test/e2e/endless-optical-proof.sh`.

## Pending

- **Stop the e2e isolation from writing the real plugin cache — this is the point to continue with.** `e2e_iso_create` in `test/e2e/config-isolation.sh` (line 279) symlinks the machine's `~/.cache` into the throwaway HOME (`ln -s "${HOME}/.cache" "$E2E_ISO_HOME/.cache"`, header lines 31-34: kept so the drivers find the debug log at `~/.cache/opencode-agent-intercom/debug.log`), and the run's `XDG_CACHE_HOME` points at that link. Every state file the plugin keeps under `cacheDir()` therefore lands in the productive `~/.cache/opencode-agent-intercom/` — `endless-cycles.json` (`endlessCycleFilePath`, `src/endlesscycle.js`), `notice-journal/`, `results/`, `endless-pauses.json` — which contradicts the project rule that a harness run never writes productive state. Isolate the cache and hand the drivers the debug-log path through the env `src/log.js` already reads.
- **Make `test/e2e/endless-task.sh` clean up `~/testopencode/work/cycle-state.md`.** The cycle-2 wind-down planner writes `/home/wu/testopencode/work/cycle-state.md` in the drivers' working directory, and the driver leaves it behind after the run.
- **Test the instance-restart reconcile against a real opencode dispose.** `src/instancerestart.js` reconciles the runs an opencode instance dispose cuts off; it is covered only by the unit suite `test/instance-restart.test.js` against simulated events and has never met a real `opencode serve` disposing and rebuilding a project's instance.
- **Relax the e2e preflight `quiesce_window_conflict`.** `test/e2e/endless-task.sh` refuses a run where `maxSubagentToolCallMs` is `0`, non-numeric, or `+ 30000 >= ENDLESS_QUIESCE_TIMEOUT_MS`, on the ground that the quiesce would abandon while a stuck subagent is in flight; the quiesce now re-arms its deadline on every poll that sees a subagent of the primary running (`src/endless.js`), so the check is stricter than needed. Loosening it touches the driver and its pin in `test/e2e-endless-task.test.js`.
