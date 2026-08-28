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
#   order      the five evidence lines appear in that order in the debug log
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
#   ENDLESS_PROJECT_DIR /home/user/testopencode  project whose opencode.json wires
#                      this plugin by absolute path; the server runs in it and
#                      the session is created with ?directory= pointing at it.
#                      Its own name, not PROJECT_DIR: run-all.sh passes that one
#                      to the message-tree drivers and it must not redirect the
#                      cycle by accident
#   ENDLESS_PORT       4599                    own port, kept clear of run-all's 4567
#   ENDLESS_CONTEXT    8000                    the threshold the primary must cross
#   ENDLESS_MAX_CYCLES 1                       ceiling; 1 = the loop stops itself
#                      after the one cycle this driver asserts
#   ENDLESS_QUIESCE_TIMEOUT_MS 120000          the plugin's own quiesce bound
#   SPAWN_AGENT        coder                   the in-flight subagent's role
#   SUBAGENT_SLEEP_S   30                      how long it stays in flight
#   TURN_TIMEOUT_S     600                     per blocking prompt POST
#   STEP_TIMEOUT_S     300                     per awaited log line
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
# four endless keys; backed up and restored, including the `endlessMode: false`
# the plugin writes back itself when the cycle ceiling ends the loop), the todo
# file of the driven project, the two sessions of the cycle, and the server.
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

PROJECT_DIR=${ENDLESS_PROJECT_DIR:-/home/user/testopencode}
PORT=${ENDLESS_PORT:-4599}
BASE=$(e2e_server_url "$PORT")
ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-8000}
ENDLESS_MAX_CYCLES=${ENDLESS_MAX_CYCLES:-1}
ENDLESS_QUIESCE_TIMEOUT_MS=${ENDLESS_QUIESCE_TIMEOUT_MS:-120000}
SPAWN_AGENT=${SPAWN_AGENT:-coder}
SUBAGENT_SLEEP_S=${SUBAGENT_SLEEP_S:-30}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-600}
STEP_TIMEOUT_S=${STEP_TIMEOUT_S:-300}
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
RESOLVED_MODEL="(unresolved)"
SERVER_VERSION="(unknown)"

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

  # The project's todo file goes back to what it was before the cycle wrote to it.
  if [ "$TODO_GUARDED" = 1 ]; then
    if [ "$TODO_EXISTED" = 1 ]; then
      cp "$TODO_BAK" "$PROJECT_DIR/$TODO_BAK_NAME" && say "restored $PROJECT_DIR/$TODO_BAK_NAME"
    else
      local f
      for f in "$PROJECT_DIR"/[Tt][Oo][Dd][Oo].md "$PROJECT_DIR"/[Tt][Oo][Dd][Oo][Ss].md; do
        [ -f "$f" ] && rm -f "$f" && say "removed $f (the cycle created it; there was none before)"
      done
    fi
  fi

  # The server.
  if [ "$KEEP_SERVER" = 1 ]; then
    say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $BASE"
  else
    e2e_server_stop
  fi

  # Settings last: the plugin writes `endlessMode: false` back itself when a
  # bound ends the loop, so the restore has to happen after the server is gone.
  # Only ever touched when this driver wrote the file in the first place.
  if [ "$SETTINGS_WRITTEN" = 1 ]; then
    if [ "$SETTINGS_EXISTED" = 1 ]; then
      cp "$SETTINGS_BAK" "$SETTINGS_FILE" && say "restored $SETTINGS_FILE from $SETTINGS_BAK"
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
  die "$PROJECT_DIR wires neither $PLUGIN_ROOT in its opencode.json plugin array nor a drop-in under .opencode/plugin/ — the run would observe a server without this plugin"

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

python3 - "$SETTINGS_FILE" "$ENDLESS_CONTEXT" "$ENDLESS_QUIESCE_TIMEOUT_MS" "$ENDLESS_MAX_CYCLES" <<'PY' || die "could not write the endless keys into the settings file"
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
settings written    endlessMode=true endlessContext=$ENDLESS_CONTEXT endlessQuiesceTimeoutMs=$ENDLESS_QUIESCE_TIMEOUT_MS endlessMaxCycles=$ENDLESS_MAX_CYCLES
debug log           $DEBUG_LOG   (read from byte $LOG_OFFSET)
todo baseline       $TODO_BASELINE   (backup: $TODO_BAK)
in-flight subagent  spawn("$SPAWN_AGENT", sleep ${SUBAGENT_SLEEP_S}s)
timeouts            turn=${TURN_TIMEOUT_S}s step=${STEP_TIMEOUT_S}s start=${SERVER_START_TIMEOUT_S}s poll=${POLL_S}s
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

TURN1="Do exactly two things and nothing else. First, call spawn(\"$SPAWN_AGENT\", \"Run the shell command: sleep $SUBAGENT_SLEEP_S. Then reply with the single line: slept $SUBAGENT_SLEEP_S seconds.\") exactly once. Second, name three short open points you would still have to verify in this project, and keep them in mind. End your turn after the spawn returns. Do not poll, do not call list(), do not spawn a second subagent."
post_prompt "$TURN1" "$OUT_DIR/$PREFIX.turn1.json"
say "[$PREFIX] turn 1 (spawn + open points) done $(date +%H:%M:%S)"

# trigger — the precondition of everything below
if wait_for_pattern "endless: scheduled" "endless: scheduled .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S"; then
  LINE_SCHEDULED=$WAIT_LINENO
  record "trigger — the primary crossed endlessContext=$ENDLESS_CONTEXT" 1 "$WAIT_LINE"
else
  LINE_SCHEDULED=0
  record "trigger — the primary crossed endlessContext=$ENDLESS_CONTEXT" 0 "$WAIT_REASON"
  say ""
  say "the cycle never started — the steps below cannot be observed"
  say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
  exit 1
fi

TURN2="Call spawn(\"$SPAWN_AGENT\", \"Reply with the single line: second subagent.\") exactly once. If the tool refuses, report the refusal text verbatim and end your turn immediately. Do not retry, do not call any other tool."
post_prompt "$TURN2" "$OUT_DIR/$PREFIX.turn2.json"
say "[$PREFIX] turn 2 (post-trigger spawn attempt) done $(date +%H:%M:%S)"

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
  if [ -z "$NOTICE_HIT" ]; then
    record "(b) quiesce — waited for the in-flight subagent" 0 \
      "no \"notified primary of completion\" line for parentID=$SID before the quiesce: $QUIESCE_LINE"
  elif [ "$ACTIVE_AT_START" = 0 ]; then
    record "(b) quiesce — waited for the in-flight subagent" 0 \
      "activeAtStart=0: nothing was in flight when the cycle began waiting — $QUIESCE_LINE"
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
  KICKOFF_DEADLINE=$(( $(date +%s) + STEP_TIMEOUT_S ))
  KICK_RESULT="pending|no message list was read from the new session"
  while :; do
    curl -s -m 30 "$BASE/session/$NEWSID/message" > "$OUT_DIR/$PREFIX.new-session-messages.json"
    KICK_RESULT=$(python3 - "$OUT_DIR/$PREFIX.new-session-messages.json" "$SAVED_IDS" <<'PY'
import json, re, sys
HEADING = "## Endless mode — work off the todo file"
try:
    payload = json.load(open(sys.argv[1]))
except Exception as err:
    print(f"pending|the message list was unreadable: {err}"); raise SystemExit
expected = [i for i in sys.argv[2].split(",") if i]

# Every string anywhere in the payload, so the check does not depend on the
# exact message/part nesting the server returns.
def strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from strings(v)

hit = next((t for t in strings(payload) if HEADING in t), None)
if hit is None:
    print("pending|no message on the new session carries the endless kickoff heading yet")
    raise SystemExit
block = hit.split(HEADING, 1)[1]
head = block.split("\n\n")[1] if len(block.split("\n\n")) > 1 else block
named = re.findall(r"\bT\d+\b", head)
missing = [i for i in expected if i not in named]
extra = [i for i in named if i not in expected]
first = " ".join(head.split())[:200]
if missing or extra:
    print(f"fail|kickoff names {named or 'no id'}; missing {missing or 'none'}, not from this save {extra or 'none'} — \"{first}\"")
else:
    print(f"pass|kickoff names exactly {named} — \"{first}\"")
PY
)
    case "$KICK_RESULT" in
      pass\|*|fail\|*) break ;;
    esac
    if [ "$(date +%s)" -ge "$KICKOFF_DEADLINE" ] || ! e2e_server_alive; then break; fi
    sleep "$POLL_S"
  done
  case "$KICK_RESULT" in
    pass\|*) record "kickoff — the new session is told to work off exactly the saved ids" 1 "${KICK_RESULT#*|}" ;;
    fail\|*) record "kickoff — the new session is told to work off exactly the saved ids" 0 "${KICK_RESULT#*|}" ;;
    *)       record "kickoff — the new session is told to work off exactly the saved ids" 0 "${KICK_RESULT#*|} (within ${STEP_TIMEOUT_S}s)" ;;
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

# ---------- what this driver does not assert -------------------------------

say ""
note_uncovered "(e) work-off (specs/endless-mode.md §7)" \
  "the new orchestrator spawning for the first task and the DONE: T<n> path removing it is a second cycle's worth of model work; test/e2e/todo-driver.mjs covers the DONE path on its own"
note_uncovered "(f) view switch and (g) sidebar (specs/endless-mode.md §7)" \
  "both require a screenshot of the rendered TUI; a shell driver cannot produce visual evidence"

say ""
print_setup >/dev/null
say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
say "(setup for reproduction is at the top of $REPORT_FILE)"
[ "$FAILURES" = 0 ] && exit 0
exit 1
