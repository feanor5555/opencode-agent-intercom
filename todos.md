# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.

## Pending

- `promptSession`, `deleteSession`, `abortSession`, `updateSessionTitle` and `archiveSession` in `src/client.js` still read a resolved failure envelope as success, so a 4xx/5xx on the spawn task prompt, the handoff kickoff, the DOC_SUMMARY prompt or a teardown call passes silently. The concept for the uniform repair is `concepts/client-failure-contract.md`; carrying it out changes the failure contract of `spawn`, the handoff and teardown and touches their suites.
- The test "a parent deleted with its children is not woken for them" in `test/retention-drop-notice.test.js` feeds the parent's `session.deleted` first, an order that never occurs on a real server; it pins the already-seen fast path and the real-order case now stands beside it. Decide whether the artificial-order case stays.

Last commit: ee55aa7 fix: read a subagent's last text after the flush, not before it
