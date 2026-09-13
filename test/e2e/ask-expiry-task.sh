#!/bin/bash
# Mid-run ASK expiry and clamp end-to-end driver.
#
# `ask-task.sh` drives the answered path: the caller answers inside the window
# and the answer comes back as the result of the subagent's own `ask` call. Two
# things it explicitly does not reach — its own report names them
# `NOT ASSERTED` — are what this driver exists for:
#
#   (b) THE UNANSWERED PATH   a question the caller never answers. The wait
#                             runs out, the one-shot timer in
#                             `registerAskWaiter` (src/agentmsg.js) settles the
#                             waiter with `status: "unanswered"`, the plugin
#                             logs `ask expired unanswered`, and the subagent's
#                             blocked tool call returns the `No answer came
#                             within …s` form (src/midrun.js).
#   (c) THE CLAMP             `askWaitMs` (src/agentmsg.js) measures the
#                             requested `answerWaitMs` against the watchdog
#                             window the blocked call sits on
#                             (`maxSubagentToolCallMs`, resolved through
#                             `workingWindowMs`, src/settings.js) less
#                             `ASK_WAIT_WATCHDOG_MARGIN_MS`, and takes the
#                             smaller of the two. Where that window leaves no
#                             room at all, no wait is taken: no record is
#                             registered, the plugin logs `ask registered
#                             without a wait`, and the call returns the
#                             `not-waiting` form at once, naming the clamp as
#                             its cause rather than the other way into that
#                             branch, a requested wait of 0.
#
# Both clamp cases are read off the plugin's own `ask registered` line the
# moment it is written, so neither of them waits for a timer: the figure that
# decides them is `waitMs`, and it stands in that line.
#
# Three phases, each with its own primary session and its own subagent:
#
#   expiry   answerWaitMs=ASK_EXPIRY_WAIT_MS (10 000) under a window wide
#            enough that the clamp is inert, so the registered wait IS the
#            pinned one. The orchestrator is told to leave the question
#            unanswered, and the run waits the window out.
#   clamp    answerWaitMs=ASK_CLAMP_REQUEST_MS (30 000) under
#            maxSubagentToolCallMs=ASK_CLAMP_TOOL_CALL_MS (70 000): the room
#            inside that window is 70 000 − 60 000 = 10 000, so the registered
#            wait must be 10 000 and not the 30 000 asked for.
#   no-room  the same request under ASK_NOROOM_TOOL_CALL_MS (60 000): the
#            window equals the margin, the room is 0, and no wait is taken at
#            all.
#
# Asserted criteria (each phase's name carries its phase):
#
#   asked (expiry)        the subagent really called `ask`: its own session
#                         shows the call, the plugin's log shows it posted
#   wait armed (expiry)   the registered wait is the pinned answerWaitMs —
#                         `"waitMs":<pin>` on the `ask registered` line
#   unanswered (expiry)   the caller answered nothing: no `Answer delivered`
#                         line in the primary's transcript
#   expired (expiry)      the timer fired: `ask expired unanswered` for that
#                         session, and the waiter settled with that status
#   tool-result (expiry)  the subagent's own `ask` call returned the unanswered
#                         form, and not the answered one
#   asked (clamp)         as above, for the clamp phase
#   clamp (clamp)         the registered wait is the ROOM inside the window,
#                         below the requested wait
#   asked (no-room)       as above, for the no-room phase
#   no-wait (no-room)     `ask registered without a wait` for that session, and
#                         no `ask registered` line with a wait for it
#   tool-result (no-room) the `ask` call returned the not-waiting form at once
#   cause (no-room)       the cause that form names is this run's own: the
#                         clamp, and not a switched-off wait
#   model-pin             every captured turn answered on the pin
#
# A phase whose subagent never called `ask` fails its own `asked` criterion and
# records the criteria that hang off that call as NOT ASSERTED: a case this run
# did not produce is never reported as a pass.
#
# THIS DRIVER OWNS ITS SERVER, unlike `message-task.sh` and `ask-task.sh`. Its
# three phases each need `answerWaitMs` and `maxSubagentToolCallMs` at values of
# their own, and the only file those come from is the `agent-intercom.json` the
# server reads. It therefore builds a throwaway HOME of its own
# (`config-isolation.sh`), starts an `opencode serve` on its own port with it,
# and writes the two keys into that isolated file between phases — the plugin
# re-resolves them every 2 000 ms (src/settings.js TTL_MS), so a phase change
# needs no restart, only the wait past that cache. Nothing outside the
# throwaway home is written, and the machine's ~/.config/opencode is read once
# for the provider block and never written.
#
# Usage:
#   bash test/e2e/ask-expiry-task.sh
#
# Env (all with defaults):
#   PROJECT_DIR             $HOME/testopencode  the server's cwd, and the
#                           directory sessions are created against
#   OUT_DIR                 ./out               captures and the report
#   E2E_MODEL               openai/gpt-5.6-luna the pin: every agent runs on it
#   ASK_EXPIRY_PORT         4588                own port, clear of run-all's
#                           4567 and the endless driver's 4599
#   ASK_AGENT               planner             the role that asks
#   ASK_EXPIRY_WAIT_MS      10000               the wait phase 1 pins and waits
#                           out; low on purpose, so the run stays short
#   ASK_EXPIRY_TOOL_CALL_MS 660000              the window phase 1 runs under,
#                           wide enough that the clamp is inert
#   ASK_CLAMP_REQUEST_MS    30000               what phases 2 and 3 request
#   ASK_CLAMP_TOOL_CALL_MS  70000               phase 2's window: room = 10000
#   ASK_NOROOM_TOOL_CALL_MS 60000               phase 3's window: room = 0
#   SETTINGS_TTL_WAIT_S     3                   wait after a settings write,
#                           past the plugin's 2 000 ms settings cache
#   MIDRUN_POLL_S           2                   poll cadence
#   SPAWN_TIMEOUT_S         240                 wait for the spawn
#   REGISTER_TIMEOUT_S      300                 wait for the `ask registered`
#                           line of a phase
#   TURN_TIMEOUT_S          900                 per blocking prompt POST
#   FINISH_TIMEOUT_S        420                 wait for a subagent to end
#   SETTLE_TIMEOUT_S        240                 wait for a primary to settle
#   SERVER_START_TIMEOUT_S  60                  readiness probe budget
#   KEEP_SERVER             0                   1 leaves the server running
#   E2E_TUI_BUILT           0                   1 skips the TUI build
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, setsid, npm, an `opencode` on PATH, a provider
# serving E2E_MODEL configured in the machine's opencode.json, and the plugin's
# debug log switched on (every figure this driver asserts is read out of it).
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

PREFIX=15-ask-expiry
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

# Building the TUI, starting the server, waiting for it and stopping it again.
. "$HERE/server-lifecycle.sh"
# The report lines, the session calls, the captures, the debug-log slice and the
# model audit — shared with message-task.sh and ask-task.sh. It sources
# config-isolation.sh itself.
. "$HERE/lib/midrun-common.sh"

AGENT=${ASK_AGENT:-planner}
PORT=${ASK_EXPIRY_PORT:-4588}
EXPIRY_WAIT_MS=${ASK_EXPIRY_WAIT_MS:-10000}
EXPIRY_TOOL_CALL_MS=${ASK_EXPIRY_TOOL_CALL_MS:-660000}
CLAMP_REQUEST_MS=${ASK_CLAMP_REQUEST_MS:-30000}
CLAMP_TOOL_CALL_MS=${ASK_CLAMP_TOOL_CALL_MS:-70000}
NOROOM_TOOL_CALL_MS=${ASK_NOROOM_TOOL_CALL_MS:-60000}
SETTINGS_TTL_WAIT_S=${SETTINGS_TTL_WAIT_S:-3}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-240}
REGISTER_TIMEOUT_S=${REGISTER_TIMEOUT_S:-300}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-420}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-240}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
KEEP_SERVER=${KEEP_SERVER:-0}

# The two literals the subagent's own tool result is recognised by. They are
# the plugin's rendering of the two outcomes (src/midrun.js), not anything the
# prompt puts within the model's reach, so finding one in the `ask` call's
# output is the plugin speaking and not the model.
UNANSWERED_MARKER="No answer came within"
NOT_WAITING_MARKER="this run does not wait for answers"
# The answered form, looked for so a phase can say it did NOT happen.
ANSWERED_MARKER="The orchestrator answers:"
# The two causes the not-waiting form names, one per way into that branch
# (src/midrun.js). The no-room phase must be told the first and not the second.
NOROOM_CAUSE_MARKER="watchdog window this call sits in leaves no room for it"
OFF_CAUSE_MARKER="the wait is switched off"

SETTINGS_FILE=""
SESSION_IDS=""
SERVER_VERSION="(unknown)"

# What one phase leaves behind for the criteria below it.
P_LABEL=""
P_SID=""
P_SUB_SID=""
P_SUB_HANDLE=""
P_REG_KIND=none      # waited | nowait | none
P_REG_LINE=""
P_REG_WAIT_MS=""
P_POSTED_LINE=""
P_EXPIRED_LINE=""
P_SETTLED_LINE=""
P_ANSWERED_LINE=""
P_NOTICE_LINE=""
P_FLAT=""
P_PRIMARY_FLAT=""
P_ENDED=""

# ---------- a window into the shared debug log ------------------------------

# The slice midrun-common keeps runs from the byte the driver started at and
# therefore holds every phase of this run at once. A `spawned` line of phase 1
# would satisfy a wait of phase 2, so every read that is not already scoped by a
# session id is scoped to the phase's own window: the slice line count taken
# when that phase starts.
AE_FROM_LINE=0

ae_mark_window() {
  mr_refresh_slice
  AE_FROM_LINE=$(wc -l < "$MR_SLICE_FILE" 2>/dev/null || echo 0)
}

# The first line of the current phase's window matching $1, without its line
# number; empty when there is none.
ae_match_after() {
  grep -nE -- "$1" "$MR_SLICE_FILE" 2>/dev/null |
    awk -F: -v from="$AE_FROM_LINE" '$1 > from { sub(/^[0-9]+:/, ""); print; exit }'
}

# Waits for one line inside the current phase's window. 0 with AE_LINE set, or
# 1 with AE_REASON set; never 0 on a timeout.
# Usage: ae_wait_after <label> <pattern> <timeout_s>
AE_LINE=""
AE_REASON=""
ae_wait_after() {
  local label="$1" pattern="$2" timeout="$3"
  local deadline=$(( $(date +%s) + timeout )) hit
  AE_LINE=""; AE_REASON=""
  while :; do
    mr_refresh_slice
    hit=$(ae_match_after "$pattern")
    if [ -n "$hit" ]; then
      AE_LINE="$hit"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      AE_REASON="no line matching /$pattern/ within ${timeout}s while waiting for \"$label\" — last log line: $(tail -n 1 "$MR_SLICE_FILE")"
      return 1
    fi
    sleep "$MR_POLL_S"
  done
}

# ---------- the settings of one phase ---------------------------------------

# Writes the two keys one phase runs under into the isolated agent-intercom.json
# and waits past the plugin's settings cache. Every other key is left as it
# stands.
# Usage: ae_pin_settings <answerWaitMs> <maxSubagentToolCallMs>
ae_pin_settings() {
  python3 - "$SETTINGS_FILE" "$1" "$2" <<'PY' || return 1
import json, os, sys

path, wait_ms, tool_call_ms = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
raw = {}
if os.path.exists(path):
    with open(path) as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        sys.exit(f"{path} is not a JSON object — refusing to overwrite it")
raw.update({
    "midRunMessaging": True,
    "answerWaitMs": wait_ms,
    "maxSubagentToolCallMs": tool_call_ms,
})
with open(path, "w") as fh:
    json.dump(raw, fh, indent=2)
    fh.write("\n")
PY
  sleep "$SETTINGS_TTL_WAIT_S"
}

# ---------- preflight -------------------------------------------------------

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"

for tool in curl python3 setsid npm; do
  command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
done
command -v opencode >/dev/null || mr_die "opencode is not on PATH — this driver starts a server of its own"

# The margin the clamp keeps below the watchdog window, read out of the source
# rather than repeated here: every expected figure below is derived from it, so
# a change to the constant changes this driver's expectations with it instead of
# leaving them silently wrong.
MARGIN_MS=$(sed -nE 's/^export const ASK_WAIT_WATCHDOG_MARGIN_MS = ([0-9]+).*/\1/p' "$PLUGIN_ROOT/src/agentmsg.js" | head -n 1)
[ -n "$MARGIN_MS" ] ||
  mr_die "could not read ASK_WAIT_WATCHDOG_MARGIN_MS out of $PLUGIN_ROOT/src/agentmsg.js — every expected wait of this run is derived from it"

EXPIRY_ROOM_MS=$((EXPIRY_TOOL_CALL_MS - MARGIN_MS))
CLAMP_ROOM_MS=$((CLAMP_TOOL_CALL_MS - MARGIN_MS))
NOROOM_ROOM_MS=$((NOROOM_TOOL_CALL_MS - MARGIN_MS))

# Its own preflight, suited to what it pins. ask-task.sh refuses a run at
# answerWaitMs=0 because its answer would arrive after the call returned; this
# driver refuses every pinning under which one of its three phases would not be
# the branch of `askWaitMs` it claims to assert.
[ "$EXPIRY_WAIT_MS" -gt 0 ] 2>/dev/null ||
  mr_die "ASK_EXPIRY_WAIT_MS=$EXPIRY_WAIT_MS — a wait of 0 registers no waiter at all (askWaitMs, src/agentmsg.js), so no timer could expire and the unanswered path would never be reached"
[ "$EXPIRY_ROOM_MS" -ge "$EXPIRY_WAIT_MS" ] ||
  mr_die "the expiry phase would be clamped: ASK_EXPIRY_TOOL_CALL_MS=$EXPIRY_TOOL_CALL_MS leaves ${EXPIRY_ROOM_MS}ms of room, below the pinned ASK_EXPIRY_WAIT_MS=$EXPIRY_WAIT_MS — raise the window so the registered wait IS the pin"
[ "$CLAMP_ROOM_MS" -gt 0 ] ||
  mr_die "the clamp phase would take no wait at all: ASK_CLAMP_TOOL_CALL_MS=$CLAMP_TOOL_CALL_MS leaves ${CLAMP_ROOM_MS}ms of room — that is the no-room branch, not the clamp"
[ "$CLAMP_ROOM_MS" -lt "$CLAMP_REQUEST_MS" ] ||
  mr_die "the clamp phase would not clamp: ASK_CLAMP_TOOL_CALL_MS=$CLAMP_TOOL_CALL_MS leaves ${CLAMP_ROOM_MS}ms of room, at or above the requested ASK_CLAMP_REQUEST_MS=$CLAMP_REQUEST_MS — the registered wait would be the request and nothing would be observable"
[ "$NOROOM_ROOM_MS" -le 0 ] ||
  mr_die "the no-room phase would still take a wait: ASK_NOROOM_TOOL_CALL_MS=$NOROOM_TOOL_CALL_MS leaves ${NOROOM_ROOM_MS}ms of room — set it at or below the ${MARGIN_MS}ms margin"
[ "$NOROOM_TOOL_CALL_MS" -gt 0 ] ||
  mr_die "ASK_NOROOM_TOOL_CALL_MS=0 switches the working window off entirely (workingWindowMs, src/settings.js) — the requested wait would then stand unclamped, which is not the branch this phase asserts"
[ "$CLAMP_REQUEST_MS" -gt 0 ] ||
  mr_die "ASK_CLAMP_REQUEST_MS=$CLAMP_REQUEST_MS — with no wait requested both clamp phases would take the same 0 for a different reason, and neither branch would be told apart"

EXPECT_EXPIRY_WAIT_MS=$EXPIRY_WAIT_MS
EXPECT_CLAMP_WAIT_MS=$CLAMP_ROOM_MS

# ---------- the isolated configuration and the server -----------------------

PROJECT=${PROJECT_DIR:-$HOME/testopencode}
BASE=$(e2e_server_url "$PORT")
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || mr_die "cannot create $OUT_PRE"
OUT_PRE=$(cd "$OUT_PRE" && pwd)

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  mr_die "something already answers on $BASE — stop it, or set ASK_EXPIRY_PORT to a free port"
fi

# Phase 1's values; the phases below rewrite the two keys in this same file.
e2e_iso_create "$PLUGIN_ROOT" \
  "$(printf '{"maxSubagents":8,"maxContext":130000,"endlessMode":false,"agentMode":"orchestrator","midRunMessaging":true,"answerWaitMs":%s,"maxSubagentToolCallMs":%s}' \
    "$EXPIRY_WAIT_MS" "$EXPIRY_TOOL_CALL_MS")" ||
  mr_die "could not build the isolated opencode configuration"
SETTINGS_FILE="$E2E_ISO_SETTINGS_FILE"

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  local s
  for s in $SESSION_IDS; do
    [ -z "$s" ] && continue
    e2e_server_alive || continue
    mr_say "session delete $s -> HTTP $(curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$s" 2>/dev/null)"
  done
  if [ "$KEEP_SERVER" = 1 ]; then
    mr_say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $BASE"
  else
    e2e_server_stop
  fi
  # After the server, never before: the process reads its configuration while it
  # runs.
  e2e_iso_remove
  [ -n "$MR_REPORT_FILE" ] && mr_say "report:      $MR_REPORT_FILE"
  [ -n "$MR_OUT_DIR" ] && mr_say "captures:    $MR_OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ -n "$MR_SLICE_FILE" ] && mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# From here on a setup error removes the isolated home again: the trap above is
# installed, and both wiring checks resolve against the configuration just built.
e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "$PLUGIN_ROOT is wired nowhere the server would read it — name it in the plugin array of ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json, or of $PROJECT/opencode.json, or drop a loader into $PROJECT/.opencode/plugin/"
e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "the TUI half of $PLUGIN_ROOT is wired nowhere the TUI would read it — see the tui.json paths listed above"

e2e_build_tui "$PLUGIN_ROOT" || mr_die "the TUI build failed — see the npm output above"

# Before the server starts, so the slice carries this run's plugin load too.
mr_debug_start

e2e_server_start "$PORT" "$PROJECT" "$OUT_PRE/$PREFIX.server.log" "$OUT_PRE/$PREFIX.serverpid" ||
  mr_die "could not start opencode on $BASE — see $OUT_PRE/$PREFIX.server.log"
e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_PRE/$PREFIX.health.json" ||
  mr_die "opencode on $BASE did not become ready — see $OUT_PRE/$PREFIX.server.log"
SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$OUT_PRE/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")

# The shared ground, against the server this driver just started: OPENCODE_URL
# is exported before mr_init, which probes it. The offset mr_debug_start took
# above survives — mr_init does not touch it.
OPENCODE_URL="$BASE"
export OPENCODE_URL
LOG_OFFSET_KEPT=$MR_LOG_OFFSET
mr_init "$PREFIX"
MR_LOG_OFFSET=$LOG_OFFSET_KEPT
mr_check_settings

# ---------- the setup, printed so a run can be reproduced -------------------

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
project dir         $MR_PROJECT_DIR
server              opencode serve --port $PORT --hostname 127.0.0.1   (owned by this driver, cwd = project dir)
server pid / pgid   $E2E_SERVER_PID / $E2E_SERVER_PGID
opencode version    $SERVER_VERSION
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
asking role         $AGENT
isolated config     $E2E_ISO_OPENCODE_DIR   (the machine's ~/.config/opencode is not written)
settings file       $SETTINGS_FILE   (the two keys are rewritten per phase, settings-cache wait ${SETTINGS_TTL_WAIT_S}s)
clamp margin        ASK_WAIT_WATCHDOG_MARGIN_MS=$MARGIN_MS   (read from src/agentmsg.js)
phase expiry        answerWaitMs=$EXPIRY_WAIT_MS maxSubagentToolCallMs=$EXPIRY_TOOL_CALL_MS -> room ${EXPIRY_ROOM_MS}ms, expected waitMs=$EXPECT_EXPIRY_WAIT_MS, left to expire
phase clamp         answerWaitMs=$CLAMP_REQUEST_MS maxSubagentToolCallMs=$CLAMP_TOOL_CALL_MS -> room ${CLAMP_ROOM_MS}ms, expected waitMs=$EXPECT_CLAMP_WAIT_MS
phase no-room       answerWaitMs=$CLAMP_REQUEST_MS maxSubagentToolCallMs=$NOROOM_TOOL_CALL_MS -> room ${NOROOM_ROOM_MS}ms, expected no waiter at all
resolved settings   midRunMessaging=$MR_MID_RUN answerWaitMs=$MR_ANSWER_WAIT_MS maxMessageTokens=$MR_MAX_MESSAGE_TOKENS maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
timeouts            spawn=${SPAWN_TIMEOUT_S}s register=${REGISTER_TIMEOUT_S}s turn=${TURN_TIMEOUT_S}s finish=${FINISH_TIMEOUT_S}s settle=${SETTLE_TIMEOUT_S}s poll=${MR_POLL_S}s
debug log           $MR_DEBUG_LOG   (read from byte $MR_LOG_OFFSET)
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- one phase --------------------------------------------------------

# The subagent's task. One `ask`, nothing else, and a final reply that says what
# the call returned. The literal it is asked to compose is deliberately NOT the
# literal the criteria look for: the tool result is read off the `ask` call's
# own output in the captured session, which the model cannot write.
ae_sub_task() {
  printf '%s' "This is a deliberate test of the plugin's ask channel, not a planning job. Do exactly these three steps and nothing else. Step 1: call ask('Which variant is this run to use? Answer with the single variant word.') exactly once and wait for its result. Step 2: make no other tool call at all — do not read, write or edit any file, do not search, do not spawn, do not ask a second time whatever the first call returns. Step 3: reply with exactly one line and nothing else: the word ASK-ENDED, then a hyphen, then in three or four words what the ask call's result told you happened."
}

# The orchestrator's turn. It spawns and then leaves the question alone — the
# unanswered path is the thing under test, so an answer would destroy the case
# rather than fail it.
ae_turn_prompt() {
  printf '%s' "Call spawn(\"$AGENT\", \"$(ae_sub_task)\") exactly once, passing that prompt through unchanged, then end your turn. That subagent will put ONE question to you. Do NOT answer it: this run deliberately tests what happens to a question nobody answers. Do not call message() for it or for anything else, do not abort it, do not spawn anything, do not call list(), and do not put any variant word anywhere. When the question reaches you, say in one line that you are leaving it unanswered, and end your turn."
}

# Drives one phase to its end and leaves its evidence in the P_* variables.
# Usage: ae_drive_phase <label> <answerWaitMs> <maxSubagentToolCallMs> <marker>
#
# <marker> is the literal the phase's tool-result criterion looks for inside the
# `ask` call's own output; it is handed to lib/midrun-ask.py as its answer
# marker, so `answer_marker=1` means the plugin rendered that outcome and
# `answer_prefix=1` means it rendered the answered one instead.
ae_drive_phase() {
  local label="$1" wait_ms="$2" tool_call_ms="$3" marker="$4"
  local turn_pid deadline code count prev stable_since now analysis

  P_LABEL="$label"
  P_SID=""; P_SUB_SID=""; P_SUB_HANDLE=""
  P_REG_KIND=none; P_REG_LINE=""; P_REG_WAIT_MS=""
  P_POSTED_LINE=""; P_EXPIRED_LINE=""; P_SETTLED_LINE=""; P_ANSWERED_LINE=""; P_NOTICE_LINE=""
  P_FLAT=""; P_PRIMARY_FLAT=""; P_ENDED=""
  # The evidence reader's figures, reset here rather than only where they are
  # loaded: a phase that never gets as far as a capture must not be judged on
  # the phase before it, and must not read an unset variable either.
  A_parsed=0; A_ask_calls=0; A_ask_status=""; A_ask_ms=0; A_ask_question=0
  A_answer_prefix=0; A_answer_marker=0; A_tool_names=""

  mr_say "--- phase $label: answerWaitMs=$wait_ms maxSubagentToolCallMs=$tool_call_ms ---"
  ae_pin_settings "$wait_ms" "$tool_call_ms" ||
    mr_die "phase $label: could not write answerWaitMs=$wait_ms / maxSubagentToolCallMs=$tool_call_ms into $SETTINGS_FILE"

  # Everything this phase reads out of the log lies past this line.
  ae_mark_window

  P_SID=$(mr_new_session "$MR_PREFIX-$label")
  [ -n "$P_SID" ] || mr_die "phase $label: the server did not return a session id"
  SESSION_IDS="$SESSION_IDS $P_SID"
  echo "$P_SID" > "$MR_OUT_DIR/$MR_PREFIX.$label.sid"
  mr_say "[$MR_PREFIX/$label] primary=$P_SID start $(date +%H:%M:%S)"

  mr_post_prompt "$P_SID" "$(ae_turn_prompt)" "$MR_OUT_DIR/$MR_PREFIX.$label.turn.json" "$TURN_TIMEOUT_S" &
  turn_pid=$!

  if ae_wait_after "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
    P_SUB_SID=$(mr_log_field "$AE_LINE" sessionID)
    P_SUB_HANDLE=$(mr_log_field "$AE_LINE" handle)
    mr_say "[$MR_PREFIX/$label] subagent=$P_SUB_HANDLE session=$P_SUB_SID $(date +%H:%M:%S)"
  else
    mr_say "[$MR_PREFIX/$label] no subagent was spawned: $AE_REASON"
    wait "$turn_pid" 2>/dev/null
    P_PRIMARY_FLAT=$(mr_capture "$P_SID" "$label-primary")
    return 0
  fi

  # The registration line, which carries the figure both clamp criteria are
  # decided on. Scoped by the subagent's own session id, so no other phase and
  # no other opencode instance on this machine can satisfy it.
  if ae_wait_after "the question was registered" \
      "ask registered( without a wait)? .*\"sessionID\":\"$P_SUB_SID\"" "$REGISTER_TIMEOUT_S"; then
    P_REG_LINE="$AE_LINE"
    case "$P_REG_LINE" in
      *"ask registered without a wait"*) P_REG_KIND=nowait ;;
      *) P_REG_KIND=waited; P_REG_WAIT_MS=$(mr_log_field "$P_REG_LINE" waitMs) ;;
    esac
    mr_say "[$MR_PREFIX/$label] registered: kind=$P_REG_KIND waitMs=${P_REG_WAIT_MS:-none} $(date +%H:%M:%S)"
  else
    mr_say "[$MR_PREFIX/$label] no registration line: $AE_REASON"
  fi

  # Watch the subagent until its session is gone or the plugin reports its
  # completion — the only window in which its `ask` call and that call's own
  # output can still be read off the live session.
  deadline=$(( $(date +%s) + FINISH_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    mr_capture "$P_SUB_SID" "$label-subagent" > /dev/null
    mr_refresh_slice
    [ -n "$P_POSTED_LINE" ] || P_POSTED_LINE=$(grep -E -m1 -- "ask posted .*\"sessionID\":\"$P_SUB_SID\"" "$MR_SLICE_FILE")
    [ -n "$P_EXPIRED_LINE" ] || P_EXPIRED_LINE=$(grep -E -m1 -- "ask expired unanswered .*\"sessionID\":\"$P_SUB_SID\"" "$MR_SLICE_FILE")
    [ -n "$P_SETTLED_LINE" ] || P_SETTLED_LINE=$(grep -E -m1 -- "ask settled .*\"sessionID\":\"$P_SUB_SID\"" "$MR_SLICE_FILE")
    code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$MR_BASE/session/$P_SUB_SID" 2>/dev/null)
    if [ "$code" != 200 ]; then
      P_ENDED="its session is gone (HTTP $code)"
      break
    fi
    if grep -qE -- "notified primary of completion .*\"parentID\":\"$P_SID\"" "$MR_SLICE_FILE"; then
      sleep "$MR_POLL_S"
      mr_capture "$P_SUB_SID" "$label-subagent" > /dev/null
      P_ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
      break
    fi
    sleep "$MR_POLL_S"
  done
  if [ -n "$P_ENDED" ]; then
    mr_say "[$MR_PREFIX/$label] subagent ended: $P_ENDED $(date +%H:%M:%S)"
  else
    mr_say "[$MR_PREFIX/$label] subagent neither ended nor was notified within ${FINISH_TIMEOUT_S}s — its captures may be short of its last step"
  fi

  wait "$turn_pid" 2>/dev/null

  # Let the primary settle, so its transcript carries the notice and whatever it
  # did with it.
  prev=-1; stable_since=$(date +%s)
  deadline=$(( $(date +%s) + SETTLE_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count=$(curl -s -m 30 "$MR_BASE/session/$P_SID/message" |
      python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
    now=$(date +%s)
    if [ "$count" = "$prev" ]; then
      [ "$((now - stable_since))" -ge 20 ] && { mr_say "[$MR_PREFIX/$label] primary settled at $count messages $(date +%H:%M:%S)"; break; }
    else
      stable_since=$now; prev=$count
    fi
    sleep "$MR_POLL_S"
  done
  P_PRIMARY_FLAT=$(mr_capture "$P_SID" "$label-primary")
  P_FLAT="$MR_OUT_DIR/$MR_PREFIX.$label-subagent.transcript.txt"
  P_NOTICE_LINE=$(mr_first_in "$P_PRIMARY_FLAT" "asks you:")
  P_ANSWERED_LINE=$(mr_first_in "$P_PRIMARY_FLAT" "Answer delivered to \"$P_SUB_HANDLE\"")

  # The `ask` call itself, out of the subagent's captured session.
  analysis="$MR_OUT_DIR/$MR_PREFIX.$label.analysis.txt"
  if [ -f "$MR_OUT_DIR/$MR_PREFIX.$label-subagent.messages.json" ]; then
    python3 "$HERE/lib/midrun-ask.py" "$MR_OUT_DIR/$MR_PREFIX.$label-subagent.messages.json" "$marker" > "$analysis" 2>/dev/null
  else
    : > "$analysis"
  fi
  mr_load_kv "$analysis" A_
  mr_say ""
}

# The `asked` criterion, identical in all three phases.
# Usage: ae_record_asked <label>
ae_record_asked() {
  local label="$1"
  if [ "$A_ask_calls" -ge 1 ] || [ -n "$P_POSTED_LINE" ]; then
    mr_record "asked ($label) — the subagent put a question to its caller" 1 \
      "ask_calls=$A_ask_calls status=$A_ask_status question_carried=$A_ask_question; plugin log: ${P_POSTED_LINE:-no ask posted line}"
    return 0
  fi
  mr_record "asked ($label) — the subagent put a question to its caller" 0 \
    "no ask call in the captured session (tool calls: ${A_tool_names:-none}) and no \"ask posted\" line for ${P_SUB_SID:-(no subagent at all)} — the model finished without using the channel"
  return 1
}

# Whether one more literal stands in the `ask` call's own output of the phase
# just driven. lib/midrun-ask.py decides ONE marker per run, so a second literal
# is read by running it again over the same capture; the answer is its own
# `answer_marker` line, which is the plugin's text and not the model's.
# Usage: ae_output_carries <literal>   (0 = the output carries it)
ae_output_carries() {
  local literal="$1" capture="$MR_OUT_DIR/$MR_PREFIX.$P_LABEL-subagent.messages.json" figures
  [ -f "$capture" ] || return 1
  # Held in a variable rather than piped: `set -o pipefail` is on, and a reader
  # cut short by a `grep -q` would come back as a failure of its own.
  figures=$(python3 "$HERE/lib/midrun-ask.py" "$capture" "$literal" 2>/dev/null) || return 1
  grep -qx "answer_marker=1" <<< "$figures"
}

# ---------- phase 1: the wait runs out --------------------------------------

ae_drive_phase expiry "$EXPIRY_WAIT_MS" "$EXPIRY_TOOL_CALL_MS" "$UNANSWERED_MARKER"

if ae_record_asked expiry; then
  if [ "$P_REG_KIND" = waited ] && [ "$P_REG_WAIT_MS" = "$EXPECT_EXPIRY_WAIT_MS" ]; then
    mr_record "wait armed (expiry) — the registered wait is the pinned answerWaitMs" 1 \
      "$P_REG_LINE"
  else
    mr_record "wait armed (expiry) — the registered wait is the pinned answerWaitMs" 0 \
      "expected waitMs=$EXPECT_EXPIRY_WAIT_MS under a ${EXPIRY_TOOL_CALL_MS}ms window; got kind=$P_REG_KIND waitMs=${P_REG_WAIT_MS:-none} — ${P_REG_LINE:-no registration line for $P_SUB_SID}"
  fi

  if [ -z "$P_ANSWERED_LINE" ]; then
    mr_record "unanswered (expiry) — the caller answered nothing" 1 \
      "no \"Answer delivered\" line in the primary's transcript; the notice it got: ${P_NOTICE_LINE:-no \"asks you:\" line}"
    if [ -n "$P_EXPIRED_LINE" ]; then
      mr_record "expired (expiry) — the wait ran out and the plugin logged the expiry" 1 \
        "$P_EXPIRED_LINE"
    else
      mr_record "expired (expiry) — the wait ran out and the plugin logged the expiry" 0 \
        "no \"ask expired unanswered\" line for $P_SUB_SID within the watched window; how the question ended instead: ${P_SETTLED_LINE:-no \"ask settled\" line either}"
    fi
    if [ "$A_answer_marker" = 1 ] && [ "$A_answer_prefix" = 0 ]; then
      mr_record "tool-result (expiry) — the ask call returned the unanswered form" 1 \
        "the ask call's own output carries \"$UNANSWERED_MARKER\" and not \"$ANSWERED_MARKER\" (ask ran ${A_ask_ms}ms, status=$A_ask_status)"
    else
      mr_record "tool-result (expiry) — the ask call returned the unanswered form" 0 \
        "unanswered_marker=$A_answer_marker answered_form=$A_answer_prefix in the ask call's output (ask ran ${A_ask_ms}ms, status=$A_ask_status) — see $P_FLAT"
    fi
  else
    mr_note_uncovered "expired (expiry) — the wait ran out and the plugin logged the expiry" \
      "the orchestrator answered the question although the turn forbade it, so this run never reached the unanswered path: $P_ANSWERED_LINE"
    mr_note_uncovered "tool-result (expiry) — the ask call returned the unanswered form" \
      "same cause: the answered form is what the call returned (answered_form=$A_answer_prefix)"
  fi
else
  mr_note_uncovered "wait armed (expiry) — the registered wait is the pinned answerWaitMs" \
    "no question was asked in this phase, so nothing was registered"
  mr_note_uncovered "unanswered (expiry) / expired (expiry) / tool-result (expiry)" \
    "no question was asked in this phase, so no wait could run out"
fi
mr_note "how the expiry phase's question ended, in the plugin's own words" \
  "${P_SETTLED_LINE:-no \"ask settled\" line for ${P_SUB_SID:-(no subagent)}}"
mr_note "what the expiry phase's subagent finally replied" \
  "$(mr_first_in "$P_FLAT" "ASK-ENDED" || true)"

# ---------- phase 2: the clamp cuts the wait down ---------------------------

ae_drive_phase clamp "$CLAMP_REQUEST_MS" "$CLAMP_TOOL_CALL_MS" "$UNANSWERED_MARKER"

if ae_record_asked clamp; then
  if [ "$P_REG_KIND" = waited ] && [ "$P_REG_WAIT_MS" = "$EXPECT_CLAMP_WAIT_MS" ]; then
    mr_record "clamp (clamp) — the wait is cut to the room left inside the watchdog window" 1 \
      "requested answerWaitMs=$CLAMP_REQUEST_MS, window maxSubagentToolCallMs=$CLAMP_TOOL_CALL_MS less the ${MARGIN_MS}ms margin = ${CLAMP_ROOM_MS}ms, registered: $P_REG_LINE"
  else
    mr_record "clamp (clamp) — the wait is cut to the room left inside the watchdog window" 0 \
      "expected waitMs=$EXPECT_CLAMP_WAIT_MS (window $CLAMP_TOOL_CALL_MS less the ${MARGIN_MS}ms margin) against a requested $CLAMP_REQUEST_MS; got kind=$P_REG_KIND waitMs=${P_REG_WAIT_MS:-none} — ${P_REG_LINE:-no registration line for $P_SUB_SID}"
  fi
else
  mr_note_uncovered "clamp (clamp) — the wait is cut to the room left inside the watchdog window" \
    "no question was asked in this phase, so no wait was registered to read the clamp off"
fi
mr_note "how the clamp phase's question ended" \
  "${P_EXPIRED_LINE:-${P_SETTLED_LINE:-no ending line for ${P_SUB_SID:-(no subagent)}}}"

# ---------- phase 3: the window leaves no room at all -----------------------

ae_drive_phase no-room "$CLAMP_REQUEST_MS" "$NOROOM_TOOL_CALL_MS" "$NOT_WAITING_MARKER"

if ae_record_asked no-room; then
  if [ "$P_REG_KIND" = nowait ]; then
    mr_record "no-wait (no-room) — a window at the margin registers no waiter at all" 1 \
      "$P_REG_LINE"
  else
    mr_record "no-wait (no-room) — a window at the margin registers no waiter at all" 0 \
      "expected \"ask registered without a wait\" for $P_SUB_SID under a ${NOROOM_TOOL_CALL_MS}ms window (room ${NOROOM_ROOM_MS}ms); got kind=$P_REG_KIND waitMs=${P_REG_WAIT_MS:-none} — ${P_REG_LINE:-no registration line at all}"
  fi
  if [ "$A_answer_marker" = 1 ] && [ "$A_answer_prefix" = 0 ]; then
    mr_record "tool-result (no-room) — the ask call returned the not-waiting form at once" 1 \
      "the ask call's own output carries \"$NOT_WAITING_MARKER\" (ask ran ${A_ask_ms}ms, status=$A_ask_status)"
  else
    mr_record "tool-result (no-room) — the ask call returned the not-waiting form at once" 0 \
      "not_waiting_marker=$A_answer_marker answered_form=$A_answer_prefix in the ask call's output (ask ran ${A_ask_ms}ms, status=$A_ask_status) — see $P_FLAT"
  fi

  # The CAUSE named inside that form. The not-waiting branch has two ways in
  # (askWaitMs, src/agentmsg.js), and this phase takes the clamp: a positive
  # answerWaitMs under a window that leaves no room. The text the subagent is
  # shown must name that one and must not claim the wait is switched off.
  if [ "$P_REG_KIND" = nowait ] && [ "$A_answer_marker" = 1 ]; then
    ae_output_carries "$NOROOM_CAUSE_MARKER" && A_cause_noroom=1 || A_cause_noroom=0
    ae_output_carries "$OFF_CAUSE_MARKER" && A_cause_off=1 || A_cause_off=0
    if [ "$A_cause_noroom" = 1 ] && [ "$A_cause_off" = 0 ]; then
      mr_record "cause (no-room) — the not-waiting text names the branch this run pinned" 1 \
        "the ask call's own output carries \"$NOROOM_CAUSE_MARKER\" and not \"$OFF_CAUSE_MARKER\", under answerWaitMs=$CLAMP_REQUEST_MS and a ${NOROOM_TOOL_CALL_MS}ms window"
    else
      mr_record "cause (no-room) — the not-waiting text names the branch this run pinned" 0 \
        "expected the clamp cause and not the switched-off one in the ask call's output; carries_no_room=$A_cause_noroom carries_off=$A_cause_off, under answerWaitMs=$CLAMP_REQUEST_MS and a ${NOROOM_TOOL_CALL_MS}ms window — see $P_FLAT"
    fi
  else
    mr_note_uncovered "cause (no-room) — the not-waiting text names the branch this run pinned" \
      "this run produced no not-waiting tool result to read a cause off (registration kind=$P_REG_KIND, not_waiting_marker=$A_answer_marker)"
  fi
else
  mr_note_uncovered "no-wait (no-room) / tool-result (no-room) / cause (no-room)" \
    "no question was asked in this phase, so neither the registration nor the tool result exists"
fi

# ---------- what this driver deliberately leaves to others ------------------

mr_note_uncovered "the answered path" \
  "a question answered inside the window, and the answer as the ask call's own result, are ask-task.sh's criteria — this driver never answers"
mr_note_uncovered "askWaitMs branch 1 — a requested wait of 0" \
  "answerWaitMs=0 reaches the same no-wait branch as this run's no-room phase by another route; it is pinned by the unit suite (test/agentmsg.test.js) and refused as a live pinning by this driver's preflight, because the two branches would then be indistinguishable in the log"
mr_note_uncovered "the reap of a subagent whose ask outlives the watchdog window" \
  "the clamp exists to make that unreachable; a run that could produce it would have to defeat the clamp this driver asserts"

# What answered: every session this run captured, both primaries and subagents.
mr_model_audit

mr_verdict
