# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.

## Pending

- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Its name has never been captured; capture it next time the suite fails.
- Decide the endless e2e driver's trigger-timing: in the after-fix run the spawned `coder` had already finished when the ceiling was crossed, so `activeAtStart=0` and the driver ends at 8/9 although the work-off criterion itself passed. Either the driver must hold a subagent active until the trigger (raise `SUBAGENT_SLEEP_S` or gate the trigger on an active subagent) or the criterion must stop requiring an active subagent. Same run also shows the ceiling only fires reliably at `ENDLESS_CONTEXT=2500`; at exactly 3000 one attempt did not cross — the trigger-timing question above covers it.
- Establish whether the endless successor works off ALL saved tasks: the after-fix run saved T1 and T2 (2 saved tasks), but the captured successor turn contained 1 spawn, naming T1 only on its first prompt line — T2 got no spawn. Confirm in a later successor turn whether T2 is then spawned, and if not decide whether the kickoff must ask for one spawn per task more insistently.
- Decide whether to ask GitHub Support to delete the GitHub-managed ref `refs/pull/1/head` of the public repository, which still serves pre-rewrite history: 34 commits carrying the developer home directory `/home/user` (about 2000 lines, in `test/e2e/*`, `test/e2e/golden/*` and `test/fixtures/agent-task-snapshots/*`) and the LAN address `192.0.2.45` in `test/fixtures/agent-task-snapshots/requests.jsonl`. A force-push cannot reach that ref and the repository owner cannot delete it; only GitHub Support can. The API keys are NOT affected — they are absent from that ref too.
