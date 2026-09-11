#!/bin/bash
# Mid-run MESSAGE end-to-end driver.
#
# Drives one steering message into a RUNNING subagent against a real
# `opencode serve` and asserts what `specs/mid-run-messaging.md` and
# `concepts/mid-run-agent-messaging.md` §12 claim about it. The unit suite
# proves the mechanism against a mock client; this driver is the only place
# where a real opencode, a real model and the real session lifecycle decide the
# two things no mock can settle:
#
#   the DELIVERY MOMENT   a message queued into a busy session is read at the
#                         subagent's next STEP — as soon as the tool call it is
#                         inside returns — and not at a next turn, which never
#                         comes: `noReply: true` starts none.
#   the MODEL ACTS ON IT  a subagent told it can be messaged folds the message
#                         into the task it is already on, in its own words.
#
# The scenario, in one subagent run:
#
#   1. the orchestrator spawns a `debugger` on three deliberately slow shell
#      commands (`sleep 30; echo STEP-n-DONE`), so there is a wide, certain
#      window in which the subagent is INSIDE a tool call;
#   2. the driver waits until that session really shows a running tool call,
#      then prompts the orchestrator to `message(...)` it: stop after the
#      command running right now, make no further tool call, and reply with one
#      composed line: STEERED- plus the output of that very command;
#   3. what the subagent did with it is read off its own session — the framed
#      message's position between two steps, the tool call it landed inside,
#      every tool call that started afterwards — and off the wake notice the
#      orchestrator got.
#
# Asserted criteria:
#
#   queued       the `message` tool reported the text queued for that handle
#   in-tool      and named the tool the subagent was inside at that moment
#   framed       the framed block is a persisted user message in the subagent's
#                own session
#   mid-flight   it landed strictly inside a tool call's span — proof the
#                subagent could not have been between steps when it arrived
#   between-steps it sits between two steps of the same run: steps before it,
#                steps after it
#   one-turn     the session was never re-prompted — two user messages, the
#                briefing and the framed block — so the step that read it
#                belongs to the run that was already going
#   next-step    the first step after it began only after the in-flight call
#                returned
#   stopped      no tool call started after it landed, though the baseline task
#                still had commands to run: the subagent obeyed at the next step
#   acted        its final reply carries STEERED-STEP-<n>-DONE, a line only a
#                subagent that read the message can compose
#   exchange     the completion notice bills the traffic: `1 message down`
#   seen         and does not say the message was never read
#
# Opt-in, like every driver here: it talks to a real opencode, spends real model
# tokens, and is never run by `npm test`.
#
# It uses a server it does NOT own — run-all.sh's, or one started by hand —
# exactly like run-task.sh and multi-task.sh, and it changes nothing outside its
# own out-dir: no setting is written, and the subagent's role (`debugger`)
# cannot write or edit a file.
#
# Usage:
#   bash test/e2e/message-task.sh                    # against OPENCODE_URL
#   OUT_DIR=/somewhere/kept bash test/e2e/message-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL     http://localhost:4567  the running server
#   PROJECT_DIR      $HOME/testopencode     sessions are created against it
#   OUT_DIR          ./out                  captures and the report
#   E2E_MODEL        xai/grok-4.6           provider/model for every primary prompt
#   MIDRUN_AGENT     debugger               the role that gets messaged; it needs
#                    the `bash` tool for the slow steps
#   MIDRUN_MARKER    MIDRUN-MESSAGE-OK      the literal the UN-steered baseline
#                    reply would carry, so a run in which the message changed
#                    nothing is recognisable; the steered reply's own line is
#                    composed by the subagent (STEERED-STEP-<n>-DONE)
#   MIDRUN_SLEEP_S   30                     seconds per baseline step
#   MIDRUN_POLL_S    2                      poll cadence
#   SPAWN_TIMEOUT_S  180                    wait for the spawn
#   INTOOL_TIMEOUT_S 300                    wait for a running tool call
#   TURN_TIMEOUT_S   900                    per blocking prompt POST
#   FINISH_TIMEOUT_S 600                    wait for the subagent to end
#   SETTLE_TIMEOUT_S 420                    wait for the primary to settle
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, a server on OPENCODE_URL with this plugin
# loaded, and the plugin's debug log switched on (it carries the spawned
# subagent's session id).
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/lib/midrun-common.sh"

AGENT=${MIDRUN_AGENT:-debugger}
MARKER=${MIDRUN_MARKER:-MIDRUN-MESSAGE-OK}
SLEEP_S=${MIDRUN_SLEEP_S:-30}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
INTOOL_TIMEOUT_S=${INTOOL_TIMEOUT_S:-300}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-600}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}

FRAMED_OPENING="📨 agent-intercom: message from the orchestrator"
SID=""
SUB_SID=""
SUB_HANDLE=""

mr_init 13-message
mr_check_settings

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  [ -n "$SID" ] && mr_say "primary session delete $SID -> HTTP $(mr_delete_session "$SID")"
  mr_refresh_slice
  mr_say "report:      $MR_REPORT_FILE"
  mr_say "captures:    $MR_OUT_DIR/$MR_PREFIX.*.messages.json / .transcript.txt"
  mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- the setup, printed so a run can be reproduced -------------------

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
server              $MR_BASE   (not owned by this driver)
project dir         $MR_PROJECT_DIR
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
messaged role       $AGENT   (three baseline steps of "sleep $SLEEP_S; echo STEP-n-DONE")
marker              $MARKER
resolved settings   midRunMessaging=$MR_MID_RUN answerWaitMs=$MR_ANSWER_WAIT_MS maxMessageTokens=$MR_MAX_MESSAGE_TOKENS maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- turn 1: spawn the subagent on a deliberately slow task ----------

mr_debug_start

SUB_TASK="This is a deliberate test of the plugin's message channel, not a diagnosis. Do exactly these four steps in order, one tool call at a time, and nothing else. Step 1: run the shell command: sleep $SLEEP_S; echo STEP-1-DONE . Step 2: run the shell command: sleep $SLEEP_S; echo STEP-2-DONE . Step 3: run the shell command: sleep $SLEEP_S; echo STEP-3-DONE . Step 4: reply with exactly this one line and nothing else: BASELINE-$MARKER . Do not shorten or drop the sleeps, do not read or write any file, and run no other command."
TURN1="Call spawn(\"$AGENT\", \"$SUB_TASK\") exactly once, passing that prompt through unchanged. That is your entire task for this turn. Do not call list(), do not poll, do not spawn anything else. End your turn as soon as spawn returns."

SID=$(mr_new_session "$MR_PREFIX")
[ -n "$SID" ] || mr_die "the server did not return a session id"
echo "$SID" > "$MR_OUT_DIR/$MR_PREFIX.sid"
mr_say "[$MR_PREFIX] primary=$SID start $(date +%H:%M:%S)"

mr_post_prompt "$SID" "$TURN1" "$MR_OUT_DIR/$MR_PREFIX.turn1.json" "$TURN_TIMEOUT_S" &
TURN1_PID=$!

if mr_wait_for_pattern "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
  SUB_SID=$(mr_log_field "$MR_WAIT_LINE" sessionID)
  SUB_HANDLE=$(mr_log_field "$MR_WAIT_LINE" handle)
  mr_say "[$MR_PREFIX] subagent=$SUB_HANDLE session=$SUB_SID $(date +%H:%M:%S)"
else
  wait "$TURN1_PID" 2>/dev/null
  mr_capture "$SID" primary > /dev/null
  mr_record "queued — the orchestrator queued a mid-run message for its subagent" 0 \
    "no subagent was spawned at all: $MR_WAIT_REASON"
  mr_verdict
  exit 1
fi

# ---------- wait until the subagent is INSIDE a tool call -------------------

# The window the whole run hangs on. Read off the subagent's own session rather
# than assumed from the clock: a `running` tool part is opencode's own record
# that the call is open, and a completed one before it proves the run is under
# way rather than at its first step.
running_state() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '|0'
import json, sys
try:
    msgs = json.load(open(sys.argv[1]))
except Exception:
    msgs = []
running, done = "", 0
for m in msgs if isinstance(msgs, list) else []:
    if not isinstance(m, dict):
        continue
    for p in m.get("parts") or []:
        if not isinstance(p, dict) or p.get("type") != "tool":
            continue
        state = p.get("state") if isinstance(p.get("state"), dict) else {}
        if state.get("status") == "running":
            running = str(p.get("tool") or "?")
        elif state.get("status") == "completed":
            done += 1
print(f"{running}|{done}")
PY
}

SUB_RAW="$MR_OUT_DIR/$MR_PREFIX.subagent.messages.json"
RUNNING_TOOL=""
DEADLINE=$(( $(date +%s) + INTOOL_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  mr_capture "$SUB_SID" subagent > /dev/null
  STATE=$(running_state "$SUB_RAW")
  RUNNING_TOOL=${STATE%%|*}
  TOOLS_DONE=${STATE#*|}
  [ -n "$RUNNING_TOOL" ] && break
  sleep "$MR_POLL_S"
done

if [ -z "$RUNNING_TOOL" ]; then
  mr_note "in-tool window" "the subagent never showed a running tool call within ${INTOOL_TIMEOUT_S}s — the message below goes down anyway, and the mid-flight criterion will say what it landed in"
else
  mr_say "[$MR_PREFIX] subagent is inside \`$RUNNING_TOOL\` ($TOOLS_DONE call(s) completed) $(date +%H:%M:%S)"
fi

# ---------- turn 2: the orchestrator sends the steering message -------------

# The steered reply has to be a literal the steering text itself does NOT
# contain: the framed block lands in the subagent's session and the `message`
# call's input stands in the orchestrator's, so a marker spelled out here would
# be found in both transcripts whatever the subagent did. So the subagent is
# told to COMPOSE it — the word STEERED, a hyphen, and the output line of the
# command it was inside — which yields STEERED-STEP-<n>-DONE and nothing else
# in either transcript produces that string.
STEER="Change of plan, and it replaces the rest of your task: stop as soon as the command you are running right now returns. Do not run any further command and make no further tool call. Then reply with exactly one line and nothing else: the word STEERED, then a hyphen, then the output line that command printed."
STEERED_PATTERN="STEERED-STEP-[123]-DONE"
TURN2="Your subagent \"$SUB_HANDLE\" is still running. Call message(\"$SUB_HANDLE\", \"$STEER\") exactly once, passing that text through unchanged, and end your turn immediately afterwards. Do not spawn anything, do not call list(), do not abort anything, do not repeat the message."

mr_post_prompt "$SID" "$TURN2" "$MR_OUT_DIR/$MR_PREFIX.turn2.json" "$TURN_TIMEOUT_S" &
TURN2_PID=$!
mr_say "[$MR_PREFIX] message turn posted $(date +%H:%M:%S)"

# ---------- watch the subagent until its session is gone --------------------

# A finished subagent's session is DELETED by the plugin, so the capture loop is
# the only chance to record what it did. It ends when the session stops
# answering with a message list.
# It ends on either of the two ways a run ends: the session stops answering —
# the ordinary teardown deletes it — or the plugin reports the completion to
# this primary, which is what happens while retention is on and the session is
# HELD instead of deleted. One further capture after that line, so the snapshot
# carries the final reply the notice was built from.
ENDED=""
DEADLINE=$(( $(date +%s) + FINISH_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep "$MR_POLL_S"
  mr_capture "$SUB_SID" subagent > /dev/null
  CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$MR_BASE/session/$SUB_SID" 2>/dev/null)
  if [ "$CODE" != 200 ]; then
    ENDED="its session is gone (HTTP $CODE)"
    break
  fi
  mr_refresh_slice
  if grep -qE -- "notified primary of completion .*\"parentID\":\"$SID\"" "$MR_SLICE_FILE"; then
    sleep "$MR_POLL_S"
    mr_capture "$SUB_SID" subagent > /dev/null
    ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
    break
  fi
done
if [ -n "$ENDED" ]; then
  mr_say "[$MR_PREFIX] subagent ended: $ENDED $(date +%H:%M:%S)"
else
  mr_say "[$MR_PREFIX] subagent neither ended nor was notified within ${FINISH_TIMEOUT_S}s — captures may be short of its last step"
fi

wait "$TURN2_PID" 2>/dev/null
wait "$TURN1_PID" 2>/dev/null

# ---------- let the primary settle, then capture it -------------------------

PREV=-1; STABLE_SINCE=$(date +%s)
DEADLINE=$(( $(date +%s) + SETTLE_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  COUNT=$(curl -s -m 30 "$MR_BASE/session/$SID/message" |
    python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
  NOW=$(date +%s)
  if [ "$COUNT" = "$PREV" ]; then
    [ "$((NOW - STABLE_SINCE))" -ge 25 ] && { mr_say "[$MR_PREFIX] primary settled at $COUNT messages $(date +%H:%M:%S)"; break; }
  else
    STABLE_SINCE=$NOW; PREV=$COUNT
  fi
  sleep "$MR_POLL_S"
done
PRIMARY_FLAT=$(mr_capture "$SID" primary)
SUB_FLAT="$MR_OUT_DIR/$MR_PREFIX.subagent.transcript.txt"

# ---------- the evidence ----------------------------------------------------

mr_say ""
ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
if [ -f "$SUB_RAW" ]; then
  python3 "$HERE/lib/midrun-message.py" "$SUB_RAW" "$FRAMED_OPENING" > "$ANALYSIS" 2>/dev/null
else
  : > "$ANALYSIS"
fi
mr_load_kv "$ANALYSIS" A_
: "${A_parsed:=0}" "${A_framed_found:=0}" "${A_framed_time:=0}" "${A_user_messages:=0}"
: "${A_assistants_before:=0}" "${A_assistants_after:=0}" "${A_inflight_tool:=}"
: "${A_inflight_start:=0}" "${A_inflight_end:=0}" "${A_step_after_inflight_ms:=-1}"
: "${A_tools_before:=0}" "${A_tools_after:=0}" "${A_tools_total:=0}" "${A_tool_names:=}"

QUEUED_LINE=$(mr_first_in "$PRIMARY_FLAT" "Queued for \"$SUB_HANDLE\"")
mr_record "queued — the \`message\` tool reported the text queued for \"$SUB_HANDLE\"" \
  "$([ -n "$QUEUED_LINE" ] && echo 1 || echo 0)" \
  "${QUEUED_LINE:-no \"Queued for \\\"$SUB_HANDLE\\\"\" line in the primary transcript $PRIMARY_FLAT — see $MR_OUT_DIR/$MR_PREFIX.turn2.json for what the orchestrator did instead}"

INTOOL_LINE=$(mr_first_in "$PRIMARY_FLAT" "right now, so the moment that call returns")
mr_record "in-tool — that answer named the tool call the subagent was inside" \
  "$([ -n "$INTOOL_LINE" ] && echo 1 || echo 0)" \
  "${INTOOL_LINE:-the tool answer did not carry the in-flight phrase; the plugin saw no tool call in flight for this subagent at that moment}"

FRAMED_COUNT=$(mr_count_in "$SUB_FLAT" "$FRAMED_OPENING")
mr_record "framed — the framed block is a persisted user message in the subagent's session" \
  "$([ "$A_framed_found" = 1 ] && echo 1 || echo 0)" \
  "framed_found=$A_framed_found, occurrences in the captured transcript: $FRAMED_COUNT (capture parsed=$A_parsed, $A_tools_total tool call(s): $A_tool_names)"

if [ "$A_framed_found" = 1 ] && [ -n "$A_inflight_tool" ]; then
  mr_record "mid-flight — it landed strictly inside a tool call of the subagent" 1 \
    "\`$A_inflight_tool\` ran $A_inflight_start..$A_inflight_end and the framed message was created at $A_framed_time, i.e. $(( (A_framed_time - A_inflight_start) / 1000 ))s into that call"
else
  mr_record "mid-flight — it landed strictly inside a tool call of the subagent" 0 \
    "no tool call of the subagent spans the framed message's creation time ($A_framed_time); tool calls: $A_tool_names"
fi

if [ "$A_assistants_before" -ge 1 ] && [ "$A_assistants_after" -ge 1 ]; then
  mr_record "between-steps — the message sits between two steps of the same run" 1 \
    "$A_assistants_before step(s) before it, $A_assistants_after after it"
else
  mr_record "between-steps — the message sits between two steps of the same run" 0 \
    "$A_assistants_before step(s) before it, $A_assistants_after after it — a message read at a next TURN would show no step after it"
fi

mr_record "one-turn — the session was never re-prompted, so that step belongs to the running turn" \
  "$([ "$A_user_messages" = 2 ] && echo 1 || echo 0)" \
  "$A_user_messages user message(s) in the subagent's session (expected 2: the briefing and the framed block)"

if [ "$A_step_after_inflight_ms" -ge 0 ]; then
  mr_record "next-step — the first step after the message began once the in-flight call returned" 1 \
    "the step started ${A_step_after_inflight_ms}ms after \`$A_inflight_tool\` returned"
else
  mr_record "next-step — the first step after the message began once the in-flight call returned" 0 \
    "no step of the subagent begins at or after the in-flight call's end (inflight_end=$A_inflight_end); nothing was measured"
fi

if [ "$A_framed_found" = 1 ] && [ "$A_tools_after" = 0 ] && [ "$A_tools_before" -lt 3 ]; then
  mr_record "stopped — no tool call started after the message, though the baseline had steps left" 1 \
    "$A_tools_before of the 3 baseline commands had started when it landed, 0 afterwards"
else
  mr_record "stopped — no tool call started after the message, though the baseline had steps left" 0 \
    "$A_tools_before tool call(s) before the message, $A_tools_after after it (baseline: 3 commands) — with 3 before it, the steering arrived too late to prove anything"
fi

ACTED_LINE=$(grep -m1 -E -- "$STEERED_PATTERN" "$PRIMARY_FLAT" 2>/dev/null | cut -c1-240)
[ -n "$ACTED_LINE" ] || ACTED_LINE=$(grep -m1 -E -- "$STEERED_PATTERN" "$SUB_FLAT" 2>/dev/null | cut -c1-240)
# The un-steered baseline line is NOT evidence on its own: it stands in the
# spawn prompt, so it is in both transcripts whatever the subagent did. What
# separates the two outcomes is the composed line above.
if [ -n "$ACTED_LINE" ]; then
  mr_record "acted — the final reply carries the line only the message could produce" 1 "$ACTED_LINE"
else
  mr_record "acted — the final reply carries the line only the message could produce" 0 \
    "nothing matching /$STEERED_PATTERN/ in the wake notice or in the captured subagent transcript — the subagent finished on its briefing alone; its tool calls were: ${A_tool_names:-none}"
fi

EXCHANGE_LINE=$(mr_first_in "$PRIMARY_FLAT" "📨 exchange:")
if printf '%s' "$EXCHANGE_LINE" | grep -qF "1 message down"; then
  mr_record "exchange — the completion notice bills the mid-run traffic" 1 "$EXCHANGE_LINE"
else
  mr_record "exchange — the completion notice bills the mid-run traffic" 0 \
    "${EXCHANGE_LINE:-no \"📨 exchange:\" line in the wake notice}"
fi

if [ -n "$EXCHANGE_LINE" ] && ! printf '%s' "$EXCHANGE_LINE" | grep -qF "never read"; then
  mr_record "seen — the notice does not report the message as unread" 1 "$EXCHANGE_LINE"
else
  mr_record "seen — the notice does not report the message as unread" 0 \
    "${EXCHANGE_LINE:-no exchange line at all, so the run cannot say whether the message was read}"
fi

mr_note "which baseline step it was in when the message landed" \
  "${ACTED_LINE:-not named — the steered line is missing}"
mr_note_uncovered "a message into a subagent that is between steps" \
  "this run sends into a tool call on purpose; the between-steps wording of the tool answer is covered by the unit suite alone"

mr_verdict
