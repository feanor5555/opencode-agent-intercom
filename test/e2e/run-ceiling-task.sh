#!/bin/bash
# The third watchdog window — a ceiling over the whole run — against a live
# subagent that never goes silent.
#
# `watchdogLimit` (src/watchdog.js) answers `kind: "run"` first, measured from
# `entry.runStartedAt`, which nothing the subagent does renews. The two windows
# that already existed cannot catch a poller: every short call restarts
# `maxSubagentToolCallMs`, and every event restarts `maxSubagentAgeMs`. This
# driver is the live proof of that defect's close, and of the wrap-up band that
# announces the cut before it happens.
#
# Three phases, each with its own primary session and its own subagent, all on
# one isolated server:
#
#   poller    maxSubagentRunMs=240000, maxSubagentToolCallMs=600000,
#             maxSubagentAgeMs=90000. The subagent waits for a file that is
#             never created, checking with short bash calls. Neither existing
#             window can have fired (`neither-old`, from opencode's own
#             state.time.start/end). The wrap-up band is handed to the provider
#             at or after 0.75 of the ceiling (request log — the carrier is
#             never persisted). The primary then sees the run-ceiling timeout
#             notice, the snapshot is secured (a result file under the
#             project's work/ plus the produced-text notice), and list()
#             shows no running subagent.
#   control   the same pin. One bash call that sleeps 120 s — past the silence
#             window, inside the run ceiling. It finishes; no timeout notice,
#             no wrap-up band. Without this phase the driver would pass on a
#             plugin that reaps everything.
#   handback  the poller task again, but the subagent is told to honour the
#             wrap-up band with a Blocked: line. If it does, the reap never
#             fires. If the model ignores the band the phase records
#             NOT ASSERTED rather than failing — the pattern between-steps
#             uses for a criterion that depends on the model's cooperation.
#
# Asserted criteria:
#
#   neither-old (poller)  longest call < maxSubagentToolCallMs and longest
#                         gap < maxSubagentAgeMs, from the subagent's own
#                         session parts, at least two completed calls
#   warned (poller)       the wrap-up band appears in the request log on a
#                         turn at or after 0.75 of the ceiling, and a tool
#                         call of that same turn still executed
#   reaped (poller)       the primary's transcript carries the timeout wake
#                         notice naming maxSubagentRunMs and "cut off on its
#                         run ceiling" — plugin text, not model text
#   rescued (poller)      the notice carries what the subagent produced and a
#                         non-empty result file exists under the project's
#                         work/ (concept §9). Empty-snapshot fallback only
#                         when that same capture is parsed with ≥2 tools and
#                         USABLE=0, plus `file:null` `secured:true`
#   slot (poller)         a list() afterwards shows no running subagent
#   finished (control)    CONTROL_MARKER in the subagent transcript and
#                         longest_call_ms in [CONTROL_SLEEP_MS, SUB_TOOL_CALL_MS)
#   no-timeout (control)  no run-ceiling timeout notice on the primary
#   no-wrap-up (control)  no wrap-up band in the request log for that session
#   handed-back (handback) final reply begins Blocked: naming the wait-file,
#                         and the reap never fired — or NOT ASSERTED when
#                         the model ignores the band
#   model-pin             every captured turn answered on the pin
#
# THIS DRIVER OWNS ITS SERVER, like `ask-expiry-task.sh` and
# `context-bands-task.sh`: the three windows and the request log are read at
# plugin load and from the agent-intercom.json the server was started with, so
# it builds a throwaway HOME (`config-isolation.sh`), writes the pin into that
# file (including `maxSubagentRunMs`), starts an `opencode serve` of its own on
# its own port with the request log switched on into its own out directory, and
# removes all of it again. Nothing outside the throwaway home is written, and
# the machine's ~/.config/opencode is read once for the provider block and
# never written.
#
# Usage:
#   bash test/e2e/run-ceiling-task.sh
#
# Env (all with defaults):
#   PROJECT_DIR            $HOME/testopencode  the server's cwd, the directory
#                          sessions are created against
#   OUT_DIR                ./out               captures, request log, report
#   E2E_MODEL              openai/gpt-5.6-luna the pin: every agent runs on it
#   RUN_CEILING_PORT       4612                own port, clear of run-all's
#                          4567, ask-expiry's 4588, endless' 4599, nested's
#                          4602, context-bands' 4606, mcp-after's 4608,
#                          tui-route's 4610
#   RUN_CEILING_AGENT      coder               the role that is driven; it
#                          needs `bash`, which planner / reviewer / documenter
#                          deny
#   RUN_CEILING_RUN_MS     240000              the run ceiling this pin uses
#   RUN_CEILING_AGE_MS     90000               the silence window
#   RUN_CEILING_TOOL_MS    600000              the in-tool window
#   RUN_CEILING_POLL_S     15                  seconds each poller bash sleeps
#   RUN_CEILING_CONTROL_S  120                 seconds the control call sleeps
#   SPAWN_TIMEOUT_S        240                 wait for the spawn
#   FINISH_TIMEOUT_S       (derived)           wait for a subagent to end:
#                          RUN_CEILING_RUN_MS/1000 + 180
#   TURN_TIMEOUT_S         900                 per blocking prompt POST
#   SETTLE_TIMEOUT_S       240                 wait for the primary to settle
#   SERVER_START_TIMEOUT_S 60                  readiness probe budget
#   MIDRUN_POLL_S          2                   poll cadence
#   KEEP_SERVER            0                   1 leaves the server running
#   E2E_TUI_BUILT          0                   1 skips the TUI build
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, setsid, npm, an `opencode` on PATH, a provider
# serving E2E_MODEL configured in the machine's opencode.json, and the plugin's
# debug log switched on.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

PREFIX=20-run-ceiling
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

. "$HERE/server-lifecycle.sh"
. "$HERE/lib/midrun-common.sh"

AGENT=${RUN_CEILING_AGENT:-coder}
PORT=${RUN_CEILING_PORT:-4612}
RUN_MS=${RUN_CEILING_RUN_MS:-240000}
SUB_AGE_MS=${RUN_CEILING_AGE_MS:-90000}
SUB_TOOL_CALL_MS=${RUN_CEILING_TOOL_MS:-600000}
POLL_SLEEP_S=${RUN_CEILING_POLL_S:-15}
CONTROL_SLEEP_S=${RUN_CEILING_CONTROL_S:-120}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-240}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-240}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
KEEP_SERVER=${KEEP_SERVER:-0}

WAIT_FILE=e2e-run-ceiling-never.txt
WRAP_HEAD="⏳ RUN CEILING AHEAD."
TIMEOUT_CAUSE="cut off on its run ceiling"
TIMEOUT_SETTING="maxSubagentRunMs"
RESCUED_MARKER="What it produced before it was cut off"
LIST_EMPTY="No active subagents."
CONTROL_MARKER="CONTROL-SLEEP-DONE"

SETTINGS_FILE=""
SESSION_IDS=""
SERVER_VERSION="(unknown)"
REQUEST_LOG=""
RC_HANDLES=""

P_LABEL=""
P_SID=""
P_SUB_SID=""
P_SUB_HANDLE=""
P_SPAWN_MS=0
P_ENDED=""
P_TIMEOUT_LINE=""
P_WRAP_LINE=""
P_FLAT=""
P_PRIMARY_FLAT=""
P_FINISH_S=0

R_parsed=0
R_tools=0
R_longest_call_ms=0
R_longest_gap_ms=0
R_neither_old=0
R_wrap_records=0
R_wrap_elapsed_ms=0
R_wrap_at_or_after=0
R_wrap_tool_after=0
RC_RESCUED_OK=0
RC_RESCUED_EVIDENCE=""

# How many assistant messages in a capture carry usable (non-empty, non-synthetic)
# text — the same cut `finalResult` in src/client.js walks. 0 means the snapshot
# the reap secured had nothing to file. A missing or unreadable capture also
# prints 0; callers must not treat that as proven emptiness (see rc_rescued_decide).
rc_usable_assistant() {
  local capture="$1"
  [ -f "$capture" ] || { printf '0'; return 0; }
  python3 - "$capture" <<'PY' 2>/dev/null || printf '0'
import json, sys
try:
    messages = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    print(0)
    raise SystemExit
n = 0
if isinstance(messages, list):
    for message in messages:
        info = message.get("info") if isinstance(message, dict) else None
        if not isinstance(info, dict) or info.get("role") != "assistant":
            continue
        if info.get("summary") is True:
            continue
        for part in message.get("parts") or []:
            if not isinstance(part, dict) or part.get("type") != "text":
                continue
            if part.get("synthetic"):
                continue
            text = part.get("text") if isinstance(part.get("text"), str) else ""
            if text.strip():
                n += 1
                break
print(n)
PY
}

# Concept §9: a result file under the project's work/ and the produced-text
# notice. The empty-snapshot branch is only a fallback for a poller that still
# produced no assistant text, and only when that emptiness was read from a
# parsed capture with ≥2 tools (the same capture neither-old required).
rc_rescued_decide() {
  local work="${PROJECT%/}/work"
  local file="${RESULT_FILE:-}"
  local hit="${RESCUED_HIT:-0}"
  local parsed="${R_parsed:-0}"
  local tools="${R_tools:-0}"
  local usable="${USABLE:-0}"
  local gone="${SESSION_GONE:-0}"
  local line="${SECURED_LINE:-}"
  RC_RESCUED_OK=0
  RC_RESCUED_EVIDENCE=""

  case "$file" in
    "$work"/*)
      if [ -n "$file" ] && [ -s "$file" ] && [ "$hit" -ge 1 ] 2>/dev/null; then
        RC_RESCUED_OK=1
        RC_RESCUED_EVIDENCE="result file $file ($(wc -c < "$file" | tr -d ' ') bytes); primary transcript carries \"$RESCUED_MARKER\""
        return 0
      fi
      ;;
  esac

  if [ "$parsed" = 1 ] && [ "$tools" -ge 2 ] 2>/dev/null && [ "$usable" = 0 ] && [ "$gone" = 1 ] \
     && printf '%s' "$line" | grep -q '"secured":true' \
     && printf '%s' "$line" | grep -q '"file":null'; then
    RC_RESCUED_OK=1
    RC_RESCUED_EVIDENCE="no usable assistant text (usable=$usable); plugin log file=null secured=true; session deleted — nothing to file. ${line}"
    return 0
  fi

  if [ "$parsed" != 1 ] || [ "$tools" -lt 2 ] 2>/dev/null; then
    RC_RESCUED_EVIDENCE="usable unknown — capture missing/unparsed"
    return 1
  fi

  RC_RESCUED_EVIDENCE="result file=${file:-none} rescued-marker hits=${hit} usable_assistant=${usable} session_gone=${gone} secured_line=${line:-none} — looked under $work/agent-intercom-result-*"
  return 1
}

# Sourced by the unit test that drives rc_rescued_decide. Skip the live server.
if [ "${RC_SOURCE_ONLY:-}" = 1 ]; then
  return 0 2>/dev/null || exit 0
fi

# ---------- a window into the shared debug log ------------------------------

RC_FROM_LINE=0

rc_mark_window() {
  mr_refresh_slice
  RC_FROM_LINE=$(wc -l < "$MR_SLICE_FILE" 2>/dev/null || echo 0)
}

rc_match_after() {
  grep -nE -- "$1" "$MR_SLICE_FILE" 2>/dev/null |
    awk -F: -v from="$RC_FROM_LINE" '$1 > from { sub(/^[0-9]+:/, ""); print; exit }'
}

RC_LINE=""
RC_REASON=""
rc_wait_after() {
  local label="$1" pattern="$2" timeout="$3"
  local deadline=$(( $(date +%s) + timeout )) hit
  RC_LINE=""; RC_REASON=""
  while :; do
    mr_refresh_slice
    hit=$(rc_match_after "$pattern")
    if [ -n "$hit" ]; then
      RC_LINE="$hit"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      RC_REASON="no line matching /$pattern/ within ${timeout}s while waiting for \"$label\" — last log line: $(tail -n 1 "$MR_SLICE_FILE")"
      return 1
    fi
    sleep "$MR_POLL_S"
  done
}

rc_now_ms() {
  date +%s%3N
}

# ---------- preflight -------------------------------------------------------

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"

for tool in curl python3 setsid npm; do
  command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
done
command -v opencode >/dev/null || mr_die "opencode is not on PATH — this driver starts a server of its own"
[ -f "$HERE/lib/run-ceiling.py" ] || mr_die "run-ceiling reader is missing: $HERE/lib/run-ceiling.py"

RUN_WRAP_UP=$(sed -nE 's/^export const RUN_WRAP_UP = ([0-9.]+).*/\1/p' "$PLUGIN_ROOT/src/settings.js" | head -n 1)
[ -n "$RUN_WRAP_UP" ] ||
  mr_die "could not read RUN_WRAP_UP out of $PLUGIN_ROOT/src/settings.js — every expected wrap-up of this run is derived from it"

WRAP_AT_MS=$(python3 -c 'import sys; print(int(float(sys.argv[1]) * int(sys.argv[2])))' "$RUN_WRAP_UP" "$RUN_MS" 2>/dev/null || echo "")
[ -n "$WRAP_AT_MS" ] || mr_die "could not derive the wrap-up threshold from RUN_WRAP_UP=$RUN_WRAP_UP and RUN_MS=$RUN_MS"

CONTROL_SLEEP_MS=$((CONTROL_SLEEP_S * 1000))
POLL_SLEEP_MS=$((POLL_SLEEP_S * 1000))

if [ -z "${FINISH_TIMEOUT_S:-}" ]; then
  FINISH_TIMEOUT_S=$(( RUN_MS / 1000 + 180 ))
fi
CONTROL_FINISH_S=$(( CONTROL_SLEEP_S + 180 ))

[ "$RUN_MS" -gt 0 ] 2>/dev/null ||
  mr_die "RUN_CEILING_RUN_MS=$RUN_MS — a ceiling of 0 switches the run window off (runCeilingFor, src/settings.js), so nothing this driver asserts could fire"
[ "$SUB_AGE_MS" -gt 0 ] 2>/dev/null ||
  mr_die "RUN_CEILING_AGE_MS=$SUB_AGE_MS — maxSubagentAgeMs<=0 disables the sweep's running branch, run ceiling included"
[ "$WRAP_AT_MS" -lt "$RUN_MS" ] ||
  mr_die "wrap-up threshold $WRAP_AT_MS is not below the ceiling $RUN_MS"
[ "$CONTROL_SLEEP_MS" -gt "$SUB_AGE_MS" ] ||
  mr_die "the control sleep ${CONTROL_SLEEP_S}s does not outlast the silence window ${SUB_AGE_MS}ms — a silence reap could then look like a pass of the control"
[ "$CONTROL_SLEEP_MS" -lt "$WRAP_AT_MS" ] ||
  mr_die "the control sleep ${CONTROL_SLEEP_S}s reaches the wrap-up at ${WRAP_AT_MS}ms — the control would then see the band this phase asserts is absent"
[ "$POLL_SLEEP_MS" -lt "$SUB_AGE_MS" ] ||
  mr_die "the poller sleep ${POLL_SLEEP_S}s is not under the silence window ${SUB_AGE_MS}ms — neither-old could not be proven"
[ "$SUB_TOOL_CALL_MS" -gt "$CONTROL_SLEEP_MS" ] ||
  mr_die "the in-tool window ${SUB_TOOL_CALL_MS}ms does not outlast the control sleep ${CONTROL_SLEEP_S}s — the control could then be cut on maxSubagentToolCallMs"
[ "$SUB_TOOL_CALL_MS" -gt "$RUN_MS" ] ||
  mr_die "the in-tool window ${SUB_TOOL_CALL_MS}ms is not above the run ceiling ${RUN_MS}ms — the poller could then be cut on a call rather than on the run"

# ---------- the isolated configuration and the server -----------------------

PROJECT=${PROJECT_DIR:-$HOME/testopencode}
BASE=$(e2e_server_url "$PORT")
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || mr_die "cannot create $OUT_PRE"
OUT_PRE=$(cd "$OUT_PRE" && pwd)
REQUEST_LOG="$OUT_PRE/$PREFIX.requests.jsonl"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  mr_die "something already answers on $BASE — stop it, or set RUN_CEILING_PORT to a free port"
fi

e2e_iso_create "$PLUGIN_ROOT" \
  "$(printf '{"maxSubagents":8,"maxContext":130000,"compaction":false,"endlessMode":false,"agentMode":"orchestrator","midRunMessaging":true,"maxRetainedSubagents":0,"maxSubagentAgeMs":%s,"maxSubagentToolCallMs":%s,"maxSubagentRunMs":%s}' \
    "$SUB_AGE_MS" "$SUB_TOOL_CALL_MS" "$RUN_MS")" ||
  mr_die "could not build the isolated opencode configuration"
SETTINGS_FILE="$E2E_ISO_SETTINGS_FILE"

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  local s f
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
  e2e_iso_remove
  rm -f "$PROJECT/$WAIT_FILE"
  for h in $RC_HANDLES; do
    [ -z "$h" ] && continue
    safe=$(printf '%s' "$h" | sed 's/[^A-Za-z0-9._-]/-/g')
    for f in "$PROJECT/work"/agent-intercom-result-"$h"-* "$PROJECT/work"/agent-intercom-result-"$safe"-*; do
      [ -f "$f" ] || continue
      rm -f "$f"
      mr_say "removed result file $f"
    done
  done
  [ -n "$MR_REPORT_FILE" ] && mr_say "report:      $MR_REPORT_FILE"
  [ -n "$MR_OUT_DIR" ] && mr_say "captures:    $MR_OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ -n "$REQUEST_LOG" ] && mr_say "requests:    $REQUEST_LOG"
  [ -n "$MR_SLICE_FILE" ] && mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "$PLUGIN_ROOT is wired nowhere the server would read it — name it in the plugin array of ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json, or of $PROJECT/opencode.json, or drop a loader into $PROJECT/.opencode/plugin/"
e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "the TUI half of $PLUGIN_ROOT is wired nowhere the TUI would read it — see the tui.json paths listed above"

e2e_build_tui "$PLUGIN_ROOT" || mr_die "the TUI build failed — see the npm output above"

mr_debug_start

export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1
export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE="$REQUEST_LOG"
: > "$REQUEST_LOG"
e2e_server_start "$PORT" "$PROJECT" "$OUT_PRE/$PREFIX.server.log" "$OUT_PRE/$PREFIX.serverpid" ||
  mr_die "could not start opencode on $BASE — see $OUT_PRE/$PREFIX.server.log"
unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS
unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE
e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_PRE/$PREFIX.health.json" ||
  mr_die "opencode on $BASE did not become ready — see $OUT_PRE/$PREFIX.server.log"
SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$OUT_PRE/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")

OPENCODE_URL="$BASE"
export OPENCODE_URL
LOG_OFFSET_KEPT=$MR_LOG_OFFSET
mr_init "$PREFIX"
MR_LOG_OFFSET=$LOG_OFFSET_KEPT
mr_check_settings skip-midrun

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
project dir         $MR_PROJECT_DIR
server              opencode serve --port $PORT --hostname 127.0.0.1   (owned by this driver, cwd = project dir)
server pid / pgid   $E2E_SERVER_PID / $E2E_SERVER_PGID
opencode version    $SERVER_VERSION
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
driven role         $AGENT
isolated config     $E2E_ISO_OPENCODE_DIR   (the machine's ~/.config/opencode is not written)
settings file       $SETTINGS_FILE
run ceiling         maxSubagentRunMs=$RUN_MS   wrap-up at ${WRAP_AT_MS}ms (RUN_WRAP_UP=$RUN_WRAP_UP, read from src/settings.js)
watchdog windows    maxSubagentAgeMs=$SUB_AGE_MS maxSubagentToolCallMs=$SUB_TOOL_CALL_MS
poller sleep        ${POLL_SLEEP_S}s   control sleep ${CONTROL_SLEEP_S}s
wait-file           $PROJECT/$WAIT_FILE   (never created)
request log         $REQUEST_LOG   (OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1 for this server alone)
resolved settings   midRunMessaging=$MR_MID_RUN maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
timeouts            spawn=${SPAWN_TIMEOUT_S}s finish=${FINISH_TIMEOUT_S}s control-finish=${CONTROL_FINISH_S}s turn=${TURN_TIMEOUT_S}s settle=${SETTLE_TIMEOUT_S}s poll=${MR_POLL_S}s
debug log           $MR_DEBUG_LOG   (read from byte $MR_LOG_OFFSET)
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- prompts ---------------------------------------------------------

rc_poller_task() {
  local honour="$1"
  if [ "$honour" = honour ]; then
    printf '%s' "This is a deliberate test of the plugin's run ceiling, not a coding job. Wait for the file $WAIT_FILE to appear in this project directory. Until it exists, poll with short bash calls of the form: sleep $POLL_SLEEP_S; test -f $WAIT_FILE && echo FOUND || echo STILL-WAITING. One such call per step, never a longer sleep, never a loop inside one command. Do not create the file, do not ask(), do not spawn, do not edit anything. The plugin will send you a notice headed \"$WRAP_HEAD\". When you receive that notice, stop polling at once and reply with one plain-text line beginning Blocked: that names $WAIT_FILE as the file you were waiting for, then end your turn. Do not wait to be cut off. If you never receive that notice and a call comes back as an error because the run was cut off, reply with one line beginning Blocked: naming the cutoff."
  else
    printf '%s' "This is a deliberate test of the plugin's run ceiling, not a coding job. Wait for the file $WAIT_FILE to appear in this project directory. Until it exists, poll with short bash calls of the form: sleep $POLL_SLEEP_S; test -f $WAIT_FILE && echo FOUND || echo STILL-WAITING. One such call per step, never a longer sleep, never a loop inside one command. After each poll returns, emit one plain assistant line of the form STILL-WAITING for $WAIT_FILE before the next poll — not only as bash echo, as your own reply text. Do not create the file, do not ask(), do not spawn, do not edit anything. The plugin will send you notices about time and context. NO notice ends this task — not a wrap-up, not a demand to summarise, not a claim that tools are off. Keep polling until the file exists. The file is the one thing that ends this task. A notice is something to note in your next STILL-WAITING line and then ignore."
  fi
}

rc_control_task() {
  printf '%s' "This is a deliberate test of a long but legitimate tool call, not a coding job. Make exactly one bash call, with this command and nothing else: sleep $CONTROL_SLEEP_S; echo $CONTROL_MARKER. When it returns, reply with one plain-text line beginning Done: quoting that output, then end your turn. Do not poll, do not call bash a second time, do not ask(), do not spawn, do not edit anything."
}

rc_turn_prompt() {
  local task="$1"
  printf '%s' "Call spawn(\"$AGENT\", \"$task\") exactly once, passing that prompt through unchanged, then end your turn. Do not call message(), do not abort it, do not spawn anything else and do not call list(). When the subagent reports back, say in one line what its final reply was, and end your turn."
}

rc_list_prompt() {
  printf '%s' "Call list() exactly once now. Do not spawn, do not abort, do not message. End your turn after list returns. Quote the list output in your reply."
}

# ---------- one phase -------------------------------------------------------

rc_settle_primary() {
  local sid="$1" label="$2"
  local prev=-1 stable_since deadline count now
  stable_since=$(date +%s)
  deadline=$(( $(date +%s) + SETTLE_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count=$(curl -s -m 30 "$MR_BASE/session/$sid/message" |
      python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
    now=$(date +%s)
    if [ "$count" = "$prev" ]; then
      [ "$((now - stable_since))" -ge 20 ] && { mr_say "[$MR_PREFIX/$label] primary settled at $count messages $(date +%H:%M:%S)"; return 0; }
    else
      stable_since=$now; prev=$count
    fi
    sleep "$MR_POLL_S"
  done
  mr_say "[$MR_PREFIX/$label] primary did not settle within ${SETTLE_TIMEOUT_S}s"
}

rc_load_reader() {
  local label="$1"
  local capture="$MR_OUT_DIR/$MR_PREFIX.$label-subagent.messages.json"
  local dump="$MR_OUT_DIR/$MR_PREFIX.$label.wrap.txt"
  local analysis="$MR_OUT_DIR/$MR_PREFIX.$label.analysis.txt"
  R_parsed=0; R_tools=0; R_longest_call_ms=0; R_longest_gap_ms=0; R_neither_old=0
  R_wrap_records=0; R_wrap_elapsed_ms=0; R_wrap_at_or_after=0; R_wrap_tool_after=0
  if [ ! -f "$capture" ]; then
    : > "$analysis"
    return 0
  fi
  python3 "$HERE/lib/run-ceiling.py" \
    "$capture" "$REQUEST_LOG" "$P_SUB_SID" "$dump" \
    "$SUB_TOOL_CALL_MS" "$SUB_AGE_MS" "$P_SPAWN_MS" "$WRAP_AT_MS" \
    > "$analysis" 2>/dev/null || : > "$analysis"
  mr_load_kv "$analysis" R_
}

rc_result_file() {
  local handle="$1" sid="$2" f safe dir
  safe=$(printf '%s' "$handle" | sed 's/[^A-Za-z0-9._-]/-/g')
  for dir in "$PROJECT/work" "$HOME/.cache/opencode-agent-intercom/results"; do
    [ -d "$dir" ] || continue
    for f in "$dir"/agent-intercom-result-*; do
      [ -f "$f" ] || continue
      case "$f" in
        *"$handle"*|*"$safe"*|*"$sid"*) printf '%s' "$f"; return 0 ;;
      esac
    done
  done
  printf ''
}

# Usage: rc_drive_phase <label> <kind> <finish_s>
# kind: ignore | honour | control
rc_drive_phase() {
  local label="$1" kind="$2" finish_s="$3"
  local turn_pid deadline code task

  P_LABEL="$label"
  P_SID=""; P_SUB_SID=""; P_SUB_HANDLE=""
  P_SPAWN_MS=0; P_ENDED=""; P_TIMEOUT_LINE=""; P_WRAP_LINE=""
  P_FLAT=""; P_PRIMARY_FLAT=""; P_FINISH_S="$finish_s"

  mr_say "--- phase $label ($kind) ---"
  rc_mark_window

  case "$kind" in
    control) task=$(rc_control_task) ;;
    honour)  task=$(rc_poller_task honour) ;;
    *)       task=$(rc_poller_task ignore) ;;
  esac

  P_SID=$(mr_new_session "$MR_PREFIX-$label")
  [ -n "$P_SID" ] || mr_die "phase $label: the server did not return a session id"
  SESSION_IDS="$SESSION_IDS $P_SID"
  echo "$P_SID" > "$MR_OUT_DIR/$MR_PREFIX.$label.sid"
  mr_say "[$MR_PREFIX/$label] primary=$P_SID start $(date +%H:%M:%S)"

  mr_post_prompt "$P_SID" "$(rc_turn_prompt "$task")" "$MR_OUT_DIR/$MR_PREFIX.$label.turn.json" "$TURN_TIMEOUT_S" &
  turn_pid=$!

  if rc_wait_after "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
    P_SUB_SID=$(mr_log_field "$RC_LINE" sessionID)
    P_SUB_HANDLE=$(mr_log_field "$RC_LINE" handle)
    P_SPAWN_MS=$(rc_now_ms)
    RC_HANDLES="$RC_HANDLES $P_SUB_HANDLE"
    mr_say "[$MR_PREFIX/$label] subagent=$P_SUB_HANDLE session=$P_SUB_SID spawn_ms=$P_SPAWN_MS $(date +%H:%M:%S)"
  else
    mr_say "[$MR_PREFIX/$label] no subagent was spawned: $RC_REASON"
    wait "$turn_pid" 2>/dev/null
    P_PRIMARY_FLAT=$(mr_capture "$P_SID" "$label-primary")
    return 0
  fi

  deadline=$(( $(date +%s) + finish_s ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    mr_capture "$P_SUB_SID" "$label-subagent" > /dev/null
    mr_refresh_slice
    [ -n "$P_TIMEOUT_LINE" ] || P_TIMEOUT_LINE=$(rc_match_after "subagent timed out .*\"sessionID\":\"$P_SUB_SID\"")
    [ -n "$P_WRAP_LINE" ] || P_WRAP_LINE=$(rc_match_after "subagent entering run wrap-up band .*\"handle\":\"$P_SUB_HANDLE\"")
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
    mr_say "[$MR_PREFIX/$label] subagent neither ended nor was notified within ${finish_s}s — its captures may be short of its last step"
  fi

  wait "$turn_pid" 2>/dev/null
  rc_settle_primary "$P_SID" "$label"
  P_PRIMARY_FLAT=$(mr_capture "$P_SID" "$label-primary")
  P_FLAT="$MR_OUT_DIR/$MR_PREFIX.$label-subagent.transcript.txt"
  [ -n "$P_TIMEOUT_LINE" ] || P_TIMEOUT_LINE=$(rc_match_after "subagent timed out .*\"sessionID\":\"$P_SUB_SID\"")
  [ -n "$P_WRAP_LINE" ] || P_WRAP_LINE=$(rc_match_after "subagent entering run wrap-up band .*\"handle\":\"$P_SUB_HANDLE\"")
  rc_load_reader "$label"
  mr_say "[$MR_PREFIX/$label] reader parsed=${R_parsed:-0} tools=${R_tools:-0} longest_call=${R_longest_call_ms:-0} longest_gap=${R_longest_gap_ms:-0} neither_old=${R_neither_old:-0} wrap_records=${R_wrap_records:-0} wrap_elapsed=${R_wrap_elapsed_ms:-0} wrap_at_or_after=${R_wrap_at_or_after:-0} wrap_tool_after=${R_wrap_tool_after:-0}"
  mr_say ""
}

# ---------- phase 1: the poller ---------------------------------------------

rc_drive_phase poller ignore "$FINISH_TIMEOUT_S"

if [ -z "$P_SUB_SID" ]; then
  mr_record "neither-old (poller) — neither existing window could have fired" 0 \
    "no subagent was spawned, so there are no tool times to read"
  mr_note_uncovered "warned (poller) / reaped (poller) / rescued (poller) / slot (poller)" \
    "no subagent was spawned in the poller phase"
else
  if [ "${R_neither_old:-0}" = 1 ]; then
    mr_record "neither-old (poller) — neither existing window could have fired" 1 \
      "tools=${R_tools} longest_call_ms=${R_longest_call_ms} < maxSubagentToolCallMs=$SUB_TOOL_CALL_MS, longest_gap_ms=${R_longest_gap_ms} < maxSubagentAgeMs=$SUB_AGE_MS (opencode state.time.start/end, not the plugin)"
  else
    mr_record "neither-old (poller) — neither existing window could have fired" 0 \
      "tools=${R_tools:-0} longest_call_ms=${R_longest_call_ms:-0} longest_gap_ms=${R_longest_gap_ms:-0} against maxSubagentToolCallMs=$SUB_TOOL_CALL_MS maxSubagentAgeMs=$SUB_AGE_MS — need >=2 calls, each under the in-tool window, gaps under the silence window"
  fi

  WRAP_ELAPSED_LOG=$(mr_log_field "$P_WRAP_LINE" elapsedMs)
  DENIED=$(grep -cE -- "denied tool call .*\"handle\":\"$P_SUB_HANDLE\"" "$MR_SLICE_FILE" 2>/dev/null || true)
  if [ "${R_wrap_records:-0}" -ge 1 ] && [ "${R_wrap_at_or_after:-0}" = 1 ] && [ "${R_wrap_tool_after:-0}" = 1 ] && [ "${DENIED:-0}" = 0 ]; then
    mr_record "warned (poller) — the wrap-up band reached the provider and nothing was denied" 1 \
      "wrap_records=${R_wrap_records} wrap_elapsed_ms=${R_wrap_elapsed_ms} (plugin elapsedMs=${WRAP_ELAPSED_LOG:-none}) wrap_at=${WRAP_AT_MS} wrap_tool_after=${R_wrap_tool_after} denied=$DENIED; log: ${P_WRAP_LINE:-no wrap-up log line}"
  elif [ "${R_wrap_records:-0}" -ge 1 ] && [ "${WRAP_ELAPSED_LOG:-0}" -ge "$WRAP_AT_MS" ] 2>/dev/null && [ "${R_wrap_tool_after:-0}" = 1 ] && [ "${DENIED:-0}" = 0 ]; then
    mr_record "warned (poller) — the wrap-up band reached the provider and nothing was denied" 1 \
      "request-log wrap_records=${R_wrap_records} wrap_elapsed_ms=${R_wrap_elapsed_ms} (reader at-or-after=${R_wrap_at_or_after}); plugin elapsedMs=$WRAP_ELAPSED_LOG >= wrap_at=$WRAP_AT_MS; wrap_tool_after=${R_wrap_tool_after} denied=$DENIED"
  else
    mr_record "warned (poller) — the wrap-up band reached the provider and nothing was denied" 0 \
      "wrap_records=${R_wrap_records:-0} wrap_elapsed_ms=${R_wrap_elapsed_ms:-0} wrap_at_or_after=${R_wrap_at_or_after:-0} wrap_tool_after=${R_wrap_tool_after:-0} plugin_elapsed=${WRAP_ELAPSED_LOG:-none} denied=${DENIED:-0} wrap_at=$WRAP_AT_MS — ${P_WRAP_LINE:-no wrap-up log line}"
  fi

  TIMEOUT_NOTICE=$(mr_first_in "$P_PRIMARY_FLAT" "$TIMEOUT_CAUSE")
  TIMEOUT_SETTING_HIT=$(mr_count_in "$P_PRIMARY_FLAT" "$TIMEOUT_SETTING")
  TIMEOUT_KIND=$(mr_log_field "$P_TIMEOUT_LINE" limit)
  TIMEOUT_SETTING_LOG=$(mr_log_field "$P_TIMEOUT_LINE" setting)
  if [ -n "$TIMEOUT_NOTICE" ] && [ "${TIMEOUT_SETTING_HIT:-0}" -ge 1 ] && [ "$TIMEOUT_KIND" = run ]; then
    mr_record "reaped (poller) — the primary was told the run ceiling cut the subagent off" 1 \
      "primary transcript carries \"$TIMEOUT_CAUSE\" and \"$TIMEOUT_SETTING\"; plugin log limit=$TIMEOUT_KIND setting=$TIMEOUT_SETTING_LOG — ${P_TIMEOUT_LINE:-(notice only)}"
  else
    mr_record "reaped (poller) — the primary was told the run ceiling cut the subagent off" 0 \
      "timeout_notice=$( [ -n "$TIMEOUT_NOTICE" ] && echo yes || echo no ) setting_hits=${TIMEOUT_SETTING_HIT:-0} log_kind=${TIMEOUT_KIND:-none} log_setting=${TIMEOUT_SETTING_LOG:-none} ended=${P_ENDED:-still running} — see $P_PRIMARY_FLAT"
  fi

  RESULT_FILE=$(rc_result_file "$P_SUB_HANDLE" "$P_SUB_SID")
  RESCUED_HIT=$(mr_count_in "$P_PRIMARY_FLAT" "$RESCUED_MARKER")
  USABLE=$(rc_usable_assistant "$MR_OUT_DIR/$MR_PREFIX.poller-subagent.messages.json")
  SECURED_LINE=$(rc_match_after "subagent state secured .*\"sessionID\":\"$P_SUB_SID\"")
  SESSION_GONE=0
  case "$P_ENDED" in
    *"session is gone"*) SESSION_GONE=1 ;;
  esac
  rc_rescued_decide
  mr_record "rescued (poller) — the snapshot was secured" "$RC_RESCUED_OK" \
    "$RC_RESCUED_EVIDENCE"

  mr_say "[$MR_PREFIX/poller] posting list() $(date +%H:%M:%S)"
  mr_post_prompt "$P_SID" "$(rc_list_prompt)" "$MR_OUT_DIR/$MR_PREFIX.poller-list.json" "$TURN_TIMEOUT_S"
  rc_settle_primary "$P_SID" "poller-list"
  P_PRIMARY_FLAT=$(mr_capture "$P_SID" "poller-primary")
  LIST_HIT=$(mr_count_in "$P_PRIMARY_FLAT" "$LIST_EMPTY")
  if [ "${LIST_HIT:-0}" -ge 1 ]; then
    mr_record "slot (poller) — list() shows no running subagent" 1 \
      "primary transcript after list() carries \"$LIST_EMPTY\""
  else
    mr_record "slot (poller) — list() shows no running subagent" 0 \
      "no \"$LIST_EMPTY\" in the primary transcript after the list() turn — $(mr_first_in "$P_PRIMARY_FLAT" "list" || true)"
  fi
fi

# ---------- phase 2: the control --------------------------------------------

rc_drive_phase control control "$CONTROL_FINISH_S"

if [ -z "$P_SUB_SID" ]; then
  mr_record "finished (control) — a single long call under the ceiling is left alone" 0 \
    "no subagent was spawned in the control phase"
  mr_note_uncovered "no-timeout (control) / no-wrap-up (control)" \
    "no subagent was spawned in the control phase"
else
  CONTROL_HIT=$(mr_count_in "$P_FLAT" "$CONTROL_MARKER")
  if [ -n "$P_ENDED" ] && [ -z "$P_TIMEOUT_LINE" ] && [ "${CONTROL_HIT:-0}" -ge 1 ] \
     && [ "${R_longest_call_ms:-0}" -ge "$CONTROL_SLEEP_MS" ] 2>/dev/null \
     && [ "${R_longest_call_ms:-0}" -lt "$SUB_TOOL_CALL_MS" ] 2>/dev/null; then
    mr_record "finished (control) — a single long call under the ceiling is left alone" 1 \
      "subagent ended ($P_ENDED) with $CONTROL_MARKER in its transcript and no timed-out log line; longest_call_ms=${R_longest_call_ms:-0} in [$CONTROL_SLEEP_MS, $SUB_TOOL_CALL_MS)"
  else
    mr_record "finished (control) — a single long call under the ceiling is left alone" 0 \
      "ended=${P_ENDED:-still running} timeout_log=$( [ -n "$P_TIMEOUT_LINE" ] && echo yes || echo no ) CONTROL_MARKER hits=${CONTROL_HIT:-0} longest_call_ms=${R_longest_call_ms:-0} need in [$CONTROL_SLEEP_MS, $SUB_TOOL_CALL_MS) — ${P_TIMEOUT_LINE:-see $P_FLAT}"
  fi

  CONTROL_NOTICE=$(mr_first_in "$P_PRIMARY_FLAT" "$TIMEOUT_CAUSE")
  if [ -z "$P_TIMEOUT_LINE" ] && [ -z "$CONTROL_NOTICE" ]; then
    mr_record "no-timeout (control) — no run-ceiling notice reached the primary" 1 \
      "no \"subagent timed out\" line for $P_SUB_SID and no \"$TIMEOUT_CAUSE\" in the primary transcript"
  else
    mr_record "no-timeout (control) — no run-ceiling notice reached the primary" 0 \
      "timeout_log=${P_TIMEOUT_LINE:-none} notice=${CONTROL_NOTICE:-none}"
  fi

  if [ "${R_wrap_records:-0}" = 0 ] && [ -z "$P_WRAP_LINE" ]; then
    mr_record "no-wrap-up (control) — the wrap-up band did not fire under a 120s call" 1 \
      "wrap_records=0 and no wrap-up log line for $P_SUB_HANDLE (control sleep ${CONTROL_SLEEP_S}s, wrap-up at ${WRAP_AT_MS}ms)"
  else
    mr_record "no-wrap-up (control) — the wrap-up band did not fire under a 120s call" 0 \
      "wrap_records=${R_wrap_records:-0} wrap_elapsed_ms=${R_wrap_elapsed_ms:-0} log: ${P_WRAP_LINE:-none}"
  fi
fi

# ---------- phase 3: the ladder without a kill ------------------------------

rc_drive_phase handback honour "$FINISH_TIMEOUT_S"

if [ -z "$P_SUB_SID" ]; then
  mr_note_uncovered "handed-back (handback) — the wrap-up band produced a Blocked: and no reap" \
    "no subagent was spawned in the handback phase"
else
  BLOCKED_HIT=$(mr_count_in "$P_FLAT" "Blocked:")
  WAIT_NAMED=$(mr_count_in "$P_FLAT" "$WAIT_FILE")
  HANDBACK_NOTICE=$(mr_first_in "$P_PRIMARY_FLAT" "$TIMEOUT_CAUSE")
  HANDBACK_KIND=$(mr_log_field "$P_TIMEOUT_LINE" limit)
  if [ -n "$P_TIMEOUT_LINE" ] || [ -n "$HANDBACK_NOTICE" ] || [ "$HANDBACK_KIND" = run ]; then
    mr_note_uncovered "handed-back (handback) — the wrap-up band produced a Blocked: and no reap" \
      "the model did not hand back before the ceiling: timeout_log=${P_TIMEOUT_LINE:-none} notice=$( [ -n "$HANDBACK_NOTICE" ] && echo yes || echo no ) kind=${HANDBACK_KIND:-none} Blocked: hits=${BLOCKED_HIT:-0} — recorded NOT ASSERTED rather than failed"
  elif [ "${BLOCKED_HIT:-0}" -ge 1 ] && [ "${WAIT_NAMED:-0}" -ge 1 ] && [ -n "$P_ENDED" ]; then
    mr_record "handed-back (handback) — the wrap-up band produced a Blocked: and no reap" 1 \
      "subagent transcript carries Blocked: naming $WAIT_FILE; no run-ceiling timeout; ended: $P_ENDED; wrap_records=${R_wrap_records:-0}"
  else
    mr_note_uncovered "handed-back (handback) — the wrap-up band produced a Blocked: and no reap" \
      "the band was not honoured with a Blocked: naming $WAIT_FILE (Blocked: hits=${BLOCKED_HIT:-0} wait-file hits=${WAIT_NAMED:-0} ended=${P_ENDED:-still running} wrap_records=${R_wrap_records:-0}) — recorded NOT ASSERTED rather than failed"
  fi
fi

mr_model_audit

mr_verdict
