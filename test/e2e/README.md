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
- `endless-task.sh` — endless-mode harness. Seeds the driven project's todo
  file, then drives two endless cycles in sequence — the second from the file
  and the session the first left behind — asserts each cycle's steps in order
  and, once over the cycles together, that a carried-over task id was re-titled;
  see "Endless mode" below. Its seed and its work-off gates are covered by
  `test/e2e-endless-task.test.js`, which runs them without a server.
- `nested-task.sh` — nested-delegation harness. Drives one nested spawn
  (orchestrator → coder → researcher) and asserts it; see "Nested delegation"
  below.
- `message-task.sh` — mid-run MESSAGE harness. Spawns a subagent on three slow
  shell steps, waits until its session really shows a running tool call, has the
  orchestrator `message(...)` it, and asserts the delivery moment off the
  subagent's own session: the framed block landed inside that call, sits between
  two steps of the same run, the next step began once the call returned, and no
  tool call started after it. See "The mid-run channel" below.
- `ask-task.sh` — mid-run ASK harness. Spawns a subagent whose task cannot start
  before one decision, lets it `ask`, answers from the orchestrator, and asserts
  that the answer came back as the output of the subagent's own `ask` call.
- `todo-driver.mjs` — TODO.md auto-tracking harness. Drives DONE and BLOCKED
  markers through the wake hook and checks the resulting file.
- `run-all.sh` — runs the 8 single-agent tests, the multi-agent test, the two
  mid-run drivers and the endless-mode cycles. The mid-run drivers are the only
  ones in it that assert: a failed criterion of theirs does not stop the suite —
  the endless cycle still runs — but it decides the suite's exit code at the
  end. Owns the server the first ten use: builds the TUI, starts
  a fresh `opencode serve` in the configured directory (default
  `$HOME/testopencode`), and stops it again before the endless driver, which
  needs no server of this suite's and would be contaminated by its sessions —
  and once more on the way out, for every path that does not reach that stop.
- `lib/` — the Python evidence readers used by `endless-task.sh` (the kickoff
  ids, the successor's first turn, and the child session id of the driver's own
  spawn), plus their shared recursive payload walker; `midrun-message.py` and
  `midrun-ask.py`, the readers the two mid-run drivers decide on, covered
  without a server by `test/e2e-midrun-readers.test.js`; and
  `midrun-common.sh`, the report lines, session calls, capture and debug-log
  slice those two share.
- `config-isolation.sh` — sourced library, not a driver. Builds the throwaway
  opencode configuration a run is carried out in (`e2e_resolve_model`,
  `e2e_iso_create`, `e2e_iso_remove`), and audits what answered
  (`e2e_model_audit`, `e2e_audit_subagent_sids`, `e2e_audit_fetch_sessions`).
  See "What a run touches" below. Covered by
  `test/e2e-config-isolation.test.js`, which builds a configuration against a
  fake machine config and drives the audit over fixture captures.
- `lib/model-audit.py` — the audit's reader: every assistant message in the
  captures it is given, tallied by the `providerID`/`modelID` opencode stamps
  on it. Exit `0` all on the pin, `1` any other model, `2` nothing to audit.
- `server-lifecycle.sh` — sourced library, not a driver. Holds the four server
  steps `run-all.sh` and `endless-task.sh` share: `e2e_build_tui`,
  `e2e_server_start`, `e2e_server_wait_ready`, `e2e_server_stop`, plus
  `e2e_plugin_wired` and `e2e_tui_plugin_wired` (global and project wiring
  alike, server half and TUI half), `e2e_server_alive`,
  `e2e_server_url` and the subshell guard `e2e_require_caller_shell`. Covered by
  `test/e2e-server-lifecycle.test.js`, which drives it against a stub server.
- `out/` — created at runtime; `.gitignore` covers it. Every driver writes its
  message-tree capture there. A capture is the output of the run that produced
  it and is not committed; a driver decides pass or fail from its own assertions
  on the live session, not from a comparison against a stored capture.

## How to run

`run-all.sh` needs no server of its own started by hand. It builds
`tui/dist/tui.js` — the sidebar is served from that bundle, so a restart alone
would keep the previous one — then starts `opencode serve` on `RUN_ALL_PORT`
(4567) in `PROJECT_DIR` (default `$HOME/testopencode`), waits for
`/global/health`, exports `OPENCODE_URL` for the drivers, and stops the server's
process group again on the way out, including on a failing driver and on
Ctrl-C. Every run therefore uses the plugin code in the working tree against the
wired test project.

That server is stopped **before `endless-task.sh` starts**, not only in the exit
trap. The endless driver arms endless mode in the global settings file every
opencode instance on the machine reads, and it asserts on the todo file of
`PROJECT_DIR` — the directory this server's own sessions were created in. A
session left alive there is a second primary under the same low ceiling: a
straggler subagent wakes it, its next turn crosses the threshold, and it runs a
wind-down cycle of its own that rewrites the todo file the endless driver reads
and appends to the process-global debug log the driver slices. Nothing after the
multi-agent driver uses the suite server, so it goes down there; the trap's own
stop is then a no-op.

```bash
cd ~/opencode-agent-intercom
bash test/e2e/run-all.sh
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

**Both halves have to be wired where opencode will read them.** A server that
loads neither half comes up with no `spawn` tool and no diagnostic saying so,
and a TUI whose own half is unwired shows no sidebar however the server is
wired. `run-all.sh` checks both before it starts anything and exits `2` with the
remedy if either is missing. `e2e_plugin_wired` covers the server half and
accepts four forms, one of which is enough:

| scope | form |
|---|---|
| global | `plugin` array of `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json` naming the plugin root |
| global | a drop-in under `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin/` or `plugins/` |
| project | `plugin` array of `$PROJECT_DIR/opencode.json` naming the plugin root |
| project | a drop-in under `$PROJECT_DIR/.opencode/plugin/` or `plugins/` |

`e2e_tui_plugin_wired` covers the TUI half. The TUI reads a plugin list of its
own and never the server's, so the entry above does nothing for it; there is no
drop-in directory on this side, only a `plugin` entry, and again one of the
three places is enough:

| scope | form |
|---|---|
| global | `plugin` array of `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/tui.json` or `tui.jsonc` |
| project | `plugin` array of `$PROJECT_DIR/tui.json` or `tui.jsonc` |
| project | `plugin` array of `$PROJECT_DIR/.opencode/tui.json` or `tui.jsonc` |

```json
{ "plugin": ["/absolute/path/to/opencode-agent-intercom"] }
```

When it refuses, it lists every one of those files, keeping a file that does not
exist apart from one that exists without the entry, and prints the remedy.

On this machine both wirings are global — that entry stands in
`~/.config/opencode/opencode.json` for the server half and in
`~/.config/opencode/tui.json` for the TUI half — so both checks pass in any
directory, the `PROJECT_DIR` default `$HOME/testopencode` included, which
carries no config of its own. The default is kept for what it still decides: the
server's working directory and the `?directory=` every session is created with,
which is what keeps subagent reads on real paths (see "Known caveats").

`endless-task.sh` and `nested-task.sh` make the same two checks against
`ENDLESS_PROJECT_DIR` and `NESTED_PROJECT_DIR`.

The setup the drivers are written against:
- `agent-intercom.json` → `maxSubagents: 8, maxContext: 130000`, written into
  the run's own throwaway configuration, never into the machine's
- `opencode serve` started in `$HOME/testopencode`
- `E2E_MODEL` defaults to `openai/gpt-5.6-luna` — Luna, reached natively through
  the `openai` provider with ChatGPT OAuth. Every agent, the primary and the nine
  subagent roles alike, is pinned to it; `gpuserver/Qwen3.8 Flash Next` is
  refused outright, whatever `E2E_MODEL` says
- Multi-agent test: 4 subagent spawns (planner / coder / reviewer / gitter), all
  status=completed, ~6:26 min wall-clock, 92 messages, produces `bytes()` in
  `src/format.js` plus 5 unit tests in `test/plugin.test.js`

## What a run touches, and what it does not

**No run changes an opencode setting of this machine.** Every driver that owns
a server builds a throwaway `HOME` first (`e2e_iso_create`) and starts the
server with it, so the whole of `~/.config/opencode` the server sees is the
run's own: `opencode.json`, `tui.json`, `llm-models.json` and
`agent-intercom.json` are written fresh under `$TMPDIR/e2e-opencode-home.*` and
removed with it at the end. The machine's own `~/.config/opencode` is read
exactly once — for the provider block, the `AGENTS.md`, the config-directory
`node_modules` and the search credentials — and never written. `endless-task.sh`
arms its ceiling in the isolated `agent-intercom.json`, not in the machine's.

`HOME` and not `XDG_CONFIG_HOME` is the lever, because the plugin resolves its
own three files through `os.homedir()` (`src/llmmodel.js`, `src/settings.js`,
`src/llmparams.js`) and would otherwise keep reading the machine's
`llm-models.json` under any `XDG_CONFIG_HOME`.

Three paths stay shared on purpose:

| path | why |
|---|---|
| `~/.local/share/opencode` | symlinked in: `auth.json` and `opencode.db`. A fresh one has no provider credentials and no run could authenticate. Sessions are created and deleted there, as they always were. |
| `~/.cache/opencode-agent-intercom` | symlinked in, so the plugin's `debug.log` stays where every driver slices it. A cache is not a setting. |
| the driven project (`PROJECT_DIR`) | the drivers work on real files there; each puts back what it seeded (`endless-task.sh`'s todo file and fixture directory). |

And one that deliberately is not: `~/.local/state/opencode/model.json`,
opencode's per-model variant store, which `applyModelChoices` writes
(`src/variantstore.js`). The isolated home gets a state directory of its own, so
a run cannot rewrite the effort the machine shows in its TUI.

**No run uses `gpuserver/Qwen3.8 Flash Next`.** `e2e_resolve_model` refuses that
pair before anything starts, and `E2E_MODEL` reaches the agents the only way it
can: through the isolated `llm-models.json`. The model a driver names in its
POST does **not** decide what answers — `applyModelChoices` (`src/llmmodel.js`)
writes the file's entry into `config.agent[<name>].model` at instance bootstrap
and that wins; a live run was answered by Qwen although the request named
another model. The isolated file therefore pins the ten plugin roles and the
opencode built-ins that can answer a turn, with no `variant` key, and the
isolated `opencode.json` carries `model` and `small_model` for anything not
named there at all.

**Every driver then checks what really answered.** opencode stamps
`providerID`/`modelID` on every assistant message, so `e2e_model_audit` reads
them back over the run's captures — the primary sessions and every subagent
session the driver snapshotted while it was alive (`run-task.sh` and
`multi-task.sh` take those snapshots in their settle loop, off the session ids
the plugin's `spawned` lines name). A turn on another model fails the driver:
`run-task.sh` and `multi-task.sh` exit non-zero, which ends `run-all.sh`; the
asserting drivers record it as a failed `model-pin` criterion. An audit that
finds no assistant message at all fails too — an empty capture must not pass.

The one thing the audit cannot see is a subagent session that was deleted
before any snapshot reached it; for those the pin and the isolated
configuration are the evidence, and nothing in the audit's output claims
otherwise.

A driver that uses a server it does not own — `run-task.sh`, `multi-task.sh`,
`message-task.sh`, `ask-task.sh`, `todo-driver.mjs` — builds no configuration:
it inherits the `E2E_ISO_*` variables `run-all.sh` exports. Started standalone
against a server somebody else launched, it audits that server's answers but
cannot isolate its configuration — that belongs to whoever starts it.

## Endless mode

`endless-task.sh` is the one driver that does **not** use the server
`run-all.sh` starts. A cycle needs endless mode armed with a threshold the
primary is known to cross, and it is read off the plugin's debug log, so the
driver starts its own server on its own port and tears it down again, through
the same `server-lifecycle.sh`.

**Two cycles, on a seeded file.** A first cycle over a freshly created todo file
proves less than it looks: with nothing in the file, every id the wind-down
subagent writes is a fresh one, so the rule that decides whether an EXISTING
entry may be rewritten (V6, `src/endless.js`) is never reached and every check
against pre-existing entries passes over an empty comparison. That hole let the
same class of defect through four times, each failure sitting in the second
cycle on an accumulated file. The driver therefore

- seeds the project's todo file with four ids (`T101`–`T104`) inside the
  markers, human prose outside them and a `next-id T105` watermark, plus the
  fixture directory `e2e-endless-fixture/` the seeded tasks work on;
- shapes two of those entries the way the live file was shaped: `T101` produces
  `merged.md`, and `T104`'s title still says it is waiting for `T101` to produce
  exactly that file, so once `T101` is worked off and removed, `T104`'s title
  names work that is already landed and only the owner's release is left of it —
  which is what makes a wind-down subagent re-title a surviving id;
- keeps that stale entry alive past the work-off phase that would otherwise eat
  it. Every seeded task but `T101` is **gated** on a flag file under the fixture
  directory that its own `accept:` line forbids the subagent to create: a
  subagent that finds its gate absent reports blocked, no `DONE: T<n>` reaches
  the wake hook, and the plugin leaves the task in the file. The driver opens
  exactly one gate per cycle — `cycle<k>.flag`, written after cycle `k`'s
  rewrite is confirmed, while the freeze is on, the quiesce has emptied the
  flight and the successor does not exist yet — so cycle `k`'s work-off can
  finish that one task and nothing else, and `T104`, whose gate `owner.flag`
  nothing in the run writes, is still open when the last cycle winds down. This
  is what the first two-cycle run could not do: its stale entry was worked off
  inside cycle 1 and cycle 2 met a file without it;
- drives `ENDLESS_CYCLES` (2) cycles in sequence, each on the session and the
  file its predecessor left, with `ENDLESS_MAX_CYCLES` defaulting to the same
  number so the plugin's own ceiling stops the loop right after the last driven
  cycle;
- asserts every criterion **per cycle**, reading the debug log through a
  per-cycle window: the driver records the slice's line count when a cycle
  starts and no wait, count or ordering check looks at a line before it, so
  cycle 2 can never be satisfied by cycle 1's lines.

The seeded file, the fixture directory and every session of every cycle are put
back in `cleanup()`; a todo file that was there before the run is restored
byte-identically from the backup, one the driver created is removed.

```bash
bash test/e2e/endless-task.sh                       # defaults: 2 cycles, ~15-25 min
ENDLESS_CYCLES=1 bash test/e2e/endless-task.sh      # the old single-cycle run
SEED_TODO=0 bash test/e2e/endless-task.sh           # drive the file that is there
SUBAGENT_SLEEP_S=30 bash test/e2e/endless-task.sh   # shorter flight window
ENDLESS_CONTEXT=6000 bash test/e2e/endless-task.sh  # a fixed ceiling, verified
ENDLESS_PROJECT_DIR="$HOME/testopencode" \
ENDLESS_PORT=4599 KEEP_SERVER=1 \
  bash test/e2e/endless-task.sh                     # leave the server up
```

**The ceiling is derived, not guessed.** `endlessContext` is held at
`ENDLESS_CONTEXT_CEILING` (100 000 000) for the whole preparation, so no
preparation turn can start a cycle. The driver then reads the primary's real
context off `GET /session/{id}/message` — the sum `input + output + cache.read +
cache.write` of the newest assistant message with a non-zero sum, which is what
`latestContextTokens` (`src/client.js`) compares against `endlessContext` — and
writes the key at `ENDLESS_CONTEXT_MARGIN` (1 000) below that measurement. The
next turn's transform hook re-reads the same figure and latches. Giving
`ENDLESS_CONTEXT` a value uses it verbatim and **verifies** it against the
measurement instead: a value the session never reaches ends the run as a setup
error naming both numbers. Where the ceiling is not crossed within
`STEP_TIMEOUT_S` the trigger criterion fails with the armed threshold, the
measured context and the context read again at that moment.

**The in-flight subagent is observed, not assumed.** The run is sequenced
turn 1 open points → turn 2 the one `spawn` → arm the ceiling → turn 3 the
crossing → turn 4 the post-trigger spawn attempt. The driver puts a marker of its own into that
spawn's prompt, polls the primary's messages for the `spawn` tool call carrying
it (`lib/spawn-child.py`), takes the child session id off that call's metadata,
and only then reads the handle out of the plugin's `spawned` line for that
session; from the second cycle on the primary is a successor still working its
todo file off, so it spawns subagents of its own at the same time and neither
the role nor the absence of a task-id prefix would pick the driver's subagent
out. The subagent counts as in flight until `notified primary of completion`
names that handle **under this primary, past the slice line of this spawn's own
`spawned` line**. Neither qualifier is optional: `releaseHandle`
(`src/registry.js`) hands a handle number back when the freed handle is the
current max, so the successor's just-finished work-off subagents carry the very
handle string this spawn then gets — with their completion already standing in
the cycle's window — and the debug log is process-global, so another opencode
instance allocates the same handle strings from a counter of its own. It checks twice, once
before arming and once immediately before the crossing turn; a subagent that
finished earlier ends the run as a **setup error (exit 2)** naming exactly that,
because criterion (b) would otherwise be asserted over a cycle that had nothing
to wait for. A completion that lands between the arming and the trigger is
caught at (b) itself, whose failure text names the two slice lines. More than
one prefix-free `spawned` line since that cycle's spawn turn is likewise a setup
error — the gate would be
watching a subagent the cycle is not waiting for.

Exit `0` = every asserted criterion passed, `1` = at least one failed, `2` =
preflight/setup error (nothing was asserted). Each criterion is reported as
`PASS`/`FAIL` with the evidence line that decided it; the run's captures,
backups and report land in `out/11-endless.*`.

What it asserts per cycle, in this order, against `specs/endless-mode.md` §3.1
and its live criteria §7 (every criterion's name carries the cycle it belongs
to, so a report says which cycle a failure sits in):

| criterion | evidence |
|---|---|
| trigger | `endless: scheduled` for the primary, with `ctx` and `threshold`, the threshold being the armed one |
| (a) freeze | `spawn refused: endless cycle in progress` after a non-conforming post-trigger `spawn` |
| (a) permit | `spawn admitted: endless wind-down permit consumed` for this primary's own session appears **exactly once** — the single-use permit admits the one conforming wind-down spawn and a second is refused |
| (b) quiesce | `notified primary of completion` appears **before** `endless: quiesced …, activeAtStart>=1`, and after the trigger line |
| (c) rewrite | `endless: wind-down confirmed N open task(s) [T…] file=…`, every confirmed id present as `- T<n>:` in the todo file, exactly one todo file in the directory, and the `next-id` watermark above every confirmed id (no id reused) |
| (c) carry-over | the accepted rewrite kept at least one id that already stood in the file when the cycle latched, and the evidence names which of those ids it re-titled |
| (d) replacement | `endless: cycle K/M complete, new session …`; the new session is readable, the old one is readable **and** archived |
| kickoff | the new session carries `## Endless mode — work off the todo file`, whose body is the todo file's own text, naming exactly the ids of (c) as `- T<n>:` lines |
| (e) work-off | the successor's first turn contains a `spawn` tool call whose `input.prompt` carries the first saved task id as the first non-empty line (`T<n>:` / `T<n>.` / `T<n>-` …) and every further spawn prompt of that turn likewise carries a saved id; the turn's per-task spawn tally rides along as evidence |
| (e) removal | a successor subagent's `DONE: T<n>` reply removes that task: `notified primary of completion` for the successor carrying `"kind":"done","id":"T<n>"`, the id one of (c)'s, and the line `- T<n>:` gone from the todo file on disk while the file itself stays — with no foreign primary having written that file since the confirmation and no line in it the confirmed rewrite did not carry |
| order | the five cycle lines — scheduled, refused, quiesced, confirmed, complete — appear in that order in the debug-log slice |

And once over the driven cycles together, after the last work-off phase:

| criterion | evidence |
|---|---|
| re-title | some cycle's accepted rewrite kept an id and gave it a **different** title; the evidence quotes the old and the new one |
| re-title (V6) | `endless: wind-down task title changed — V6 observation` names that id in that cycle's window — the plugin saw the change and accepted the rewrite instead of rejecting it |
| model-pin | every assistant message in the run's captures names `E2E_MODEL` — no turn of any cycle ran on another model |

**The carry-over criterion is what closes the vacuous-pass hole.** When a cycle
latches, the driver copies the todo file to `out/11-endless.cycle<k>.pre-todo.md`
and reads its `- T<n>:` ids and titles. After the confirmation it compares: at
least one confirmed id has to be one of those, or the criterion FAILS naming
both sets — an all-fresh rewrite exercises nothing of the path the live failures
sit on and must not be reported as a pass. Titles are compared in the plugin's
own form (trimmed, lower-cased, whitespace collapsed — `normaliseTitle`).

**The re-title is a criterion of the run, not of a cycle.** Carrying an id over
is not yet the case the live session broke on: there the id survived and its
*title* changed, because another task completing had made the old title wrong.
The seed puts that staleness in front of the LAST cycle and not every one of
them — nothing has been completed when cycle 1 winds down — so the driver
collects the re-titles of every cycle and asserts them once, after the last
work-off phase. A run in which no carried-over id was ever re-titled FAILS,
quoting each cycle's carry-over comparison and the staleness precondition it
recorded before the last cycle's first turn (whether `T101` was gone from the
file and `merged.md` on disk), so a failure says whether the condition was even
in front of the cycle. The second criterion is the plugin's own side of the same
change: V6 stopped being a gate in commit `debed11` and became an observation,
so its line is what shows the rewrite was accepted **with** the re-title rather
than rejected over it. A file that shows the change without that line is
reported as the rewrite not having reached the accepted path.

`ENDLESS_CYCLES=1` cannot produce the case at all — no work-off phase precedes
its wind-down — so a single-cycle run reports the re-title as `NOT ASSERTED`
rather than failing it.

A cycle that produces no confirmation because the plugin rejected the rewrite
reports the rejection line, with its failing conjunct, as the evidence of (c) —
so `wind-down rewrite rejected … "failed":"V6"` is legible as itself rather than
as a missing log line.

**The successor's first turn is captured whole.** The kickoff starts that turn
asynchronously, and the driver follows it to its end — every tool call, not only
up to the first spawn — into `out/11-endless.successor-first-turn.json`. The end
is read off the persisted messages: an assistant message whose `finish` is a
terminal value other than `tool-calls` or `unknown` is the turn's last step, and
a further user message (a subagent's completion notice) already belongs to the next turn;
`STEP_TIMEOUT_S` bounds the wait, and a turn still running at that bound is
judged on what it produced by then, with the evidence saying so. The evidence
line of (e) therefore ends in `first turn ended after N spawn call(s), per saved
task: T1=… T2=… T3=…`, so the distribution over the saved tasks is readable from
a run's own report.

Spawning one subagent per saved task in the first turn is deliberately **not**
asserted: `specs/endless-mode.md` §7 (e) requires a subagent for the first task,
and the kickoff of §3.5 tells the successor to work the file off top to bottom
starting with the first task, so a first turn that spawns only `T1` satisfies
the concept. The tally is what makes the actual distribution visible.

**The removal is asserted on both sides.** §7 (e) has a second half — the
`DONE: T<n>` path removes the task from the file — and the spawn prompts alone
only show the task being picked up. The driver therefore waits for the plugin's
own wake-path outcome (`autoMarkTask` → `removeTask`, `src/hooks.js`,
`src/todofile.js`), which rides on the successor's `notified primary of
completion` line as `"kind":"done","id":"T<n>"`, and then reads the todo file:
the id must be one of (c)'s, the `- T<n>:` line must be gone, and the file
itself must still be there. The log line without the file write would be a
claim, the file without the line would not say who wrote it.

It also has to be **this run's** removal that the file shows. Two guards say so,
because the file is a shared path and the log a shared file: a wind-down
confirmation or a wake-path removal naming one of this cycle's ids under a
session the run never created is reported as another primary having written the
file, and the file itself is compared against the copy taken when the rewrite
was confirmed (`out/11-endless.cycle<k>.confirmed-todo.md`) — `removeTask` only
splices lines out, so a line on disk that the confirmed file did not carry means
some other writer rewrote it. Either way the criterion FAILS naming the evidence
instead of passing on a state it cannot attribute. This step waits on
a subagent finishing real work rather than on a line the cycle emits by itself,
so it has its own bound, `WORKOFF_TIMEOUT_S` (600 s), instead of
`STEP_TIMEOUT_S`.

**The teardown runs after the last cycle's work-off phase**, and in this order:
every session of every cycle (which needs a live server), then the server, then
the todo file, then the fixture directory, then the settings file. Deleting the successor's session takes its
running subagents with it and restoring the todo file puts a removed task
straight back, so a teardown before the observation above would make the
removal unobservable; and the todo file is restored only once the server is
gone, because a late wake writes that file too and would otherwise overwrite
the restore. `KEEP_SERVER=1` keeps the server but not the sessions — those are
deleted either way, which is what ends the writing. The work-off of a cycle also
runs before the NEXT cycle starts, because its removal is what leaves that cycle
an accumulated file whose entries no longer all match the state on disk. The restore path hangs on
the baseline having been taken, not on any assertion, so it runs on a failing
run as well.

Not asserted, and reported as such rather than silently passed: §7 (f) view
switch and (g) sidebar, which need a screenshot of the rendered TUI.

Parameters are env vars with cheap defaults — `ENDLESS_PROJECT_DIR`,
`ENDLESS_PORT`, `ENDLESS_CONTEXT` (empty, i.e. derived),
`ENDLESS_CONTEXT_CEILING` (100000000), `ENDLESS_CONTEXT_MARGIN` (1000),
`SETTINGS_TTL_WAIT_S` (3, past the plugin's 2 000 ms settings cache),
`ENDLESS_CYCLES` (2), `SEED_TODO` (1 — the seeded file carries a work-off gate
for cycles 2 and 3 only, so `SEED_TODO=1` with more than 3 cycles is refused in
the preflight: a later cycle's work-off would meet nothing it can finish),
`ENDLESS_MAX_CYCLES` (`$ENDLESS_CYCLES`), `ENDLESS_QUIESCE_TIMEOUT_MS` (600000 —
a later cycle quiesces over the previous cycle's work-off subagents as well),
`QUIESCE_WAIT_S` (that bound + 60 s, the driver's own wait for the quiesce
line), `SPAWN_AGENT`,
`SUBAGENT_SLEEP_S` (45, and the preflight refuses a value within 10 s of
`maxSubagentAgeMs`, where the watchdog would abort the subagent instead),
`TURN_TIMEOUT_S`, `STEP_TIMEOUT_S`, `WORKOFF_TIMEOUT_S` (600, the removal step's
own bound), `SERVER_START_TIMEOUT_S`, `POLL_S`, `OUT_DIR`, `KEEP_SERVER`,
`E2E_TUI_BUILT`. The setup is printed at the top of every run and into
`out/11-endless.report.txt`, together with the `armed` line carrying the
measured context and the threshold derived from it; at the end of the run the
same block is written into the report a second time, into the file alone, with
the figures the run resolved along the way — the armed ceiling, the in-flight
handle, the server pid — filled in, so a run can be reproduced from its own
output.

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

`ENDLESS_MAX_CYCLES` is what keeps the loop from running on: the cycles the
driver asserts complete, and the next one stops at the ceiling with
`endless: cycle ceiling reached (2/2) — paused for this session`. Between one
cycle completing and the next one being set up the driver also puts
`endlessContext` back to `ENDLESS_CONTEXT_CEILING`, so the successor cannot latch
a cycle on a turn of its own while the driver is still observing the work-off. That stop is a
runtime pause on the successor session and nothing else — the plugin never
writes the settings file, `endlessMode` stays the user's own switch
(`src/endless.js`). The driver backs up and restores
`~/.config/opencode/agent-intercom.json` and the driven project's todo file,
deletes every session of every cycle, removes the fixture directory, stops the
server's process group and removes its isolated home.

## The mid-run channel

`message-task.sh` and `ask-task.sh` are the only proof of the two claims in
`specs/mid-run-messaging.md` that no unit test can reach: WHEN a message queued
into a busy session is read, and that a caller's answer comes back as the result
of the subagent's own `ask` call.

Both use the server `run-all.sh` owns — they start none of their own, write no
setting and build no configuration — and both take the driver env contract `OPENCODE_URL`,
`PROJECT_DIR`, `OUT_DIR`, `E2E_MODEL`. Standalone:

```bash
OPENCODE_URL=http://127.0.0.1:4567 bash test/e2e/message-task.sh
OPENCODE_URL=http://127.0.0.1:4567 bash test/e2e/ask-task.sh
```

They exit `0` when every criterion passed, `1` on a failed one, `2` on a setup
error, and each writes `out/13-message.report.txt` resp. `out/14-ask.report.txt`
with one `PASS` / `FAIL` line per criterion and the evidence that decided it.
The evidence itself is read off the live session by `lib/midrun-message.py` and
`lib/midrun-ask.py`.

The message driver makes the timing certain instead of hoping for it: the
subagent's baseline task is three `sleep 30; echo STEP-n-DONE` commands, and the
driver only prompts the orchestrator to send once the subagent's session really
shows a `running` tool part. The steered reply is a line the subagent has to
COMPOSE (`STEERED-STEP-<n>-DONE`), because any literal spelled out in the
steering text stands in both transcripts whatever the subagent did.

Both drivers need the plugin's debug log (`~/.cache/opencode-agent-intercom/
debug.log`): the spawned subagent's session id is read out of it, and it is
read from the byte the driver found rather than truncated. They end their
capture loop on either way a run ends — the session deleted, or the plugin
notifying the primary of the completion, which is what happens while retention
holds the session.

What a green run establishes, from the run of 2026-09-11 against opencode
1.18.30 with `E2E_MODEL=xai/grok-4.6` (the pin at the time):

- the framed message landed 13 s into a `bash` call that ran 30 s, and the
  subagent's next step began **9 ms after that call returned** — the delivery
  moment is the next step boundary, and a step, not a turn: the session was
  never re-prompted (two user messages), and no tool call started after the
  message although two baseline commands were still outstanding;
- the subagent's `ask` call stayed open 7494 ms with zero steps and zero other
  tool calls inside that window, and the orchestrator's answer came back as that
  call's own output.

What they do NOT cover: a message into a subagent that is BETWEEN steps, a
question left to expire unanswered, and the clamp of `answerWaitMs` against
`maxSubagentToolCallMs`. Each run names those in its report as `NOT ASSERTED`.

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
NESTED_CALLER=planner NESTED_DENIED_ROLE=grounder \
  bash test/e2e/nested-task.sh                          # other roles
```

Exit `0` = every asserted criterion passed, `1` = at least one failed, `2` =
preflight/setup error. Captures and report land in `out/12-nested.*`.

| criterion | evidence |
|---|---|
| grant | `GET /agent` carries no `spawn` deny rule on the six delegating roles and one on the other three |
| admitted | `nested spawn: caller blocks until its child ends` with `callerAgent` = the caller's role |
| survives | orchestrator, blocked caller and child all answer `200` on `GET /session/<id>` in every probe round of the wait |
| result | the caller's own `spawn` tool result reads `<handle> (researcher) finished and is gone. Its reply:` and holds the marker line the child was told to reply with |
| not-a-wake | zero `🔔 agent-intercom: your subagent` in the caller's transcript |
| target | the caller's spawn of a non-researcher returns the caller-specific `Spawn refused: a "<caller>" may spawn "researcher" and nothing else — you asked for a "<target>".` |
| woken | `🔔 agent-intercom: your subagent "<handle>" (<role>) has finished and been destroyed.` in the primary |
| nested-line | `⤷ nested: 1 run, …(not counted in the figure above).` in that same notice |
| denied | a role that may not delegate has no child session under it, and the run names which of the three layers refused it |
| gone | both subagent sessions answer `404` afterwards |
| clean | no `subagent timed out (inactivity)`, no `subagent llm error`, no `FOREIGN KEY` in the server log |
| todo | the project's todo file is byte-identical — a nested spawn carries no task id |
| model-pin | every assistant message of the three captured sessions names `E2E_MODEL` |

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
