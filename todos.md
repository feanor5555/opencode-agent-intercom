# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Its name has never been captured; capture it next time the suite fails.
- Establish whether the endless successor works off ALL saved tasks: the after-fix run saved T1 and T2 (2 saved tasks), but the captured successor turn contained 1 spawn, naming T1 only on its first prompt line — T2 got no spawn. Confirm in a later successor turn whether T2 is then spawned, and if not decide whether the kickoff must ask for one spawn per task more insistently.
- Decide whether to ask GitHub Support to delete the GitHub-managed ref `refs/pull/1/head` of the public repository, which still serves pre-rewrite history: 34 commits carrying the developer home directory spelled literally under the user name (about 2000 lines, in `test/e2e/*`, `test/e2e/golden/*` and `test/fixtures/agent-task-snapshots/*`) and a private LAN address of the house network in `test/fixtures/agent-task-snapshots/requests.jsonl`. A force-push cannot reach that ref and the repository owner cannot delete it; only GitHub Support can. The API keys are NOT affected — they are absent from that ref too. That same ref also still serves the recorded session captures that were deleted from the working tree and purged from every branch and tag (25 objects under the two capture directories are reachable from it and from nothing else).
- Draft the GitHub Support request that would delete the pull-request ref (the existing item covers the decision itself; this notes that the drafting was offered and is undecided).
- Rewrite the eight `Source:` pointers in `learnings.md`, which reference files under `work/`; `work/` is no longer tracked, so they resolve locally but dangle for anyone reading the published repository.
- Remove or give a purpose to the `print_setup >/dev/null` call near the end of `test/e2e/endless-task.sh`: it discards its own output and does nothing.
