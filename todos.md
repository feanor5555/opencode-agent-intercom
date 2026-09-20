# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired globally in `~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json`; `e2e_plugin_wired` accepts that server wiring and `e2e_tui_plugin_wired` the TUI wiring, and `~/testopencode` remains the drivers' working directory. TUI captures currently run against the fixture `/tmp/intercom-retention-project`, which wires the same absolute path — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.
- `work/` is untracked local scratch (not in any commit), so `todos.md` items must state their evidence self-containedly and not cite a `work/` path.
- The automatically captured session material that was removed from the repository is archived on the house share as `opencode-agent-intercom-captured-session-material-2026-08-31.md`.
- `~/.config/opencode/agent-intercom.json` currently holds `endlessContext: 20000` (lowered from 88000 for the endless e2e test on 19 Sep); the original is backed up at `work/e2e-endless-low-context/agent-intercom.json.orig` and has not been restored yet.
- The endless-mode repair and context-figure change set is committed on `main` and pushed (HEAD `85ce0af`; the set: `84dbfaf`, `53b5f27`, `6015839`, `b429c55`, `974e48b`, `85ce0af`); the working tree is clean. The shared figure lives in `src/context-figure.js`, the optical-proof driver in `test/e2e/endless-optical-proof.sh`, and `specs/endless-mode.md` and `README.md` document both as finished — no concurrent edit is outstanding on them.

## Pending

- **`test/e2e/README.md` does not yet list the `endless-optical-proof.sh` driver — this is the point to continue with.** The driver exists at `test/e2e/endless-optical-proof.sh` and fired one endless cycle end to end, but the README names no optical-proof run: add its table entry and its run note — default model `cliproxy/gpt-5.6-luna` reaches the 12000-token ceiling only after ~190 repeats and was never run end to end; the verified invocation is `E2E_MODEL=cliproxy/qwen3.8-flash-medium` (~110 repeats, ~15 min); artefacts land in `work/endless-optical-proof-run/` (four PNGs: before / crossed / fired / successor, plus the cycle's debug log); `KEEP_SERVER=1` leaves the stack up. This is the only open item; with it done there is no further pending work on the list.
