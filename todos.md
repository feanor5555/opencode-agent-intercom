# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Acceptance criterion (f) of `specs/endless-mode.md` is unmet: that the TUI follows to the new session after the cycle replaces it. It needs a capture taken after the kickoff. The mechanism is established and works — `Xvfb`, Zutty at `/usr/bin/zutty`, and `ffmpeg` with `x11grab` writing a PNG; the two sidebar screenshots under `work/screenshots/` were made that way. Criteria (a) to (e) and (g) are met.
