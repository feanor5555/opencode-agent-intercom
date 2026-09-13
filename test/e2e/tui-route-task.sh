#!/bin/bash
# Server-scoped (and owning-panel) pre-delete route move, live against
# `opencode serve`.
#
# Three Node writers publish into the shared
# `~/.cache/opencode-agent-intercom/tui-route.json` the panel and the plugin
# already use. A is the owning primary on this server, C is an observer on
# the same server (start order, not a written hint), B names a different
# server and the same dying session. The orchestrator then `abort`s the
# parked subagent, which is the live path through `deleteSession` →
# `escapeTuiRouteOffSession`. The plugin posts once because that owning
# same-server primary is on the dying session; foreign writers are not a
# reason to post. One `tui route escape before delete` whose `target` is
# the parent, a `tui route scope` of mine=1 / observers=1 with B among
# foreign. Writers do not consume the post, so TUI navigation is not
# observed.
#
# Sequenced by `run-all.sh` on the suite server (OPENCODE_URL already healthy).
# Started on its own it owns a server, through `config-isolation.sh` and
# `server-lifecycle.sh`, the same way `mcp-after-task.sh` does.
#
# Usage:
#   bash test/e2e/tui-route-task.sh
#   OPENCODE_URL=http://127.0.0.1:4567 bash test/e2e/tui-route-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL           inherit when it already answers; else this driver
#                          starts a server of its own
#   PROJECT_DIR            $HOME/testopencode
#   OUT_DIR                ./out
#   E2E_MODEL              openai/gpt-5.6-luna
#   TUI_ROUTE_PORT         4610   own port when this driver starts the server
#   TUI_ROUTE_OWN_SERVER   0      1 forces a server of its own even if
#                          OPENCODE_URL already answers
#   TUI_ROUTE_AGENT        debugger
#   TUI_ROUTE_SLEEP_S      90     the parked subagent's sleep, so abort has a
#                          live session to delete
#   TUI_ROUTE_FOREIGN_PORT 4799   identity string only; nothing listens
#   SPAWN_TIMEOUT_S        180
#   ABORT_TIMEOUT_S        180
#   TURN_TIMEOUT_S         900
#   SERVER_START_TIMEOUT_S 60
#   MIDRUN_POLL_S          2
#   KEEP_SERVER            0
#   E2E_TUI_BUILT          0
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# NOT `set -e`: a failed criterion must be reported and cleanup must still run.
set -uo pipefail

PREFIX=19-tui-route
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)
WRITER="$HERE/lib/tui-route-writer.ts"

. "$HERE/server-lifecycle.sh"
. "$HERE/lib/midrun-common.sh"

AGENT=${TUI_ROUTE_AGENT:-debugger}
PORT=${TUI_ROUTE_PORT:-4610}
SLEEP_S=${TUI_ROUTE_SLEEP_S:-90}
FOREIGN_PORT=${TUI_ROUTE_FOREIGN_PORT:-4799}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
ABORT_TIMEOUT_S=${ABORT_TIMEOUT_S:-180}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
KEEP_SERVER=${KEEP_SERVER:-0}

SESSION_IDS=""
SERVER_VERSION="(unknown)"
SID=""
SUB_SID=""
SUB_HANDLE=""
OWN_SERVER=0
WRITER_PIDS=""
WRITER_A=""
WRITER_B=""
WRITER_C=""
ROUTE_FILE="${HOME}/.cache/opencode-agent-intercom/tui-route.json"
CTL_DIR=""
THIS_SERVER=""
FOREIGN_SERVER=""

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"

for tool in curl python3 node setsid npm; do
  command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
done
[ -f "$WRITER" ] || mr_die "route writer is missing: $WRITER"

PROJECT=${PROJECT_DIR:-$HOME/testopencode}
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || mr_die "cannot create $OUT_PRE"
OUT_PRE=$(cd "$OUT_PRE" && pwd)

if [ "${TUI_ROUTE_OWN_SERVER:-0}" = 1 ]; then
  OWN_SERVER=1
elif [ -z "${OPENCODE_URL:-}" ]; then
  OWN_SERVER=1
elif ! curl -fsS -m 3 "$OPENCODE_URL/global/health" >/dev/null 2>&1; then
  OWN_SERVER=1
fi

stop_writers() {
  local p
  if [ -n "${CTL_DIR:-}" ]; then
    mkdir -p "$CTL_DIR" 2>/dev/null || true
    printf '1\n' > "$CTL_DIR/stop" 2>/dev/null || true
  fi
  for p in $WRITER_PIDS; do
    [ -z "$p" ] && continue
    kill -TERM "$p" 2>/dev/null || true
  done
  for p in $WRITER_PIDS; do
    [ -z "$p" ] && continue
    wait "$p" 2>/dev/null || true
  done
  WRITER_PIDS=""
}

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  stop_writers
  # Dead writer pids drop on the next prune-on-read. Do not rewrite the
  # shared file: publishTuiRoute holds tui-route.json.lock, and an unlocked
  # dump would lose a live panel sample that landed between the read and write.
  local s
  for s in $SESSION_IDS; do
    [ -z "$s" ] && continue
    if [ "$OWN_SERVER" = 1 ]; then
      e2e_server_alive || continue
      mr_say "session delete $s -> HTTP $(curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$OPENCODE_URL/session/$s" 2>/dev/null)"
    else
      mr_say "session delete $s -> HTTP $(mr_delete_session "$s")"
    fi
  done
  if [ "$OWN_SERVER" = 1 ]; then
    if [ "$KEEP_SERVER" = 1 ]; then
      mr_say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $OPENCODE_URL"
    else
      e2e_server_stop
    fi
    e2e_iso_remove
  fi
  [ -n "$MR_REPORT_FILE" ] && mr_say "report:      $MR_REPORT_FILE"
  [ -n "$MR_OUT_DIR" ] && mr_say "captures:    $MR_OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ -n "$MR_SLICE_FILE" ] && mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [ "$OWN_SERVER" = 1 ]; then
  command -v opencode >/dev/null || mr_die "opencode is not on PATH — this driver starts a server of its own"
  BASE=$(e2e_server_url "$PORT")
  if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
    mr_die "something already answers on $BASE — stop it, or set TUI_ROUTE_PORT to a free port"
  fi
  e2e_iso_create "$PLUGIN_ROOT" \
    '{"maxSubagents":8,"maxContext":130000,"endlessMode":false,"agentMode":"orchestrator"}' ||
    mr_die "could not build the isolated opencode configuration"
  e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
    mr_die "$PLUGIN_ROOT is wired nowhere the server would read it"
  e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
    mr_die "the TUI half of $PLUGIN_ROOT is wired nowhere the TUI would read it"
  e2e_build_tui "$PLUGIN_ROOT" || mr_die "the TUI build failed — see the npm output above"
  mr_debug_start
  export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1
  export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE="${OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE:-$OUT_PRE/$PREFIX.requests.jsonl}"
  : > "$OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE"
  e2e_server_start "$PORT" "$PROJECT" "$OUT_PRE/$PREFIX.server.log" "$OUT_PRE/$PREFIX.serverpid" ||
    mr_die "could not start opencode on $BASE — see $OUT_PRE/$PREFIX.server.log"
  unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS
  e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_PRE/$PREFIX.health.json" ||
    mr_die "opencode on $BASE did not become ready — see $OUT_PRE/$PREFIX.server.log"
  SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$OUT_PRE/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")
  OPENCODE_URL="$BASE"
  export OPENCODE_URL
  LOG_OFFSET_KEPT=$MR_LOG_OFFSET
  mr_init "$PREFIX"
  MR_LOG_OFFSET=$LOG_OFFSET_KEPT
else
  mr_init "$PREFIX"
  mr_debug_start
  SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$MR_OUT_DIR/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")
fi

mr_check_settings skip-midrun

THIS_SERVER="url:${MR_BASE}"
FOREIGN_SERVER="url:http://127.0.0.1:${FOREIGN_PORT}"
[ "$FOREIGN_SERVER" != "$THIS_SERVER" ] ||
  mr_die "TUI_ROUTE_FOREIGN_PORT names this server ($THIS_SERVER) — pick a different identity"
CTL_DIR="$MR_OUT_DIR/$PREFIX.writers"
rm -rf "$CTL_DIR"
mkdir -p "$CTL_DIR" || mr_die "cannot create $CTL_DIR"

# A leftover live primary on this serve would make A publish as observer.
refuse_live_primary() {
  python3 - "$ROUTE_FILE" "$THIS_SERVER" <<'PY'
import json, os, sys

path, server = sys.argv[1], sys.argv[2]
try:
    with open(path) as handle:
        raw = json.load(handle)
except Exception:
    sys.exit(0)
if not isinstance(raw, dict):
    sys.exit(0)


def alive(pid):
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


claimants = []
for key, value in raw.items():
    try:
        pid = int(key)
    except (TypeError, ValueError):
        continue
    if not isinstance(value, dict) or not alive(pid):
        continue
    if value.get("server") != server:
        continue
    if value.get("panel") != "observer":
        claimants.append(str(pid))
if claimants:
    print(" ".join(claimants))
    sys.exit(1)
PY
}

CLAIMANTS=$(refuse_live_primary) ||
  mr_die "live writer(s) ${CLAIMANTS:-?} already claim $THIS_SERVER as primary — stop them or pick another serve"

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
project dir         $MR_PROJECT_DIR
server              $MR_BASE   ($([ "$OWN_SERVER" = 1 ] && echo "owned by this driver" || echo "not owned by this driver"))
opencode version    $SERVER_VERSION
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
driven role         $AGENT
this server         $THIS_SERVER
foreign server      $FOREIGN_SERVER   (identity only)
route file          $ROUTE_FILE
writer              $WRITER
sleep               ${SLEEP_S}s
timeouts            spawn=${SPAWN_TIMEOUT_S}s abort=${ABORT_TIMEOUT_S}s turn=${TURN_TIMEOUT_S}s poll=${MR_POLL_S}s
debug log           $MR_DEBUG_LOG   (read from byte $MR_LOG_OFFSET)
out dir             $MR_OUT_DIR
EOF
mr_say ""

wait_ready() {
  local label="$1" timeout="$2"
  local deadline=$(( $(date +%s) + timeout ))
  while [ ! -f "$CTL_DIR/${label}.ready" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.1
  done
  return 0
}

# Started in this shell, never in a command substitution: the writer is a
# background job whose pid has to survive the call.
start_writer() {
  local label="$1" server="$2" panel="$3"
  local pid reported
  node "$WRITER" "$server" "$panel" "$SUB_SID" "$CTL_DIR" "$label" \
    > "$MR_OUT_DIR/$PREFIX.$label.stdout" 2> "$MR_OUT_DIR/$PREFIX.$label.stderr" &
  pid=$!
  WRITER_PIDS="$WRITER_PIDS $pid"
  wait_ready "$label" 10 || mr_die "writer $label (pid $pid) did not publish within 10s — stderr: $(tr '\n' ' ' < "$MR_OUT_DIR/$PREFIX.$label.stderr" 2>/dev/null)"
  reported=$(tr -d ' \n' < "$CTL_DIR/${label}.ready")
  [ "$reported" = "$pid" ] || mr_die "writer $label ready pid $reported does not match spawn pid $pid"
  case "$label" in
    A) WRITER_A=$pid ;;
    B) WRITER_B=$pid ;;
    C) WRITER_C=$pid ;;
  esac
}

poke_writer() {
  local label="$1"
  rm -f "$CTL_DIR/${label}.after.json"
  printf '1\n' > "$CTL_DIR/${label}.republish"
  local deadline=$(( $(date +%s) + 5 ))
  while [ ! -f "$CTL_DIR/${label}.after.json" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi
    sleep 0.05
  done
  return 0
}

json_field() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || printf ''
import json, sys
path, key = sys.argv[1], sys.argv[2]
with open(path) as handle:
    raw = json.load(handle)
print(raw.get(key, ""))
PY
}

copy_route() {
  local dest="$1"
  if [ -f "$ROUTE_FILE" ]; then
    cp "$ROUTE_FILE" "$dest"
  else
    printf '{}\n' > "$dest"
  fi
}

# Split the copied file the way `routesOnThisServer` does: this server's
# owning primary is mine, other same-server live writers are observers,
# every other named server is foreign. Missing keys come back as "".
classify_snapshot() {
  local dest="$1"
  python3 - "$MR_OUT_DIR/$PREFIX.route.before.json" "$THIS_SERVER" \
    "$WRITER_A" "$WRITER_B" "$WRITER_C" "$SUB_SID" "$dest" <<'PY'
import json, sys

path, server, pid_a, pid_b, pid_c, session, dest = sys.argv[1:]
try:
    with open(path) as handle:
        raw = json.load(handle)
except Exception:
    raw = {}
if not isinstance(raw, dict):
    raw = {}


def entry(pid):
    value = raw.get(str(pid)) if pid else None
    if not isinstance(value, dict):
        return {"present": False, "server": "", "panel": "", "sessionID": "", "bucket": ""}
    panel = value.get("panel")
    panel = panel if panel in ("primary", "observer") else "primary"
    named = value.get("server") if isinstance(value.get("server"), str) and value.get("server") else None
    session_id = value.get("sessionID") if isinstance(value.get("sessionID"), str) else ""
    return {
        "present": True,
        "server": named or "",
        "panel": panel,
        "sessionID": session_id,
        "named_server": named,
    }


def owning_pid(here):
    if not here:
        return None
    primaries = [e for e in here if e["panel"] != "observer"]
    pool = primaries or here
    owner = pool[0]
    for item in pool:
        if item["pid"] < owner["pid"]:
            owner = item
    return owner["pid"]


here = []
foreign_pids = []
unscoped_pids = []
for key, value in raw.items():
    try:
        pid = int(key)
    except (TypeError, ValueError):
        continue
    if not isinstance(value, dict):
        continue
    named = value.get("server") if isinstance(value.get("server"), str) and value.get("server") else None
    panel = value.get("panel")
    panel = panel if panel in ("primary", "observer") else "primary"
    item = {"pid": pid, "panel": panel, "server": named}
    if named is None:
        unscoped_pids.append(pid)
        continue
    if named == server:
        here.append(item)
    else:
        foreign_pids.append(pid)

owner = owning_pid(here)
mine_pids = list(unscoped_pids)
observer_pids = []
if owner is not None:
    mine_pids.append(owner)
for item in here:
    if item["pid"] != owner:
        observer_pids.append(item["pid"])


def bucket_of(pid):
    try:
        n = int(pid)
    except (TypeError, ValueError):
        return ""
    if n in mine_pids:
        return "mine"
    if n in observer_pids:
        return "observer"
    if n in foreign_pids:
        return "foreign"
    return ""


a, b, c = entry(pid_a), entry(pid_b), entry(pid_c)
a["bucket"] = bucket_of(pid_a)
b["bucket"] = bucket_of(pid_b)
c["bucket"] = bucket_of(pid_c)
body = {
    "A": a,
    "B": b,
    "C": c,
    "mine_pids": mine_pids,
    "observer_pids": observer_pids,
    "foreign_pids": foreign_pids,
    "want_session": session,
}
with open(dest, "w") as handle:
    json.dump(body, handle, indent=2)
    handle.write("\n")
PY
}

# ---------- turn 1: spawn a parked subagent ---------------------------------

SUB_TASK="This is a deliberate test of the plugin's TUI route escape, not a diagnosis. Run exactly one shell command: sleep $SLEEP_S; echo ROUTE-E2E-ALIVE . Then reply with that one line and nothing else. Do not shorten the sleep, do not read or write any file, and run no other command."
TURN1="Call spawn(\"$AGENT\", \"$SUB_TASK\") exactly once, passing that prompt through unchanged. That is your entire task for this turn. Do not call list(), do not abort, do not poll, do not spawn anything else. End your turn as soon as spawn returns."

SID=$(mr_new_session "$MR_PREFIX")
[ -n "$SID" ] || mr_die "the server did not return a session id"
SESSION_IDS="$SESSION_IDS $SID"
echo "$SID" > "$MR_OUT_DIR/$PREFIX.sid"
mr_say "[$MR_PREFIX] primary=$SID start $(date +%H:%M:%S)"

mr_post_prompt "$SID" "$TURN1" "$MR_OUT_DIR/$PREFIX.turn1.json" "$TURN_TIMEOUT_S" &
TURN1_PID=$!

if mr_wait_for_pattern "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
  SUB_SID=$(mr_log_field "$MR_WAIT_LINE" sessionID)
  SUB_HANDLE=$(mr_log_field "$MR_WAIT_LINE" handle)
  mr_say "[$MR_PREFIX] subagent=$SUB_HANDLE session=$SUB_SID $(date +%H:%M:%S)"
else
  wait "$TURN1_PID" 2>/dev/null
  mr_capture "$SID" primary > /dev/null
  mr_die "no subagent was spawned: $MR_WAIT_REASON"
fi
SESSION_IDS="$SESSION_IDS $SUB_SID"
echo "$SUB_SID" > "$MR_OUT_DIR/$PREFIX.sub.sid"
mr_capture "$SUB_SID" subagent > /dev/null

# A first (same-server primary), then B (foreign), then C (same-server observer).
# The panel argv is the expected computed role; publishTuiRoute decides it.
start_writer A "$THIS_SERVER" primary
start_writer B "$FOREIGN_SERVER" primary
start_writer C "$THIS_SERVER" observer
mr_say "[$MR_PREFIX] writers A=$WRITER_A B=$WRITER_B C=$WRITER_C $(date +%H:%M:%S)"

copy_route "$MR_OUT_DIR/$PREFIX.route.before.json"
classify_snapshot "$MR_OUT_DIR/$PREFIX.snapshot-scope.json"
wait "$TURN1_PID" 2>/dev/null

# ---------- turn 2: abort, which is the live deleteSession path -------------

TURN2="Call abort(\"$SUB_HANDLE\") exactly once. Do not spawn anything else, do not call list(), do not message it. End your turn as soon as abort returns."
mr_post_prompt "$SID" "$TURN2" "$MR_OUT_DIR/$PREFIX.turn2.json" "$TURN_TIMEOUT_S" &
TURN2_PID=$!

ESCAPE_OK=0
SCOPE_OK=0
if mr_wait_for_pattern "the pre-delete route escape" "tui route escape before delete" "$ABORT_TIMEOUT_S"; then
  ESCAPE_OK=1
  ESCAPE_LINE=$MR_WAIT_LINE
else
  ESCAPE_LINE=""
  ESCAPE_WAIT_REASON=$MR_WAIT_REASON
fi
if grep -qF "tui route scope" "$MR_SLICE_FILE" 2>/dev/null; then
  SCOPE_OK=1
  SCOPE_LINE=$(grep -F "tui route scope" "$MR_SLICE_FILE" | tail -n 1)
else
  # the scope line is written on the same crossing as the escape; give it a moment
  if mr_wait_for_pattern "the route-scope split" "tui route scope" 8; then
    SCOPE_OK=1
    SCOPE_LINE=$MR_WAIT_LINE
  else
    SCOPE_LINE=""
    SCOPE_WAIT_REASON=$MR_WAIT_REASON
  fi
fi

wait "$TURN2_PID" 2>/dev/null
mr_refresh_slice
mr_capture "$SID" primary > /dev/null
copy_route "$MR_OUT_DIR/$PREFIX.route.after-delete.json"

poke_writer A || true
poke_writer B || true
poke_writer C || true
copy_route "$MR_OUT_DIR/$PREFIX.route.after-republish.json"

# ---------- evidence --------------------------------------------------------

python3 - "$MR_SLICE_FILE" "$SUB_SID" "$SID" "$THIS_SERVER" \
  "$MR_OUT_DIR/$PREFIX.escape.json" <<'PY'
import json, sys
slice_path, child, parent, server, dest = sys.argv[1:]

def tails(path, needle):
    out = []
    try:
        with open(path) as handle:
            lines = handle.readlines()
    except FileNotFoundError:
        return out
    for line in lines:
        if needle not in line:
            continue
        i = line.find("{")
        if i < 0:
            continue
        try:
            out.append(json.loads(line[i:]))
        except Exception:
            continue
    return out

try:
    with open(slice_path) as handle:
        text = handle.read()
except FileNotFoundError:
    text = ""

escapes = [e for e in tails(slice_path, "tui route escape before delete") if e.get("sessionID") == child]
scopes = [e for e in tails(slice_path, "tui route scope") if e.get("sessionID") == child]
body = {
    "escape_count": len(escapes),
    "scope_count": len(scopes),
    "escape": escapes[-1] if escapes else {},
    "scope": scopes[-1] if scopes else {},
    "held": "abort: holding the opencode session" in text,
    "deleted": "deleted opencode session (aborted)" in text,
    "select_fail": "tui select-session post failed" in text,
    "parent": parent,
    "child": child,
    "server": server,
}
with open(dest, "w") as handle:
    json.dump(body, handle, indent=2)
    handle.write("\n")
PY

EV="$MR_OUT_DIR/$PREFIX.escape.json"
[ -f "$EV" ] || printf '{}\n' > "$EV"

E_COUNT=$(json_field "$EV" escape_count)
S_COUNT=$(json_field "$EV" scope_count)
E_TARGET=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("escape") or {}).get("target") or "")' "$EV")
E_SESSION=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("escape") or {}).get("sessionID") or "")' "$EV")
E_PARENT=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("escape") or {}).get("parentID") or "")' "$EV")
E_MOVED=$(python3 -c 'import json,sys; v=(json.load(open(sys.argv[1])).get("escape") or {}).get("moved"); print("true" if v is True else "false" if v is False else "")' "$EV")
E_CAUSE=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("escape") or {}).get("cause") or "")' "$EV")
S_MINE=$(python3 -c 'import json,sys; v=(json.load(open(sys.argv[1])).get("scope") or {}).get("mine"); print("" if v is None else v)' "$EV")
S_OBS=$(python3 -c 'import json,sys; v=(json.load(open(sys.argv[1])).get("scope") or {}).get("observers"); print("" if v is None else v)' "$EV")
S_FOR=$(python3 -c 'import json,sys; v=(json.load(open(sys.argv[1])).get("scope") or {}).get("foreign"); print("" if v is None else v)' "$EV")
S_SERVER=$(python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("scope") or {}).get("server") or "")' "$EV")
HELD=$(json_field "$EV" held)
DELETED=$(json_field "$EV" deleted)

SNAP="$MR_OUT_DIR/$PREFIX.snapshot-scope.json"
[ -f "$SNAP" ] || printf '{}\n' > "$SNAP"

snap_writer() {
  python3 - "$SNAP" "$1" "$2" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
node = raw.get(sys.argv[2]) or {}
value = node.get(sys.argv[3], "")
if isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

snap_has_pid() {
  python3 - "$SNAP" "$1" "$2" <<'PY'
import json, sys
raw = json.load(open(sys.argv[1]))
try:
    want = int(sys.argv[3])
except (TypeError, ValueError):
    print("0")
    raise SystemExit
print("1" if want in (raw.get(sys.argv[2]) or []) else "0")
PY
}

A_PRESENT=$(snap_writer A present)
B_PRESENT=$(snap_writer B present)
C_PRESENT=$(snap_writer C present)
A_SERVER=$(snap_writer A server)
B_SERVER=$(snap_writer B server)
C_SERVER=$(snap_writer C server)
A_PANEL=$(snap_writer A panel)
B_PANEL=$(snap_writer B panel)
C_PANEL=$(snap_writer C panel)
A_SESS=$(snap_writer A sessionID)
B_SESS=$(snap_writer B sessionID)
C_SESS=$(snap_writer C sessionID)
A_BUCKET=$(snap_writer A bucket)
B_BUCKET=$(snap_writer B bucket)
C_BUCKET=$(snap_writer C bucket)
B_IS_FOREIGN=$(snap_has_pid foreign_pids "$WRITER_B")
C_IS_OBS=$(snap_has_pid observer_pids "$WRITER_C")
B_IS_MINE=$(snap_has_pid mine_pids "$WRITER_B")
C_IS_MINE=$(snap_has_pid mine_pids "$WRITER_C")

# ---------- criteria --------------------------------------------------------

if [ "$A_PRESENT" = true ] && [ "$B_PRESENT" = true ] && [ "$C_PRESENT" = true ] \
  && [ "$A_SERVER" = "$THIS_SERVER" ] && [ "$A_PANEL" = primary ] && [ "$A_SESS" = "$SUB_SID" ] \
  && [ "$B_SERVER" = "$FOREIGN_SERVER" ] && [ "$B_PANEL" = primary ] && [ "$B_SESS" = "$SUB_SID" ] \
  && [ "$C_SERVER" = "$THIS_SERVER" ] && [ "$C_PANEL" = observer ] && [ "$C_SESS" = "$SUB_SID" ]; then
  mr_record "writers published" 1 \
    "route.before.json A pid=$WRITER_A $A_SERVER/$A_PANEL; B pid=$WRITER_B $B_SERVER/$B_PANEL; C pid=$WRITER_C $C_SERVER/$C_PANEL; all on $SUB_SID"
else
  mr_record "writers published" 0 \
    "want keys $WRITER_A/$WRITER_B/$WRITER_C primary/$FOREIGN_SERVER/observer on $SUB_SID; got A present=$A_PRESENT $A_SERVER/$A_PANEL sess=$A_SESS; B present=$B_PRESENT $B_SERVER/$B_PANEL sess=$B_SESS; C present=$C_PRESENT $C_SERVER/$C_PANEL sess=$C_SESS"
fi

if [ "${S_MINE:-}" = 1 ] && [ "${S_OBS:-}" = 1 ] && [ "$B_IS_FOREIGN" = 1 ] \
  && [ "$S_SERVER" = "$THIS_SERVER" ]; then
  mr_record "scope" 1 \
    "tui route scope mine=$S_MINE observers=$S_OBS foreign=$S_FOR (B pid=$WRITER_B among foreign) server=$S_SERVER sessionID=$SUB_SID"
else
  mr_record "scope" 0 \
    "want mine=1 observers=1 B pid=$WRITER_B among foreign server=$THIS_SERVER; got mine=$S_MINE observers=$S_OBS foreign=$S_FOR B_foreign=$B_IS_FOREIGN server=$S_SERVER count=$S_COUNT ${SCOPE_WAIT_REASON:-}"
fi

if [ "$ESCAPE_OK" = 1 ] && [ "$E_COUNT" = 1 ] && [ "$E_SESSION" = "$SUB_SID" ] \
  && [ "$E_TARGET" = "$SID" ] && [ "$E_PARENT" = "$SID" ]; then
  mr_record "escape-target" 1 \
    "one escape sessionID=$E_SESSION target=$E_TARGET parentID=$E_PARENT cause=$E_CAUSE"
else
  mr_record "escape-target" 0 \
    "want one escape sessionID=$SUB_SID target=$SID parentID=$SID; got count=$E_COUNT sessionID=$E_SESSION target=$E_TARGET parentID=$E_PARENT cause=$E_CAUSE held=$HELD deleted=$DELETED ${ESCAPE_WAIT_REASON:-}"
fi

if [ "$C_IS_OBS" = 1 ] && [ "$C_IS_MINE" = 0 ] && [ "$C_BUCKET" = observer ]; then
  mr_record "observer-untouched" 1 \
    "pre-delete snapshot: C pid=$WRITER_C in observer (not mine) server=$C_SERVER panel=$C_PANEL session=$C_SESS"
else
  mr_record "observer-untouched" 0 \
    "want C pid=$WRITER_C in observer not mine; got bucket=$C_BUCKET observer=$C_IS_OBS mine=$C_IS_MINE panel=$C_PANEL"
fi

if [ "$B_IS_FOREIGN" = 1 ] && [ "$B_IS_MINE" = 0 ] && [ "$B_BUCKET" = foreign ]; then
  mr_record "foreign-untouched" 1 \
    "pre-delete snapshot: B pid=$WRITER_B among foreign (not mine) server=$B_SERVER panel=$B_PANEL session=$B_SESS"
else
  mr_record "foreign-untouched" 0 \
    "want B pid=$WRITER_B among foreign not mine; got bucket=$B_BUCKET foreign=$B_IS_FOREIGN mine=$B_IS_MINE server=$B_SERVER"
fi

if [ "$E_MOVED" = true ]; then
  mr_record "moved" 1 \
    "escape moved=true onto $E_TARGET (select-session accepted)"
else
  mr_record "moved" 0 \
    "escape moved=$E_MOVED target=$E_TARGET held=$HELD deleted=$DELETED — the decision still names the parent; the TUI post did not confirm"
fi

mr_note "abort outcome" "held=$HELD deleted=$DELETED cause=$E_CAUSE"
mr_note "snapshot buckets" "A=$A_BUCKET B=$B_BUCKET C=$C_BUCKET mine_pids B=$B_IS_MINE C=$C_IS_MINE"
mr_note_uncovered "writers follow /tui/select-session" \
  "writers republish argv sessionID; they do not consume the post so TUI navigation is not observed"

mr_model_audit
mr_verdict
