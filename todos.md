# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Pull the server lifecycle out of `test/e2e/endless-task.sh` into a piece the whole harness shares, and put `run-all.sh` on it, so every e2e run starts a fresh server against the working tree instead of inheriting whatever plugin build an already-running server happens to carry. `run-task.sh` and `multi-task.sh` talk to a server that is already up and have that flaw today. The lifecycle must also run `npm run build` in `tui/`, because the TUI half is served from `tui/dist/tui.js` and a restart alone leaves the sidebar on the old code, while the server half is plain JavaScript loaded by absolute path and needs only the restart.
- Acceptance criterion (f) of `specs/endless-mode.md` is unmet: that the TUI follows to the new session after the cycle replaces it. It needs a capture taken after the kickoff. The mechanism is established and works — `Xvfb`, Zutty at `/usr/bin/zutty`, and `ffmpeg` with `x11grab` writing a PNG; the two sidebar screenshots under `work/screenshots/` were made that way. Criteria (a) to (e) and (g) are met.
