#!/bin/bash
# Endless-mode end-to-end driver.
#
# Drives ENDLESS_CYCLES full endless cycles IN SEQUENCE against a real
# `opencode serve` — the second cycle starting from the session and the todo
# file the first one produced — and asserts each cycle's observable steps in the
# order the concept states them (specs/endless-mode.md §3.1, live criteria
# §7 a-e):
#
#   trigger    the primary crosses `endlessContext`      → `endless: scheduled`
#   (a) freeze a non-conforming post-trigger spawn is refused
#                                                        → `spawn refused: endless cycle in progress`
#   (a) permit the ONE conforming wind-down spawn is admitted exactly once
#                                                        → `spawn admitted: endless wind-down permit consumed`
#   (b) quiesce the in-flight subagent's completion notice is delivered BEFORE
#              the cycle stops waiting                   → `notified primary of completion` < `endless: quiesced`
#   (c) rewrite the wind-down subagent's rewrite reaches the todo file on disk,
#              one todo file only, no id reused          → `endless: wind-down confirmed N open task(s) [T…] file=…`
#   (c) carry-over the accepted rewrite kept at least one id that ALREADY stood
#              in the file before this cycle, and the run says which of those
#              ids the rewrite re-titled
#   (d) replace a new orchestrator session exists, the old one is archived and
#              not deleted                               → `endless: cycle K/M complete, new session …`
#   kickoff    the new session's first message is the endless kickoff and names
#              exactly the ids of (c)
#   (e) work-off the successor's first turn is captured to its end and its spawn
#              prompts carry saved task ids on line one; the per-task spawn
#              tally of that turn is reported as evidence beside it
#   (e) removal one of those subagents replies `DONE: T<n>` and the plugin
#              removes that task from the todo file
#                                                        → `notified primary of completion … "kind":"done","id":"T<n>"`
#                                                          plus the id gone from the file on disk
#   order      the five evidence lines appear in that order in the debug log
#
# WHY MORE THAN ONE CYCLE, AND WHY A SEEDED FILE. A first cycle over a freshly
# created todo file proves less than it looks: with nothing in the file, every
# id the wind-down subagent writes is a fresh one, so V6 — "an id must not be
# re-bound to a different title" (src/endless.js) — is never reached, and every
# check that compares the rewrite against pre-existing entries passes over an
# empty comparison. The live failures all sat in the SECOND cycle, on an
# accumulated file, where the wind-down subagent edits an entry that was already
# there. This driver therefore
#
#   - SEEDS the todo file with several ids inside the markers before cycle 1,
#     so even the first cycle rewrites a file that already carries entries;
#   - arranges those entries so that ONE task landing makes ANOTHER task's title
#     stale — T101 lands the merge that T102's title still describes as
#     outstanding — which is the live shape that makes a wind-down subagent
#     re-title a surviving id;
#   - drives the cycles one after the other, each from the file and the session
#     its predecessor left behind;
#   - asserts PER CYCLE that the cycle confirmed and replaced, and that the
#     accepted rewrite touched an id that already existed.
#
# How each cycle is sequenced, and why in this order:
#
#   turn 1  the primary reads the todo file and names its open points
#           (context grows; from cycle 2 on it is asked which entry the last
#           completion has made stale, which is what the wind-down hand-over
#           carries)
#   turn 2  the primary spawns ONE sleeping subagent and ends its turn
#           → the driver waits for the plugin's own `spawned` line and takes the
#             handle from it; that handle is the in-flight state everything below
#             is gated on. From here the subagent counts as in flight until
#             `notified primary of completion` names it. The line is matched on
#             its ABSENT `taskId` field, so a work-off spawn of the previous
#             cycle (which always carries `"taskId":"T<n>"`) is never mistaken
#             for it.
#   arming  the driver reads the primary's REAL context off the session
#           (the sum `latestContextTokens` computes, src/client.js) and only then
#           writes `endlessContext` below it. Until this moment the key sits at
#           ENDLESS_CONTEXT_CEILING, high enough that no turn crosses it, so the
#           cycle cannot start before the subagent is in flight. The key is put
#           BACK to that ceiling the moment a cycle completes, so the successor
#           cannot start the next cycle before this driver has set it up.
#   turn 3  one short turn whose transform hook re-reads that same context, finds
#           it at or above the armed ceiling and latches the cycle. The turn
#           spawns nothing — the freeze is already on from the latch.
#   turn 4  the post-trigger spawn attempt of (a).
#   work-off the successor's first turn, its spawn prompts, and the removal of a
#           saved task when one of its subagents replies `DONE: T<n>`. That
#           removal is also what makes the next cycle's file an accumulated one
#           with a stale title in it.
#
# Every criterion reads the debug log through a per-cycle window: the driver
# records the slice's line count when a cycle starts and no wait, count or
# ordering check looks at a line before it. Without that, cycle 2 would be
# satisfied by cycle 1's lines.
#
# The whole work-off phase of a cycle is observed BEFORE the next cycle starts
# and before anything is torn down. Deleting a session takes its running
# subagents with it, and restoring the todo file puts a removed task straight
# back, so a teardown that ran first would make the removal unobservable.
# cleanup() therefore keeps this order: every session of the run (which needs a
# live server), then the server, then the todo file — once no plugin is running,
# the restore is the last write to that file — then the fixture directory, then
# the settings.
#
# The precondition of criterion (b) is that the subagent is STILL in flight when
# the cycle starts waiting. The driver checks the handle twice per cycle —
# before it arms and again immediately before turn 3 — and refuses to run a
# vacuous quiesce: a subagent that finished early is a setup error (exit 2)
# naming exactly that, never a quietly recorded pass.
#
# This driver owns its server: it builds the TUI, starts one on its own port,
# waits for it, and tears it down again — a cycle needs its own settings (endless
# mode on, a low threshold) and a known debug-log offset, so it never shares the
# server run-all.sh starts for run-task.sh and multi-task.sh. The four lifecycle
# steps come from ./server-lifecycle.sh.
#
# Opt-in, exactly like the other drivers in this directory: it talks to a real
# opencode, spends real model tokens, and is never run by `npm test`.
#
# Usage:
#   bash test/e2e/endless-task.sh
#
# Parameters (env, all with defaults chosen so one run is quick and cheap):
#   ENDLESS_PROJECT_DIR $HOME/testopencode  directory this plugin is wired
#                      into, globally or by its own opencode.json; the server runs in it and
#                      the session is created with ?directory= pointing at it.
#                      Its own name, not PROJECT_DIR: run-all.sh passes that one
#                      to the message-tree drivers and it must not redirect the
#                      cycle by accident
#   ENDLESS_CYCLES     2                       how many cycles are driven in
#                      sequence; 2 is the minimum that reaches an accumulated
#                      file. 1 drives the old single-cycle run
#   ENDLESS_PORT       4599                    own port, kept clear of run-all's 4567
#   ENDLESS_CONTEXT    (empty)                 the armed threshold. Empty — the
#                      default — derives it per cycle from the primary's measured
#                      context; a value given here is used verbatim and VERIFIED
#                      against that measurement, the run stopping as a setup
#                      error when the session never reaches it
#   ENDLESS_CONTEXT_CEILING 100000000          the threshold in force until the
#                      driver arms, and again from a completed cycle until the
#                      next one arms; high enough that no turn crosses it
#   ENDLESS_CONTEXT_MARGIN 1000                how far below the measured context
#                      the derived threshold is placed
#   SETTINGS_TTL_WAIT_S 3                      wait after arming, past the
#                      plugin's 2 000 ms settings cache (src/settings.js TTL_MS)
#   ENDLESS_MAX_CYCLES $ENDLESS_CYCLES         ceiling; equal to the number of
#                      driven cycles, so the loop stops itself right after the
#                      last cycle this driver asserts
#   ENDLESS_QUIESCE_TIMEOUT_MS 600000          the plugin's own quiesce bound. A
#                      later cycle quiesces over the previous cycle's work-off
#                      subagents as well, which the 120 s of a single-cycle run
#                      does not cover
#   SEED_TODO          1                       1 seeds the project's todo file
#                      and the fixture directory the seeded tasks work on; 0
#                      drives whatever file is there
#   SPAWN_AGENT        coder                   the in-flight subagent's role
#   SUBAGENT_SLEEP_S   45                      how long it stays in flight; the
#                      run is gated on the observed handle, not on this number
#   TURN_TIMEOUT_S     600                     per blocking prompt POST
#   STEP_TIMEOUT_S     300                     per awaited log line
#   QUIESCE_WAIT_S     (derived)               bound for the quiesce line alone:
#                      the plugin's own quiesce timeout plus 60 s, so the
#                      driver's wait outlives the bound it is observing
#   WORKOFF_TIMEOUT_S  600                     bound for the removal step alone:
#                      it waits for a successor subagent to finish a real task,
#                      not for a log line the cycle emits by itself
#   SERVER_START_TIMEOUT_S 60                  readiness probe budget
#   POLL_S             2                       log poll cadence
#   OUT_DIR            ./out                   captures and backups
#   KEEP_SERVER        0                       1 leaves the server running
#   E2E_TUI_BUILT      0                       1 skips the TUI build; run-all.sh
#                      exports it after building once for the whole suite
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# What it changes and puts back: ~/.config/opencode/agent-intercom.json (the
# four endless keys; backed up and restored — the plugin itself never writes
# that file, a self-stop such as the cycle ceiling only pauses the mode for the
# session at runtime, src/endless.js), the todo file of the driven project —
# which the driver seeds, the cycles append to and the work-off removes from,
# restored byte-identically from the backup, or deleted again where there was
# none — the fixture directory the seeded tasks work on, every session of every
# cycle, and the server.
#
# Prerequisites: curl, python3, setsid, npm, an `opencode` on PATH, and a model
# provider that the project resolves.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run, so failures are recorded rather than aborted on.
set -uo pipefail

PREFIX=11-endless
HERE=$(cd "$(dirname "$0")" && pwd)

# Building the TUI, starting the server, waiting for it and stopping it again
# are shared with run-all.sh.
. "$HERE/server-lifecycle.sh"

PROJECT_DIR=${ENDLESS_PROJECT_DIR:-$HOME/testopencode}
PORT=${ENDLESS_PORT:-4599}
BASE=$(e2e_server_url "$PORT")
ENDLESS_CYCLES=${ENDLESS_CYCLES:-2}
ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-}
ENDLESS_CONTEXT_CEILING=${ENDLESS_CONTEXT_CEILING:-100000000}
ENDLESS_CONTEXT_MARGIN=${ENDLESS_CONTEXT_MARGIN:-1000}
SETTINGS_TTL_WAIT_S=${SETTINGS_TTL_WAIT_S:-3}
ENDLESS_MAX_CYCLES=${ENDLESS_MAX_CYCLES:-$ENDLESS_CYCLES}
ENDLESS_QUIESCE_TIMEOUT_MS=${ENDLESS_QUIESCE_TIMEOUT_MS:-600000}
SEED_TODO=${SEED_TODO:-1}
SPAWN_AGENT=${SPAWN_AGENT:-coder}
SUBAGENT_SLEEP_S=${SUBAGENT_SLEEP_S:-45}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-600}
STEP_TIMEOUT_S=${STEP_TIMEOUT_S:-300}
QUIESCE_WAIT_S=${QUIESCE_WAIT_S:-$((ENDLESS_QUIESCE_TIMEOUT_MS / 1000 + 60))}
WORKOFF_TIMEOUT_S=${WORKOFF_TIMEOUT_S:-600}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
POLL_S=${POLL_S:-2}
OUT_DIR=${OUT_DIR:-$HERE/out}
KEEP_SERVER=${KEEP_SERVER:-0}

SETTINGS_FILE="$HOME/.config/opencode/agent-intercom.json"
DEBUG_LOG="$HOME/.cache/opencode-agent-intercom/debug.log"

# The directory the seeded tasks operate on. It is named for this driver, is
# created by it and is removed again in cleanup.
FIXTURE_NAME=e2e-endless-fixture

mkdir -p "$OUT_DIR"
# Absolute from here on: the server is started with the project directory as its
# working directory, so every path handed to it has to stand on its own.
OUT_DIR=$(cd "$OUT_DIR" && pwd)
SERVER_LOG="$OUT_DIR/$PREFIX.server.log"
SLICE_FILE="$OUT_DIR/$PREFIX.debug-slice.log"
SETTINGS_BAK="$OUT_DIR/$PREFIX.settings.bak"
TODO_BAK="$OUT_DIR/$PREFIX.todo.bak"
REPORT_FILE="$OUT_DIR/$PREFIX.report.txt"
PID_FILE="$OUT_DIR/$PREFIX.serverpid"

SID=""
SESSION_IDS=""
LOG_OFFSET=0
LOG_TRUNCATED=0
SETTINGS_EXISTED=0
SETTINGS_WRITTEN=0
TODO_BAK_NAME=""
TODO_NAME=""
TODO_EXISTED=0
TODO_GUARDED=0
TODO_SEEDED=0
FIXTURE_CREATED=0
FAILURES=0
ASSERTED=0
WAIT_LINE=""
WAIT_LINENO=0
WAIT_REASON=""
POLL_URL=""
RESOLVED_MODEL="(unresolved)"
SERVER_VERSION="(unknown)"
# The cycle currently being driven, and the line of the debug-log slice its
# window starts after. Every read of the slice is scoped to that window.
CYCLE=0
SLICE_FROM_LINE=0
# The in-flight subagent's handle, taken from the plugin's own `spawned` line,
# and the context figures the ceiling is armed from — all three per cycle.
SPAWN_HANDLE=""
MEASURED_CTX=""
ARMED_CONTEXT=""
# What a cycle hands to its work-off phase and to the cycle after it.
CYCLE_NEWSID=""
CYCLE_SAVED_IDS=""
CYCLE_SAVED_FILE=""

# ---------- reporting ------------------------------------------------------

say() { printf '%s\n' "$*"; }

# One asserted criterion: name, 1|0, and the evidence line that decided it.
# Every criterion of a driven cycle carries that cycle in its name, so a report
# says which of the cycles a failure belongs to.
record() {
  local name="$1" ok="$2" evidence="$3"
  ASSERTED=$((ASSERTED + 1))
  if [ "$ok" = 1 ]; then
    printf 'PASS  %s\n      %s\n' "$name" "$evidence" | tee -a "$REPORT_FILE"
  else
    FAILURES=$((FAILURES + 1))
    printf 'FAIL  %s\n      %s\n' "$name" "$evidence" | tee -a "$REPORT_FILE"
  fi
}

# A criterion this driver deliberately does not assert, or a condition a run did
# not happen to produce, named so a reader does not mistake its absence for a
# pass.
note_uncovered() {
  printf 'NOT ASSERTED  %s\n      %s\n' "$1" "$2" | tee -a "$REPORT_FILE"
}

die() {
  say "SETUP ERROR: $*"
  exit 2
}

# ---------- debug log ------------------------------------------------------

# The plugin logs to ~/.cache/opencode-agent-intercom/debug.log and appends
# forever. The driver never truncates that file: it records its size before the
# server starts and reads only what was appended after it.
refresh_slice() {
  local cur
  cur=$(stat -c %s "$DEBUG_LOG" 2>/dev/null || echo 0)
  if [ "$cur" -lt "$LOG_OFFSET" ]; then
    LOG_TRUNCATED=1
    LOG_OFFSET=0
  fi
  tail -c "+$((LOG_OFFSET + 1))" "$DEBUG_LOG" > "$SLICE_FILE" 2>/dev/null || : > "$SLICE_FILE"
}

# The first line of the slice matching $1 that lies PAST the current cycle's
# window start, as "<lineno>:<text>"; empty when there is none. Every wait,
# count and ordering check in this driver goes through this pair of helpers, so
# a line another cycle produced can never satisfy the cycle being asserted.
slice_match_after() {
  grep -nE -- "$1" "$SLICE_FILE" 2>/dev/null |
    awk -F: -v from="$SLICE_FROM_LINE" '$1 > from { print; exit }'
}

slice_count_after() {
  grep -nE -- "$1" "$SLICE_FILE" 2>/dev/null |
    awk -F: -v from="$SLICE_FROM_LINE" '$1 > from' | grep -c .
}

# The slice's current length — a cycle's window start.
slice_lines() {
  refresh_slice
  wc -l < "$SLICE_FILE" 2>/dev/null || echo 0
}

# Waits for one line in the current cycle's window. Returns 0 with WAIT_LINE /
# WAIT_LINENO set, or 1 with WAIT_REASON set. Never returns 0 on a timeout, and
# gives up early when the cycle abandoned, when the optional 4th pattern shows
# the cycle has already moved past this step, or when the server died — a step
# that does not happen must fail loudly, not be waited out.
wait_for_pattern() {
  local label="$1" pattern="$2" timeout="$3" giveup="${4:-}"
  local deadline=$(( $(date +%s) + timeout ))
  local hit ab past
  WAIT_LINE=""; WAIT_LINENO=0; WAIT_REASON=""
  while :; do
    refresh_slice
    hit=$(slice_match_after "$pattern")
    if [ -n "$hit" ]; then
      WAIT_LINENO=${hit%%:*}
      WAIT_LINE=${hit#*:}
      return 0
    fi
    ab=$(slice_match_after 'endless: abandoned at')
    if [ -n "$ab" ]; then
      WAIT_REASON="cycle abandoned before \"$label\" — ${ab#*:}"
      return 1
    fi
    if [ -n "$giveup" ]; then
      past=$(slice_match_after "$giveup")
      if [ -n "$past" ]; then
        WAIT_REASON="no \"$label\" line, and the cycle is already past it — ${past#*:}"
        return 1
      fi
    fi
    if ! e2e_server_alive; then
      WAIT_REASON="opencode (pid $E2E_SERVER_PID) is gone while waiting for \"$label\"; server log: $SERVER_LOG"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      WAIT_REASON="no line matching /$pattern/ within ${timeout}s — last log line: $(tail -n 1 "$SLICE_FILE")"
      return 1
    fi
    sleep "$POLL_S"
  done
}

# The rejection the confirm step files when it will not stand behind a rewrite,
# with the failing conjunct in it — the evidence a failed (c) needs to say WHY
# the cycle produced no confirmation.
rejection_line() {
  refresh_slice
  local hit
  hit=$(slice_match_after 'endless: wind-down rewrite rejected')
  [ -n "$hit" ] && printf '%s' "${hit#*:}"
}

# Poll a message capture through a small verdict reader. The reader prints
# state|verdict|evidence; a non-running state ends the poll, while a running
# state keeps waiting until the shared step bound, or until the server dies.
# POLL_URL is set by each criterion because it is not part of the reader's args.
poll_verdict() {
  local capture="$1" script="$2"
  shift 2
  local deadline=$(( $(date +%s) + STEP_TIMEOUT_S ))
  local result="running|pending|no verdict was read" state
  while :; do
    curl -s -m 30 "$POLL_URL" > "$capture"
    result=$(python3 "$script" "$capture" "$@")
    state=${result%%|*}
    [ "$state" != running ] && break
    if [ "$(date +%s)" -ge "$deadline" ] || ! e2e_server_alive; then
      break
    fi
    sleep "$POLL_S"
  done
  printf '%s\n' "$result"
}

# ---------- the todo file ---------------------------------------------------

# `todo.md` / `todos.md` in any casing all count as the todo file
# (src/todofile.js). The baseline is both the "exactly one file" assertion of
# (c) and what cleanup restores.
todo_names() {
  find "$PROJECT_DIR" -maxdepth 1 -type f -iregex '.*/todos?\.md' -printf '%f\n' 2>/dev/null | sort
}

# The one todo file's path, or nothing when there is not exactly one.
todo_path() {
  local names count
  names=$(todo_names)
  count=$(printf '%s' "$names" | grep -c .)
  [ "$count" = 1 ] || return 1
  printf '%s/%s' "$PROJECT_DIR" "$names"
}

# The title a canonical `- <id>: <title>` line carries in $2, in the plugin's
# own comparison form: trimmed, lower-cased, runs of whitespace collapsed
# (normaliseTitle, src/endless.js). Empty when the file carries no such line.
task_title() {
  local id="$1" file="$2"
  sed -nE "s/^- $id:[[:space:]]*(.*)\$/\1/p" "$file" 2>/dev/null | head -n 1 |
    tr 'A-Z' 'a-z' | tr -s ' \t' ' ' | sed -E 's/^ //; s/ $//'
}

# The seeded todo file. It stands in for an ACCUMULATED file, which is the state
# every cycle after the first works on and the state the single-cycle run never
# reached: human prose outside the markers, five ids inside them and a watermark
# above all of them.
#
# The two first entries are the shape that makes a wind-down subagent re-title a
# surviving id, which is what reaches V6: T101 lands the merge that T102's title
# still describes as outstanding, so once T101 is done and removed, T102's title
# names work that is already landed and only its deletion half is left. T103
# goes stale the same way once the note files are gone.
seed_todo_file() {
  local path="$1"
  cat > "$path" <<'SEED'
# testopencode

Scratch project the agent-intercom end-to-end drivers run against. The text
outside the two intercom markers is human text: no cycle may change it.

## Open

The fixture under `e2e-endless-fixture/` is written by `test/e2e/endless-task.sh`
before the first cycle and removed again when the run ends.

## Intercom tasks

<!-- intercom:begin -->
- T101: Write e2e-endless-fixture/merged.md, holding the lines of e2e-endless-fixture/notes-a.md and then those of e2e-endless-fixture/notes-b.md
  accept: e2e-endless-fixture/merged.md carries every line of both note files, in that order, and both note files are still there
  link: e2e-endless-fixture/notes-a.md
- T102: Merge the two note files into e2e-endless-fixture/merged.md and delete notes-a.md and notes-b.md afterwards — not before T101 has landed
  accept: merged.md carries both notes and neither note file is left in e2e-endless-fixture/
  link: e2e-endless-fixture/notes-b.md
- T103: Compare e2e-endless-fixture/merged.md against the two note files and write the verdict to e2e-endless-fixture/review.md
  accept: e2e-endless-fixture/review.md names every line that is missing from merged.md, or states there is none
  link: e2e-endless-fixture/merged.md
- T104: List the file names under e2e-endless-fixture/, one per line, in e2e-endless-fixture/index.md
  accept: e2e-endless-fixture/index.md carries one line per file in that directory
  link: e2e-endless-fixture/index.md
- T105: Write the total line count over the files under e2e-endless-fixture/ to e2e-endless-fixture/count.txt
  accept: e2e-endless-fixture/count.txt holds a single number
  link: e2e-endless-fixture/count.txt
<!-- intercom: next-id T106 -->
<!-- intercom:end -->

## Notes

The `bytes()` helper in `src/format.js` is an artefact of the multi-agent run.
SEED
}

# The two note files T101 and T102 work on.
seed_fixture() {
  rm -rf "${PROJECT_DIR:?}/$FIXTURE_NAME" || return 1
  mkdir -p "$PROJECT_DIR/$FIXTURE_NAME" || return 1
  printf '%s\n' '# notes a' 'alpha one' 'alpha two' > "$PROJECT_DIR/$FIXTURE_NAME/notes-a.md" || return 1
  printf '%s\n' '# notes b' 'beta one' 'beta two' > "$PROJECT_DIR/$FIXTURE_NAME/notes-b.md" || return 1
  FIXTURE_CREATED=1
}

# ---------- cleanup --------------------------------------------------------

cleanup() {
  local code=$?
  set +u
  say ""
  say "--- cleanup ---"

  # Sessions first, every one the run created: the server has to be alive to
  # delete them.
  for s in $SESSION_IDS; do
    [ -z "$s" ] && continue
    if e2e_server_alive; then
      local http
      http=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$s")
      say "session delete $s -> HTTP $http"
    fi
  done

  # No session of this run is alive from here on. With KEEP_SERVER=1 the server
  # survives but its sessions do not, which is what ends the run's writes; when
  # it is not kept, stopping the server also ends any remaining plugin activity
  # before the restores below.
  if [ "$KEEP_SERVER" = 1 ]; then
    say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $BASE"
  else
    e2e_server_stop
  fi

  # The project's todo file goes back to what it was before the driver seeded it
  # and the cycles wrote to it: remove every name not present in the baseline,
  # then restore the backup where there was one. Runs on the failure path too —
  # it hangs on TODO_GUARDED, which is set once the baseline was taken, not on
  # any assertion.
  if [ "$TODO_GUARDED" = 1 ]; then
    local f todo_after
    todo_after=$(todo_names)
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if ! printf '%s\n' "$TODO_BEFORE" | grep -Fqx -- "$f"; then
        [ -f "$PROJECT_DIR/$f" ] && rm -f "$PROJECT_DIR/$f" && \
          say "removed $PROJECT_DIR/$f (the run created it; it was not in the baseline)"
      fi
    done <<< "$todo_after"
    if [ "$TODO_EXISTED" = 1 ]; then
      if cp "$TODO_BAK" "$PROJECT_DIR/$TODO_BAK_NAME"; then
        say "restored $PROJECT_DIR/$TODO_BAK_NAME"
      else
        say "CLEANUP FAILED: could not restore $PROJECT_DIR/$TODO_BAK_NAME from $TODO_BAK — the project's todo file is not back at its baseline"
        code=2
      fi
    fi
  fi

  # The fixture the seeded tasks work on. Created by this driver under a name of
  # its own, so it goes whole.
  if [ "$FIXTURE_CREATED" = 1 ]; then
    if rm -rf "${PROJECT_DIR:?}/$FIXTURE_NAME"; then
      say "removed $PROJECT_DIR/$FIXTURE_NAME (the driver seeded it)"
    else
      say "CLEANUP FAILED: could not remove $PROJECT_DIR/$FIXTURE_NAME"
      code=2
    fi
  fi

  # Settings are restored after the run's sessions too. The plugin resolves this
  # file every 2 000 ms while it runs (src/settings.js TTL_MS), but it never
  # writes the file itself — a self-stop only pauses the mode at runtime
  # (src/endless.js) — so this driver's write is the only one being restored.
  if [ "$SETTINGS_WRITTEN" = 1 ]; then
    if [ "$SETTINGS_EXISTED" = 1 ]; then
      if cp "$SETTINGS_BAK" "$SETTINGS_FILE"; then
        say "restored $SETTINGS_FILE from $SETTINGS_BAK"
      else
        say "CLEANUP FAILED: could not restore $SETTINGS_FILE from $SETTINGS_BAK — endless mode is still armed in it"
        code=2
      fi
    elif [ -f "$SETTINGS_FILE" ]; then
      rm -f "$SETTINGS_FILE" && say "removed $SETTINGS_FILE (the driver created it; there was none before)"
    fi
  fi

  refresh_slice
  say "debug-log slice: $SLICE_FILE"
  say "server log:      $SERVER_LOG"
  say "report:          $REPORT_FILE"
  [ "$LOG_TRUNCATED" = 1 ] && say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- preflight ------------------------------------------------------

: > "$REPORT_FILE"

for tool in curl python3 setsid stat npm awk; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
command -v opencode >/dev/null || die "opencode is not on PATH"
[ -d "$PROJECT_DIR" ] || die "PROJECT_DIR does not exist: $PROJECT_DIR"
case "$ENDLESS_CYCLES" in
  '' | *[!0-9]* | 0) die "ENDLESS_CYCLES=$ENDLESS_CYCLES is not a positive whole number" ;;
esac
if [ "$ENDLESS_MAX_CYCLES" -lt "$ENDLESS_CYCLES" ] 2>/dev/null; then
  die "ENDLESS_MAX_CYCLES=$ENDLESS_MAX_CYCLES is below ENDLESS_CYCLES=$ENDLESS_CYCLES — the plugin would pause the mode before the last driven cycle and that cycle's criteria would be asserted over a cycle that never started"
fi

PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)
e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT_DIR" ||
  die "$PLUGIN_ROOT is wired nowhere the server would read it — name it in the plugin array of ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json for every directory, or of $PROJECT_DIR/opencode.json for this project alone, or drop a loader into $PROJECT_DIR/.opencode/plugin/ — as it stands the run would observe a server without this plugin"

# The sidebar is served from the TUI half, which reads its own plugin list —
# the check above covers the server half alone. e2e_tui_plugin_wired prints the
# files it looked at and the remedy itself.
e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT_DIR" ||
  die "the TUI half of $PLUGIN_ROOT is wired nowhere the TUI would read it — see the tui.json paths listed above; as it stands the run would observe a TUI without this plugin's sidebar"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  die "something already answers on $BASE — choose another PORT"
fi

# The inactivity watchdog aborts a subagent that is silent for maxSubagentAgeMs
# (default 90 000). A sleeping subagent is silent, so a sleep at or above that
# bound would be aborted instead of staying in flight for the quiesce step.
MAX_AGE_MS=$(python3 - "$SETTINGS_FILE" <<'PY'
import json, sys
try:
    raw = json.load(open(sys.argv[1]))
    v = raw.get("maxSubagentAgeMs")
    print(int(v) if isinstance(v, int) and v > 0 else 90000)
except Exception:
    print(90000)
PY
)
if [ $((SUBAGENT_SLEEP_S * 1000 + 10000)) -ge "$MAX_AGE_MS" ]; then
  die "SUBAGENT_SLEEP_S=$SUBAGENT_SLEEP_S is too close to maxSubagentAgeMs=$MAX_AGE_MS — the watchdog would abort the in-flight subagent instead of letting the cycle wait for it"
fi

# ---------- settings -------------------------------------------------------

if [ -f "$SETTINGS_FILE" ]; then
  SETTINGS_EXISTED=1
  cp "$SETTINGS_FILE" "$SETTINGS_BAK" || die "could not back up $SETTINGS_FILE"
else
  SETTINGS_EXISTED=0
  rm -f "$SETTINGS_BAK"
fi

# The four endless keys, with `endlessContext` as the caller passes it. Called
# once per hold and once per arming: the hold puts the unreachable ceiling back
# so no cycle can start while the driver sets one up, the arming puts the
# threshold derived from the primary's real context in its place. Every other
# key in the file is left as it stands.
write_endless_settings() {
  python3 - "$SETTINGS_FILE" "$1" "$ENDLESS_QUIESCE_TIMEOUT_MS" "$ENDLESS_MAX_CYCLES" <<'PY'
import json, os, sys
path, ctx, quiesce, cycles = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
raw = {}
if os.path.exists(path):
    with open(path) as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        sys.exit(f"{path} is not a JSON object — refusing to overwrite it")
raw.update({
    "endlessMode": True,
    "endlessContext": ctx,
    "endlessQuiesceTimeoutMs": quiesce,
    "endlessMaxCycles": cycles,
})
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as fh:
    json.dump(raw, fh, indent=2)
    fh.write("\n")
PY
}

# Puts the threshold out of reach again. Run the moment a cycle completes, so
# the successor cannot latch the next cycle on a turn of its own before this
# driver has a subagent in flight for it.
hold_ceiling() {
  write_endless_settings "$ENDLESS_CONTEXT_CEILING" ||
    die "could not put endlessContext back to $ENDLESS_CONTEXT_CEILING in $SETTINGS_FILE"
  ARMED_CONTEXT=""
  sleep "$SETTINGS_TTL_WAIT_S"
}

write_endless_settings "$ENDLESS_CONTEXT_CEILING" ||
  die "could not write the endless keys into the settings file"
SETTINGS_WRITTEN=1

# ---------- todo-file baseline and the seeded file --------------------------

TODO_BEFORE=$(todo_names)
TODO_COUNT_BEFORE=$(printf '%s' "$TODO_BEFORE" | grep -c . )
if [ "$TODO_COUNT_BEFORE" -gt 1 ]; then
  die "$PROJECT_DIR already holds several todo files ($(echo "$TODO_BEFORE" | tr '\n' ' ')) — the plugin refuses that state and the cycle would abandon at save"
fi
if [ "$TODO_COUNT_BEFORE" = 1 ]; then
  TODO_EXISTED=1
  TODO_BAK_NAME=$(printf '%s' "$TODO_BEFORE")
  cp "$PROJECT_DIR/$TODO_BAK_NAME" "$TODO_BAK" || die "could not back up $PROJECT_DIR/$TODO_BAK_NAME"
  TODO_NAME=$TODO_BAK_NAME
  TODO_BASELINE="present: $TODO_BAK_NAME"
else
  TODO_NAME=TODO.md
  TODO_BASELINE="none in $PROJECT_DIR — the driver creates $TODO_NAME"
fi
TODO_GUARDED=1

# The seed goes into the file the project already uses, under its own name — a
# second todo file would be a state the plugin refuses.
if [ "$SEED_TODO" = 1 ]; then
  seed_todo_file "$PROJECT_DIR/$TODO_NAME" ||
    die "could not seed $PROJECT_DIR/$TODO_NAME"
  seed_fixture ||
    die "could not create the fixture directory $PROJECT_DIR/$FIXTURE_NAME the seeded tasks work on"
  TODO_SEEDED=1
  SEED_IDS=$(sed -nE 's/^- (T[0-9]+):.*/\1/p' "$PROJECT_DIR/$TODO_NAME" | tr '\n' ',' | sed 's/,$//')
  TODO_BASELINE="$TODO_BASELINE — seeded with $SEED_IDS inside the markers"
else
  SEED_IDS="(not seeded)"
fi

# ---------- server ---------------------------------------------------------

# The sidebar is served from tui/dist/tui.js, so the build has to happen before
# the server starts. Skipped when the caller (run-all.sh) already built.
e2e_build_tui "$PLUGIN_ROOT" || die "the TUI build failed — see the npm output above"

LOG_OFFSET=$(stat -c %s "$DEBUG_LOG" 2>/dev/null || echo 0)

e2e_server_start "$PORT" "$PROJECT_DIR" "$SERVER_LOG" "$PID_FILE" ||
  die "could not start opencode on $BASE — see $SERVER_LOG"
e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_DIR/$PREFIX.health.json" ||
  die "opencode on $BASE did not become ready — see $SERVER_LOG"

SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$OUT_DIR/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")
RESOLVED_MODEL=$(curl -fsS -m 10 "$BASE/config/providers" 2>/dev/null |
  python3 -c 'import json,sys; d=json.load(sys.stdin); dflt=d.get("default") or {}; print(next((f"{k}/{v}" for k,v in dflt.items()), "(no default)"))' 2>/dev/null || echo "(unresolved)")

# ---------- the setup, printed so a run can be reproduced -------------------

print_setup() {
  cat <<EOF
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
project dir         $PROJECT_DIR   (opencode.json names the plugin by absolute path)
server              opencode serve --port $PORT --hostname 127.0.0.1   (cwd = project dir)
server pid / pgid   $E2E_SERVER_PID / $E2E_SERVER_PGID
opencode version    $SERVER_VERSION
default model       $RESOLVED_MODEL   (the model that actually served a run is read off ~/.local/share/opencode/log/opencode.log, not from this line)
cycles driven       $ENDLESS_CYCLES in sequence, each from the file and the session the one before it left
settings file       $SETTINGS_FILE   (backup: $SETTINGS_BAK, existed=$SETTINGS_EXISTED)
settings written    endlessMode=true endlessQuiesceTimeoutMs=$ENDLESS_QUIESCE_TIMEOUT_MS endlessMaxCycles=$ENDLESS_MAX_CYCLES
endless ceiling     held at $ENDLESS_CONTEXT_CEILING between cycles, then ${ARMED_CONTEXT:-(armed per cycle after its spawn turn)}   (ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-derive from the measured context}, margin $ENDLESS_CONTEXT_MARGIN, settings-cache wait ${SETTINGS_TTL_WAIT_S}s)
debug log           $DEBUG_LOG   (read from byte $LOG_OFFSET)
todo baseline       $TODO_BASELINE   (backup: $TODO_BAK)
fixture             $PROJECT_DIR/$FIXTURE_NAME   (seeded=$TODO_SEEDED; T101 lands the merge T102's title still describes)
in-flight subagent  spawn("$SPAWN_AGENT", sleep ${SUBAGENT_SLEEP_S}s) -> handle ${SPAWN_HANDLE:-(spawned in the turn 2 of each cycle)}
timeouts            turn=${TURN_TIMEOUT_S}s step=${STEP_TIMEOUT_S}s quiesce=${QUIESCE_WAIT_S}s work-off=${WORKOFF_TIMEOUT_S}s start=${SERVER_START_TIMEOUT_S}s poll=${POLL_S}s
out dir             $OUT_DIR
EOF
}
print_setup | tee -a "$REPORT_FILE"

# ---------- driving the primary ---------------------------------------------

post_prompt() {
  local text="$1" outfile="$2"
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"agent":"orchestrator","parts":[{"type":"text","text":sys.argv[1]}]}))' "$text")
  curl -s --max-time "$TURN_TIMEOUT_S" -X POST "$BASE/session/$SID/message" \
    -H 'content-type: application/json' -d "$body" > "$outfile" 2>&1
}

# The primary's context as the PLUGIN counts it against `endlessContext`:
# input + output + cache.read + cache.write of the newest assistant message
# whose sum is non-zero — `latestContextTokens` (src/client.js), read off the
# same `GET /session/{id}/message` the plugin's own snapshot reads. Prints that
# number, or nothing when no message carries a non-zero token sum yet.
primary_ctx_tokens() {
  curl -s -m 30 "$BASE/session/$SID/message" > "$OUT_DIR/$PREFIX.cycle$CYCLE.primary-messages.json"
  python3 - "$OUT_DIR/$PREFIX.cycle$CYCLE.primary-messages.json" <<'PY'
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception:
    raise SystemExit
messages = payload.get("data") if isinstance(payload, dict) else payload
if not isinstance(messages, list):
    raise SystemExit
for message in reversed(messages):
    if not isinstance(message, dict):
        continue
    info = message.get("info")
    tokens = info.get("tokens") if isinstance(info, dict) else None
    if not isinstance(tokens, dict):
        continue
    cache = tokens.get("cache")
    total = (tokens.get("input") or 0) + (tokens.get("output") or 0)
    if isinstance(cache, dict):
        total += (cache.get("read") or 0) + (cache.get("write") or 0)
    if total > 0:
        print(int(total))
        break
PY
}

# The completion notice for the handle this cycle's `spawned` line named:
# "<lineno>:<text>" once the subagent has finished, nothing while it is still in
# flight. Matched on the handle rather than on the parent, and scoped to the
# cycle's own window — handles restart at #1 per role, so a bare handle match
# would find the previous cycle's subagent.
subagent_completion_line() {
  [ -n "$SPAWN_HANDLE" ] || return 0
  refresh_slice
  slice_match_after "notified primary of completion .*\"handle\":\"$SPAWN_HANDLE\""
}

# Criterion (b) asserts that the cycle waited for a subagent that was really in
# flight; the plugin reports that as `activeAtStart`. A subagent that has already
# finished would make the assertion vacuous, so the run stops here — before the
# ceiling is armed and before anything is asserted — and says exactly that,
# instead of arriving at a quiesce over nothing.
require_subagent_in_flight() {
  local where="$1" done_line
  done_line=$(subagent_completion_line)
  [ -z "$done_line" ] && return 0
  die "cycle $CYCLE: the in-flight subagent $SPAWN_HANDLE finished $where — criterion (b) needs it still running when the cycle starts waiting, and a quiesce with activeAtStart=0 asserts nothing. Its completion notice: ${done_line#*:} — raise SUBAGENT_SLEEP_S (it has to stay below maxSubagentAgeMs=$MAX_AGE_MS) or use a faster SPAWN_AGENT model"
}

# Puts `endlessContext` where the primary's MEASURED context is known to reach
# it, so the crossing of the next turn follows from a figure read off the session
# rather than from a guessed constant. Until this runs the key sits at
# ENDLESS_CONTEXT_CEILING and no turn can start a cycle.
arm_ceiling() {
  MEASURED_CTX=$(primary_ctx_tokens)
  case "$MEASURED_CTX" in
    '' | *[!0-9]*)
      die "cycle $CYCLE: could not read the primary's context from $BASE/session/$SID/message — with no measurement the ceiling could only be guessed (capture: $OUT_DIR/$PREFIX.cycle$CYCLE.primary-messages.json)"
      ;;
  esac
  if [ -n "$ENDLESS_CONTEXT" ]; then
    ARMED_CONTEXT=$ENDLESS_CONTEXT
    if [ "$MEASURED_CTX" -lt "$ARMED_CONTEXT" ]; then
      die "cycle $CYCLE: ENDLESS_CONTEXT=$ARMED_CONTEXT was given, but the primary's context measures $MEASURED_CTX tokens after its preparation turns — that ceiling would not be crossed. Leave ENDLESS_CONTEXT unset and the driver derives it from the measurement"
    fi
  else
    ARMED_CONTEXT=$((MEASURED_CTX - ENDLESS_CONTEXT_MARGIN))
    [ "$ARMED_CONTEXT" -lt 1 ] && ARMED_CONTEXT=1
  fi
  write_endless_settings "$ARMED_CONTEXT" ||
    die "cycle $CYCLE: could not arm endlessContext=$ARMED_CONTEXT in $SETTINGS_FILE"
  printf 'armed               cycle %s: endlessContext=%s, from a measured %s tokens on %s (handle %s in flight)\n' \
    "$CYCLE" "$ARMED_CONTEXT" "$MEASURED_CTX" "$SID" "$SPAWN_HANDLE" | tee -a "$REPORT_FILE"
  # The plugin caches its settings for TTL_MS = 2000 (src/settings.js), so the
  # crossing turn has to start after that cache can have expired.
  sleep "$SETTINGS_TTL_WAIT_S"
}

# ---------- one cycle -------------------------------------------------------

# Drives cycle $1 on the current $SID and asserts trigger, (a), (b), (c),
# (c) carry-over, (d), the kickoff and the order. Leaves CYCLE_NEWSID,
# CYCLE_SAVED_IDS and CYCLE_SAVED_FILE for the work-off phase and for the cycle
# after it, and puts the ceiling back out of reach the moment the cycle
# completes. Returns 1 when the cycle did not complete, so the caller stops
# driving further cycles rather than asserting them against a session that was
# never replaced.
run_cycle() {
  CYCLE=$1
  local tag="cycle $CYCLE"
  CYCLE_NEWSID=""; CYCLE_SAVED_IDS=""; CYCLE_SAVED_FILE=""
  SPAWN_HANDLE=""; MEASURED_CTX=""; ARMED_CONTEXT=""

  # Everything this cycle asserts is read past this line of the slice.
  SLICE_FROM_LINE=$(slice_lines)
  say ""
  say "=== $tag — primary $SID, debug-log window from slice line $SLICE_FROM_LINE ==="
  printf '\n--- cycle %s (primary %s, slice window from line %s) ---\n' \
    "$CYCLE" "$SID" "$SLICE_FROM_LINE" >> "$REPORT_FILE"

  # Turn 1 — the open points the cycle will later be asked to save, and the bulk
  # of the context the ceiling is derived from. No spawn: a subagent started here
  # would spend its flight time on the turns below.
  #
  # From cycle 2 on the turn asks for the ONE thing that makes an accumulated
  # file different from a fresh one: which entry the last completion has made
  # stale. That answer travels into the wind-down hand-over, and a wind-down that
  # corrects a stale title is what re-binds a pre-existing id.
  local turn1
  if [ "$CYCLE" = 1 ]; then
    turn1="Read ./$TODO_NAME in this project. Then name, one line each, the three open tasks you would take first and what would still be left of the others afterwards. Read that one file, call no other tool — do not spawn, do not list — and end your turn."
  else
    turn1="Read ./$TODO_NAME in this project. Then state, one line each: which task id a subagent of yours has just completed; which remaining task's title still describes work that has already landed; and what is actually left of that task now. Read that one file, call no other tool — do not spawn, do not list — and end your turn."
  fi
  post_prompt "$turn1" "$OUT_DIR/$PREFIX.cycle$CYCLE.turn1.json"
  say "[$PREFIX] $tag turn 1 (open points) done $(date +%H:%M:%S)"

  # Turn 2 — the in-flight subagent, spawned as late as the sequence allows and
  # in its own short turn, so its flight overlaps the trigger rather than the
  # setup.
  # The marker makes the spawn identifiable. From cycle 2 on the primary is a
  # successor that is still working its todo file off, so it spawns subagents of
  # its own while this turn runs: neither the role nor the absence of a task-id
  # prefix picks the driver's own subagent out any more, and a run gated on
  # either would watch the wrong one.
  local marker="endless-e2e-sleeper-c$CYCLE-$$"
  local turn2="Call spawn(\"$SPAWN_AGENT\", \"Run the shell command: sleep $SUBAGENT_SLEEP_S. Then reply with the single line: slept $SUBAGENT_SLEEP_S seconds ($marker).\") exactly once and end your turn as soon as it returns. Do not poll, do not call list(), do not spawn a second subagent, do not write anything else."
  local spawn_window
  spawn_window=$(slice_lines)
  post_prompt "$turn2" "$OUT_DIR/$PREFIX.cycle$CYCLE.turn2.json"
  say "[$PREFIX] $tag turn 2 (spawn) done $(date +%H:%M:%S)"

  # The child's session id, read off the spawn tool call that carries the
  # marker. The blocking POST above returns the first turn that FINISHES, which
  # on a busy successor can be another turn entirely, so the tool call is polled
  # for rather than taken from that response.
  POLL_URL="$BASE/session/$SID/message"
  local child_read child_rest child_verdict child_id
  child_read=$(poll_verdict "$OUT_DIR/$PREFIX.cycle$CYCLE.spawn-call.json" \
    "$HERE/lib/spawn-child.py" "$marker")
  child_rest=${child_read#*|}
  child_verdict=${child_rest%%|*}
  child_id=${child_rest#*|}
  [ "$child_verdict" = pass ] ||
    die "$tag: no spawn tool call carrying the marker $marker on $SID within ${STEP_TIMEOUT_S}s — the primary never got THIS driver's subagent in flight, so criterion (b) would have nothing to observe ($child_id)"

  # The handle is the in-flight state the rest of the cycle is gated on, and the
  # child session id above is what makes it this cycle's rather than a work-off
  # subagent of the cycle before.
  local outer_from=$SLICE_FROM_LINE
  SLICE_FROM_LINE=$spawn_window
  if ! wait_for_pattern "spawned" "spawned .*\"sessionID\":\"$child_id\"" "$STEP_TIMEOUT_S"; then
    SLICE_FROM_LINE=$outer_from
    die "$tag: the spawn of $child_id produced no \"spawned\" line within ${STEP_TIMEOUT_S}s ($WAIT_REASON)"
  fi
  SLICE_FROM_LINE=$outer_from
  SPAWN_HANDLE=$(printf '%s' "$WAIT_LINE" | sed -E 's/.*"handle":"([^"]+)".*/\1/')
  [ -n "$SPAWN_HANDLE" ] && [ "$SPAWN_HANDLE" != "$WAIT_LINE" ] ||
    die "$tag: the \"spawned\" line carries no handle to gate on: $WAIT_LINE"
  say "[$PREFIX] $tag subagent $SPAWN_HANDLE (session $child_id) in flight (slice line $WAIT_LINENO)"

  # Gate 1: still in flight before the ceiling is armed.
  require_subagent_in_flight "before the ceiling was armed"

  # The ceiling, derived from the primary's real context rather than guessed.
  arm_ceiling

  # Gate 2: still in flight after the arming, immediately before the turn that
  # crosses. Everything between here and the cycle's own quiesce is one short
  # turn.
  require_subagent_in_flight "while the ceiling was being armed"

  # Turn 3 — the crossing. Its transform hook re-reads the same context the
  # arming measured, finds it at or above the armed ceiling and latches the
  # cycle; the turn itself stays short so the subagent is still in flight at the
  # primary's idle, which is where the cycle starts waiting.
  post_prompt "Reply with the single line: ceiling check. Call no tool at all — do not spawn, do not list." \
    "$OUT_DIR/$PREFIX.cycle$CYCLE.turn3.json"
  say "[$PREFIX] $tag turn 3 (context crossing) done $(date +%H:%M:%S)"

  # trigger — the precondition of everything below
  local line_scheduled=0
  if wait_for_pattern "endless: scheduled" "endless: scheduled .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S"; then
    line_scheduled=$WAIT_LINENO
    record "$tag trigger — the primary crossed endlessContext=$ARMED_CONTEXT" 1 "$WAIT_LINE"
  else
    local ctx_now
    ctx_now=$(primary_ctx_tokens)
    record "$tag trigger — the primary crossed endlessContext=$ARMED_CONTEXT" 0 \
      "the ceiling was not crossed within ${STEP_TIMEOUT_S}s: endlessContext armed at $ARMED_CONTEXT from a measured $MEASURED_CTX tokens, the primary's context now reads ${ctx_now:-unreadable} — $WAIT_REASON"
    say "$tag never started — the steps below cannot be observed"
    return 1
  fi

  # The file as it stands the moment the cycle latches: what the wind-down
  # rewrite will be compared against for the carry-over criterion. Taken here
  # because the freeze is on from the latch, so no new subagent can change it,
  # and the plugin's own snapshot follows a few seconds later.
  local pre_todo="$OUT_DIR/$PREFIX.cycle$CYCLE.pre-todo.md"
  local pre_path pre_ids
  pre_path=$(todo_path)
  if [ -n "$pre_path" ] && cp "$pre_path" "$pre_todo"; then
    pre_ids=$(sed -nE 's/^- (T[0-9]+):.*/\1/p' "$pre_todo" | tr '\n' ',' | sed 's/,$//')
  else
    : > "$pre_todo"
    pre_ids=""
  fi
  say "[$PREFIX] $tag pre-cycle todo ids: ${pre_ids:-none} (copy: $pre_todo)"

  # Whether the subagent outlived the trigger. Read once, here, so criterion (b)
  # can name the sequencing rather than only the plugin's activeAtStart=0.
  local completion_before_trigger="" completion_line
  completion_line=$(subagent_completion_line)
  if [ -n "$completion_line" ] && [ "${completion_line%%:*}" -lt "$line_scheduled" ]; then
    completion_before_trigger="the subagent $SPAWN_HANDLE finished at slice line ${completion_line%%:*}, before the trigger at slice line $line_scheduled — nothing was left in flight for the cycle to wait for: ${completion_line#*:}"
  fi

  post_prompt "Call spawn(\"$SPAWN_AGENT\", \"Reply with the single line: second subagent.\") exactly once. If the tool refuses, report the refusal text verbatim and end your turn immediately. Do not retry, do not call any other tool." \
    "$OUT_DIR/$PREFIX.cycle$CYCLE.turn4.json"
  say "[$PREFIX] $tag turn 4 (post-trigger spawn attempt) done $(date +%H:%M:%S)"

  # ---------- (a) the freeze ------------------------------------------------

  local line_refused=0
  if wait_for_pattern "spawn refused" "spawn refused: endless cycle in progress .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S" \
       "endless: wind-down confirmed"; then
    line_refused=$WAIT_LINENO
    record "$tag (a) freeze — the non-conforming post-trigger spawn was refused" 1 "$WAIT_LINE"
  else
    record "$tag (a) freeze — the non-conforming post-trigger spawn was refused" 0 "$WAIT_REASON"
  fi

  # ---------- (b) the quiesce -----------------------------------------------

  # Bounded by the plugin's own quiesce timeout rather than by STEP_TIMEOUT_S: a
  # later cycle waits out the previous cycle's work-off subagents as well as its
  # own sleeper, which takes longer than a single-cycle run ever did.
  local line_quiesced=0
  if wait_for_pattern "endless: quiesced" "endless: quiesced after [0-9]+ms, activeAtStart=[0-9]+ .*\"sessionID\":\"$SID\"" "$QUIESCE_WAIT_S" \
       "endless: wind-down confirmed"; then
    line_quiesced=$WAIT_LINENO
    local quiesce_line=$WAIT_LINE active_at_start notice_hit notice_no
    active_at_start=$(printf '%s' "$quiesce_line" | sed -E 's/.*activeAtStart=([0-9]+).*/\1/')
    notice_hit=$(subagent_completion_line)
    notice_no=${notice_hit%%:*}
    if [ -n "$completion_before_trigger" ]; then
      record "$tag (b) quiesce — waited for the in-flight subagent" 0 "$completion_before_trigger"
    elif [ -z "$notice_hit" ]; then
      record "$tag (b) quiesce — waited for the in-flight subagent" 0 \
        "no \"notified primary of completion\" line for $SPAWN_HANDLE before the quiesce: $quiesce_line"
    elif [ "$active_at_start" = 0 ]; then
      record "$tag (b) quiesce — waited for the in-flight subagent" 0 \
        "activeAtStart=0: $SPAWN_HANDLE was no longer in flight when the cycle began waiting, so the wait asserted nothing — $quiesce_line"
    elif [ "$notice_no" -lt "$line_quiesced" ]; then
      record "$tag (b) quiesce — waited for the in-flight subagent" 1 \
        "completion notice for $SPAWN_HANDLE (slice line $notice_no) precedes the quiesce (slice line $line_quiesced): $quiesce_line"
    else
      record "$tag (b) quiesce — waited for the in-flight subagent" 0 \
        "the quiesce (slice line $line_quiesced) is not preceded by $SPAWN_HANDLE's completion notice (slice line $notice_no)"
    fi
  else
    record "$tag (b) quiesce — waited for the in-flight subagent" 0 "$WAIT_REASON"
  fi

  # ---------- (c) the rewrite -----------------------------------------------

  # The confirm line is `endless: wind-down confirmed N open task(s) [T1,T2] file=<name>`
  # (src/endless.js). The open ids stand between the brackets, comma-joined, or a
  # lone `-` when none are open. What (c) asserts against the file on disk: the
  # canonical `- <id>:` line for every confirmed id, exactly one todo file in the
  # directory, and — per §7 (c) — no id reused, checked against the id watermark.
  local line_saved=0 saved_ids="" saved_file="" saved_count=0
  if wait_for_pattern "endless: wind-down confirmed" "endless: wind-down confirmed [0-9]+ open task\(s\) \[[^]]*\] file=[^ ]+ .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S" \
       "endless: cycle [0-9]+/[^ ]+ complete"; then
    line_saved=$WAIT_LINENO
    local save_line=$WAIT_LINE
    saved_ids=$(printf '%s' "$save_line" | sed -E 's/.*\[([^]]*)\].*/\1/')
    saved_count=$(printf '%s' "$save_line" | sed -E 's/.*confirmed ([0-9]+) open task.*/\1/')
    saved_file=$(printf '%s' "$save_line" | sed -E 's/.*file=([^ ]+).*/\1/')
    if [ "$saved_count" = 0 ] || [ "$saved_ids" = "-" ] || [ -z "$saved_ids" ]; then
      saved_ids=""
      record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 0 \
        "the cycle confirmed no open task: $save_line"
    else
      local todo_after todo_count_after missing="" next_id next_num max_num=0 id n
      todo_after=$(todo_names)
      todo_count_after=$(printf '%s' "$todo_after" | grep -c .)
      for id in $(printf '%s' "$saved_ids" | tr ',' ' '); do
        grep -qE "^- $id:" "$PROJECT_DIR/$saved_file" 2>/dev/null || missing="$missing $id"
      done
      # No id reused: the watermark's next-id must sit strictly above every
      # confirmed id, so no id the cycle handed out can be handed out again.
      next_id=$(sed -nE 's/.*intercom: next-id (T[0-9]+).*/\1/p' "$PROJECT_DIR/$saved_file" 2>/dev/null | head -n1)
      next_num=$(printf '%s' "$next_id" | sed -E 's/^T//')
      for id in $(printf '%s' "$saved_ids" | tr ',' ' '); do
        n=$(printf '%s' "$id" | sed -E 's/^T//')
        [ "$n" -gt "$max_num" ] 2>/dev/null && max_num=$n
      done
      if [ "$todo_count_after" != 1 ]; then
        record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 0 \
          "$PROJECT_DIR holds $todo_count_after todo files after the cycle ($(echo "$todo_after" | tr '\n' ' ')); exactly one is required"
      elif [ -n "$missing" ]; then
        record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 0 \
          "$PROJECT_DIR/$saved_file carries no \"- <id>:\" line for:$missing — log line: $save_line"
      elif [ -z "$next_id" ] || ! [ "$next_num" -gt "$max_num" ] 2>/dev/null; then
        record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 0 \
          "the id watermark ${next_id:-absent} does not sit above the highest confirmed id T$max_num — an id could be reused. log line: $save_line"
      else
        record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 1 \
          "$saved_count task(s) $saved_ids present in $PROJECT_DIR/$saved_file, one todo file, watermark $next_id above T$max_num — $save_line"
      fi
    fi
  else
    # A rewrite the plugin would not stand behind is the failure this driver was
    # extended for, so it is named with the conjunct that rejected it rather
    # than only as a missing line.
    local rejected
    rejected=$(rejection_line)
    record "$tag (c) rewrite — the wind-down rewrite reached the todo file" 0 \
      "${rejected:+the rewrite was rejected and the snapshot restored: $rejected — }$WAIT_REASON"
  fi

  # ---------- (c) the rewrite touched an entry that was already there --------

  # The hole this driver was extended to close. A cycle whose accepted rewrite
  # carries only ids the file did not have before proves nothing about the path
  # the live failures sit on: the wind-down subagent editing an entry that
  # already existed, which is where V6 ("an id must not be re-bound to a
  # different title", src/endless.js) decides. The criterion therefore fails on
  # an all-fresh rewrite instead of passing over an empty comparison, and names
  # which of the carried-over ids were re-titled.
  local carried="" retitled="" id pre_title now_title
  if [ -n "$saved_ids" ] && [ -s "$pre_todo" ]; then
    for id in $(printf '%s' "$saved_ids" | tr ',' ' '); do
      pre_title=$(task_title "$id" "$pre_todo")
      [ -n "$pre_title" ] || continue
      carried="$carried $id"
      now_title=$(task_title "$id" "$PROJECT_DIR/$saved_file")
      [ "$now_title" != "$pre_title" ] && retitled="$retitled $id"
    done
  fi
  if [ -z "$saved_ids" ]; then
    local rejected2
    rejected2=$(rejection_line)
    record "$tag (c) carry-over — the accepted rewrite touched a pre-existing id" 0 \
      "not reachable: the cycle confirmed no rewrite.${rejected2:+ The rewrite was rejected: $rejected2}"
  elif [ -z "$pre_ids" ]; then
    record "$tag (c) carry-over — the accepted rewrite touched a pre-existing id" 0 \
      "the todo file carried no task before this cycle, so the rewrite could only add fresh ids — nothing here exercises an edit of an existing entry (confirmed: $saved_ids)"
  elif [ -z "$carried" ]; then
    record "$tag (c) carry-over — the accepted rewrite touched a pre-existing id" 0 \
      "the rewrite kept none of the ids that stood in the file before the cycle: pre-existing [$pre_ids], confirmed [$saved_ids] — every confirmed id is a fresh one, so the edit-an-existing-entry path was not exercised and this cycle proves nothing about it"
  else
    record "$tag (c) carry-over — the accepted rewrite touched a pre-existing id" 1 \
      "pre-existing [$pre_ids], confirmed [$saved_ids]; kept:$carried; re-titled by the rewrite:${retitled:- none}"
    [ -z "$retitled" ] && note_uncovered "$tag — an accepted RE-TITLE of a carried-over id" \
      "the rewrite kept$carried unchanged in title, so the id-rebinding path (V6) was not reached in this cycle"
  fi

  # ---------- (a) the permit was consumed exactly once -----------------------

  # The conforming wind-down spawn is admitted through the single-use permit; a
  # second permitted spawn would be refused. Observable as exactly one
  # `spawn admitted: endless wind-down permit consumed` line in this cycle's
  # window — the count is per cycle, not over the whole run.
  refresh_slice
  local admitted_count
  admitted_count=$(slice_count_after "spawn admitted: endless wind-down permit consumed")
  if [ "$admitted_count" = 1 ]; then
    local admit_line
    admit_line=$(slice_match_after "spawn admitted: endless wind-down permit consumed")
    record "$tag (a) permit — the conforming wind-down spawn was admitted exactly once" 1 \
      "one admission line: ${admit_line#*:}"
  elif [ "$admitted_count" = 0 ]; then
    # The plugin's own fallback spawn (startWindDownSubagent) does not go through
    # the permit, so a confirmed rewrite with no admission means the orchestrator
    # never made the permitted spawn and the fallback wrote the file.
    local fallback
    fallback=$(slice_match_after "endless: wind-down spawned by the plugin")
    record "$tag (a) permit — the conforming wind-down spawn was admitted exactly once" 0 \
      "no admission line — ${fallback:+the plugin fallback wrote the file instead: ${fallback#*:}}${fallback:-the wind-down produced no permitted spawn}"
  else
    record "$tag (a) permit — the conforming wind-down spawn was admitted exactly once" 0 \
      "$admitted_count admission lines in this cycle, expected exactly one — the single-use permit was consumed more than once"
  fi

  # ---------- (d) the replacement -------------------------------------------

  local line_cycle=0 newsid=""
  if wait_for_pattern "endless: cycle complete" "endless: cycle [0-9]+/[^ ]+ complete, new session ses_[A-Za-z0-9]+" "$STEP_TIMEOUT_S"; then
    line_cycle=$WAIT_LINENO
    local cycle_line=$WAIT_LINE old_state new_ok
    newsid=$(printf '%s' "$cycle_line" | sed -E 's/.*new session ([A-Za-z0-9_]+).*/\1/')
    SESSION_IDS="$SESSION_IDS $newsid"
    CYCLE_NEWSID=$newsid
    # The successor may not start the next cycle on a turn of its own: the
    # ceiling goes back out of reach before the work-off phase below, which
    # takes minutes.
    hold_ceiling
    curl -s -m 20 "$BASE/session/$newsid" > "$OUT_DIR/$PREFIX.cycle$CYCLE.new-session.json"
    curl -s -m 20 "$BASE/session/$SID" > "$OUT_DIR/$PREFIX.cycle$CYCLE.old-session.json"
    old_state=$(python3 - "$OUT_DIR/$PREFIX.cycle$CYCLE.old-session.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("unreadable"); raise SystemExit
if not isinstance(d, dict) or "id" not in d:
    print("gone"); raise SystemExit
print("archived" if (d.get("time") or {}).get("archived") else "live")
PY
)
    new_ok=$(python3 - "$OUT_DIR/$PREFIX.cycle$CYCLE.new-session.json" "$newsid" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("no"); raise SystemExit
print("yes" if isinstance(d, dict) and d.get("id") == sys.argv[2] else "no")
PY
)
    if [ "$new_ok" != yes ]; then
      record "$tag (d) replacement — new session created, old one archived" 0 \
        "GET /session/$newsid did not return that session — $cycle_line"
    elif [ "$old_state" = archived ]; then
      record "$tag (d) replacement — new session created, old one archived" 1 \
        "new session $newsid readable, old session $SID still readable and archived — $cycle_line"
    else
      record "$tag (d) replacement — new session created, old one archived" 0 \
        "old session $SID reads as \"$old_state\", expected \"archived\" (archived, not deleted) — $cycle_line"
    fi
  else
    record "$tag (d) replacement — new session created, old one archived" 0 "$WAIT_REASON"
  fi

  # ---------- the kickoff names the saved ids -------------------------------

  if [ -n "$newsid" ] && [ -n "$saved_ids" ]; then
    POLL_URL="$BASE/session/$newsid/message"
    local kick_result kick_verdict kick_evidence kick_rest
    kick_result=$(poll_verdict "$OUT_DIR/$PREFIX.cycle$CYCLE.new-session-messages.json" \
      "$HERE/lib/kickoff-ids.py" "$saved_ids")
    kick_rest=${kick_result#*|}
    kick_verdict=${kick_rest%%|*}
    kick_evidence=${kick_rest#*|}
    case "$kick_verdict" in
      pass) record "$tag kickoff — the new session is told to work off exactly the saved ids" 1 "$kick_evidence" ;;
      fail) record "$tag kickoff — the new session is told to work off exactly the saved ids" 0 "$kick_evidence" ;;
      *)    record "$tag kickoff — the new session is told to work off exactly the saved ids" 0 "$kick_evidence (within ${STEP_TIMEOUT_S}s)" ;;
    esac
  else
    record "$tag kickoff — the new session is told to work off exactly the saved ids" 0 \
      "not reachable: no new session id and/or no saved ids from the steps above"
  fi

  # ---------- the order -----------------------------------------------------

  if printf '%s' "$line_scheduled $line_refused $line_quiesced $line_saved $line_cycle" | grep -q '\b0\b'; then
    record "$tag order — the five cycle lines appear in the concept's order" 0 \
      "not all five lines were found (slice lines: scheduled=$line_scheduled refused=$line_refused quiesced=$line_quiesced saved=$line_saved cycle=$line_cycle)"
  elif [ "$line_scheduled" -lt "$line_refused" ] && [ "$line_refused" -lt "$line_quiesced" ] &&
       [ "$line_quiesced" -lt "$line_saved" ] && [ "$line_saved" -lt "$line_cycle" ]; then
    record "$tag order — the five cycle lines appear in the concept's order" 1 \
      "slice lines: scheduled=$line_scheduled < refused=$line_refused < quiesced=$line_quiesced < saved=$line_saved < cycle=$line_cycle"
  else
    record "$tag order — the five cycle lines appear in the concept's order" 0 \
      "out of order — slice lines: scheduled=$line_scheduled refused=$line_refused quiesced=$line_quiesced saved=$line_saved cycle=$line_cycle"
  fi

  CYCLE_SAVED_IDS=$saved_ids
  CYCLE_SAVED_FILE=$saved_file
  [ -n "$newsid" ] || return 1
  return 0
}

# ---------- the work-off phase of one cycle ---------------------------------

# (e) over the successor of cycle $1. It runs before the next cycle and before
# any teardown for the reason stated at the top: a session delete takes the
# running subagents and the todo restore puts a removed task back. Its removal is
# also what leaves the next cycle an accumulated file whose entries no longer all
# match the state on disk.
observe_workoff() {
  local tag="cycle $CYCLE" newsid="$CYCLE_NEWSID" saved_ids="$CYCLE_SAVED_IDS" saved_file="$CYCLE_SAVED_FILE"

  # The kickoff prompt starts the successor's model turn asynchronously. The
  # capture follows that FIRST turn to its END — every tool call it makes, not
  # only up to the first spawn — and inspects the spawn tool inputs themselves;
  # looking at the kickoff text alone would let a model that ignored the task ids
  # pass this criterion.
  #
  # What is asserted is what the concept states: the successor spawns the FIRST
  # saved task, and every spawn prompt carries a saved id on its first line
  # (specs/endless-mode.md §7 (e), §3.5). One spawn per saved task in the first
  # turn is NOT required — the kickoff's own instruction is "top to bottom, the
  # first task is the next one to do" — so the per-task spawn tally is carried as
  # evidence under this criterion rather than asserted as one.
  if [ -n "$newsid" ] && [ -n "$saved_ids" ]; then
    local work_capture="$OUT_DIR/$PREFIX.cycle$CYCLE.successor-first-turn.json"
    POLL_URL="$BASE/session/$newsid/message"
    local work_read work_state work_rest work_verdict work_evidence
    work_read=$(poll_verdict "$work_capture" "$HERE/lib/successor-turn.py" "$saved_ids")
    work_state=${work_read%%|*}
    work_rest=${work_read#*|}
    work_verdict=${work_rest%%|*}
    work_evidence=${work_rest#*|}
    [ "$work_state" = setup ] && die "$tag: $work_evidence"
    say "[$PREFIX] $tag successor first turn $work_state — capture: $work_capture"
    case "$work_verdict" in
      pass) record "$tag (e) work-off — successor spawn prompts carry saved task ids on their first line" 1 "$work_evidence" ;;
      fail) record "$tag (e) work-off — successor spawn prompts carry saved task ids on their first line" 0 "$work_evidence" ;;
      *)    record "$tag (e) work-off — successor spawn prompts carry saved task ids on their first line" 0 "$work_evidence (within ${STEP_TIMEOUT_S}s)" ;;
    esac
  else
    record "$tag (e) work-off — successor spawn prompts carry saved task ids on their first line" 0 \
      "not reachable: no new session id and/or no saved ids from the save step"
  fi

  # The second half of §7 (e): "the `DONE: T<n>` path removes it from the file".
  # The spawn half above only shows the successor picking the task up. The
  # removal is the plugin's own wake-path write — autoMarkTask -> removeTask
  # (src/hooks.js, src/todofile.js) — which rides on the successor's completion
  # line as `"kind":"done","id":"T<n>"`.
  #
  # Both sides are asserted, because either alone would be weak: a line without
  # the file write would be a claim, a file without the line would not say who
  # wrote it.
  if [ -n "$newsid" ] && [ -n "$saved_ids" ] && [ -n "$saved_file" ]; then
    if wait_for_pattern "DONE removal" \
         "notified primary of completion .*\"parentID\":\"$newsid\".*\"kind\":\"done\",\"id\":\"T[0-9]+\"" \
         "$WORKOFF_TIMEOUT_S"; then
      local removal_line=$WAIT_LINE removed_id open_now
      removed_id=$(printf '%s' "$removal_line" | sed -E 's/.*"kind":"done","id":"(T[0-9]+)".*/\1/')
      open_now=$(sed -nE 's/^- (T[0-9]+):.*/\1/p' "$PROJECT_DIR/$saved_file" 2>/dev/null | tr '\n' ' ')
      if ! printf ' %s ' "$(printf '%s' "$saved_ids" | tr ',' ' ')" | grep -q " $removed_id "; then
        record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
          "the plugin removed $removed_id, which is not one of this cycle's saved ids $saved_ids — $removal_line"
      elif [ ! -f "$PROJECT_DIR/$saved_file" ]; then
        record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
          "$PROJECT_DIR/$saved_file does not exist any more — a removal takes the task's lines out of the file, it does not take the file — $removal_line"
      elif grep -qE "^- $removed_id:" "$PROJECT_DIR/$saved_file"; then
        record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
          "$PROJECT_DIR/$saved_file still carries \"- $removed_id:\" after the plugin reported it removed; open ids now: ${open_now:-none} — $removal_line"
      else
        record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 1 \
          "$removed_id is gone from $PROJECT_DIR/$saved_file (saved $saved_ids, still open: ${open_now:-none}) — $removal_line"
      fi
    else
      record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
        "no completion line reporting a removed task for the successor $newsid within ${WORKOFF_TIMEOUT_S}s — $WAIT_REASON"
    fi
  else
    record "$tag (e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
      "not reachable: no new session id, no saved ids and/or no todo file name from the save step"
  fi
}

# ---------- the run ---------------------------------------------------------

SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT_DIR" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$SID" ] || die "the server did not return a session id"
SESSION_IDS="$SID"
echo "$SID" > "$OUT_DIR/$PREFIX.sid"
say ""
say "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

# The whole run is read off the plugin's debug log, so a server that loaded no
# plugin has to fail here rather than after a spent model turn.
if ! wait_for_pattern "agent-intercom initialized" "agent-intercom initialized" 30; then
  die "no \"agent-intercom initialized\" line in $DEBUG_LOG within 30s — the server on $BASE did not load the plugin from $PLUGIN_ROOT ($WAIT_REASON)"
fi
say "[$PREFIX] plugin loaded (slice line $WAIT_LINENO)"

CYCLES_DRIVEN=0
k=1
while [ "$k" -le "$ENDLESS_CYCLES" ]; do
  if ! run_cycle "$k"; then
    CYCLES_DRIVEN=$k
    say ""
    say "cycle $k did not complete — the cycles after it are not driven"
    if [ "$k" -lt "$ENDLESS_CYCLES" ]; then
      note_uncovered "cycles $((k + 1))..$ENDLESS_CYCLES" \
        "cycle $k left no successor session, so the cycles after it had nothing to start from"
    fi
    break
  fi
  observe_workoff
  # The successor is the next cycle's primary, and the file it now carries — one
  # task removed, its remaining entries no longer all matching the state on disk
  # — is the accumulated state the next cycle rewrites.
  SID=$CYCLE_NEWSID
  CYCLES_DRIVEN=$k
  k=$((k + 1))
done

# ---------- what this driver does not assert -------------------------------

say ""
note_uncovered "(f) view switch and (g) sidebar (specs/endless-mode.md §7)" \
  "both require a screenshot of the rendered TUI; a shell driver cannot produce visual evidence"

say ""
# The copy at the top of the report was printed before the run resolved its own
# figures: it names the armed ceiling and the in-flight handle as pending. The
# same block written again here, into the report alone rather than onto the
# terminal a second time, carries the last cycle's figures filled in, so the
# report holds a setup a rerun can be driven from.
{ printf '\n'; print_setup; } >> "$REPORT_FILE"
say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed over $CYCLES_DRIVEN of $ENDLESS_CYCLES driven cycle(s) ==="
say "(the setup for reproduction stands at the top of $REPORT_FILE and again, fully resolved, at its end)"
[ "$FAILURES" = 0 ] && [ "$CYCLES_DRIVEN" = "$ENDLESS_CYCLES" ] && exit 0
exit 1
