# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- `test/retention-texts.test.js` flakes intermittently in a full run — a different test name each time, always green in isolation and on a re-run. Its name has never been captured; capture it next time the suite fails.
- Rewrite the eight `Source:` pointers in `learnings.md`, which reference files under `work/`; `work/` is no longer tracked, so they resolve locally but dangle for anyone reading the published repository.
- Submit the prepared request to GitHub Support at `support.github.com/request/remove-data`, category "Remove pull requests", asking it to dereference `refs/pull/1/head` (tip `df751e9`, 34 commits, none reachable from `main`) and clear the cached views. The draft is prepared locally and awaits review; submitting needs the logged-in account, so only the repository owner can do it. Expect a possible refusal: no credentials are on that ref, GitHub does not remove non-sensitive data, and the sole fork belongs to a third party who alone can clean it.
