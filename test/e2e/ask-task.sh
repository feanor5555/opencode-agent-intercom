#!/bin/bash
# Mid-run ASK end-to-end driver.
#
# Drives one question from a RUNNING subagent up to its caller and the caller's
# answer back down, against a real `opencode serve`, and asserts what
# `specs/mid-run-messaging.md` and `concepts/mid-run-agent-messaging.md` §12
# claim about it. The unit suite proves the waiter against a mock client; this
# driver is the only place where a real opencode, a real model and the real
# session lifecycle decide the two things no mock can settle:
#
#   the QUESTION ARRIVES  `ask` reaches the caller as a notice it acts on, and
#                         the subagent STOPS on it — no step, no tool call and
#                         no token spent while it waits.
#   the ANSWER IS THE     the caller's `message(...)` comes back as the RESULT
#   TOOL RESULT           OF THE `ask` CALL ITSELF, not as a message the
#                         subagent has to notice in its session.
#
# The scenario, in one subagent run:
#
#   1. the orchestrator spawns a `planner` whose task cannot start before one
#      decision — ALPHA or BETA — and which is told to `ask` for it;
#   2. the same turn tells the orchestrator what to answer, so the run measures
#      the CHANNEL and not the model's taste: `message(handle, "Use ALPHA: …")`;
#   3. what came back is read off the subagent's own session — the `ask` call's
#      output, its span, and what happened inside that span — and off the wake
#      notice the orchestrator got.
#
# Asserted criteria:
#
#   asked        the subagent really called `ask` (its own session shows the
#                call, the plugin's log shows the question posted)
#   notice       the question reached the caller as the `asks you:` notice
#   answered     the caller's `message` was taken as the ANSWER — the tool said
#                "Answer delivered", not "Queued"
#   tool-result  the answer is the output of the subagent's own `ask` call, and
#                carries the answer marker
#   blocked      no step and no other tool call of the subagent while the
#                question was open: it stopped and cost nothing
#   acted        its final reply carries the word the answer decided
#   exchange     the completion notice bills the traffic: `1 question answered`
#
# Opt-in, like every driver here: it talks to a real opencode, spends real model
# tokens, and is never run by `npm test`.
#
# It uses a server it does NOT own — run-all.sh's, or one started by hand —
# exactly like run-task.sh and multi-task.sh, and it changes nothing outside its
# own out-dir: no setting is written, and the subagent is told to touch no file.
#
# Usage:
#   bash test/e2e/ask-task.sh                        # against OPENCODE_URL
#   OUT_DIR=/somewhere/kept bash test/e2e/ask-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL     http://localhost:4567  the running server
#   PROJECT_DIR      $HOME/testopencode     sessions are created against it
#   OUT_DIR          ./out                  captures and the report
#   E2E_MODEL        openai/gpt-5.6-luna  the pin: every agent runs on it
#   ASK_AGENT        planner                the role that asks
#   ASK_ANSWER_MARKER ASK-ANSWER-ALPHA      the literal the orchestrator is told
#                    to answer with; it is looked for inside the `ask` call's own
#                    output, so it must be a string nothing else produces
#   MIDRUN_POLL_S    2                      poll cadence
#   SPAWN_TIMEOUT_S  180                    wait for the spawn
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

AGENT=${ASK_AGENT:-planner}
ANSWER_MARKER=${ASK_ANSWER_MARKER:-ASK-ANSWER-ALPHA}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-600}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}

# What the answer decides, and the line the subagent composes out of it. The
# decided word is spelled out in the answer; the composed line is not, so
# finding CHOSE-ALPHA anywhere proves a subagent that read the answer wrote it.
DECISION=ALPHA
CHOSE_LINE="CHOSE-$DECISION"
SID=""
SUB_SID=""
SUB_HANDLE=""

mr_init 14-ask
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
asking role         $AGENT
answer              Use $DECISION: $ANSWER_MARKER
composed reply      $CHOSE_LINE
resolved settings   midRunMessaging=$MR_MID_RUN answerWaitMs=$MR_ANSWER_WAIT_MS maxMessageTokens=$MR_MAX_MESSAGE_TOKENS maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF
mr_say ""

if [ "$MR_ANSWER_WAIT_MS" = 0 ]; then
  mr_die "answerWaitMs is 0 — this run answers questions asynchronously, so the ask call returns before any answer and the tool-result criterion cannot hold. Raise it for the run."
fi

# ---------- turn 1: spawn a subagent whose task starts with a question ------

mr_debug_start

SUB_TASK="This is a deliberate test of the plugin's ask channel, not a planning job. Do exactly these three steps and nothing else. Step 1: call ask('Write the plan for variant $DECISION or for variant BETA? Answer with one of the two words.') exactly once and wait for its result. Step 2: make no other tool call at all — do not read, write or edit any file and do not search. Step 3: reply with exactly one line and nothing else: the word CHOSE, then a hyphen, then the single word the answer told you to use."
TURN1="Call spawn(\"$AGENT\", \"$SUB_TASK\") exactly once, passing that prompt through unchanged, then end your turn. That subagent will put ONE question to you. When it does, answer it in that same turn with message(\"<its handle>\", \"Use $DECISION: $ANSWER_MARKER\") and nothing else: do not spawn anything for it, do not abort it, do not call list(), and do not report the question to me as a result."

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
  mr_record "asked — the subagent put a question to its caller" 0 \
    "no subagent was spawned at all: $MR_WAIT_REASON"
  mr_verdict
  exit 1
fi

# ---------- watch the subagent until its session is gone --------------------

# A finished subagent's session is DELETED by the plugin, so this loop is the
# only chance to record the `ask` call and the answer that came back as its
# result. The two log lines it collects on the way are the plugin's own account
# of the same exchange, which is what tells a question that was never posted
# from one whose answer never arrived.
ASK_POSTED_LINE=""
ASK_SETTLED_LINE=""
# It ends on either of the two ways a run ends: the session stops answering —
# the ordinary teardown deletes it — or the plugin reports the completion to
# this primary, which is what happens while retention is on and the session is
# HELD instead of deleted. One further capture after that line, so the snapshot
# carries the final reply the notice was built from.
ENDED=""
DEADLINE=$(( $(date +%s) + FINISH_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  mr_capture "$SUB_SID" subagent > /dev/null
  mr_refresh_slice
  [ -n "$ASK_POSTED_LINE" ] || ASK_POSTED_LINE=$(grep -E -m1 -- "ask posted .*\"sessionID\":\"$SUB_SID\"" "$MR_SLICE_FILE")
  [ -n "$ASK_SETTLED_LINE" ] || ASK_SETTLED_LINE=$(grep -E -m1 -- "ask settled .*\"sessionID\":\"$SUB_SID\"" "$MR_SLICE_FILE")
  CODE=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$MR_BASE/session/$SUB_SID" 2>/dev/null)
  if [ "$CODE" != 200 ]; then
    ENDED="its session is gone (HTTP $CODE)"
    break
  fi
  if grep -qE -- "notified primary of completion .*\"parentID\":\"$SID\"" "$MR_SLICE_FILE"; then
    sleep "$MR_POLL_S"
    mr_capture "$SUB_SID" subagent > /dev/null
    ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
    break
  fi
  sleep "$MR_POLL_S"
done
if [ -n "$ENDED" ]; then
  mr_say "[$MR_PREFIX] subagent ended: $ENDED $(date +%H:%M:%S)"
else
  mr_say "[$MR_PREFIX] subagent neither ended nor was notified within ${FINISH_TIMEOUT_S}s — captures may be short of its last step"
fi

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
SUB_RAW="$MR_OUT_DIR/$MR_PREFIX.subagent.messages.json"

# ---------- the evidence ----------------------------------------------------

mr_say ""
ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
if [ -f "$SUB_RAW" ]; then
  python3 "$HERE/lib/midrun-ask.py" "$SUB_RAW" "$ANSWER_MARKER" > "$ANALYSIS" 2>/dev/null
else
  : > "$ANALYSIS"
fi
mr_load_kv "$ANALYSIS" A_
: "${A_parsed:=0}" "${A_ask_calls:=0}" "${A_ask_status:=}" "${A_ask_ms:=0}" "${A_ask_question:=0}"
: "${A_answer_prefix:=0}" "${A_answer_marker:=0}" "${A_tools_during_ask:=0}"
: "${A_assistants_during_ask:=0}" "${A_tools_after_ask:=0}" "${A_assistants_after_ask:=0}"
: "${A_tool_names:=}"

if [ "$A_ask_calls" -ge 1 ] || [ -n "$ASK_POSTED_LINE" ]; then
  mr_record "asked — the subagent put a question to its caller" 1 \
    "ask_calls=$A_ask_calls status=$A_ask_status question_carried=$A_ask_question; plugin log: ${ASK_POSTED_LINE:-no ask posted line}"
else
  mr_record "asked — the subagent put a question to its caller" 0 \
    "no ask call in the captured session (tool calls: ${A_tool_names:-none}) and no \"ask posted\" line for $SUB_SID — the model finished without using the channel"
fi

NOTICE_LINE=$(mr_first_in "$PRIMARY_FLAT" "asks you:")
mr_record "notice — the question reached the caller as the ask notice" \
  "$([ -n "$NOTICE_LINE" ] && echo 1 || echo 0)" \
  "${NOTICE_LINE:-no \"asks you:\" notice in the primary transcript}"

DELIVERED_LINE=$(mr_first_in "$PRIMARY_FLAT" "Answer delivered to \"$SUB_HANDLE\"")
QUEUED_LINE=$(mr_first_in "$PRIMARY_FLAT" "Queued for \"$SUB_HANDLE\"")
if [ -n "$DELIVERED_LINE" ]; then
  mr_record "answered — the caller's message was taken as the answer, not queued as a message" 1 \
    "$DELIVERED_LINE"
else
  mr_record "answered — the caller's message was taken as the answer, not queued as a message" 0 \
    "no \"Answer delivered\" line; what the message tool said instead: ${QUEUED_LINE:-nothing at all — the orchestrator never called message}"
fi

if [ "$A_answer_prefix" = 1 ] && [ "$A_answer_marker" = 1 ]; then
  mr_record "tool-result — the answer came back as the output of the subagent's own ask call" 1 \
    "the ask call's output opens with the answer line and carries $ANSWER_MARKER (ask ran ${A_ask_ms}ms, status=$A_ask_status)"
else
  mr_record "tool-result — the answer came back as the output of the subagent's own ask call" 0 \
    "answer_prefix=$A_answer_prefix answer_marker=$A_answer_marker in the ask call's output (ask ran ${A_ask_ms}ms, status=$A_ask_status) — see $SUB_FLAT"
fi

if [ "$A_ask_calls" -ge 1 ] && [ "$A_tools_during_ask" = 0 ] && [ "$A_assistants_during_ask" = 0 ]; then
  mr_record "blocked — the subagent took no step and no other tool call while it waited" 1 \
    "0 steps and 0 other tool calls inside the ${A_ask_ms}ms the ask call was open"
else
  mr_record "blocked — the subagent took no step and no other tool call while it waited" 0 \
    "$A_assistants_during_ask step(s) and $A_tools_during_ask other tool call(s) inside the ask window (ask_calls=$A_ask_calls)"
fi

ACTED_LINE=$(mr_first_in "$PRIMARY_FLAT" "$CHOSE_LINE")
[ -n "$ACTED_LINE" ] || ACTED_LINE=$(mr_first_in "$SUB_FLAT" "$CHOSE_LINE")
if [ -n "$ACTED_LINE" ]; then
  mr_record "acted — the final reply carries the word the answer decided" 1 "$ACTED_LINE"
else
  mr_record "acted — the final reply carries the word the answer decided" 0 \
    "nothing carrying $CHOSE_LINE in the wake notice or in the captured subagent transcript: the answer reached the tool but did not reach the reply"
fi

EXCHANGE_LINE=$(mr_first_in "$PRIMARY_FLAT" "📨 exchange:")
if printf '%s' "$EXCHANGE_LINE" | grep -qF "1 question answered"; then
  mr_record "exchange — the completion notice bills the answered question" 1 "$EXCHANGE_LINE"
else
  mr_record "exchange — the completion notice bills the answered question" 0 \
    "${EXCHANGE_LINE:-no \"📨 exchange:\" line in the wake notice}"
fi

mr_note "the plugin's own account of the exchange" \
  "${ASK_SETTLED_LINE:-no ask settled line for this session}"
mr_note "what the subagent did after the answer" \
  "$A_assistants_after_ask step(s), $A_tools_after_ask tool call(s) — tool calls of the whole run: ${A_tool_names:-none}"
mr_note_uncovered "the unanswered path and the clamp" \
  "a question left to expire, and the clamp against maxSubagentToolCallMs, are covered by the unit suite alone — this run answers inside the window"

# What answered. Both sessions of this run were captured above, so the audit
# reads the subagent's turns as well as the orchestrator's.
mr_model_audit

mr_verdict
