# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Clean up after a failed `e2e_server_start`. It creates the log file and deletes the pid file (`test/e2e/server-lifecycle.sh:164-165`) before the `setsid` wrapper writes the pid; if the wrapper never does, the function fails at `:174-176` and leaves a capture directory holding only `00-suite.server.log`. Nothing removes it afterwards. The `!work/**/*.log` rule in `.gitignore` makes such a leftover visible to `git status`, but the failed-start path should clean up after itself.


