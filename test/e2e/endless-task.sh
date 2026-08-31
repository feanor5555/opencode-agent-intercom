#!/bin/bash
# Endless-mode end-to-end driver.
#
# Drives ONE full endless cycle against a real `opencode serve` and asserts the
# cycle's observable steps in the order the concept states them
# (specs/endless-mode.md §3.1, live criteria §7 a-d):
#
#   trigger    the primary crosses `endlessContext`      → `endless: scheduled`
#   (a) freeze a post-trigger spawn is refused           → `spawn refused: endless cycle in progress`
#   (b) quiesce the in-flight subagent's completion notice is delivered BEFORE
#              the cycle stops waiting                   → `notified primary of completion` < `endless: quiesced`
#   (c) save   the open points reach the todo file on disk, one todo file only
#                                                        → `endless: saved N point(s) as T…`
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
# How the run is sequenced, and why in this order:
#
#   turn 1  the primary names its open points          (context grows)
#   turn 2  the primary spawns ONE sleeping subagent and ends its turn
#           → the driver waits for the plugin's own `spawned` line and takes the
#             handle from it; that handle is the in-flight state everything below
#             is gated on. From here the subagent counts as in flight until
#             `notified primary of completion` names it.
#   arming  the driver reads the primary's REAL context off the session
#           (the sum `latestContextTokens` computes, src/client.js) and only then
#           writes `endlessContext` below it. Until this moment the key sits at
#           ENDLESS_CONTEXT_CEILING, high enough that no turn crosses it, so the
#           cycle cannot start before the subagent is in flight.
#   turn 3  one short turn whose transform hook re-reads that same context, finds
#           it at or above the armed ceiling and latches the cycle. The turn
#           spawns nothing — the freeze is already on from the latch.
#   turn 4  the post-trigger spawn attempt of (a).
#   work-off the successor's first turn, its spawn prompts, and the removal of a
#           saved task when one of its subagents replies `DONE: T<n>`.
#
# The whole work-off phase is observed BEFORE anything is torn down. Deleting
# the successor's session takes its running subagents with it, and restoring the
# todo file puts a removed task straight back, so a teardown that ran first
# would make the removal unobservable. cleanup() therefore keeps this order:
# the two sessions (which needs a live server), then the server, then the todo
# file — once no plugin is running, the restore is the last write to that file —
# then the settings.
#
# The precondition of criterion (b) is that the subagent is STILL in flight when
# the cycle starts waiting. The driver checks the handle twice — before it arms
# and again immediately before turn 3 — and refuses to run a vacuous quiesce:
# a subagent that finished early is a setup error (exit 2) naming exactly that,
# never a quietly recorded pass.
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
#   ENDLESS_PORT       4599                    own port, kept clear of run-all's 4567
#   ENDLESS_CONTEXT    (empty)                 the armed threshold. Empty — the
#                      default — derives it from the primary's measured context;
#                      a value given here is used verbatim and VERIFIED against
#                      that measurement, the run stopping as a setup error when
#                      the session never reaches it
#   ENDLESS_CONTEXT_CEILING 100000000          the threshold in force until the
#                      driver arms; high enough that no preparation turn crosses it
#   ENDLESS_CONTEXT_MARGIN 1000                how far below the measured context
#                      the derived threshold is placed
#   SETTINGS_TTL_WAIT_S 3                      wait after arming, past the
#                      plugin's 2 000 ms settings cache (src/settings.js TTL_MS)
#   ENDLESS_MAX_CYCLES 1                       ceiling; 1 = the loop stops itself
#                      after the one cycle this driver asserts
#   ENDLESS_QUIESCE_TIMEOUT_MS 120000          the plugin's own quiesce bound
#   SPAWN_AGENT        coder                   the in-flight subagent's role
#   SUBAGENT_SLEEP_S   45                      how long it stays in flight; the
#                      run is gated on the observed handle, not on this number
#   TURN_TIMEOUT_S     600                     per blocking prompt POST
#   STEP_TIMEOUT_S     300                     per awaited log line
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
# which the cycle appends to and the work-off removes from, restored
# byte-identically from the backup, or deleted again where the cycle created it
# — the two sessions of the cycle, and the server.
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
ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-}
ENDLESS_CONTEXT_CEILING=${ENDLESS_CONTEXT_CEILING:-100000000}
ENDLESS_CONTEXT_MARGIN=${ENDLESS_CONTEXT_MARGIN:-1000}
SETTINGS_TTL_WAIT_S=${SETTINGS_TTL_WAIT_S:-3}
ENDLESS_MAX_CYCLES=${ENDLESS_MAX_CYCLES:-1}
ENDLESS_QUIESCE_TIMEOUT_MS=${ENDLESS_QUIESCE_TIMEOUT_MS:-120000}
SPAWN_AGENT=${SPAWN_AGENT:-coder}
SUBAGENT_SLEEP_S=${SUBAGENT_SLEEP_S:-45}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-600}
STEP_TIMEOUT_S=${STEP_TIMEOUT_S:-300}
WORKOFF_TIMEOUT_S=${WORKOFF_TIMEOUT_S:-600}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
POLL_S=${POLL_S:-2}
OUT_DIR=${OUT_DIR:-$HERE/out}
KEEP_SERVER=${KEEP_SERVER:-0}

SETTINGS_FILE="$HOME/.config/opencode/agent-intercom.json"
DEBUG_LOG="$HOME/.cache/opencode-agent-intercom/debug.log"

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
NEWSID=""
LOG_OFFSET=0
LOG_TRUNCATED=0
SETTINGS_EXISTED=0
SETTINGS_WRITTEN=0
TODO_BAK_NAME=""
TODO_EXISTED=0
TODO_GUARDED=0
FAILURES=0
ASSERTED=0
WAIT_LINE=""
WAIT_LINENO=0
WAIT_REASON=""
POLL_URL=""
RESOLVED_MODEL="(unresolved)"
SERVER_VERSION="(unknown)"
# The in-flight subagent's handle, taken from the plugin's own `spawned` line,
# and the context figures the ceiling is armed from.
SPAWN_HANDLE=""
MEASURED_CTX=""
ARMED_CONTEXT=""

# ---------- reporting ------------------------------------------------------

say() { printf '%s\n' "$*"; }

# One asserted criterion: name, 1|0, and the evidence line that decided it.
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

# A criterion this driver deliberately does not assert, named so a reader does
# not mistake its absence for a pass.
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

# Waits for one line in the slice. Returns 0 with WAIT_LINE / WAIT_LINENO set,
# or 1 with WAIT_REASON set. Never returns 0 on a timeout, and gives up early
# when the cycle abandoned, when the optional 4th pattern shows the cycle has
# already moved past this step, or when the server died — a step that does not
# happen must fail loudly, not be waited out.
wait_for_pattern() {
  local label="$1" pattern="$2" timeout="$3" giveup="${4:-}"
  local deadline=$(( $(date +%s) + timeout ))
  local hit ab past
  WAIT_LINE=""; WAIT_LINENO=0; WAIT_REASON=""
  while :; do
    refresh_slice
    hit=$(grep -nE -m1 -- "$pattern" "$SLICE_FILE")
    if [ -n "$hit" ]; then
      WAIT_LINENO=${hit%%:*}
      WAIT_LINE=${hit#*:}
      return 0
    fi
    ab=$(grep -nE -m1 -- 'endless: abandoned at' "$SLICE_FILE")
    if [ -n "$ab" ]; then
      WAIT_REASON="cycle abandoned before \"$label\" — ${ab#*:}"
      return 1
    fi
    if [ -n "$giveup" ]; then
      past=$(grep -nE -m1 -- "$giveup" "$SLICE_FILE")
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

# ---------- cleanup --------------------------------------------------------

cleanup() {
  local code=$?
  set +u
  say ""
  say "--- cleanup ---"

  # Sessions first: the server has to be alive to delete them.
  for s in "$SID" "$NEWSID"; do
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

  # The project's todo file goes back to what it was before the cycle wrote to
  # it: remove every name not present in the baseline, then restore the backup
  # where there was one. Runs on the failure path too — it hangs on
  # TODO_GUARDED, which is set once the baseline was taken, not on any assertion.
  if [ "$TODO_GUARDED" = 1 ]; then
    local f todo_after
    todo_after=$(todo_names)
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if ! printf '%s\n' "$TODO_BEFORE" | grep -Fqx -- "$f"; then
        [ -f "$PROJECT_DIR/$f" ] && rm -f "$PROJECT_DIR/$f" && \
          say "removed $PROJECT_DIR/$f (the cycle created it; it was not in the baseline)"
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

for tool in curl python3 setsid stat npm; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
command -v opencode >/dev/null || die "opencode is not on PATH"
[ -d "$PROJECT_DIR" ] || die "PROJECT_DIR does not exist: $PROJECT_DIR"

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
# twice: once here with the unreachable ceiling, and once from arm_ceiling with
# the threshold derived from the primary's real context. Every other key in the
# file is left as it stands.
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

write_endless_settings "$ENDLESS_CONTEXT_CEILING" ||
  die "could not write the endless keys into the settings file"
SETTINGS_WRITTEN=1

# ---------- todo-file baseline --------------------------------------------

# `todo.md` / `todos.md` in any casing all count as the todo file
# (src/todofile.js). The baseline is both the "exactly one file" assertion of
# (c) and what cleanup restores.
todo_names() {
  find "$PROJECT_DIR" -maxdepth 1 -type f -iregex '.*/todos?\.md' -printf '%f\n' 2>/dev/null | sort
}
TODO_BEFORE=$(todo_names)
TODO_COUNT_BEFORE=$(printf '%s' "$TODO_BEFORE" | grep -c . )
if [ "$TODO_COUNT_BEFORE" -gt 1 ]; then
  die "$PROJECT_DIR already holds several todo files ($(echo "$TODO_BEFORE" | tr '\n' ' ')) — the plugin refuses that state and the cycle would abandon at save"
fi
if [ "$TODO_COUNT_BEFORE" = 1 ]; then
  TODO_EXISTED=1
  TODO_BAK_NAME=$(printf '%s' "$TODO_BEFORE")
  cp "$PROJECT_DIR/$TODO_BAK_NAME" "$TODO_BAK" || die "could not back up $PROJECT_DIR/$TODO_BAK_NAME"
  TODO_BASELINE="present: $TODO_BAK_NAME"
else
  TODO_BASELINE="none in $PROJECT_DIR — the cycle creates TODO.md"
fi
TODO_GUARDED=1

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
default model       $RESOLVED_MODEL
settings file       $SETTINGS_FILE   (backup: $SETTINGS_BAK, existed=$SETTINGS_EXISTED)
settings written    endlessMode=true endlessQuiesceTimeoutMs=$ENDLESS_QUIESCE_TIMEOUT_MS endlessMaxCycles=$ENDLESS_MAX_CYCLES
endless ceiling     held at $ENDLESS_CONTEXT_CEILING until armed, then ${ARMED_CONTEXT:-(armed after the spawn turn)}   (ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-derive from the measured context}, margin $ENDLESS_CONTEXT_MARGIN, settings-cache wait ${SETTINGS_TTL_WAIT_S}s)
debug log           $DEBUG_LOG   (read from byte $LOG_OFFSET)
todo baseline       $TODO_BASELINE   (backup: $TODO_BAK)
in-flight subagent  spawn("$SPAWN_AGENT", sleep ${SUBAGENT_SLEEP_S}s) -> handle ${SPAWN_HANDLE:-(spawned in turn 2)}
timeouts            turn=${TURN_TIMEOUT_S}s step=${STEP_TIMEOUT_S}s work-off=${WORKOFF_TIMEOUT_S}s start=${SERVER_START_TIMEOUT_S}s poll=${POLL_S}s
out dir             $OUT_DIR
EOF
}
print_setup | tee -a "$REPORT_FILE"

# ---------- drive the primary ----------------------------------------------

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
  curl -s -m 30 "$BASE/session/$SID/message" > "$OUT_DIR/$PREFIX.primary-messages.json"
  python3 - "$OUT_DIR/$PREFIX.primary-messages.json" <<'PY'
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

# The completion notice for the handle the `spawned` line named: "<lineno>:<text>"
# once the subagent has finished, nothing while it is still in flight. The same
# line criterion (b) reads, matched on the handle rather than on the parent, so
# it names THIS subagent.
subagent_completion_line() {
  [ -n "$SPAWN_HANDLE" ] || return 0
  refresh_slice
  grep -nE -m1 -- "notified primary of completion .*\"handle\":\"$SPAWN_HANDLE\"" "$SLICE_FILE"
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
  die "the in-flight subagent $SPAWN_HANDLE finished $where — criterion (b) needs it still running when the cycle starts waiting, and a quiesce with activeAtStart=0 asserts nothing. Its completion notice: ${done_line#*:} — raise SUBAGENT_SLEEP_S (it has to stay below maxSubagentAgeMs=$MAX_AGE_MS) or use a faster SPAWN_AGENT model"
}

# Puts `endlessContext` where the primary's MEASURED context is known to reach
# it, so the crossing of the next turn follows from a figure read off the session
# rather than from a guessed constant. Until this runs the key sits at
# ENDLESS_CONTEXT_CEILING and no preparation turn can start a cycle.
arm_ceiling() {
  MEASURED_CTX=$(primary_ctx_tokens)
  case "$MEASURED_CTX" in
    '' | *[!0-9]*)
      die "could not read the primary's context from $BASE/session/$SID/message — with no measurement the ceiling could only be guessed (capture: $OUT_DIR/$PREFIX.primary-messages.json)"
      ;;
  esac
  if [ -n "$ENDLESS_CONTEXT" ]; then
    ARMED_CONTEXT=$ENDLESS_CONTEXT
    if [ "$MEASURED_CTX" -lt "$ARMED_CONTEXT" ]; then
      die "ENDLESS_CONTEXT=$ARMED_CONTEXT was given, but the primary's context measures $MEASURED_CTX tokens after its preparation turns — that ceiling would not be crossed. Leave ENDLESS_CONTEXT unset and the driver derives it from the measurement"
    fi
  else
    ARMED_CONTEXT=$((MEASURED_CTX - ENDLESS_CONTEXT_MARGIN))
    [ "$ARMED_CONTEXT" -lt 1 ] && ARMED_CONTEXT=1
  fi
  write_endless_settings "$ARMED_CONTEXT" ||
    die "could not arm endlessContext=$ARMED_CONTEXT in $SETTINGS_FILE"
  printf 'armed               endlessContext=%s, from a measured %s tokens on %s (handle %s in flight)\n' \
    "$ARMED_CONTEXT" "$MEASURED_CTX" "$SID" "$SPAWN_HANDLE" | tee -a "$REPORT_FILE"
  # The plugin caches its settings for TTL_MS = 2000 (src/settings.js), so the
  # crossing turn has to start after that cache can have expired.
  sleep "$SETTINGS_TTL_WAIT_S"
}

SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT_DIR" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$SID" ] || die "the server did not return a session id"
echo "$SID" > "$OUT_DIR/$PREFIX.sid"
say ""
say "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

# The whole run is read off the plugin's debug log, so a server that loaded no
# plugin has to fail here rather than after a spent model turn.
if ! wait_for_pattern "agent-intercom initialized" "agent-intercom initialized" 30; then
  die "no \"agent-intercom initialized\" line in $DEBUG_LOG within 30s — the server on $BASE did not load the plugin from $PLUGIN_ROOT ($WAIT_REASON)"
fi
say "[$PREFIX] plugin loaded (slice line $WAIT_LINENO)"

# Turn 1 — the open points the cycle will later be asked to save, and the bulk
# of the context the ceiling is derived from. No spawn: a subagent started here
# would spend its flight time on the turns below.
TURN1="Name three short open points you would still have to verify in this project, one line each, and keep them in mind. Call no tool at all — do not spawn, do not list — and end your turn."
post_prompt "$TURN1" "$OUT_DIR/$PREFIX.turn1.json"
say "[$PREFIX] turn 1 (open points) done $(date +%H:%M:%S)"

# Turn 2 — the in-flight subagent, spawned as late as the sequence allows and in
# its own short turn, so its flight overlaps the trigger rather than the setup.
TURN2="Call spawn(\"$SPAWN_AGENT\", \"Run the shell command: sleep $SUBAGENT_SLEEP_S. Then reply with the single line: slept $SUBAGENT_SLEEP_S seconds.\") exactly once and end your turn as soon as it returns. Do not poll, do not call list(), do not spawn a second subagent, do not write anything else."
post_prompt "$TURN2" "$OUT_DIR/$PREFIX.turn2.json"
say "[$PREFIX] turn 2 (spawn) done $(date +%H:%M:%S)"

# The handle is the in-flight state the rest of the run is gated on. Without it
# nothing below can be told apart from a cycle that had nothing to wait for.
if ! wait_for_pattern "spawned" "spawned .*\"agent\":\"$SPAWN_AGENT\".*\"directory\":\"$PROJECT_DIR\"" "$STEP_TIMEOUT_S"; then
  die "no \"spawned\" line for agent $SPAWN_AGENT within ${STEP_TIMEOUT_S}s — the primary never got a subagent in flight, so criterion (b) would have nothing to observe ($WAIT_REASON)"
fi
SPAWN_HANDLE=$(printf '%s' "$WAIT_LINE" | sed -E 's/.*"handle":"([^"]+)".*/\1/')
[ -n "$SPAWN_HANDLE" ] && [ "$SPAWN_HANDLE" != "$WAIT_LINE" ] ||
  die "the \"spawned\" line carries no handle to gate on: $WAIT_LINE"
# One spawn, and the handle above is its. A second one would mean the gates
# below watch a subagent the cycle is not waiting for.
SPAWNED_COUNT=$(grep -cE -- "spawned .*\"handle\":.*\"directory\":\"$PROJECT_DIR\"" "$SLICE_FILE")
[ "$SPAWNED_COUNT" = 1 ] ||
  die "$SPAWNED_COUNT \"spawned\" lines in the slice, expected exactly one — the primary started subagents beyond the one this run gates on, so the in-flight state below would be ambiguous"
say "[$PREFIX] subagent $SPAWN_HANDLE in flight (slice line $WAIT_LINENO)"

# Gate 1: still in flight before the ceiling is armed.
require_subagent_in_flight "before the ceiling was armed"

# The ceiling, derived from the primary's real context rather than guessed.
arm_ceiling

# Gate 2: still in flight after the arming, immediately before the turn that
# crosses. Everything between here and the cycle's own quiesce is one short turn.
require_subagent_in_flight "while the ceiling was being armed"

# Turn 3 — the crossing. Its transform hook re-reads the same context the arming
# measured, finds it at or above the armed ceiling and latches the cycle; the
# turn itself stays short so the subagent is still in flight at the primary's
# idle, which is where the cycle starts waiting.
TURN3="Reply with the single line: ceiling check. Call no tool at all — do not spawn, do not list."
post_prompt "$TURN3" "$OUT_DIR/$PREFIX.turn3.json"
say "[$PREFIX] turn 3 (context crossing) done $(date +%H:%M:%S)"

# trigger — the precondition of everything below
if wait_for_pattern "endless: scheduled" "endless: scheduled .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S"; then
  LINE_SCHEDULED=$WAIT_LINENO
  record "trigger — the primary crossed endlessContext=$ARMED_CONTEXT" 1 "$WAIT_LINE"
else
  LINE_SCHEDULED=0
  CTX_NOW=$(primary_ctx_tokens)
  record "trigger — the primary crossed endlessContext=$ARMED_CONTEXT" 0 \
    "the ceiling was not crossed within ${STEP_TIMEOUT_S}s: endlessContext armed at $ARMED_CONTEXT from a measured $MEASURED_CTX tokens, the primary's context now reads ${CTX_NOW:-unreadable} — $WAIT_REASON"
  say ""
  say "the cycle never started — the steps below cannot be observed"
  say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
  exit 1
fi

# Whether the subagent outlived the trigger. Read once, here, so criterion (b)
# can name the sequencing rather than only the plugin's activeAtStart=0.
COMPLETION_BEFORE_TRIGGER=""
COMPLETION_LINE=$(subagent_completion_line)
if [ -n "$COMPLETION_LINE" ] && [ "${COMPLETION_LINE%%:*}" -lt "$LINE_SCHEDULED" ]; then
  COMPLETION_BEFORE_TRIGGER="the subagent $SPAWN_HANDLE finished at slice line ${COMPLETION_LINE%%:*}, before the trigger at slice line $LINE_SCHEDULED — nothing was left in flight for the cycle to wait for: ${COMPLETION_LINE#*:}"
fi

TURN4="Call spawn(\"$SPAWN_AGENT\", \"Reply with the single line: second subagent.\") exactly once. If the tool refuses, report the refusal text verbatim and end your turn immediately. Do not retry, do not call any other tool."
post_prompt "$TURN4" "$OUT_DIR/$PREFIX.turn4.json"
say "[$PREFIX] turn 4 (post-trigger spawn attempt) done $(date +%H:%M:%S)"

# ---------- (a) the freeze -------------------------------------------------

if wait_for_pattern "spawn refused" "spawn refused: endless cycle in progress .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S" \
     "endless: saved [0-9]+ point"; then
  LINE_REFUSED=$WAIT_LINENO
  record "(a) freeze — the post-trigger spawn was refused" 1 "$WAIT_LINE"
else
  LINE_REFUSED=0
  record "(a) freeze — the post-trigger spawn was refused" 0 "$WAIT_REASON"
fi

# ---------- (b) the quiesce ------------------------------------------------

if wait_for_pattern "endless: quiesced" "endless: quiesced after [0-9]+ms, activeAtStart=[0-9]+ .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S" \
     "endless: saved [0-9]+ point"; then
  LINE_QUIESCED=$WAIT_LINENO
  QUIESCE_LINE=$WAIT_LINE
  ACTIVE_AT_START=$(printf '%s' "$QUIESCE_LINE" | sed -E 's/.*activeAtStart=([0-9]+).*/\1/')
  NOTICE_HIT=$(grep -nE -m1 -- "notified primary of completion .*\"parentID\":\"$SID\"" "$SLICE_FILE")
  NOTICE_NO=${NOTICE_HIT%%:*}
  if [ -n "$COMPLETION_BEFORE_TRIGGER" ]; then
    record "(b) quiesce — waited for the in-flight subagent" 0 "$COMPLETION_BEFORE_TRIGGER"
  elif [ -z "$NOTICE_HIT" ]; then
    record "(b) quiesce — waited for the in-flight subagent" 0 \
      "no \"notified primary of completion\" line for parentID=$SID before the quiesce: $QUIESCE_LINE"
  elif [ "$ACTIVE_AT_START" = 0 ]; then
    record "(b) quiesce — waited for the in-flight subagent" 0 \
      "activeAtStart=0: $SPAWN_HANDLE was no longer in flight when the cycle began waiting, so the wait asserted nothing — $QUIESCE_LINE"
  elif [ "$NOTICE_NO" -lt "$LINE_QUIESCED" ]; then
    record "(b) quiesce — waited for the in-flight subagent" 1 \
      "completion notice (slice line $NOTICE_NO) precedes the quiesce (slice line $LINE_QUIESCED): $QUIESCE_LINE"
  else
    record "(b) quiesce — waited for the in-flight subagent" 0 \
      "the quiesce (slice line $LINE_QUIESCED) is not preceded by the completion notice (slice line $NOTICE_NO)"
  fi
else
  LINE_QUIESCED=0
  record "(b) quiesce — waited for the in-flight subagent" 0 "$WAIT_REASON"
fi

# ---------- (c) the save ---------------------------------------------------

SAVED_IDS=""
SAVED_FILE=""
if wait_for_pattern "endless: saved" "endless: saved [0-9]+ point\(s\) as .* confirmed=[0-9]+ .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S" \
     "endless: cycle [0-9]+/[^ ]+ complete"; then
  LINE_SAVED=$WAIT_LINENO
  SAVE_LINE=$WAIT_LINE
  SAVED_IDS=$(printf '%s' "$SAVE_LINE" | sed -E 's/.* as ([^ ]+) confirmed=.*/\1/')
  SAVED_COUNT=$(printf '%s' "$SAVE_LINE" | sed -E 's/.*confirmed=([0-9]+).*/\1/')
  SAVED_FILE=$(printf '%s' "$SAVE_LINE" | sed -E 's/.*file=([^ ]+).*/\1/')
  if [ "$SAVED_COUNT" = 0 ] || [ "$SAVED_IDS" = "-" ]; then
    SAVED_IDS=""
    record "(c) save — the open points reached the todo file" 0 \
      "the cycle saved no point: $SAVE_LINE"
  else
    TODO_AFTER=$(todo_names)
    TODO_COUNT_AFTER=$(printf '%s' "$TODO_AFTER" | grep -c .)
    MISSING=""
    for id in $(printf '%s' "$SAVED_IDS" | tr ',' ' '); do
      grep -qE "^- $id:" "$PROJECT_DIR/$SAVED_FILE" 2>/dev/null || MISSING="$MISSING $id"
    done
    if [ "$TODO_COUNT_AFTER" != 1 ]; then
      record "(c) save — the open points reached the todo file" 0 \
        "$PROJECT_DIR holds $TODO_COUNT_AFTER todo files after the cycle ($(echo "$TODO_AFTER" | tr '\n' ' ')); exactly one is required"
    elif [ -n "$MISSING" ]; then
      record "(c) save — the open points reached the todo file" 0 \
        "$PROJECT_DIR/$SAVED_FILE carries no \"- <id>:\" line for:$MISSING — log line: $SAVE_LINE"
    else
      record "(c) save — the open points reached the todo file" 1 \
        "$SAVED_COUNT point(s) $SAVED_IDS present in $PROJECT_DIR/$SAVED_FILE, one todo file in the directory — $SAVE_LINE"
    fi
  fi
else
  LINE_SAVED=0
  record "(c) save — the open points reached the todo file" 0 "$WAIT_REASON"
fi

# ---------- (d) the replacement --------------------------------------------

if wait_for_pattern "endless: cycle complete" "endless: cycle [0-9]+/[^ ]+ complete, new session ses_[A-Za-z0-9]+" "$STEP_TIMEOUT_S"; then
  LINE_CYCLE=$WAIT_LINENO
  CYCLE_LINE=$WAIT_LINE
  NEWSID=$(printf '%s' "$CYCLE_LINE" | sed -E 's/.*new session ([A-Za-z0-9_]+).*/\1/')
  curl -s -m 20 "$BASE/session/$NEWSID" > "$OUT_DIR/$PREFIX.new-session.json"
  curl -s -m 20 "$BASE/session/$SID" > "$OUT_DIR/$PREFIX.old-session.json"
  OLD_STATE=$(python3 - "$OUT_DIR/$PREFIX.old-session.json" <<'PY'
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
  NEW_OK=$(python3 - "$OUT_DIR/$PREFIX.new-session.json" "$NEWSID" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("no"); raise SystemExit
print("yes" if isinstance(d, dict) and d.get("id") == sys.argv[2] else "no")
PY
)
  if [ "$NEW_OK" != yes ]; then
    record "(d) replacement — new session created, old one archived" 0 \
      "GET /session/$NEWSID did not return that session — $CYCLE_LINE"
  elif [ "$OLD_STATE" = archived ]; then
    record "(d) replacement — new session created, old one archived" 1 \
      "new session $NEWSID readable, old session $SID still readable and archived — $CYCLE_LINE"
  else
    record "(d) replacement — new session created, old one archived" 0 \
      "old session $SID reads as \"$OLD_STATE\", expected \"archived\" (archived, not deleted) — $CYCLE_LINE"
  fi
else
  LINE_CYCLE=0
  record "(d) replacement — new session created, old one archived" 0 "$WAIT_REASON"
fi

# ---------- the kickoff names the saved ids --------------------------------

if [ -n "$NEWSID" ] && [ -n "$SAVED_IDS" ]; then
  # The kickoff can take a moment to appear as a message on the new session.
  POLL_URL="$BASE/session/$NEWSID/message"
  KICK_RESULT=$(poll_verdict "$OUT_DIR/$PREFIX.new-session-messages.json" \
    "$HERE/lib/kickoff-ids.py" "$SAVED_IDS")
  KICK_STATE=${KICK_RESULT%%|*}
  KICK_REST=${KICK_RESULT#*|}
  KICK_VERDICT=${KICK_REST%%|*}
  KICK_EVIDENCE=${KICK_REST#*|}
  case "$KICK_VERDICT" in
    pass) record "kickoff — the new session is told to work off exactly the saved ids" 1 "$KICK_EVIDENCE" ;;
    fail) record "kickoff — the new session is told to work off exactly the saved ids" 0 "$KICK_EVIDENCE" ;;
    *)    record "kickoff — the new session is told to work off exactly the saved ids" 0 "$KICK_EVIDENCE (within ${STEP_TIMEOUT_S}s)" ;;
  esac
else
  record "kickoff — the new session is told to work off exactly the saved ids" 0 \
    "not reachable: no new session id and/or no saved ids from the steps above"
fi

# ---------- the order ------------------------------------------------------

ORDER="$LINE_SCHEDULED $LINE_REFUSED $LINE_QUIESCED $LINE_SAVED $LINE_CYCLE"
if printf '%s' "$ORDER" | grep -q '\b0\b'; then
  record "order — the five cycle lines appear in the concept's order" 0 \
    "not all five lines were found (slice lines: scheduled=$LINE_SCHEDULED refused=$LINE_REFUSED quiesced=$LINE_QUIESCED saved=$LINE_SAVED cycle=$LINE_CYCLE)"
elif [ "$LINE_SCHEDULED" -lt "$LINE_REFUSED" ] && [ "$LINE_REFUSED" -lt "$LINE_QUIESCED" ] &&
     [ "$LINE_QUIESCED" -lt "$LINE_SAVED" ] && [ "$LINE_SAVED" -lt "$LINE_CYCLE" ]; then
  record "order — the five cycle lines appear in the concept's order" 1 \
    "slice lines: scheduled=$LINE_SCHEDULED < refused=$LINE_REFUSED < quiesced=$LINE_QUIESCED < saved=$LINE_SAVED < cycle=$LINE_CYCLE"
else
  record "order — the five cycle lines appear in the concept's order" 0 \
    "out of order — slice lines: scheduled=$LINE_SCHEDULED refused=$LINE_REFUSED quiesced=$LINE_QUIESCED saved=$LINE_SAVED cycle=$LINE_CYCLE"
fi

# ---------- (e) the work-off -----------------------------------------------

# The kickoff prompt starts the successor's model turn asynchronously. The
# capture follows that FIRST turn to its END — every tool call it makes, not
# only up to the first spawn — and inspects the spawn tool inputs themselves;
# looking at the kickoff text alone would let a model that ignored the task ids
# pass this criterion.
#
# Where the turn ends is read off the persisted messages: an assistant message
# whose `finish` is set to a terminal value other than `tool-calls` or `unknown`
# is the last step of the turn, and a further user message — a subagent's
# completion notice — already belongs to the next one. Both bound the capture,
# and so does STEP_TIMEOUT_S:
# a turn still running at that bound is judged on what it produced by then and
# the evidence says so.
#
# What is asserted is what the concept states: the successor spawns the FIRST
# saved task, and every spawn prompt carries a saved id on its first line
# (specs/endless-mode.md §7 (e), §3.5). One spawn per saved task in the first
# turn is NOT required — the kickoff's own instruction is "top to bottom, the
# first task is the next one to do" — so the per-task spawn tally is carried as
# evidence under this criterion rather than asserted as one.
if [ -n "$NEWSID" ] && [ -n "$SAVED_IDS" ]; then
  WORK_CAPTURE="$OUT_DIR/$PREFIX.successor-first-turn.json"
  POLL_URL="$BASE/session/$NEWSID/message"
  WORK_READ=$(poll_verdict "$WORK_CAPTURE" "$HERE/lib/successor-turn.py" "$SAVED_IDS")
  WORK_STATE=${WORK_READ%%|*}
  WORK_REST=${WORK_READ#*|}
  WORK_VERDICT=${WORK_REST%%|*}
  WORK_EVIDENCE=${WORK_REST#*|}
  [ "$WORK_STATE" = setup ] && die "$WORK_EVIDENCE"
  say "[$PREFIX] successor first turn $WORK_STATE — capture: $WORK_CAPTURE"
  case "$WORK_VERDICT" in
    pass) record "(e) work-off — successor spawn prompts carry saved task ids on their first line" 1 "$WORK_EVIDENCE" ;;
    fail) record "(e) work-off — successor spawn prompts carry saved task ids on their first line" 0 "$WORK_EVIDENCE" ;;
    *)    record "(e) work-off — successor spawn prompts carry saved task ids on their first line" 0 "$WORK_EVIDENCE (within ${STEP_TIMEOUT_S}s)" ;;
  esac
else
  record "(e) work-off — successor spawn prompts carry saved task ids on their first line" 0 \
    "not reachable: no new session id and/or no saved ids from the save step"
fi

# ---------- (e) the removal ------------------------------------------------

# The second half of §7 (e): "the `DONE: T<n>` path removes it from the file".
# The spawn half above only shows the successor picking the task up. The removal
# is the plugin's own wake-path write — autoMarkTask -> removeTask
# (src/hooks.js, src/todofile.js) — which fires when the subagent's final reply
# carries `DONE: T<n>` on its first or last non-empty line and the id matches
# the one its spawn prompt was prefixed with.
#
# Both sides are asserted, because either alone would be weak: the plugin's own
# completion line, which carries the outcome as `"kind":"done","id":"T<n>"`, and
# the todo file on disk, from which that id has to be gone. A line without the
# file write would be a claim; a file without the line would not say who wrote
# it.
#
# This step waits for a subagent to finish real work, not for a line the cycle
# emits by itself, so it has its own bound (WORKOFF_TIMEOUT_S) rather than
# STEP_TIMEOUT_S. It runs before the teardown for the reason stated at the top:
# the session delete would take the subagent and the todo restore would put the
# task back.
if [ -n "$NEWSID" ] && [ -n "$SAVED_IDS" ] && [ -n "$SAVED_FILE" ]; then
  if wait_for_pattern "DONE removal" \
       "notified primary of completion .*\"parentID\":\"$NEWSID\".*\"kind\":\"done\",\"id\":\"T[0-9]+\"" \
       "$WORKOFF_TIMEOUT_S"; then
    REMOVAL_LINE=$WAIT_LINE
    REMOVED_ID=$(printf '%s' "$REMOVAL_LINE" | sed -E 's/.*"kind":"done","id":"(T[0-9]+)".*/\1/')
    OPEN_NOW=$(sed -nE 's/^- (T[0-9]+):.*/\1/p' "$PROJECT_DIR/$SAVED_FILE" 2>/dev/null | tr '\n' ' ')
    if ! printf ' %s ' "$(printf '%s' "$SAVED_IDS" | tr ',' ' ')" | grep -q " $REMOVED_ID "; then
      record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
        "the plugin removed $REMOVED_ID, which is not one of this cycle's saved ids $SAVED_IDS — $REMOVAL_LINE"
    elif [ ! -f "$PROJECT_DIR/$SAVED_FILE" ]; then
      record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
        "$PROJECT_DIR/$SAVED_FILE does not exist any more — a removal takes the task's lines out of the file, it does not take the file — $REMOVAL_LINE"
    elif grep -qE "^- $REMOVED_ID:" "$PROJECT_DIR/$SAVED_FILE"; then
      record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
        "$PROJECT_DIR/$SAVED_FILE still carries \"- $REMOVED_ID:\" after the plugin reported it removed; open ids now: ${OPEN_NOW:-none} — $REMOVAL_LINE"
    else
      record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 1 \
        "$REMOVED_ID is gone from $PROJECT_DIR/$SAVED_FILE (saved $SAVED_IDS, still open: ${OPEN_NOW:-none}) — $REMOVAL_LINE"
    fi
  else
    record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
      "no completion line reporting a removed task for the successor $NEWSID within ${WORKOFF_TIMEOUT_S}s — $WAIT_REASON"
  fi
else
  record "(e) removal — a DONE: T<n> reply removed the task from the todo file" 0 \
    "not reachable: no new session id, no saved ids and/or no todo file name from the save step"
fi

# ---------- what this driver does not assert -------------------------------

say ""
note_uncovered "(f) view switch and (g) sidebar (specs/endless-mode.md §7)" \
  "both require a screenshot of the rendered TUI; a shell driver cannot produce visual evidence"

say ""
# The copy at the top of the report was printed before the run resolved its own
# figures: it names the armed ceiling as "(armed after the spawn turn)" and the
# in-flight handle as "(spawned in turn 2)". The same block written again here,
# into the report alone rather than onto the terminal a second time, carries
# both filled in, so the report holds a setup a rerun can be driven from.
{ printf '\n'; print_setup; } >> "$REPORT_FILE"
say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
say "(the setup for reproduction stands at the top of $REPORT_FILE and again, fully resolved, at its end)"
[ "$FAILURES" = 0 ] && exit 0
exit 1
