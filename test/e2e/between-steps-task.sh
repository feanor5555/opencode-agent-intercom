#!/bin/bash
# Mid-run MESSAGE delivery BETWEEN two steps — end-to-end driver.
#
# `message-task.sh` drives the other half of `deliveryMomentPhrase`
# (src/midrun.js): it waits until the subagent's session shows a `running` tool
# part and only then has the orchestrator send, so every message it sends lands
# INSIDE a tool call. Its own report names what that leaves out as
# `NOT ASSERTED`: a message into a subagent that is BETWEEN steps. This driver
# is that case.
#
# What decides the branch is `oldestToolCall` (src/registry.js), i.e. the
# plugin's own record of the calls it has seen start and not yet return. With
# nothing in flight the tool answer reads
#
#   "… it reads it at its next step, which is the next model call it makes"
#
# instead of naming the call the subagent is inside. No setting reaches that
# branch: the moment has to be produced by the shape of the task the subagent
# is given.
#
# HOW THE WINDOW IS BUILT
#
# Every command in the subagent's baseline is an `echo` that returns in
# milliseconds, and the work between them is deliberately long: step 2 is ONE
# shell command whose argument the model has to write out word by word
# (`echo TICK-001 TICK-002 … TICK-<N> TICKS-WRITTEN`). A tool call only enters
# the plugin's in-flight map when it is EXECUTED — opencode stamps
# `state.time.start` there too, seconds after the assistant message that
# carries the call was opened — so the whole of that argument generation is
# time in which the subagent has nothing in flight. The run therefore spends
# almost all of its wall clock between steps and almost none inside a call,
# which is the opposite of `message-task.sh`'s baseline.
#
# On top of that the driver does not send on a clock: it waits until the
# subagent's own session shows the step-1 probe COMPLETED and no `running` tool
# part, which is the observation that the window is open, and only then prompts
# the orchestrator. A tool part still streaming its arguments shows as
# `pending`, never as `running`, and is counted as further evidence of the
# window rather than against it — that is exactly the state the plugin reads as
# "nothing in flight".
#
# HOW A RUN THAT MISSED THE WINDOW IS TOLD APART
#
# From the `message` tool's own answer in the orchestrator's transcript, which
# is the plugin speaking and not the model: it carries either the between-steps
# phrase above or the in-tool one (`… right now, so the moment that call
# returns`). The two are mutually exclusive and neither is anything a prompt of
# this run puts within the model's reach. A run whose message landed inside a
# call FAILS the `moment` criterion and records everything hanging off it as
# NOT ASSERTED — it is never reported as a pass, and the in-tool case stays
# `message-task.sh`'s. The subagent's own session corroborates it independently
# through `gap_ms` (lib/midrun-message.py): the framed message sits strictly
# between one call's end and the next one's start.
#
# Asserted criteria:
#
#   queued       the `message` tool reported the text queued for that handle
#   moment       and named the BETWEEN-STEPS delivery moment, not the in-tool
#                one — the gate; everything below it is recorded as
#                NOT ASSERTED when it fails
#   framed       the framed block is a persisted user message in the subagent's
#                own session
#   in-the-gap   it landed strictly between two tool calls of that session: no
#                call spans it, one had returned before it and one started
#                after it
#   read         a step of the subagent began after it landed
#   one-turn     the session was never re-prompted — two user messages, the
#                briefing and the framed block
#   stopped      at most the one call its own step had already committed to
#                started after it, and the baseline's remaining commands did
#                not run
#   acted        its final reply carries STEERED-TICKS-WRITTEN, a line only a
#                subagent that read the message can compose
#   exchange     the completion notice bills the traffic: `1 message down`
#   seen         and does not say the message was never read
#   model-pin    every captured turn answered on the pin
#
# Opt-in, like every driver here: it talks to a real opencode, spends real model
# tokens, and is never run by `npm test`.
#
# It uses a server it does NOT own — run-all.sh's, or one started by hand —
# exactly like message-task.sh and ask-task.sh, and for the same reason: this
# case needs no setting of its own. It changes nothing outside its own out-dir,
# and the subagent's role (`debugger`) cannot write or edit a file.
#
# The long generation costs the subagent no watchdog window: `maxSubagentAgeMs`
# governs a session with nothing in flight, and every event of a streaming step
# bumps `lastActivityAt` (src/hooks.js), so a subagent that is writing is never
# silent.
#
# Usage:
#   bash test/e2e/between-steps-task.sh              # against OPENCODE_URL
#   OUT_DIR=/somewhere/kept bash test/e2e/between-steps-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL      http://localhost:4567  the running server
#   PROJECT_DIR       $HOME/testopencode     sessions are created against it
#   OUT_DIR           ./out                  captures and the report
#   E2E_MODEL         openai/gpt-5.6-luna  the pin: every agent runs on it
#   BETWEEN_AGENT     debugger               the role that gets messaged; it
#                     needs the `bash` tool for the baseline steps
#   BETWEEN_MARKER    BETWEEN-STEPS-OK       the literal the UN-steered baseline
#                     reply would carry, so a run in which the message changed
#                     nothing is recognisable; the steered reply's own line is
#                     composed by the subagent (STEERED-TICKS-WRITTEN)
#   BETWEEN_TICKS     400                    words the step-2 command's argument
#                     has to carry — the width of the window, in tokens the
#                     model must write before anything goes in flight
#   MIDRUN_POLL_S     2                      poll cadence
#   WINDOW_POLL_S     1                      poll cadence while waiting for the
#                     window, kept below the general one: the window opens the
#                     moment the probe returns
#   SPAWN_TIMEOUT_S   180                    wait for the spawn
#   WINDOW_TIMEOUT_S  300                    wait for the window to open
#   TURN_TIMEOUT_S    900                    per blocking prompt POST
#   FINISH_TIMEOUT_S  600                    wait for the subagent to end
#   SETTLE_TIMEOUT_S  420                    wait for the primary to settle
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

AGENT=${BETWEEN_AGENT:-debugger}
MARKER=${BETWEEN_MARKER:-BETWEEN-STEPS-OK}
TICKS=${BETWEEN_TICKS:-400}
WINDOW_POLL_S=${WINDOW_POLL_S:-1}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
WINDOW_TIMEOUT_S=${WINDOW_TIMEOUT_S:-300}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-600}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}

FRAMED_OPENING="📨 agent-intercom: message from the orchestrator"
# The two renderings of `deliveryMomentPhrase` (src/midrun.js). Each is a
# substring that stands contiguously in that source, so the unit suite can pin
# both against it (test/e2e-midrun-readers.test.js).
BETWEEN_MOMENT_MARKER="it reads it at its next step, which is the next model call it makes"
INTOOL_MOMENT_MARKER="right now, so the moment"

# The words the baseline echoes print. The last word of step 2's output is what
# the steered reply has to carry, composed rather than quoted.
PROBE_WORD="WINDOW-PROBE-OPEN"
TICK_TAIL_WORD="TICKS-WRITTEN"
LAST_TICK=$(printf 'TICK-%03d' "$TICKS")

SID=""
SUB_SID=""
SUB_HANDLE=""

mr_init 16-between-steps
mr_check_settings

# The window is the time the model needs to write the step-2 argument out. Too
# few words and it is shorter than one turn of the orchestrator, which is what
# stands between the driver's observation and the `message` call: the run would
# then depend on luck rather than on its own construction.
[ "$TICKS" -ge 120 ] 2>/dev/null ||
  mr_die "BETWEEN_TICKS=$TICKS — below 120 words the step-2 argument is written in a couple of seconds and the between-steps window is narrower than the orchestrator's own turn; this run would be hoping for the moment instead of building it"

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
messaged role       $AGENT   (echo probe, then one echo carrying $TICKS written-out words, then three more echoes)
window              the generation of that argument: $TICKS words the model writes before anything goes in flight
marker              $MARKER
resolved settings   midRunMessaging=$MR_MID_RUN answerWaitMs=$MR_ANSWER_WAIT_MS maxMessageTokens=$MR_MAX_MESSAGE_TOKENS maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- turn 1: spawn the subagent on the window-building task ----------

SUB_TASK="This is a deliberate test of the plugin's message channel, not a diagnosis. Do exactly these six steps in order, one tool call per step, and nothing else. Step 1: run the shell command: echo $PROBE_WORD . Step 2: run ONE shell command that echoes a long list of words, in this exact form: echo TICK-001 TICK-002 TICK-003 and so on in ascending order up to $LAST_TICK, and then the word $TICK_TAIL_WORD as the very last word. Write all $TICKS TICK words out yourself in the command line, each zero-padded to three digits; do not use seq, brace expansion, a loop, a variable, a file or an ellipsis, and do not shorten the list — its length is the whole point of this test. Step 3: run the shell command: echo TAIL-1-DONE . Step 4: run the shell command: echo TAIL-2-DONE . Step 5: run the shell command: echo TAIL-3-DONE . Step 6: reply with exactly this one line and nothing else: BASELINE-$MARKER . Do not read, write or edit any file, and run no other command."
TURN1="Call spawn(\"$AGENT\", \"$SUB_TASK\") exactly once, passing that prompt through unchanged. That is your entire task for this turn. Do not call list(), do not poll, do not spawn anything else. End your turn as soon as spawn returns."

mr_debug_start

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
  mr_record "moment — the tool answer named the between-steps delivery moment" 0 \
    "no subagent ran, so no message was sent and no delivery moment exists"
  mr_verdict
  exit 1
fi

# ---------- wait until the subagent is BETWEEN two steps --------------------

# The window this whole run hangs on, read off the subagent's own session rather
# than assumed from the clock. Three figures decide it:
#
#   running    a tool part opencode has flipped to `running`, i.e. a call the
#              plugin has in flight. It must be EMPTY: that is the state
#              `oldestToolCall` reads as "nothing in flight".
#   completed  calls that have returned. At least one — the step-1 probe — so
#              the run is demonstrably under way and not still at its first
#              model call.
#   pending    a tool part whose arguments are still streaming. Not in flight
#              either, and its presence is the strongest sign that the subagent
#              is inside the long step-2 generation this run built.
window_state() {
  python3 - "$1" <<'PY' 2>/dev/null || printf '|0|0|0'
import json, sys
try:
    msgs = json.load(open(sys.argv[1]))
except Exception:
    msgs = []
running, done, pending, assistants = "", 0, 0, 0
for m in msgs if isinstance(msgs, list) else []:
    if not isinstance(m, dict):
        continue
    info = m.get("info") if isinstance(m.get("info"), dict) else {}
    if info.get("role") == "assistant":
        assistants += 1
    for p in m.get("parts") or []:
        if not isinstance(p, dict) or p.get("type") != "tool":
            continue
        state = p.get("state") if isinstance(p.get("state"), dict) else {}
        status = state.get("status")
        if status == "running":
            running = str(p.get("tool") or "?")
        elif status == "completed":
            done += 1
        elif status:
            pending += 1
print(f"{running}|{done}|{pending}|{assistants}")
PY
}

SUB_RAW="$MR_OUT_DIR/$MR_PREFIX.subagent.messages.json"
WINDOW_OPEN=0
WINDOW_SIGNAL=""
DEADLINE=$(( $(date +%s) + WINDOW_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  mr_capture "$SUB_SID" subagent > /dev/null
  STATE=$(window_state "$SUB_RAW")
  W_RUNNING=${STATE%%|*}
  REST=${STATE#*|}
  W_DONE=${REST%%|*}
  REST=${REST#*|}
  W_PENDING=${REST%%|*}
  W_ASSISTANTS=${REST#*|}
  if [ -z "$W_RUNNING" ] && [ "$W_DONE" -ge 1 ] 2>/dev/null; then
    WINDOW_OPEN=1
    WINDOW_SIGNAL="$W_DONE call(s) returned, none running, $W_PENDING with arguments still streaming, $W_ASSISTANTS step(s) so far"
    break
  fi
  sleep "$WINDOW_POLL_S"
done

if [ "$WINDOW_OPEN" = 1 ]; then
  mr_say "[$MR_PREFIX] between steps: $WINDOW_SIGNAL $(date +%H:%M:%S)"
else
  mr_note "window" "the subagent never showed a returned call with nothing running within ${WINDOW_TIMEOUT_S}s — the message below goes down anyway, and the \`moment\` criterion will say where it landed"
fi

# ---------- turn 2: the orchestrator sends the steering message -------------

# The steered reply has to be a literal the steering text itself does NOT
# contain: the framed block lands in the subagent's session and the `message`
# call's input stands in the orchestrator's, so a marker spelled out here would
# be found in both transcripts whatever the subagent did. So the subagent is
# told to COMPOSE it — the word STEERED, a hyphen, and the last word its most
# recent command printed — which yields STEERED-TICKS-WRITTEN and nothing else
# in either transcript produces that string.
STEER="Change of plan, and it replaces the rest of your task: stop as soon as the shell command you are working on has returned. Run no further command and make no further tool call. Then reply with exactly one line and nothing else: the word STEERED, then a hyphen, then the last word printed by the most recent command you ran."
STEERED_PATTERN="STEERED-($TICK_TAIL_WORD|$PROBE_WORD)"
TURN2="Your subagent \"$SUB_HANDLE\" is still running. Call message(\"$SUB_HANDLE\", \"$STEER\") exactly once, passing that text through unchanged, and end your turn immediately afterwards. Do not spawn anything, do not call list(), do not abort anything, do not repeat the message."

mr_post_prompt "$SID" "$TURN2" "$MR_OUT_DIR/$MR_PREFIX.turn2.json" "$TURN_TIMEOUT_S" &
TURN2_PID=$!
mr_say "[$MR_PREFIX] message turn posted $(date +%H:%M:%S)"

# ---------- watch the subagent until its session is gone --------------------

# A finished subagent's session is DELETED by the plugin unless retention holds
# it, so the capture loop is the only chance to record what it did. It ends on
# either of the two ways a run ends: the session stops answering, or the plugin
# reports the completion to this primary — which is what happens while the
# session is HELD. One further capture after that line, so the snapshot carries
# the final reply the notice was built from.
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
: "${A_tools_before:=0}" "${A_tools_after:=0}" "${A_tools_total:=0}" "${A_tool_names:=}"
: "${A_prev_tool_end:=0}" "${A_next_tool_start:=0}" "${A_into_gap_ms:=-1}" "${A_gap_ms:=-1}"

QUEUED_LINE=$(mr_first_in "$PRIMARY_FLAT" "Queued for \"$SUB_HANDLE\"")
mr_record "queued — the \`message\` tool reported the text queued for \"$SUB_HANDLE\"" \
  "$([ -n "$QUEUED_LINE" ] && echo 1 || echo 0)" \
  "${QUEUED_LINE:-no \"Queued for \\\"$SUB_HANDLE\\\"\" line in the primary transcript $PRIMARY_FLAT — see $MR_OUT_DIR/$MR_PREFIX.turn2.json for what the orchestrator did instead}"

# The gate. The plugin's own answer to the `message` call says which branch of
# `deliveryMomentPhrase` it took, and the two phrasings exclude each other.
BETWEEN_LINE=$(mr_first_in "$PRIMARY_FLAT" "$BETWEEN_MOMENT_MARKER")
INTOOL_LINE=$(mr_first_in "$PRIMARY_FLAT" "$INTOOL_MOMENT_MARKER")
MOMENT=0
if [ -n "$BETWEEN_LINE" ] && [ -z "$INTOOL_LINE" ]; then
  MOMENT=1
  mr_record "moment — the tool answer named the BETWEEN-STEPS delivery moment" 1 "$BETWEEN_LINE"
elif [ -n "$INTOOL_LINE" ]; then
  mr_record "moment — the tool answer named the BETWEEN-STEPS delivery moment" 0 \
    "this run did not produce the moment: the message landed inside a tool call and the answer took the in-tool branch — $INTOOL_LINE. The between-steps case stays UNCOVERED by this run; widen the window with BETWEEN_TICKS (now $TICKS)"
else
  mr_record "moment — the tool answer named the BETWEEN-STEPS delivery moment" 0 \
    "neither phrasing of \`deliveryMomentPhrase\` is in the primary transcript $PRIMARY_FLAT — nothing was queued at all, so no delivery moment was reached; see $MR_OUT_DIR/$MR_PREFIX.turn2.json"
fi

FRAMED_COUNT=$(mr_count_in "$SUB_FLAT" "$FRAMED_OPENING")
mr_record "framed — the framed block is a persisted user message in the subagent's session" \
  "$([ "$A_framed_found" = 1 ] && echo 1 || echo 0)" \
  "framed_found=$A_framed_found, occurrences in the captured transcript: $FRAMED_COUNT (capture parsed=$A_parsed, $A_tools_total tool call(s): $A_tool_names)"

if [ "$MOMENT" = 1 ]; then
  if [ "$A_framed_found" = 1 ] && [ -z "$A_inflight_tool" ] && [ "$A_gap_ms" -gt 0 ] 2>/dev/null; then
    mr_record "in-the-gap — it landed strictly between two tool calls of the subagent" 1 \
      "no call spans it; the previous one returned at $A_prev_tool_end, the next started at $A_next_tool_start, a gap of ${A_gap_ms}ms, and the message landed ${A_into_gap_ms}ms into it"
  else
    mr_record "in-the-gap — it landed strictly between two tool calls of the subagent" 0 \
      "the subagent's own session does not corroborate the tool answer: inflight_tool='$A_inflight_tool' gap_ms=$A_gap_ms prev_tool_end=$A_prev_tool_end next_tool_start=$A_next_tool_start framed_time=$A_framed_time; tool calls: $A_tool_names"
  fi

  if [ "$A_assistants_after" -ge 1 ] 2>/dev/null; then
    mr_record "read — a step of the subagent began after the message landed" 1 \
      "$A_assistants_before step(s) before it, $A_assistants_after after it"
  else
    mr_record "read — a step of the subagent began after the message landed" 0 \
      "$A_assistants_before step(s) before it, 0 after it — it was queued into a run that made no further model call, so nothing read it"
  fi

  mr_record "one-turn — the session was never re-prompted, so that step belongs to the running turn" \
    "$([ "$A_user_messages" = 2 ] && echo 1 || echo 0)" \
    "$A_user_messages user message(s) in the subagent's session (expected 2: the briefing and the framed block)"

  if [ "$A_framed_found" = 1 ] && [ "$A_tools_after" -le 1 ] && [ "$A_tools_total" -lt 5 ] 2>/dev/null; then
    mr_record "stopped — only the call its own step had committed to started after the message" 1 \
      "$A_tools_before call(s) before it, $A_tools_after after it, $A_tools_total in the whole run against the baseline's 5: $A_tool_names"
  else
    mr_record "stopped — only the call its own step had committed to started after the message" 0 \
      "$A_tools_before call(s) before it, $A_tools_after after it, $A_tools_total in the whole run (baseline: 5 commands): $A_tool_names — more than the one already-committed call ran on, so the steering did not stop it"
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
else
  mr_note_uncovered "in-the-gap / read / one-turn / stopped / acted / exchange / seen" \
    "this run never reached the between-steps moment, so nothing hanging off it was asserted: what the subagent did with a message delivered some other way is message-task.sh's case, not this driver's"
fi

# ---------- what the run observed, judged by nothing -------------------------

mr_note "the window this run built" \
  "signal at the send: ${WINDOW_SIGNAL:-none — the send went out without one}; measured gap between the two calls: ${A_gap_ms}ms"
mr_note "whether the subagent really wrote the argument out" \
  "$([ "$(mr_count_in "$SUB_FLAT" "$LAST_TICK")" != 0 ] && echo "yes — $LAST_TICK stands in its session, so the $TICKS words were written and the window is the one this driver asked for" || echo "no — $LAST_TICK is nowhere in its session: the model shortened or generated the list instead of writing it out, and the window was narrower than the setup claims")"
mr_note "what it finally replied" \
  "$(mr_first_in "$SUB_FLAT" "STEERED-" || true)"

mr_note_uncovered "a message into a subagent that is INSIDE a tool call" \
  "the in-tool branch of deliveryMomentPhrase, the mid-flight landing and the next-step measurement are message-task.sh's criteria — this driver sends only into the gap between two steps"
mr_note_uncovered "a message that arrives after the subagent has finished" \
  "the refusal path for a handle that is no longer running is pinned by the unit suite (test/agent-message-tool.test.js); reaching it live would mean racing the teardown, which no driver here does on purpose"

# What answered. Both sessions of this run were captured above, so the audit
# reads the subagent's turns as well as the orchestrator's.
mr_model_audit

mr_verdict
