#!/bin/bash
# Endless-mode optical proof: one non-interactive driver that carries a full
# endless cycle end to end against a real `opencode serve` behind a real TUI on
# a virtual X display, and prints everything an operator would otherwise have
# to establish by hand — the four PNGs of the sidebar and footer at each stage
# of the cycle, the plugin's own stage lines read from its debug log, and a
# final verdict naming whether the cycle fired.
#
# Run it with no arguments and read its output:
#
#   bash test/e2e/endless-optical-proof.sh
#
# What the run does, in order:
#
#   1. resolves E2E_MODEL (default cliproxy/gpt-5.6-luna) and builds an
#      isolated throwaway HOME around it (config-isolation.sh), with endless
#      mode on and endlessContext at 12000 — the machine's ~/.config/opencode
#      is read for providers and credentials and never written;
#   2. copies the fixture project /tmp/intercom-retention-project and seeds it
#      with the todo file and note files of endless-task.sh (its
#      seed_todo_file/seed_fixture), so cycle 1 has a real entry (T105) to work
#      and a wind-down has something finished to hand over;
#   3. starts Xvfb on :151, the server, the primary session, and a zutty
#      attached to it. The sidebar is OPEN by default at attach; the toggle is
#      ctrl+x (the leader key) then <leader>b (session.sidebar.toggle) through
#      the compiled xkey helper, and ensure_sidebar_open proves the panel is
#      up by measuring its region in a captured frame before any turn runs;
#   4. captures 01-before.png, drives the T105 work turn and the sleep-30
#      spawn turn verbatim from endless-task.sh, then re-posts the verbatim
#      short "ceiling check" turn until the measured context passes the
#      ceiling (a no-tool turn grows the session by ~70 tokens), plus one
#      arming turn — `endless: scheduled` fires at the START of an LLM request
#      and a turn that crosses inside its own reply arms nothing; captures
#      02-crossed.png at or past the ceiling, 03-fired.png while the cycle
#      runs; then follows the successor session with POST /tui/select-session
#      and captures 04-successor.png;
#   5. prints the debug-log stage lines verbatim and a verdict line, exits 0
#      only when the cycle completed.
#
# The cycle's true end-of-cycle marker, read off src/endless.js:756 —
# `endless: cycle N/M complete, new session <id>` — is what the verdict is
# taken from; the wind-down confirmation line (src/endless.js:732) is the
# confirmation band that precedes it.
#
# Parameters (env, each with a default; the script needs none of them):
#   E2E_MODEL              cliproxy/gpt-5.6-luna  the pin; the proven fallback
#                          is cliproxy/qwen3.8-flash-medium. gpuserver is down
#                          and its model is refused by the library itself.
#   PROOF_PORT             4611                   own port
#   PROOF_DISPLAY          151                    the Xvfb display number
#   ENDLESS_CONTEXT        12000                  the armed ceiling, verbatim
#   SUBAGENT_SLEEP_S       30                     in-flight window of turn 2
#   TURN_TIMEOUT_S         600                    per blocking prompt POST
#   STEP_TIMEOUT_S         300                    per awaited debug-log line
#   CYCLE_WAIT_S           600                    bound for the end-of-cycle line
#   PROOF_XKEY             work/endless-optical-proof-run/xkey  the key injector
#   PROOF_FIXTURE_SOURCE   /tmp/intercom-retention-project      copied as fixture
#   RUN_DIR                work/endless-optical-proof-run       PNGs, logs, run dir
#   KEEP_SERVER            0                      1 leaves server+Xvfb+TUI up
#   PROOF_STAGE            0                      development aid, unset for a
#                          real run: 1 stops after the server+session, 2a after
#                          the first frame, 2 after the sidebar proof and
#                          01-before.png, 3 after the spawn turn
#
# Exit codes:
#   0  the cycle fired: its end-of-cycle line stands in the debug log
#   1  the cycle did not fire — the evidence printed says where it stopped
#   2  preflight or setup error — nothing was driven
#
# Cleanup stops the server, the TUI and Xvfb and removes the fixture copy; the
# isolated HOME and the run directory stay for inspection. The two orphan
# `opencode serve` instances of Sep 4 (pids 2279722, 3371175) are never
# touched: every stop here goes by the pid/pgid this run recorded, and a pid
# that predates this script is not in any of those.
#
# NOT `set -e`: a failed step is reported and the captures and the log lines
# are still printed, so one run shows the whole state.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

. "$HERE/server-lifecycle.sh"
. "$HERE/config-isolation.sh"

PREFIX=endless-optical-proof

E2E_MODEL=${E2E_MODEL:-cliproxy/gpt-5.6-luna}
export E2E_MODEL

PORT=${PROOF_PORT:-4611}
BASE=$(e2e_server_url "$PORT")
DISPLAY_NO=${PROOF_DISPLAY:-151}
XDISPLAY=":$DISPLAY_NO"
ENDLESS_CONTEXT=${ENDLESS_CONTEXT:-12000}
SUBAGENT_SLEEP_S=${SUBAGENT_SLEEP_S:-30}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-600}
STEP_TIMEOUT_S=${STEP_TIMEOUT_S:-300}
CYCLE_WAIT_S=${CYCLE_WAIT_S:-600}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-90}
PROOF_XKEY=${PROOF_XKEY:-$PLUGIN_ROOT/work/endless-optical-proof-run/xkey}
PROOF_FIXTURE_SOURCE=${PROOF_FIXTURE_SOURCE:-/tmp/intercom-retention-project}
RUN_DIR=${RUN_DIR:-$PLUGIN_ROOT/work/endless-optical-proof-run}
KEEP_SERVER=${KEEP_SERVER:-0}
PROOF_STAGE=${PROOF_STAGE:-0}

TODO_NAME=TODO.md
FIXTURE_NAME=e2e-endless-fixture
GATE_CYCLES_MAX=3
SPAWN_AGENT=coder
FIRST_WORK_FILE=line-counts.md
MODEL=""
MODEL_PROVIDER=""
MODEL_ID=""

say() { printf '%s\n' "$*"; }
die() { say "SETUP ERROR: $*"; exit 2; }

mkdir -p "$RUN_DIR"
RUN_DIR=$(cd "$RUN_DIR" && pwd)
DEBUG_LOG="$RUN_DIR/debug.log"
# Exported before e2e_iso_create/e2e_server_start: config-isolation.sh puts it
# into E2E_SERVER_ENV only when it stands in this environment, and the server
# process is where the plugin's log() writes from.
export OPENCODE_AGENT_INTERCOM_DEBUG_LOG="$DEBUG_LOG"
SERVER_LOG="$RUN_DIR/server.log"
PID_FILE="$RUN_DIR/serverpid"
XVFB_LOG="$RUN_DIR/xvfb.log"
TUI_LOG="$RUN_DIR/tui.log"
REPORT_FILE="$RUN_DIR/report.txt"
SLICE_FILE="$RUN_DIR/debug-slice.log"

: > "$REPORT_FILE"
SID=""
NEWSID=""
SESSION_IDS=""
LOG_OFFSET=0
FIXTURE_DIR=""
XVFB_PID=""
XVFB_PGID=""
TUI_PID=""
TUI_PGID=""
SERVER_UP=0
FAILURES=0

# ---------- cleanup ---------------------------------------------------------

cleanup() {
  local code=$?
  say ""
  say "--- cleanup ---"
  if [ "$KEEP_SERVER" = 1 ]; then
    say "KEEP_SERVER=1 — server (pid ${E2E_SERVER_PID:-?}) on $BASE, Xvfb (pid ${XVFB_PID:-?}) on $XDISPLAY and the TUI stay up"
    say "run directory: $RUN_DIR"
    exit $code
  fi
  # The TUI first (a terminal attached to a dying X server), then the server,
  # then Xvfb. Each goes by the group this run started — never a pattern kill,
  # so the Sep-4 orphans on other pids are untouchable from here.
  if [ -n "$TUI_PGID" ]; then
    kill -TERM -- "-$TUI_PGID" 2>/dev/null || :
    say "TUI stopped (pgid $TUI_PGID)"
  fi
  if [ "$SERVER_UP" = 1 ]; then
    e2e_server_stop
  fi
  if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill -TERM -- "-$XVFB_PGID" 2>/dev/null || kill -TERM "$XVFB_PID" 2>/dev/null || :
    sleep 1
    kill -KILL -- "-$XVFB_PGID" 2>/dev/null || :
    say "Xvfb stopped (pid $XVFB_PID)"
  fi
  if [ -n "$FIXTURE_DIR" ] && [ -d "$FIXTURE_DIR" ]; then
    rm -rf "$FIXTURE_DIR" && say "fixture copy removed: $FIXTURE_DIR"
  fi
  if [ -n "${E2E_ISO_HOME:-}" ]; then
    say "isolated HOME kept for inspection: $E2E_ISO_HOME"
  fi
  say "run directory kept: $RUN_DIR"
  say "report: $REPORT_FILE"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- preflight -------------------------------------------------------

for tool in curl python3 setsid stat awk ffmpeg Xvfb zutty; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
command -v opencode >/dev/null || die "opencode is not on PATH"
[ -x "$PROOF_XKEY" ] || die "xkey helper is missing or not executable: $PROOF_XKEY"
[ -d "$PROOF_FIXTURE_SOURCE" ] || die "fixture source does not exist: $PROOF_FIXTURE_SOURCE"
[ -f "$PLUGIN_ROOT/tui/dist/tui.js" ] || die "the TUI bundle is not built: $PLUGIN_ROOT/tui/dist/tui.js"
case "$ENDLESS_CONTEXT" in '' | *[!0-9]* | 0) die "ENDLESS_CONTEXT=$ENDLESS_CONTEXT is not a positive whole number" ;; esac

e2e_resolve_model || exit 2
MODEL="$E2E_MODEL_REF"
MODEL_PROVIDER="$E2E_MODEL_PROVIDER"
MODEL_ID="$E2E_MODEL_ID"
[ "$MODEL_PROVIDER" = gpuserver ] && die "gpuserver is down; E2E_MODEL must not name it"

# ---------- stage 1: the isolated configuration and the server --------------

say "--- stage 1: isolated config, server, session ---"
say "model pin         $MODEL"
say "display           $XDISPLAY (Xvfb 1440x900x24)"
say "port              $PORT"
say "endlessContext    $ENDLESS_CONTEXT"
say "run dir           $RUN_DIR"

e2e_iso_create "$PLUGIN_ROOT" \
  "{\"endlessMode\":true,\"endlessContext\":$ENDLESS_CONTEXT,\"maxSubagents\":8,\"maxRetainedSubagents\":0,\"agentMode\":\"orchestrator\"}" \
  || die "e2e_iso_create failed"
SETTINGS_FILE="$E2E_ISO_SETTINGS_FILE"

FIXTURE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/e2e-optical-project.XXXXXXXX") ||
  die "could not create the fixture project directory"
cp -a "$PROOF_FIXTURE_SOURCE"/. "$FIXTURE_DIR"/ || die "could not copy $PROOF_FIXTURE_SOURCE"
# The copy carries no plugin wiring decision of its own beyond opencode.json,
# which names the plugin root by absolute path.

# The seeded todo file and fixture of endless-task.sh — verbatim.
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
- T102: Write the number of lines in e2e-endless-fixture/merged.md to e2e-endless-fixture/count.txt, gated on e2e-endless-fixture/cycle2.flag
  accept: e2e-endless-fixture/count.txt holds a single number. Read e2e-endless-fixture/cycle2.flag exactly ONCE before anything else: unless its first line is "open" this task is blocked — report blocked at once and end your turn, so the task stays open. Never wait for the flag, never sleep, never poll, never read it a second time, do no other task's work, and never write it: it is written by the run's owner and by nobody else.
  link: e2e-endless-fixture/count.txt
- T103: List the file names under e2e-endless-fixture/, one per line, in e2e-endless-fixture/index.md, gated on e2e-endless-fixture/cycle3.flag
  accept: e2e-endless-fixture/index.md carries one line per file in that directory. Read e2e-endless-fixture/cycle3.flag exactly ONCE before anything else: unless its first line is "open" this task is blocked — report blocked at once and end your turn, so the task stays open. Never wait for the flag, never sleep, never poll, never read it a second time, do no other task's work, and never write it: it is written by the run's owner and by nobody else.
  link: e2e-endless-fixture/index.md
- T104: Waiting on T101 to produce e2e-endless-fixture/merged.md; once that file is there and e2e-endless-fixture/owner.flag reads open, copy merged.md to e2e-endless-fixture/released.md
  accept: e2e-endless-fixture/released.md holds the merged text. Read e2e-endless-fixture/owner.flag exactly ONCE: unless its first line is "open" this task is blocked — report blocked at once and end your turn, so the task stays open. Never wait for the flag, never sleep, never poll, never read it a second time, and never write it: it is written by the run's owner and by nobody else.
  link: e2e-endless-fixture/merged.md
- T105: Write e2e-endless-fixture/line-counts.md, holding one line per note file in e2e-endless-fixture/ in the form "<file name>: <number of lines>"
  accept: e2e-endless-fixture/line-counts.md carries one line per notes-*.md file with that file's line count, and the note files are unchanged
  link: e2e-endless-fixture/notes-a.md
<!-- intercom: next-id T106 -->
<!-- intercom:end -->

## Notes

The `bytes()` helper in `src/format.js` is an artefact of the multi-agent run.
SEED
}

seed_fixture() {
  local k
  rm -rf "${FIXTURE_DIR:?}/$FIXTURE_NAME" || return 1
  mkdir -p "$FIXTURE_DIR/$FIXTURE_NAME" || return 1
  printf '%s\n' '# notes a' 'alpha one' 'alpha two' > "$FIXTURE_DIR/$FIXTURE_NAME/notes-a.md" || return 1
  printf '%s\n' '# notes b' 'beta one' 'beta two' > "$FIXTURE_DIR/$FIXTURE_NAME/notes-b.md" || return 1
  k=2
  while [ "$k" -le "$GATE_CYCLES_MAX" ]; do
    printf 'closed\n' > "$FIXTURE_DIR/$FIXTURE_NAME/cycle$k.flag" || return 1
    k=$((k + 1))
  done
  printf 'closed\n' > "$FIXTURE_DIR/$FIXTURE_NAME/owner.flag" || return 1
}

seed_todo_file "$FIXTURE_DIR/$TODO_NAME" || die "could not seed the todo file"
seed_fixture || die "could not seed the fixture directory"

LOG_OFFSET=$(stat -c %s "$DEBUG_LOG" 2>/dev/null || echo 0)

e2e_server_start "$PORT" "$FIXTURE_DIR" "$SERVER_LOG" "$PID_FILE" ||
  die "could not start opencode on $BASE — see $SERVER_LOG"
# The env the server process actually got: e2e_server_start copies an exported
# OPENCODE_AGENT_INTERCOM_DEBUG_LOG into E2E_SERVER_ENV; if it did not, the
# plugin's lines would land in the shared cache log and nothing of this run
# could be read. Fail before any model token is spent.
printf '%s\n' "${E2E_SERVER_ENV[@]}" | grep -qx "OPENCODE_AGENT_INTERCOM_DEBUG_LOG=$DEBUG_LOG" ||
  die "the server was started without OPENCODE_AGENT_INTERCOM_DEBUG_LOG=$DEBUG_LOG"
SERVER_UP=1
e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$RUN_DIR/health.json" ||
  die "opencode on $BASE did not become ready — see $SERVER_LOG"

SID=$(curl -s -X POST "$BASE/session?directory=$FIXTURE_DIR" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" |
  python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$SID" ] || die "the server did not return a session id"
SESSION_IDS="$SID"
say "port              $PORT   session $SID"

# The plugin has to be loaded before anything the cycle logs can appear.
refresh_slice() {
  local cur
  cur=$(stat -c %s "$DEBUG_LOG" 2>/dev/null || echo 0)
  tail -c "+$((LOG_OFFSET + 1))" "$DEBUG_LOG" > "$SLICE_FILE" 2>/dev/null || : > "$SLICE_FILE"
}
WAIT_LINE=""
SLICE_FROM=0   # wait_for_pattern only looks past this slice line
slice_now() {
  refresh_slice
  wc -l < "$SLICE_FILE" | tr -d ' '
}
wait_for_pattern() {
  local what="$1" pattern="$2" budget="$3" waited=0 line
  WAIT_LINE=""
  while [ "$waited" -lt "$budget" ]; do
    refresh_slice
    line=$(grep -nE -- "$pattern" "$SLICE_FILE" 2>/dev/null |
      awk -F: -v from="$SLICE_FROM" '$1 > from { print; exit }')
    if [ -n "$line" ]; then
      WAIT_LINE=${line#*:}
      SLICE_FROM=${line%%:*}
      say "$what: $WAIT_LINE"
      return 0
    fi
    e2e_server_alive || { say "$what: the server died"; return 1; }
    sleep 2
    waited=$((waited + 2))
  done
  say "$what: NOT FOUND within ${budget}s (pattern: $pattern)"
  return 1
}
wait_for_pattern "plugin load" "agent-intercom initialized" 30 ||
  die "no \"agent-intercom initialized\" line in $DEBUG_LOG — the server did not load the plugin"

if [ "$PROOF_STAGE" = 1 ]; then
  say "PROOF_STAGE=1 — stopping here: port $PORT, session $SID"
  exit 0
fi

say ""
say "stage 1 OK: server on $BASE, isolated config $E2E_ISO_OPENCODE_DIR, primary $SID"

# ---------- stage 2: the display, the TUI, the sidebar, one capture ---------

# A helper for the two X programs: each becomes its own session leader, so the
# group kill in cleanup() reaches it and nothing the script itself belongs to.
# The pid lands in a file, exactly the way e2e_server_start does it.
start_as_leader() {
  local pid_file="$1" ; shift
  rm -f "$pid_file"
  setsid --fork bash -c "echo \$\$ > '$pid_file'; exec \$0 \"\$@\"" "$@"
  local waited=0
  while [ "$waited" -lt 100 ]; do
    [ -s "$pid_file" ] && break
    sleep 0.1
    waited=$((waited + 1))
  done
  [ -s "$pid_file" ] || return 1
}

grab() {
  ffmpeg -hide_banner -loglevel error -nostdin -f x11grab -video_size 1440x900 \
    -i "$XDISPLAY+0,0" -frames:v 1 -y "$1"
}

# The key injector needs no X focus of its own — XTest writes straight into the
# server — but every window the run draws belongs to $XDISPLAY.
xkey() {
  "$PROOF_XKEY" "$XDISPLAY" "$@" || die "xkey failed: xkey $XDISPLAY $*"
}

sidebar_open() {
  # opencode's leader key is ctrl+x (the TUI config default, "Leader key for
  # keybind combinations"), and `session.sidebar.toggle` is bound to
  # `<leader>b`. ctrl+x then b toggles the sidebar; xkey carries both in one
  # call with ~80 ms between them, inside the leader's timeout. The panel is
  # OPEN by default at attach, so this is a toggle, not a one-way opener —
  # ensure_sidebar_open below reads the state first.
  xkey ctrl+x b
}

# Deviant pixels in the sidebar's own region: the top-right 360x400 block,
# which the chat column never reaches. A live sidebar holds its title and the
# Subagents/Context/LSP blocks there (thousands of deviant pixels); with the
# panel closed the block is the empty terminal (0). Proven on the two frames
# of a first run: 5302 open, 0 closed.
sidebar_deviant() {
  ffmpeg -hide_banner -loglevel error -i "$1" -vf "crop=360:400:1080:0" \
    -f rawvideo -pix_fmt rgb24 - 2>/dev/null |
    python3 -c '
import sys
from collections import Counter
data = sys.stdin.buffer.read()
px = [tuple(data[i:i+3]) for i in range(0, len(data)-2, 3)]
if not px:
    print(-1); raise SystemExit
bg = Counter(px).most_common(1)[0][0]
print(sum(1 for p in px if abs(p[0]-bg[0])+abs(p[1]-bg[1])+abs(p[2]-bg[2]) > 30))
'
}

# Opens the sidebar and proves it: capture, measure, toggle when closed,
# measure again; the run stops as a setup error when the panel cannot be shown.
ensure_sidebar_open() {
  local png="$RUN_DIR/tmp-sidebar-check.png" n
  grab "$png" || die "x11grab failed in ensure_sidebar_open"
  n=$(sidebar_deviant "$png")
  if [ "${n:-0}" -gt 500 ]; then
    say "sidebar already open ($n deviant px in its region) — no key needed"
    return 0
  fi
  say "sidebar closed ($n deviant px) — sending ctrl+x, then b"
  sidebar_open
  sleep 2
  grab "$png" || die "x11grab failed after the sidebar sequence"
  n=$(sidebar_deviant "$png")
  if [ "${n:-0}" -gt 500 ]; then
    say "sidebar opened by ctrl+x / <leader>b ($n deviant px) — sequence verified"
    return 0
  fi
  die "the sidebar did NOT open with ctrl+x then b ($n deviant px) — the key sequence is wrong, see $png"
}

say "--- stage 2: Xvfb $XDISPLAY, zutty, sidebar, one capture ---"

start_as_leader "$RUN_DIR/xvfypid" Xvfb "$XDISPLAY" -screen 0 1440x900x24 -nolisten tcp \
  >> "$XVFB_LOG" 2>&1 || die "Xvfb did not write its pid — see $XVFB_LOG"
XVFB_PID=$(cat "$RUN_DIR/xvfypid")
XVFB_PGID=$XVFB_PID
sleep 1
kill -0 "$XVFB_PID" 2>/dev/null || die "Xvfb died at once — see $XVFB_LOG"
say "Xvfb up: pid $XVFB_PID on $XDISPLAY"

start_as_leader "$RUN_DIR/tuipid" env "${E2E_SERVER_ENV[@]}" DISPLAY="$XDISPLAY" \
  zutty -geometry 160x48 \
  -e opencode attach "$BASE" --dir "$FIXTURE_DIR" -s "$SID" \
  >> "$TUI_LOG" 2>&1 || die "zutty did not start — see $TUI_LOG"
TUI_PID=$(cat "$RUN_DIR/tuipid")
TUI_PGID=$TUI_PID
# opencode's TUI boot (plugin half, session replay) takes a few seconds on a
# cold instance; the sidebar check below is the real gate, this is only the
# floor under it.
say "zutty up: pid $TUI_PID — booting opencode, waiting 12s"
sleep 12

grab "$RUN_DIR/00-plain.png" || die "the first x11grab produced nothing — see $XVFB_LOG / $TUI_LOG"

if [ "$PROOF_STAGE" = 2a ]; then
  say "PROOF_STAGE=2a — 00-plain.png captured; not touching the sidebar"
  exit 0
fi

ensure_sidebar_open

# 01-before.png: the sidebar with endless mode on and the threshold row, the
# footer context still below the ceiling (the session holds only its prompt so
# far). Captured before any turn of stage 3 runs.
grab "$RUN_DIR/01-before.png" || die "01-before.png capture failed"

if [ "$PROOF_STAGE" = 2 ]; then
  say "PROOF_STAGE=2 — stopping here. Frames: $RUN_DIR/00-plain.png $RUN_DIR/tmp-sidebar-check.png"
  exit 0
fi

say ""
say "stage 2 OK: sidebar open on $XDISPLAY, capture path proven"

# ---------- stage 3: the three turns, context printed after each ------------

# The primary's context as the PLUGIN counts it against `endlessContext`:
# input + output + reasoning + cache.read + cache.write of the newest assistant
# message with a non-zero output — `latestContextTokens` (src/context-figure.js);
# the walk stops at a compaction message and answers nothing.
primary_ctx_tokens() {
  local sid="$1"
  curl -s -m 30 "$BASE/session/$sid/message" > "$RUN_DIR/messages-$sid.json" || return 1
  python3 - "$RUN_DIR/messages-$sid.json" <<'PY'
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
    if not isinstance(info, dict):
        continue
    if info.get("summary") is True:
        raise SystemExit
    if info.get("role") != "assistant":
        continue
    tokens = info.get("tokens")
    if not isinstance(tokens, dict):
        continue
    output = tokens.get("output") or 0
    if output <= 0:
        continue
    cache = tokens.get("cache")
    total = (tokens.get("input") or 0) + output + (tokens.get("reasoning") or 0)
    if isinstance(cache, dict):
        total += (cache.get("read") or 0) + (cache.get("write") or 0)
    print(int(total))
    break
PY
}

post_prompt() {
  local text="$1" outfile="$2" body
  body=$(python3 -c 'import json,sys; print(json.dumps({"agent":"orchestrator","model":{"providerID":sys.argv[2],"modelID":sys.argv[3]},"parts":[{"type":"text","text":sys.argv[1]}]}))' "$text" "$MODEL_PROVIDER" "$MODEL_ID")
  curl -s --max-time "$TURN_TIMEOUT_S" -X POST "$BASE/session/$SID/message" \
    -H 'content-type: application/json' -d "$body" > "$outfile" 2>&1
}

# The three prompts, verbatim from endless-task.sh: the work turn (its line 820
# with $SPAWN_AGENT=coder and the line-819 work prompt interpolated), the
# sleep-30 spawn turn (line 1403 with SUBAGENT_SLEEP_S=30), and the crossing
# turn (line 1466).
WORK_MARKER="endless-optical-work-c1-$$"
WORK_PROMPT="Read this project's $TODO_NAME. Exactly one entry between the lines <!-- intercom:begin --> and <!-- intercom:end --> asks for a line-count file under $FIXTURE_NAME/; carry out that entry and no other one. Write $FIXTURE_NAME/$FIRST_WORK_FILE with one line per file whose name begins with notes- in that directory, each line reading the file name, then a colon, then that file's number of lines. Create nothing else — no flag file, no merged.md, no count.txt, no index.md, no released.md — and change no file that is already there. Marker for the run that started you: $WORK_MARKER. Then reply with exactly two lines: the first reading 'finished: ' then the id of the entry you carried out, then ' — $FIXTURE_NAME/$FIRST_WORK_FILE written'; the second reading 'still open: ' then the ids of the other entries between those two lines, comma-separated."
TURN1="Call spawn(\"$SPAWN_AGENT\", \"$WORK_PROMPT\") exactly once, passing that prompt through unchanged, and end your turn as soon as it returns. Do not poll, do not call list(), do not spawn a second subagent. When that subagent reports back to you, start no further work and spawn nothing: reply with at most two lines saying which todo entry it finished and which entries are still open."
SLEEP_MARKER="endless-optical-sleeper-c1-$$"
TURN2="Call spawn(\"$SPAWN_AGENT\", \"Run the shell command: sleep $SUBAGENT_SLEEP_S. Then reply with the single line: slept $SUBAGENT_SLEEP_S seconds ($SLEEP_MARKER).\") exactly once and end your turn as soon as it returns. Do not poll, do not call list(), do not spawn a second subagent, do not write anything else."
TURN3="Reply with the single line: ceiling check. Call no tool at all — do not spawn, do not list."

say "--- stage 3: driving the turns on $SID ---"

CTX0=$(primary_ctx_tokens "$SID"); say "context after session create: ${CTX0:-unreadable} tokens"

SLICE_FROM=$(slice_now)
post_prompt "$TURN1" "$RUN_DIR/turn1.json"
say "turn 1 (T105 work) posted $(date +%H:%M:%S)"
CTX1=$(primary_ctx_tokens "$SID"); say "context after turn 1: ${CTX1:-unreadable} tokens"
# The work spawn's line lands shortly AFTER turn 1's blocking POST returned —
# spawn is non-blocking — so consume it here, before the sleeper's window is
# taken. Same for its completion notice: the wake turn that carries it is part
# of the primary's context growth, and line-counts.md is only there once the
# subagent actually finished.
wait_for_pattern "work spawn" "spawned " 60 ||
  say "NOTE: no \"spawned\" line for turn 1's work subagent"
wait_for_pattern "work subagent finished" "notified primary of completion" 240 ||
  say "NOTE: the work subagent did not report back within 240s"
[ -f "$FIXTURE_DIR/$FIXTURE_NAME/$FIRST_WORK_FILE" ] ||
  say "NOTE: $FIRST_WORK_FILE is not there — the work subagent did not finish; the wind-down may still fire, the rewrite has less to confirm"

SLICE_FROM=$(slice_now)
post_prompt "$TURN2" "$RUN_DIR/turn2.json"
say "turn 2 (sleep-$SUBAGENT_SLEEP_S spawn) posted $(date +%H:%M:%S)"
# The spawn must be in flight before the crossing turn: the cycle quiesces on
# it. The window stands past turn 1's work spawn, so this line is the sleeper's.
if ! wait_for_pattern "sleeper spawned" "spawned " 60; then
  say "NOTE: no \"spawned\" line within 60s of turn 2 — the crossing may meet no in-flight subagent"
fi
CTX2=$(primary_ctx_tokens "$SID"); say "context after turn 2: ${CTX2:-unreadable} tokens"

if [ "$PROOF_STAGE" = 3 ]; then
  say "PROOF_STAGE=3 — stopping here. Contexts: create=${CTX0:-?} t1=${CTX1:-?} t2=${CTX2:-?} (ceiling $ENDLESS_CONTEXT)"
  exit 0
fi

# 02-crossed.png: the sidebar's Context block read at or past the ceiling.
# The crossing itself is turn 3; the figure at or past 12000 stands in the
# footer once turn 3's message is on the session, so this capture is taken
# after turn 3's POST returned and before the cycle's replacement of the
# session. ensure_sidebar_open keeps the panel up across the turns.
say "--- stage 4: the crossing, the captures, the verdict ---"

# The three briefed turns carry the session to roughly 10 000 tokens (a live
# endless-task run measured 9 985 after the work turn, its wake and the spawn
# turn). The ceiling is 12 000, so the short crossing turn is re-posted until
# the measured context passes it — the same verbatim prompt, one crossing
# attempt per LLM turn, bounded so a stuck session cannot spin the run.
SLICE_FROM=$(slice_now)
post_prompt "$TURN3" "$RUN_DIR/turn3.json"
say "turn 3 (ceiling check) posted $(date +%H:%M:%S)"
CTX3=$(primary_ctx_tokens "$SID"); say "context after turn 3: ${CTX3:-unreadable} tokens (ceiling $ENDLESS_CONTEXT)"

repeat=0
prev_ctx=${CTX3:-0}
# A no-tool crossing turn grows the session by roughly 40 tokens on
# cliproxy/gpt-5.6-luna and 65 on cliproxy/qwen3.8-flash-medium (both live
# measured), so reaching a fixed 12 000 from a few thousand takes on the order
# of 100 to 200 repeats; the bound covers both and the stall guard below ends
# the loop the moment the context stops growing.
while [ "${CTX3:-0}" -lt "$ENDLESS_CONTEXT" ] 2>/dev/null && [ "$repeat" -lt 300 ]; do
  # A crossing turn that adds no tokens at all means the session is not
  # growing — stop the loop and let the waits below report the state.
  if [ "$repeat" -gt 0 ] && [ "${CTX3:-0}" -le "$prev_ctx" ] 2>/dev/null; then
    say "crossing stalled at ${CTX3:-?} tokens — the context is not growing, giving up the repeats"
    break
  fi
  prev_ctx=${CTX3:-0}
  repeat=$((repeat + 1))
  sleep 3   # let the primary settle out of the wake turn before queueing again
  SLICE_FROM=$(slice_now)
  post_prompt "$TURN3" "$RUN_DIR/turn3-repeat$repeat.json"
  CTX3=$(primary_ctx_tokens "$SID")
  say "crossing repeat $repeat: context ${CTX3:-unreadable} tokens (ceiling $ENDLESS_CONTEXT)"
done

# The arming turn. `endless: scheduled` is emitted by the transform hook at the
# START of an LLM request, reading the context as it stands then — a turn whose
# assistant reply is what pushes the session past the ceiling arms nothing,
# because no request follows it. So once the measured context stands at or past
# the ceiling, post one more verbatim crossing turn: its request starts with
# the ceiling already crossed and the hook latches the cycle on it. (A live
# run crossed mid-turn and armed on the spot; a run that crossed exactly at a
# turn's end sat at 12 018 tokens with the ceiling never armed — this turn
# makes the arming independent of where inside a turn the crossing lands.)
if [ "${CTX3:-0}" -ge "$ENDLESS_CONTEXT" ] 2>/dev/null; then
  sleep 3
  SLICE_FROM=$(slice_now)
  post_prompt "$TURN3" "$RUN_DIR/turn3-arming.json"
  CTX3=$(primary_ctx_tokens "$SID")
  say "arming turn posted; context now ${CTX3:-unreadable} tokens (ceiling $ENDLESS_CONTEXT)"
fi

ensure_sidebar_open
grab "$RUN_DIR/02-crossed.png" || say "NOTE: 02-crossed.png failed"

# trigger — `endless: scheduled` (src/hooks.js:544). The window stands where
# the turn-3 POST set it, so no line of turns 1 and 2 can satisfy this wait.
if ! wait_for_pattern "endless: scheduled" "endless: scheduled .*\"sessionID\":\"$SID\"" "$STEP_TIMEOUT_S"; then
  say "VERDICT: the cycle never armed — no \"endless: scheduled\" for $SID; context read $CTX3 against ceiling $ENDLESS_CONTEXT"
  FAILURES=$((FAILURES + 1))
fi

grab "$RUN_DIR/03-fired.png" || say "NOTE: 03-fired.png failed"

# The cycle's own lines: quiesce, wind-down confirmation, then the true
# end-of-cycle marker `endless: cycle N/M complete, new session <id>`
# (src/endless.js:756). The briefing's "cycle … complete" is exactly this line.
FIRED=0
if wait_for_pattern "endless: quiesced" "endless: quiesced" "$((SUBAGENT_SLEEP_S + STEP_TIMEOUT_S))"; then :; fi
# The wind-down leg runs to the plugin's own bound: endlessWindDownTimeoutMs
# defaults to 900 000 ms (src/settings.js:360), so the confirmation and the
# replacement may each stand minutes behind the quiesce.
wait_for_pattern "wind-down confirmed" "endless: wind-down confirmed" 600 || :
if wait_for_pattern "endless: cycle complete" "endless: cycle [^ ]* complete, new session " "$CYCLE_WAIT_S"; then
  FIRED=1
  NEWSID=$(printf '%s' "$WAIT_LINE" | sed -nE 's/.*new session ([A-Za-z0-9_]+).*/\1/p')
  SESSION_IDS="$SESSION_IDS $NEWSID"
else
  # The failure band, printed as found: an abandonment names its stage.
  refresh_slice
  grep -E 'endless: abandoned|endless: latch dropped|cycle cannot arm' "$SLICE_FILE" | tail -5
fi

# 04-successor.png: follow the view onto the successor session and show its
# context reset. The route is opencode's own /tui/select-session.
if [ -n "$NEWSID" ]; then
  sel=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/tui/select-session" \
    -H 'content-type: application/json' -d "{\"sessionID\":\"$NEWSID\"}")
  say "POST /tui/select-session $NEWSID -> HTTP $sel"
  sleep 5
  grab "$RUN_DIR/04-successor.png" || say "NOTE: 04-successor.png failed"
  CTX4=$(primary_ctx_tokens "$NEWSID"); say "successor context: ${CTX4:-unreadable} tokens"
else
  grab "$RUN_DIR/04-successor.png" || say "NOTE: 04-successor.png failed (no successor — the frame shows the old primary)"
  say "NOTE: no successor session id — 04-successor.png cannot show a reset context"
  FAILURES=$((FAILURES + 1))
fi

# ---------- the report: images, stage lines, verdict ------------------------

say ""
say "--- images produced ---"
for png in 01-before 02-crossed 03-fired 04-successor; do
  if [ -f "$RUN_DIR/$png.png" ]; then
    say "PNG $RUN_DIR/$png.png"
  else
    say "PNG $RUN_DIR/$png.png MISSING"
    FAILURES=$((FAILURES + 1))
  fi
done

say ""
say "--- stage lines (verbatim from $DEBUG_LOG, this run's slice) ---"
refresh_slice
# The cycle's own band, in the order the concept states it: the trigger
# (src/hooks.js:544), the quiesce (src/endless.js:494), the wind-down
# confirmation (src/endless.js:732), the true end-of-cycle marker
# (src/endless.js:756), and any abandonment (src/endless.js:424).
grep -E 'endless: (scheduled|quiesced|wind-down confirmed|cycle [^ ]* complete|abandoned|latch dropped)' "$SLICE_FILE" ||
  say "(no endless stage lines in the slice)"

say ""
if [ "$FIRED" = 1 ]; then
  say "VERDICT: the endless cycle FIRED — $(grep -E 'endless: cycle [^ ]* complete' "$SLICE_FILE" | tail -1)"
  say "successor session: ${NEWSID:-unknown}"
else
  say "VERDICT: the endless cycle did NOT fire — see the stage lines and notes above"
fi

[ "$FIRED" = 1 ] || exit 1
exit 0
