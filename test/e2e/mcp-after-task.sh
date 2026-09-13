#!/bin/bash
# Does opencode fire `tool.execute.after` for MCP tools?
#
# The plugin's watchdog takes a call out of `entry.toolCalls` only on
# `tool.execute.after` (`recordToolCallFinished`, src/hooks.js). If opencode
# never sends that event for an MCP-registered tool, a subagent whose work is
# that call keeps the wide tool-call window instead of the silence one. This
# driver is the live measurement: a local stdio MCP server with one tool
# `ping` → `pong`, a subagent told to call it, and the plugin's request log
# as the evidence. No network.
#
# Verdicts, recorded as `VERDICT <name>`:
#
#   FIRES           at least one JSONL record with type=tool.execute.after
#                   whose `tool` is the MCP ping
#   DOES_NOT_FIRE   the ping was invoked (a `tool.execute.before` record or a
#                   messages tool-part) and after wrote nothing
#   TOOL_NOT_SEEN   this session never invoked the ping — distinct, not a
#                   silent skip; the hook question cannot be decided
#
# FIRES and DOES_NOT_FIRE both pass the after-hook criterion: they are answers.
# TOOL_NOT_SEEN fails `mcp tool invoked` and leaves the after criterion
# NOT ASSERTED.
#
# THIS DRIVER OWNS ITS SERVER, like `context-bands-task.sh`. It builds a
# throwaway HOME (`e2e_iso_create`), patches MCP into THAT isolated
# opencode.json only (the machine's ~/.config/opencode is not written), starts
# `opencode serve` on its own port with OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1
# into its own out file, and removes all of it again.
#
# Usage:
#   bash test/e2e/mcp-after-task.sh
#
# Env (all with defaults):
#   PROJECT_DIR            $HOME/testopencode
#   OUT_DIR                ./out
#   E2E_MODEL              openai/gpt-5.6-luna
#   MCP_AFTER_PORT         4608   own port, clear of run-all's 4567,
#                          ask-expiry's 4588, endless' 4599, nested's 4602,
#                          context-bands' 4606
#   MCP_AGENT              coder  the role that is driven; MCP tools are
#                          granted by absence of a deny (src/agents.js)
#   SUB_AGE_MS             300000
#   SUB_TOOL_CALL_MS       300000
#   SPAWN_TIMEOUT_S        240
#   FINISH_TIMEOUT_S       420
#   TURN_TIMEOUT_S         900
#   SETTLE_TIMEOUT_S       240
#   SERVER_START_TIMEOUT_S 60
#   MIDRUN_POLL_S          2
#   KEEP_SERVER            0
#   E2E_TUI_BUILT          0
#
# Exit codes:
#   0  every asserted criterion passed (the verdict was decided)
#   1  at least one criterion failed (TOOL_NOT_SEEN, or the model pin)
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, node, setsid, npm, an `opencode` on PATH, a
# provider serving E2E_MODEL configured in the machine's opencode.json, and
# the plugin's debug log switched on.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

PREFIX=18-mcp-after
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)
MCP_SERVER="$HERE/lib/mcp-ping-server.js"

. "$HERE/server-lifecycle.sh"
. "$HERE/lib/midrun-common.sh"

AGENT=${MCP_AGENT:-coder}
PORT=${MCP_AFTER_PORT:-4608}
SUB_AGE_MS=${SUB_AGE_MS:-300000}
SUB_TOOL_CALL_MS=${SUB_TOOL_CALL_MS:-300000}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-240}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-420}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-240}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
KEEP_SERVER=${KEEP_SERVER:-0}

SESSION_IDS=""
SERVER_VERSION="(unknown)"
SID=""
SUB_SID=""
SUB_HANDLE=""
SUB_ENDED=""
REQUEST_LOG=""
ISO_OPENCODE_JSON=""

# ---------- preflight -------------------------------------------------------

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"

for tool in curl python3 node setsid npm; do
  command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
done
command -v opencode >/dev/null || mr_die "opencode is not on PATH — this driver starts a server of its own"
[ -f "$MCP_SERVER" ] || mr_die "MCP ping server is missing: $MCP_SERVER"

# ---------- the isolated configuration and the server -----------------------

PROJECT=${PROJECT_DIR:-$HOME/testopencode}
BASE=$(e2e_server_url "$PORT")
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || mr_die "cannot create $OUT_PRE"
OUT_PRE=$(cd "$OUT_PRE" && pwd)
REQUEST_LOG="$OUT_PRE/$PREFIX.requests.jsonl"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  mr_die "something already answers on $BASE — stop it, or set MCP_AFTER_PORT to a free port"
fi

e2e_iso_create "$PLUGIN_ROOT" \
  "$(printf '{"maxSubagents":8,"maxContext":130000,"compaction":false,"endlessMode":false,"agentMode":"orchestrator","midRunMessaging":true,"maxSubagentAgeMs":%s,"maxSubagentToolCallMs":%s}' \
    "$SUB_AGE_MS" "$SUB_TOOL_CALL_MS")" ||
  mr_die "could not build the isolated opencode configuration"
SETTINGS_FILE="$E2E_ISO_SETTINGS_FILE"
ISO_OPENCODE_JSON="$E2E_ISO_OPENCODE_DIR/opencode.json"

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
  e2e_iso_remove
  [ -n "$MR_REPORT_FILE" ] && mr_say "report:      $MR_REPORT_FILE"
  [ -n "$MR_OUT_DIR" ] && mr_say "captures:    $MR_OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ -n "$REQUEST_LOG" ] && mr_say "requests:    $REQUEST_LOG"
  [ -n "$MR_SLICE_FILE" ] && mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Patch MCP into the isolated opencode.json only. The whole `mcp` object is
# replaced so a server carried over from the machine cannot pull this run onto
# the network. e2e_iso_create itself is not changed.
python3 - "$ISO_OPENCODE_JSON" "$MCP_SERVER" <<'PY' || mr_die "could not patch MCP into the isolated opencode.json"
import json, sys

path, server = sys.argv[1], sys.argv[2]
with open(path) as handle:
    cfg = json.load(handle)
if not isinstance(cfg, dict):
    raise SystemExit("isolated opencode.json is not an object")
cfg["mcp"] = {
    "e2eping": {
        "type": "local",
        "command": ["node", server],
        "enabled": True,
    }
}
with open(path, "w") as handle:
    json.dump(cfg, handle, indent=2)
    handle.write("\n")
PY

python3 - "$ISO_OPENCODE_JSON" "$MCP_SERVER" <<'PY' || mr_die "isolated opencode.json does not carry the e2eping MCP server after the patch"
import json, sys

path, server = sys.argv[1], sys.argv[2]
with open(path) as handle:
    cfg = json.load(handle)
entry = (cfg.get("mcp") or {}).get("e2eping") or {}
cmd = entry.get("command") or []
if entry.get("type") != "local" or cmd[-1:] != [server] or cmd[:1] != ["node"]:
    raise SystemExit(f"unexpected mcp.e2eping: {entry!r}")
PY

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
mr_check_settings

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
mcp server          $MCP_SERVER   (patched into isolated opencode.json as mcp.e2eping, type=local)
watchdog windows    maxSubagentAgeMs=$SUB_AGE_MS maxSubagentToolCallMs=$SUB_TOOL_CALL_MS
request log         $REQUEST_LOG   (OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1 for this server alone)
resolved settings   midRunMessaging=$MR_MID_RUN maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
timeouts            spawn=${SPAWN_TIMEOUT_S}s finish=${FINISH_TIMEOUT_S}s turn=${TURN_TIMEOUT_S}s settle=${SETTLE_TIMEOUT_S}s poll=${MR_POLL_S}s
debug log           $MR_DEBUG_LOG   (read from byte $MR_LOG_OFFSET)
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- the run ---------------------------------------------------------

mcp_sub_task() {
  printf '%s' "This is a deliberate test of an MCP tool, not a coding job. You have a local MCP server named e2eping that registers one tool, ping — opencode may show it as ping, e2eping_ping, or mcp_e2eping_ping. Call THAT tool exactly once, with no arguments. Do not call bash, do not spawn, do not read or edit any file, do not search the web. When the tool returns, reply with one plain-text line beginning with MCP-PING-PONG and quoting the returned text, then end your turn. If no such tool is in your tool list at all, call nothing and reply with one plain-text line MCP-PING-MISSING."
}

mcp_turn_prompt() {
  printf '%s' "Call spawn(\"$AGENT\", \"$(mcp_sub_task)\") exactly once, passing that prompt through unchanged, then end your turn. Do not call message(), do not abort it, do not spawn anything else and do not call list(). When the subagent reports back, say in one line what its final reply was, and end your turn."
}

SID=$(mr_new_session "$MR_PREFIX")
[ -n "$SID" ] || mr_die "the server did not return a session id"
SESSION_IDS="$SESSION_IDS $SID"
echo "$SID" > "$MR_OUT_DIR/$MR_PREFIX.sid"
mr_say "[$MR_PREFIX] primary=$SID start $(date +%H:%M:%S)"

mr_post_prompt "$SID" "$(mcp_turn_prompt)" "$MR_OUT_DIR/$MR_PREFIX.turn.json" "$TURN_TIMEOUT_S" &
TURN_PID=$!

if mr_wait_for_pattern "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
  SUB_SID=$(mr_log_field "$MR_WAIT_LINE" sessionID)
  SUB_HANDLE=$(mr_log_field "$MR_WAIT_LINE" handle)
  mr_say "[$MR_PREFIX] subagent=$SUB_HANDLE session=$SUB_SID $(date +%H:%M:%S)"
else
  wait "$TURN_PID" 2>/dev/null
  mr_capture "$SID" "primary" > /dev/null
  mr_die "no subagent was spawned: $MR_WAIT_REASON"
fi

DEADLINE=$(( $(date +%s) + FINISH_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  mr_capture "$SUB_SID" "subagent" > /dev/null
  mr_refresh_slice
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/session/$SUB_SID" 2>/dev/null)
  if [ "$code" != 200 ]; then
    SUB_ENDED="its session is gone (HTTP $code)"
    break
  fi
  if grep -qE -- "notified primary of completion .*\"parentID\":\"$SID\"" "$MR_SLICE_FILE"; then
    sleep "$MR_POLL_S"
    mr_capture "$SUB_SID" "subagent" > /dev/null
    SUB_ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
    break
  fi
  sleep "$MR_POLL_S"
done
if [ -n "$SUB_ENDED" ]; then
  mr_say "[$MR_PREFIX] subagent ended: $SUB_ENDED $(date +%H:%M:%S)"
else
  mr_say "[$MR_PREFIX] subagent neither ended nor was notified within ${FINISH_TIMEOUT_S}s — its captures may be short of its last step"
fi

wait "$TURN_PID" 2>/dev/null

PREV=-1; STABLE_SINCE=$(date +%s)
DEADLINE=$(( $(date +%s) + SETTLE_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  count=$(curl -s -m 30 "$BASE/session/$SID/message" |
    python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
  now=$(date +%s)
  if [ "$count" = "$PREV" ]; then
    [ "$((now - STABLE_SINCE))" -ge 20 ] && { mr_say "[$MR_PREFIX] primary settled at $count messages $(date +%H:%M:%S)"; break; }
  else
    STABLE_SINCE=$now; PREV=$count
  fi
  sleep "$MR_POLL_S"
done
PRIMARY_FLAT=$(mr_capture "$SID" "primary")
SUB_FLAT="$MR_OUT_DIR/$MR_PREFIX.subagent.transcript.txt"
mr_refresh_slice

# ---------- the evidence ----------------------------------------------------

ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
R_parsed=0; R_before_count=0; R_after_count=0
R_before_tool=""; R_after_tool=""; R_part_count=0; R_part_tool=""
R_invoked=0; R_verdict=TOOL_NOT_SEEN
python3 "$HERE/lib/mcp-after.py" "$REQUEST_LOG" "$SUB_SID" > "$ANALYSIS" 2>/dev/null || : > "$ANALYSIS"
mr_load_kv "$ANALYSIS" R_

MISSING=$(mr_count_in "$SUB_FLAT" "MCP-PING-MISSING")
PONG=$(mr_count_in "$SUB_FLAT" "MCP-PING-PONG")

mr_say ""
mr_say "[$MR_PREFIX] request-log verdict=${R_verdict:-TOOL_NOT_SEEN} before=${R_before_count:-0} after=${R_after_count:-0} parts=${R_part_count:-0} invoked=${R_invoked:-0}"
mr_say ""

# ---------- the criteria ----------------------------------------------------

if [ "${R_invoked:-0}" = 1 ]; then
  mr_record "mcp tool invoked" 1 \
    "session $SUB_SID called the e2eping ping: before=${R_before_count:-0} (${R_before_tool:-none}) after=${R_after_count:-0} (${R_after_tool:-none}) messages-parts=${R_part_count:-0} (${R_part_tool:-none})"
else
  mr_record "mcp tool invoked" 0 \
    "session $SUB_SID never invoked the e2eping ping (before=0 after=0 parts=0); subagent MCP-PING-MISSING=$MISSING MCP-PING-PONG=$PONG — TOOL_NOT_SEEN, the after-hook question cannot be decided"
fi

if [ "${R_invoked:-0}" = 1 ]; then
  if [ "${R_before_count:-0}" -ge 1 ]; then
    mr_record "tool.execute.before for MCP ping" 1 \
      "${R_before_count} record(s) type=tool.execute.before tool=${R_before_tool} sessionID=$SUB_SID"
  else
    mr_record "tool.execute.before for MCP ping" 0 \
      "the ping was invoked (after=${R_after_count:-0} parts=${R_part_count:-0} tool=${R_part_tool:-${R_after_tool:-none}}) but no type=tool.execute.before record for session $SUB_SID"
  fi
else
  mr_note_uncovered "tool.execute.before for MCP ping" \
    "the MCP tool was never seen, so whether before fired cannot be decided"
fi

if [ "${R_verdict:-}" = "FIRES" ] || [ "${R_verdict:-}" = "DOES_NOT_FIRE" ]; then
  mr_record "tool.execute.after for MCP ping" 1 \
    "${R_verdict} — type=tool.execute.after count=${R_after_count:-0} tool=${R_after_tool:-none}; before=${R_before_count:-0} tool=${R_before_tool:-none} (the field that decides it is type, matched with tool against e2eping/ping)"
else
  mr_note_uncovered "tool.execute.after for MCP ping" \
    "TOOL_NOT_SEEN: session $SUB_SID never invoked the ping, so whether after fires cannot be decided"
fi

printf 'VERDICT %s\n' "${R_verdict:-TOOL_NOT_SEEN}" | tee -a "$MR_REPORT_FILE"

mr_note "what the subagent finally replied" \
  "$(mr_first_in "$SUB_FLAT" "MCP-PING-" || mr_first_in "$SUB_FLAT" "Done:" || true)"
mr_note "what the primary was told when it finished" \
  "$(mr_first_in "$PRIMARY_FLAT" "🔔 agent-intercom: your subagent" || true)"

mr_model_audit

mr_verdict
