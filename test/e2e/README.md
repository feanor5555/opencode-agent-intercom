# End-to-end agent tests

Live regression suite that talks to a real `opencode serve` instance, drives the
orchestrator through real spawns, and captures the resulting message tree.
Used to validate that plugin changes don't silently break agent behaviour and
that opencode upgrades don't shift the system-prompt composition.

## Layout

- `run-task.sh <agent> <task> <prefix>` — single-agent harness. Creates one
  primary session, asks the orchestrator to do nothing but `spawn(agent, task)`,
  polls until the orchestrator session settles, dumps the full message tree.
- `multi-task.sh` — multi-agent harness. Drives a planner → coder → reviewer
  → gitter pipeline that adds `bytes(n)` to `src/format.js`.
- `endless-task.sh` — endless-mode harness. Drives one full endless cycle and
  asserts its steps in order; see "Endless mode" below.
- `nested-task.sh` — nested-delegation harness. Drives one nested spawn
  (orchestrator → coder → researcher) and asserts it; see "Nested delegation"
  below.
- `run-all.sh` — runs the 8 single-agent tests, the multi-agent test and the
  endless-mode cycle. Owns the server the first ten use: builds the TUI, starts
  a fresh `opencode serve` in the configured directory (default
  `/home/user/testopencode`), and stops it again on the way out.
- `server-lifecycle.sh` — sourced library, not a driver. Holds the four server
  steps `run-all.sh` and `endless-task.sh` share: `e2e_build_tui`,
  `e2e_server_start`, `e2e_server_wait_ready`, `e2e_server_stop`, plus
  `e2e_plugin_wired` (global and project wiring alike), `e2e_server_alive`,
  `e2e_server_url` and the subshell guard `e2e_require_caller_shell`. Covered by
  `test/e2e-server-lifecycle.test.js`, which drives it against a stub server.
- `golden/` — reference captures from 2026-05-16 (opencode 1.15.0, omnicoder
  Qwen3.5-9B). Diff fresh `out/*.full*.json` against these to detect drift.
- `out/` — created at runtime; `.gitignore` covers it.

## How to run

`run-all.sh` needs no server of its own started by hand. It builds
`tui/dist/tui.js` — the sidebar is served from that bundle, so a restart alone
would keep the previous one — then starts `opencode serve` on `RUN_ALL_PORT`
(4567) in `PROJECT_DIR` (default `/home/user/testopencode`), waits for
`/global/health`, exports `OPENCODE_URL` for the drivers, and stops the server's
process group again on the way out, including on a failing driver and on
Ctrl-C. Every run therefore uses the plugin code in the working tree against the
wired test project.

```bash
# 1. Run the suite:
cd /home/user/opencode-agent-intercom
bash test/e2e/run-all.sh

# 2. Diff against the golden reference (loose — message IDs and timestamps
#    change every run; the interesting bits are subagent picks, tool calls
#    and final orchestrator text):
python3 - <<'PY'
import json, sys
from pathlib import Path
for f in sorted(Path("test/e2e/golden").glob("*.json")):
    cur = Path("test/e2e/out") / f.name
    if not cur.exists():
        print(f"missing: {cur}"); continue
    g = json.load(open(f))
    c = json.load(open(cur))
    print(f"{f.name:40s} golden={len(g)} msgs  current={len(c)} msgs")
PY
```

`run-task.sh` and `multi-task.sh` keep their own env contract — `OPENCODE_URL`,
`PROJECT_DIR`, `OUT_DIR` — and stay usable on their own against a server that is
already running:

```bash
OPENCODE_URL=http://127.0.0.1:4567 \
  bash test/e2e/run-task.sh coder "What does src/log.js do?" 03-coder
```

`run-all.sh` refuses to start when something already answers on its port; give
it a free one with `RUN_ALL_PORT` or stop the other server. Its own server log,
pid file and health capture land in `out/00-suite.*`.

**The plugin has to be wired where the server will read it.** A server that
loads neither half comes up with no `spawn` tool and no diagnostic saying so, so
`run-all.sh` checks the wiring before it starts anything and exits `2` with the
remedy if it finds none. `e2e_plugin_wired` accepts four forms, and one is
enough:

| scope | form |
|---|---|
| global | `plugin` array of `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json` naming the plugin root |
| global | a drop-in under `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin/` or `plugins/` |
| project | `plugin` array of `$PROJECT_DIR/opencode.json` naming the plugin root |
| project | a drop-in under `$PROJECT_DIR/.opencode/plugin/` or `plugins/` |

```json
{ "plugin": ["/home/user/opencode-agent-intercom"] }
```

On this machine the wiring is global — that entry stands in
`~/.config/opencode/opencode.json` (and the TUI half's in
`~/.config/opencode/tui.json`) — so the check passes in any directory, the
`PROJECT_DIR` default `/home/user/testopencode` included, which carries no
`opencode.json` of its own. The default is kept for what it still decides: the
server's working directory and the `?directory=` every session is created with,
which is what keeps subagent reads on real paths (see "Known caveats").

`endless-task.sh` and `nested-task.sh` make the same check against
`ENDLESS_PROJECT_DIR` and `NESTED_PROJECT_DIR`.

Settings used for the golden references:
- `~/.config/opencode/agent-intercom.json` → `maxSubagents: 8, maxContext: 130000`
- `opencode serve` started in `/home/user/testopencode`
- llama-server: omnicoder (`Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`)
  with reasoning on, the params from `start-qwen.sh`
- Multi-agent test: 4 subagent spawns (planner / coder / reviewer / gitter), all
  status=completed, ~6:26 min wall-clock, 92 messages, produces `bytes()` in
  `src/format.js` plus 5 unit tests in `test/plugin.test.js`

## Endless mode

`endless-task.sh` is the one driver that does **not** use the server
`run-all.sh` starts. A cycle needs endless mode armed with a threshold low
enough to be crossed in one turn, and it is read off the plugin's debug log, so
the driver starts its own server on its own port and tears it down again,
through the same `server-lifecycle.sh`:

```bash
bash test/e2e/endless-task.sh                       # defaults, ~3-5 min
ENDLESS_CONTEXT=6000 SUBAGENT_SLEEP_S=20 \
  bash test/e2e/endless-task.sh                     # cheaper still
ENDLESS_PROJECT_DIR=/home/user/testopencode \
ENDLESS_PORT=4599 KEEP_SERVER=1 \
  bash test/e2e/endless-task.sh                     # leave the server up
```

Exit `0` = every asserted criterion passed, `1` = at least one failed, `2` =
preflight/setup error (nothing was asserted). Each criterion is reported as
`PASS`/`FAIL` with the evidence line that decided it; the run's captures,
backups and report land in `out/11-endless.*`.

What it asserts, in this order, against `specs/endless-mode.md` §3.1 and its
live criteria §7:

| criterion | evidence |
|---|---|
| trigger | `endless: scheduled` for the primary, with `ctx` and `threshold` |
| (a) freeze | `spawn refused: endless cycle in progress` after a post-trigger `spawn` |
| (b) quiesce | `notified primary of completion` appears **before** `endless: quiesced …, activeAtStart>=1` |
| (c) save | `endless: saved N point(s) as T…`, every id present as `- T<n>:` in the todo file, exactly one todo file in the directory |
| (d) replacement | `endless: cycle K/M complete, new session …`; the new session is readable, the old one is readable **and** archived |
| kickoff | the new session carries `## Endless mode — work off the todo file` naming exactly the ids of (c) |
| order | the five log lines appear in that order in the debug-log slice |

Not asserted, and reported as such rather than silently passed: §7 (e) work-off
(`test/e2e/todo-driver.mjs` covers the `DONE: T<n>` path on its own), and §7
(f) view switch and (g) sidebar, which need a screenshot of the rendered TUI.

Parameters are env vars with cheap defaults — `ENDLESS_PROJECT_DIR`,
`ENDLESS_PORT`, `ENDLESS_CONTEXT` (8000), `ENDLESS_MAX_CYCLES` (1),
`ENDLESS_QUIESCE_TIMEOUT_MS`, `SPAWN_AGENT`, `SUBAGENT_SLEEP_S`,
`TURN_TIMEOUT_S`, `STEP_TIMEOUT_S`, `SERVER_START_TIMEOUT_S`, `POLL_S`,
`OUT_DIR`, `KEEP_SERVER`, `E2E_TUI_BUILT`. The resolved setup is printed at the
top of every run and again into `out/11-endless.report.txt`, so a run can be
reproduced from its own output.

Run on its own it builds the TUI first, like `run-all.sh`; started *by*
`run-all.sh` it skips that build, because `E2E_TUI_BUILT=1` is exported once the
suite has built.

Three things the lifecycle library is deliberate about:

- **The readiness probe watches the server, not a wrapper.** It starts the
  server as `setsid bash -c 'cd …; echo $$ > pidfile; exec opencode serve …'`,
  so the recorded pid *is* the opencode process — a wrapper pid would exit while
  the child kept running and the probe would report a false failure. After the
  health check it confirms `/proc/<pid>/cmdline` is an opencode.
- **A step that does not happen fails loudly.** Every wait ends on the expected
  log line, on an `endless: abandoned at …` line, on the server dying, or on its
  timeout — the last two are `FAIL` with the reason, never a silent pass.
- **`e2e_server_start` refuses to run in a subshell.** The pid, the process
  group and the caller's `trap … EXIT` all live in the shell that calls it, so a
  call inside a pipeline, a command substitution, a background job or `( … )`
  would start a server nothing can stop again — that leaked a running
  `opencode serve` twice. The function compares `$BASHPID` against `$$`, and
  where they differ it starts nothing and returns 1 with the remedy on stderr.
  Call it directly in your own shell; to keep a transcript, redirect that call
  to a file (`e2e_server_start … >> run.log 2>&1`) or pipe the whole driver
  instead of the single call (`bash test/e2e/run-all.sh 2>&1 | tee run.log`),
  which keeps the state in the driver's own shell and is unaffected.

`ENDLESS_MAX_CYCLES=1` is what keeps the loop from running on: the cycle the
driver asserts completes, and the next one stops at the ceiling and switches
endless mode off. The driver backs up and restores
`~/.config/opencode/agent-intercom.json` (the plugin writes `endlessMode: false`
into it itself when a bound fires) and the driven project's todo file, deletes
the two sessions of the cycle, and stops the server's process group.

## Nested delegation

`nested-task.sh` is the live proof of the delegation rule
(`concepts/role-delegation-and-web-access.md`, step S7): a granted role spawns a
`researcher`, blocks, and gets the child's reply as the result of its own
`spawn` call. Like `endless-task.sh` it owns its server — its own port
(`NESTED_PORT`, default 4602) and its own debug-log offset — but unlike it, it
writes no settings key and so has nothing to restore.

```bash
bash test/e2e/nested-task.sh                            # defaults, ~3-5 min
OUT_DIR=/somewhere/kept bash test/e2e/nested-task.sh    # keep the captures
NESTED_CALLER=planner NESTED_DENIED_ROLE=researcher \
  bash test/e2e/nested-task.sh                          # other roles
```

Exit `0` = every asserted criterion passed, `1` = at least one failed, `2` =
preflight/setup error. Captures and report land in `out/12-nested.*`.

| criterion | evidence |
|---|---|
| grant | `GET /agent` carries no `spawn` deny rule on the five delegating roles and one on the other three |
| admitted | `nested spawn: caller blocks until its child ends` with `callerAgent` = the caller's role |
| survives | orchestrator, blocked caller and child all answer `200` on `GET /session/<id>` in every probe round of the wait |
| result | the caller's own `spawn` tool result reads `<handle> (researcher) finished and is gone. Its reply:` and holds the marker line the child was told to reply with |
| not-a-wake | zero `🔔 agent-intercom: your subagent` in the caller's transcript |
| target | the caller's spawn of a non-researcher returns `Spawn refused: a subagent may spawn a "researcher" and nothing else` |
| woken | `🔔 agent-intercom: your subagent "<handle>" (<role>) has finished and been destroyed.` in the primary |
| nested-line | `⤷ nested: 1 run, …(not counted in the figure above).` in that same notice |
| denied | a role that may not delegate has no child session under it, and the run names which of the three layers refused it |
| gone | both subagent sessions answer `404` afterwards |
| clean | no `subagent timed out (inactivity)`, no `subagent llm error`, no `FOREIGN KEY` in the server log |
| todo | the project's todo file is byte-identical — a nested spawn carries no task id |

Not asserted, and reported as such: the nested quota's own refusal (it needs a
caller that exhausts `maxNestedSpawns`; `test/nested-delegation.test.js` covers
it), and the sidebar's grandchild row, which needs a screenshot.

**Both subagent sessions are deleted the instant they finish**, so the driver
snapshots their message trees in a loop while they are alive and keeps the last
non-empty snapshot. A transcript taken after the run is empty — a `404` — and
every assertion made on it would pass vacuously.

## Why the harness polls instead of streaming

opencode's blocking `/session/<id>/message` endpoint returns after the
orchestrator's FIRST turn (the one that called `spawn`), but the actual subagent
work and the orchestrator's post-wake reply happen asynchronously after that.
Polling the message count until it's stable for ~25 s gives the same coverage
without subscribing to the event stream.

## Known caveats

- **Subagent reads must be inside the session's project directory.** opencode
  1.15 stalls reads outside the session `directory` on a headless permission
  prompt — the harness creates every session with `?directory=$PROJECT_DIR` and
  task prompts use relative paths against that root.
- **Designer test depends on the `gen` CLI** and Stable Horde / Pollinations
  being reachable. Expect 20-90 s wall-clock per image.
- **Researcher test hits the public Exa MCP endpoint** (anonymous, 150/day).
  Skip or expect 429 if running the suite repeatedly.
- The bytes() implementation and its tests are themselves a test artifact
  from the multi-agent run (kept on purpose — see `src/format.js`). If you
  revert them, the multi-agent run will recreate them on the next pass.
