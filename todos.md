# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Check whether the orchestrator respects the maximum context size of a subagent and does not cut work packages that are too large for it.
- Make `test/e2e/server-lifecycle.sh` detect and refuse being called from a subshell rather than relying on its header comment. A `tee` pipeline around `e2e_server_start` has orphaned a server twice in separate runs; in the second case the operator had read the header warning and piped it anyway, so the comment is not sufficient. `e2e_server_start` should fail loudly when it finds it is not running in the caller's shell.
