#!/bin/bash
# Nested-delegation end-to-end driver.
#
# Drives ONE nested spawn against a real `opencode serve` and asserts what
# `concepts/role-delegation-and-web-access.md` §3 option A and §4.2-4.4 claim
# about it. The unit suite proves the mechanism against a mock client; this
# driver is the only place where a real opencode, a real model and the real
# session lifecycle decide:
#
#   admitted   a GRANTED role (coder) spawns a `researcher` and blocks
#                                                → `nested spawn: caller blocks until its child ends`
#   result     the researcher's reply is the RESULT OF THE CALLER'S OWN
#              `spawn` call                      → `… (researcher) finished and is gone. Its reply:`
#   not-a-wake the caller's transcript carries NO completion notice for that
#              child                             → zero `🔔 agent-intercom: your subagent` in it
#   survives   neither the orchestrator nor the blocked caller is torn down
#              while the child runs              → both sessions answer 200 throughout the window
#   woken      the orchestrator is woken the ordinary way once the caller ends
#                                                → `notified primary of completion`
#   nested-line the caller's completion notice bills the delegation
#                                                → `⤷ nested: 1 run, …`
#   target     the same granted role asking for a NON-researcher is refused
#                                                → `Spawn refused: a subagent may spawn a "researcher" …`
#   denied     a role that may NOT delegate gets no child at all, and the run
#              records WHICH of the three layers refused it
#   gone       both subagent sessions are deleted afterwards, so the child-first
#              teardown did not leave one behind
#   todo       the todo file is byte-identical afterwards — a nested run carries
#              no task id and must tick nothing
#
# This driver owns its server, like endless-task.sh and for the same reason: it
# reads the run off the plugin's debug log and needs a known offset into it, and
# it must not be affected by whatever run-all.sh's server is doing. The four
# lifecycle steps come from ./server-lifecycle.sh.
#
# Unlike endless-task.sh it changes NOTHING outside its own out-dir: no settings
# key is written, so there is nothing to restore. It reads
# ~/.config/opencode/agent-intercom.json only to print the resolved setup and to
# refuse a configuration in which the scenario cannot happen.
#
# Opt-in, exactly like the other drivers here: it talks to a real opencode,
# spends real model tokens, and is never run by `npm test`.
#
# Usage:
#   bash test/e2e/nested-task.sh
#   OUT_DIR=/somewhere/kept bash test/e2e/nested-task.sh
#
# Parameters (env, all with defaults chosen so one run is quick and cheap):
#   NESTED_PROJECT_DIR /home/user/testopencode  directory this plugin is wired
#                      into, globally or by its own opencode.json; the server runs in it and
#                      every session is created with ?directory= pointing at it.
#                      Its own name, not PROJECT_DIR, so run-all.sh's value for
#                      the message-tree drivers cannot redirect this run
#   NESTED_PORT        4602                   own port, clear of run-all's 4567
#                      and endless-task's 4599
#   NESTED_CALLER      coder                  the granted role that delegates
#   NESTED_WRONG_TARGET planner                what it asks for first and must
#                      not get — any spawnable type that is not the researcher
#   NESTED_DENIED_ROLE designer                a role whose permission map still
#                      denies `spawn`; `researcher` and `gitter` are the others
#   NESTED_MARKER      NESTED-RESEARCH-OK      the exact line the researcher is
#                      told to reply with. The child's answer is proven to be
#                      the caller's tool result by finding this literal inside
#                      that tool result, so it must be a string nothing else in
#                      a transcript produces
#   TURN_TIMEOUT_S     900   per blocking prompt POST
#   STEP_TIMEOUT_S     420   per awaited log line
#   SERVER_START_TIMEOUT_S 60   readiness probe budget
#   POLL_S             2     log poll cadence
#   PROBE_S            1     liveness probe cadence during the blocked window
#   OUT_DIR            ./out captures and the report
#   KEEP_SERVER        0     1 leaves the server running
#   E2E_TUI_BUILT      0     1 skips the TUI build
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# What it changes and puts back: the sessions it creates (deleted on the way
# out), the todo file of the driven project (backed up, and restored only if the
# run changed it — which is itself a failed criterion), and the server.
#
# Prerequisites: curl, python3, setsid, npm, stat, an `opencode` on PATH, and a
# model provider the project resolves.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run, so failures are recorded rather than aborted on.
set -uo pipefail

PREFIX=12-nested
HERE=$(cd "$(dirname "$0")" && pwd)

# Building the TUI, starting the server, waiting for it and stopping it again
# are shared with run-all.sh and endless-task.sh.
. "$HERE/server-lifecycle.sh"

PROJECT_DIR=${NESTED_PROJECT_DIR:-/home/user/testopencode}
PORT=${NESTED_PORT:-4602}
BASE=$(e2e_server_url "$PORT")
CALLER_ROLE=${NESTED_CALLER:-coder}
WRONG_TARGET=${NESTED_WRONG_TARGET:-planner}
DENIED_ROLE=${NESTED_DENIED_ROLE:-designer}
MARKER=${NESTED_MARKER:-NESTED-RESEARCH-OK}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
STEP_TIMEOUT_S=${STEP_TIMEOUT_S:-420}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
POLL_S=${POLL_S:-2}
PROBE_S=${PROBE_S:-1}
OUT_DIR=${OUT_DIR:-$HERE/out}
KEEP_SERVER=${KEEP_SERVER:-0}

SETTINGS_FILE="$HOME/.config/opencode/agent-intercom.json"
DEBUG_LOG="$HOME/.cache/opencode-agent-intercom/debug.log"

mkdir -p "$OUT_DIR" || { echo "cannot create $OUT_DIR" >&2; exit 2; }
# Absolute from here on: the server runs with the project directory as its
# working directory, so every path handed to it has to stand on its own.
OUT_DIR=$(cd "$OUT_DIR" && pwd)
SERVER_LOG="$OUT_DIR/$PREFIX.server.log"
SLICE_FILE="$OUT_DIR/$PREFIX.debug-slice.log"
REPORT_FILE="$OUT_DIR/$PREFIX.report.txt"
PID_FILE="$OUT_DIR/$PREFIX.serverpid"
TODO_BAK="$OUT_DIR/$PREFIX.todo.bak"

SID=""
DENIED_SID=""
CALLER_SID=""
CHILD_SID=""
CALLER_HANDLE=""
CHILD_HANDLE=""
LOG_OFFSET=0
LOG_TRUNCATED=0
FAILURES=0
ASSERTED=0
WAIT_LINE=""
WAIT_LINENO=0
WAIT_REASON=""
RESOLVED_MODEL="(unresolved)"
SERVER_VERSION="(unknown)"
MAX_NESTED_SPAWNS=2
MAX_SUBAGENT_AGE_MS=90000
TODO_BAK_NAME=""
TODO_EXISTED=0
TODO_SUM_BEFORE=""

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

# Something the run OBSERVED but does not judge: which of three legitimate
# layers refused a call, what the child cost. Reported so it is not mistaken
# for an assertion, and not counted.
note() {
  printf 'NOTE  %s\n      %s\n' "$1" "$2" | tee -a "$REPORT_FILE"
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
# when the optional 4th pattern shows the run has already moved past this step
# or when the server died — a step that does not happen must fail loudly, not
# be waited out.
wait_for_pattern() {
  local label="$1" pattern="$2" timeout="$3" giveup="${4:-}"
  local deadline=$(( $(date +%s) + timeout ))
  local hit past
  WAIT_LINE=""; WAIT_LINENO=0; WAIT_REASON=""
  while :; do
    refresh_slice
    hit=$(grep -nE -m1 -- "$pattern" "$SLICE_FILE")
    if [ -n "$hit" ]; then
      WAIT_LINENO=${hit%%:*}
      WAIT_LINE=${hit#*:}
      return 0
    fi
    if [ -n "$giveup" ]; then
      past=$(grep -nE -m1 -- "$giveup" "$SLICE_FILE")
      if [ -n "$past" ]; then
        WAIT_REASON="no \"$label\" line, and the run is already past it — ${past#*:}"
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

# The value of one key out of the JSON tail of a debug-log line.
log_field() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || printf ''
import json, sys
line, key = sys.argv[1], sys.argv[2]
i = line.find("{")
if i < 0:
    sys.exit(1)
try:
    print(json.loads(line[i:]).get(key, ""))
except Exception:
    sys.exit(1)
PY
}

# ---------- session capture ------------------------------------------------

http_code() {
  curl -s -m 20 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || printf '000'
}

# Captures one session's message tree as JSON and, beside it, a flat text
# rendering of everything the session ever said or was told: assistant text,
# user text, tool input, tool output, tool errors. Every literal this driver
# asserts is grepped out of that flat file with `grep -F`, so an assertion is
# always a fixed string and never a shape.
capture_session() {
  local sid="$1" name="$2"
  local raw="$OUT_DIR/$PREFIX.$name.messages.json"
  local flat="$OUT_DIR/$PREFIX.$name.transcript.txt"
  local tmp="$raw.tmp"
  [ -f "$flat" ] || : > "$flat"
  curl -s -m 60 "$BASE/session/$sid/message" > "$tmp" 2>/dev/null
  # A session the plugin has already torn down answers 404, and one that has
  # not spoken yet answers []. Neither may overwrite a snapshot taken while the
  # session was alive: a subagent session is DELETED the moment it finishes, so
  # these two files are the only surviving record of what it did, and the last
  # non-empty snapshot is the one that counts.
  if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d, list) and d else 1)' "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    printf '%s' "$flat"
    return 0
  fi
  mv "$tmp" "$raw"
  python3 - "$raw" "$flat" <<'PY' 2>/dev/null || : > "$flat"
import json, sys

raw, flat = sys.argv[1], sys.argv[2]
try:
    with open(raw) as fh:
        msgs = json.load(fh)
except Exception:
    msgs = []
if not isinstance(msgs, list):
    msgs = []

out = []
for m in msgs:
    info = m.get("info") if isinstance(m, dict) else None
    info = info if isinstance(info, dict) else {}
    parts = m.get("parts") if isinstance(m, dict) else None
    parts = parts if isinstance(parts, list) else []
    out.append(f"=== message id={info.get('id','?')} role={info.get('role','?')}")
    for p in parts:
        if not isinstance(p, dict):
            continue
        state = p.get("state") if isinstance(p.get("state"), dict) else {}
        head = f"--- part type={p.get('type','?')}"
        if p.get("tool"):
            head += f" tool={p.get('tool')}"
        if state.get("status"):
            head += f" status={state.get('status')}"
        for meta in (state.get("metadata"), p.get("metadata")):
            if isinstance(meta, dict) and meta:
                head += " metadata=" + json.dumps(meta, sort_keys=True)
        out.append(head)
        for field in ("text", "output", "error"):
            v = p.get(field)
            if isinstance(v, str) and v:
                out.append(v)
            v = state.get(field)
            if isinstance(v, str) and v:
                out.append(v)
        inp = state.get("input")
        if inp is not None:
            out.append("input=" + json.dumps(inp, ensure_ascii=False, sort_keys=True))
with open(flat, "w") as fh:
    fh.write("\n".join(out) + "\n")
PY
  printf '%s' "$flat"
}

# How many times a fixed string occurs in a captured transcript.
count_in() {
  local file="$1" needle="$2"
  [ -f "$file" ] || { printf '0'; return; }
  grep -c -F -- "$needle" "$file" 2>/dev/null || true
}

# The first line of a captured transcript holding a fixed string, trimmed so it
# fits on one evidence line.
first_in() {
  local file="$1" needle="$2"
  [ -f "$file" ] || return 0
  grep -m1 -F -- "$needle" "$file" 2>/dev/null | cut -c1-240
}

# Every session id the server reports as a child of <sid>, from opencode's own
# `GET /session/<id>/children`. Used for the denied role: the proof that nothing
# was spawned is that no such session exists, not that the model said so.
children_of() {
  local sid="$1"
  curl -s -m 30 "$BASE/session/$sid/children" 2>/dev/null | python3 <<'PY' 2>/dev/null || printf ''
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(data, dict):
    data = data.get("data") or []
for s in data if isinstance(data, list) else []:
    if isinstance(s, dict) and s.get("id"):
        print(s["id"])
PY
}

# ---------- cleanup --------------------------------------------------------

cleanup() {
  local code=$?
  set +u
  say ""
  say "--- cleanup ---"

  # Sessions first: the server has to be alive to delete them. The two subagent
  # sessions are deleted by the plugin itself — a DELETE on one that is already
  # gone answers 404 and that is the state this driver asserts.
  for s in "$SID" "$DENIED_SID"; do
    [ -z "$s" ] && continue
    if e2e_server_alive; then
      local http
      http=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$s")
      say "session delete $s -> HTTP $http"
    fi
  done

  # The todo file goes back only if the run changed it — which is a failed
  # criterion in its own right, reported above, never silently repaired.
  if [ "$TODO_EXISTED" = 1 ] && [ -n "$TODO_BAK_NAME" ] && [ -f "$TODO_BAK" ]; then
    if ! cmp -s "$TODO_BAK" "$PROJECT_DIR/$TODO_BAK_NAME"; then
      cp "$TODO_BAK" "$PROJECT_DIR/$TODO_BAK_NAME" &&
        say "restored $PROJECT_DIR/$TODO_BAK_NAME from $TODO_BAK (the run changed it)"
    fi
  fi

  if [ "$KEEP_SERVER" = 1 ]; then
    say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $BASE"
  else
    e2e_server_stop
  fi

  refresh_slice
  say "debug-log slice: $SLICE_FILE"
  say "server log:      $SERVER_LOG"
  say "report:          $REPORT_FILE"
  say "captures:        $OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ "$LOG_TRUNCATED" = 1 ] && say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- preflight ------------------------------------------------------

: > "$REPORT_FILE"

for tool in curl python3 setsid stat npm cmp; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done
command -v opencode >/dev/null || die "opencode is not on PATH"
[ -d "$PROJECT_DIR" ] || die "NESTED_PROJECT_DIR does not exist: $PROJECT_DIR"

PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)
e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT_DIR" ||
  die "$PLUGIN_ROOT is wired nowhere the server would read it — name it in the plugin array of ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json for every directory, or of $PROJECT_DIR/opencode.json for this project alone, or drop a loader into $PROJECT_DIR/.opencode/plugin/ — as it stands the run would observe a server without this plugin"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  die "something already answers on $BASE — choose another NESTED_PORT"
fi

# The three settings the scenario stands or falls on, resolved the way the
# plugin resolves them (file > env > default) so the printed setup is what the
# server will actually run with.
SETTINGS_LINE=$(python3 - "$SETTINGS_FILE" <<'PY'
import json, os, sys

path = sys.argv[1]
raw = {}
try:
    with open(path) as fh:
        loaded = json.load(fh)
    if isinstance(loaded, dict):
        raw = loaded
except Exception:
    pass


def num(key, env, default):
    v = raw.get(key)
    if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
        return v
    e = os.environ.get(env)
    if e and e.strip().lstrip("-").isdigit():
        return int(e)
    return default


def flag(env, default):
    e = os.environ.get(env)
    if e is not None:
        e = e.strip()
        if e == "1":
            return True
        if e == "0":
            return False
    return default


nested = num("maxNestedSpawns", "OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS", 2)
age = num("maxSubagentAgeMs", "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS", 90000)
endless = raw.get("endlessMode")
endless = endless if isinstance(endless, bool) else flag("OPENCODE_AGENT_INTERCOM_ENDLESS_MODE", True)
ctx = num("endlessContext", "OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT", 250000)
print(nested, age, "true" if endless else "false", ctx)
PY
)
read -r MAX_NESTED_SPAWNS MAX_SUBAGENT_AGE_MS ENDLESS_MODE ENDLESS_CONTEXT <<< "$SETTINGS_LINE"
[ -n "${ENDLESS_CONTEXT:-}" ] ||
  die "could not resolve the plugin settings from $SETTINGS_FILE — python3 returned: '$SETTINGS_LINE'"

[ "$MAX_NESTED_SPAWNS" -gt 0 ] 2>/dev/null ||
  die "maxNestedSpawns resolves to $MAX_NESTED_SPAWNS — with 0 every nested spawn is refused before a session exists and there is no scenario to observe. Remove the key from $SETTINGS_FILE or set it above 0."

# An endless cycle freezes every spawn from the moment it is scheduled
# (src/tools.js, `spawn refused: endless cycle in progress`). A threshold this
# short run could cross would silently turn the positive criteria into refusals.
if [ "$ENDLESS_MODE" = true ] && [ "$ENDLESS_CONTEXT" -gt 0 ] && [ "$ENDLESS_CONTEXT" -lt 40000 ]; then
  die "endlessMode is on with endlessContext=$ENDLESS_CONTEXT in $SETTINGS_FILE — a cycle would fire inside this run and freeze the spawns it asserts. Raise the threshold or switch endless mode off for the run."
fi

# ---------- todo-file baseline --------------------------------------------

# `todo.md` / `todos.md` in any casing all count as the todo file
# (src/todofile.js). A nested spawn carries no task id, so nothing in this run
# may write to it.
TODO_BEFORE=$(find "$PROJECT_DIR" -maxdepth 1 -type f -iregex '.*/todos?\.md' -printf '%f\n' 2>/dev/null | sort)
TODO_COUNT_BEFORE=$(printf '%s' "$TODO_BEFORE" | grep -c . )
if [ "$TODO_COUNT_BEFORE" -gt 1 ]; then
  die "$PROJECT_DIR holds several todo files ($(echo "$TODO_BEFORE" | tr '\n' ' ')) — the plugin refuses that state"
fi
if [ "$TODO_COUNT_BEFORE" = 1 ]; then
  TODO_EXISTED=1
  TODO_BAK_NAME=$(printf '%s' "$TODO_BEFORE")
  cp "$PROJECT_DIR/$TODO_BAK_NAME" "$TODO_BAK" || die "could not back up $PROJECT_DIR/$TODO_BAK_NAME"
  TODO_SUM_BEFORE=$(md5sum "$TODO_BAK" | cut -d' ' -f1)
  TODO_BASELINE="$TODO_BAK_NAME (md5 $TODO_SUM_BEFORE)"
else
  TODO_BASELINE="none in $PROJECT_DIR"
fi

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
# The model the PROJECT resolves, not a provider's own default: /config/providers
# reports one default per provider, none of which is what the sessions run on.
RESOLVED_MODEL=$(curl -fsS -m 10 "$BASE/config" 2>/dev/null |
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("model") or "(no model in config)", "/ small:", d.get("small_model") or "(none)")' 2>/dev/null || echo "(unresolved)")

# The grant itself, as the running server resolves it. `GET /agent` returns each
# agent with its permission rules flattened, so a `spawn`+`deny` rule is exactly
# what the schema strip and the runtime guard both read. This is the one
# criterion that needs no model turn.
curl -fsS -m 15 "$BASE/agent" > "$OUT_DIR/$PREFIX.agents.json" 2>/dev/null
GRANT_VERDICT=$(python3 - "$OUT_DIR/$PREFIX.agents.json" <<'PY' 2>/dev/null || printf 'unreadable|GET /agent could not be read'
import json, sys

DELEGATING = ["planner", "coder", "debugger", "reviewer", "documenter"]
NON_DELEGATING = ["researcher", "designer", "gitter"]

try:
    data = json.load(open(sys.argv[1]))
except Exception as err:
    print(f"unreadable|GET /agent could not be parsed: {err}")
    raise SystemExit

if isinstance(data, dict):
    data = data.get("data") or []
by_name = {a.get("name"): a for a in data if isinstance(a, dict)}


def denies_spawn(agent):
    rules = agent.get("permission")
    if not isinstance(rules, list):
        return None
    for r in rules:
        if isinstance(r, dict) and r.get("permission") == "spawn" and r.get("action") == "deny":
            return True
    return False


missing = [n for n in DELEGATING + NON_DELEGATING if n not in by_name]
if missing:
    print("missing|the server does not know these roles: " + ", ".join(missing))
    raise SystemExit

wrong = []
for n in DELEGATING:
    if denies_spawn(by_name[n]) is not False:
        wrong.append(f"{n} still denies spawn")
for n in NON_DELEGATING:
    if denies_spawn(by_name[n]) is not True:
        wrong.append(f"{n} does not deny spawn")
if wrong:
    print("wrong|" + "; ".join(wrong))
else:
    print(
        "ok|no spawn deny rule on "
        + ", ".join(DELEGATING)
        + "; a spawn deny rule on "
        + ", ".join(NON_DELEGATING)
    )
PY
)

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
settings file       $SETTINGS_FILE   (read, never written)
resolved settings   maxNestedSpawns=$MAX_NESTED_SPAWNS maxSubagentAgeMs=$MAX_SUBAGENT_AGE_MS endlessMode=$ENDLESS_MODE endlessContext=$ENDLESS_CONTEXT
delegating caller   $CALLER_ROLE   (spawns "researcher", must block)
refused target      $WRONG_TARGET   (asked for first, must be refused)
denied role         $DENIED_ROLE   (permission map still denies spawn)
child marker        $MARKER
debug log           $DEBUG_LOG   (read from byte $LOG_OFFSET)
todo baseline       $TODO_BASELINE   (backup: $TODO_BAK)
timeouts            turn=${TURN_TIMEOUT_S}s step=${STEP_TIMEOUT_S}s start=${SERVER_START_TIMEOUT_S}s poll=${POLL_S}s probe=${PROBE_S}s
out dir             $OUT_DIR
EOF
}
print_setup | tee -a "$REPORT_FILE"
say ""

# ---------- the grant, as the live server resolves it ------------------------

if [ "${GRANT_VERDICT%%|*}" = ok ]; then
  record "grant — the live server resolves spawn as the S6 rule grants it, per role" 1 "${GRANT_VERDICT#*|}"
else
  record "grant — the live server resolves spawn as the S6 rule grants it, per role" 0 "${GRANT_VERDICT#*|}"
fi

# ---------- phase 1: the granted role ---------------------------------------

post_prompt() {
  local sid="$1" text="$2" outfile="$3"
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"agent":"orchestrator","parts":[{"type":"text","text":sys.argv[1]}]}))' "$text")
  curl -s --max-time "$TURN_TIMEOUT_S" -X POST "$BASE/session/$sid/message" \
    -H 'content-type: application/json' -d "$body" > "$outfile" 2>&1
}

new_session() {
  curl -s -m 30 -X POST "$BASE/session?directory=$PROJECT_DIR" -H 'content-type: application/json' \
    -d "{\"title\":\"$1\"}" |
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null
}

SID=$(new_session "$PREFIX-granted")
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

# The caller's task is written as three ordered steps because both negative and
# positive path have to come out of ONE subagent run: the refused target costs
# no nested quota (it is refused before the quota is charged), so the researcher
# spawn that follows it is still the run's first admitted one.
CALLER_TASK="This is a deliberate test of the spawn tool's own behaviour. Do exactly these three steps in order and nothing else. Step 1: call spawn(\"$WRONG_TARGET\", \"Say hello.\") exactly once. You are expected to be refused and the refusal text IS the result this step is for, so make the call even though you know it will fail; do not skip it, do not reason about it instead, do not retry it. Step 2: call spawn(\"researcher\", \"Do not use any tool and do not search. Reply with exactly this one line and nothing else: $MARKER\") exactly once and wait for it to return. Step 3: reply with exactly two lines: first line 'STEP1: ' followed by the first sentence of what step 1 returned, second line 'STEP2: ' followed by the one line the researcher replied with. Do not read or write any file, do not run any shell command, do not use any other tool."
TURN1="Call spawn(\"$CALLER_ROLE\", \"$CALLER_TASK\") exactly once, passing that prompt through unchanged. That is your entire task. Do not spawn anything else, do not call list(), do not poll. End your turn as soon as spawn returns."

# The POST blocks for the orchestrator's FIRST turn only — the one that calls
# `spawn`, which is non-blocking for a primary — so it returns at about the
# moment the caller subagent is prompted. It runs in the background all the
# same, because from that moment on both subagent sessions are live and both
# are DELETED again the instant they finish: their transcripts have to be taken
# while they exist, and the loop below is the only chance to take them.
post_prompt "$SID" "$TURN1" "$OUT_DIR/$PREFIX.turn1.json" &
POST_PID=$!

if wait_for_pattern "the caller was spawned" "spawned .*\"agent\":\"$CALLER_ROLE\"" "$STEP_TIMEOUT_S"; then
  CALLER_SID=$(log_field "$WAIT_LINE" sessionID)
  CALLER_HANDLE=$(log_field "$WAIT_LINE" handle)
  say "[$PREFIX] caller=$CALLER_HANDLE session=$CALLER_SID $(date +%H:%M:%S)"
else
  record "admitted — a granted \"$CALLER_ROLE\" spawned a researcher and blocked on it" 0 \
    "the orchestrator never spawned a \"$CALLER_ROLE\" at all: $WAIT_REASON"
  wait "$POST_PID" 2>/dev/null
  capture_session "$SID" primary > /dev/null
  say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
  exit 1
fi

# One loop for the caller's whole life. Every round it snapshots both subagent
# transcripts, and while the caller is blocked on its child it probes all three
# sessions: break 1 of the concept (the caller torn down the moment it stops
# talking) and break 2 (the DELETE cascade over a live child) would both show
# here as a session that stops answering while the child is still alive. The
# loop ends when the caller session is gone — which is the teardown the "gone"
# criterion below reads.
BLOCK_LINE=""; BLOCK_AGENT=""; END_LINE=""
PROBE_ROUNDS=0; PROBE_FAILS=0; PROBE_EVIDENCE=""
LOOP_REASON="the caller session is gone"
LOOP_DEADLINE=$(( $(date +%s) + STEP_TIMEOUT_S ))
while :; do
  refresh_slice
  if [ -z "$BLOCK_LINE" ]; then
    BLOCK_LINE=$(grep -E -m1 -- "nested spawn: caller blocks until its child ends" "$SLICE_FILE")
    if [ -n "$BLOCK_LINE" ]; then
      CHILD_SID=$(log_field "$BLOCK_LINE" sessionID)
      CHILD_HANDLE=$(log_field "$BLOCK_LINE" handle)
      BLOCK_AGENT=$(log_field "$BLOCK_LINE" callerAgent)
      say "[$PREFIX] nested spawn blocks on $CHILD_HANDLE ($CHILD_SID) $(date +%H:%M:%S)"
    fi
  elif [ -z "$END_LINE" ]; then
    END_LINE=$(grep -E -m1 -- "nested spawn: child ended" "$SLICE_FILE")
    [ -n "$END_LINE" ] && say "[$PREFIX] the child ended $(date +%H:%M:%S)"
  fi
  capture_session "$CALLER_SID" caller > /dev/null
  [ -n "$CHILD_SID" ] && capture_session "$CHILD_SID" child > /dev/null
  if [ -n "$BLOCK_LINE" ] && [ -z "$END_LINE" ]; then
    CODE_PRIMARY=$(http_code "$BASE/session/$SID")
    CODE_CALLER=$(http_code "$BASE/session/$CALLER_SID")
    CODE_CHILD=$(http_code "$BASE/session/$CHILD_SID")
    PROBE_ROUNDS=$((PROBE_ROUNDS + 1))
    if [ "$CODE_PRIMARY" != 200 ] || [ "$CODE_CALLER" != 200 ] || [ "$CODE_CHILD" != 200 ]; then
      PROBE_FAILS=$((PROBE_FAILS + 1))
      PROBE_EVIDENCE="round $PROBE_ROUNDS: primary=$CODE_PRIMARY caller=$CODE_CALLER child=$CODE_CHILD (all three must answer 200 while the child runs)"
    fi
  elif [ "$(http_code "$BASE/session/$CALLER_SID")" != 200 ]; then
    break
  fi
  if ! e2e_server_alive; then
    LOOP_REASON="the server died during the caller's run"
    break
  fi
  if [ "$(date +%s)" -ge "$LOOP_DEADLINE" ]; then
    LOOP_REASON="the caller was still alive after ${STEP_TIMEOUT_S}s"
    break
  fi
  sleep "$PROBE_S"
done
wait "$POST_PID" 2>/dev/null
say "[$PREFIX] caller loop ended: $LOOP_REASON ($PROBE_ROUNDS probe rounds) $(date +%H:%M:%S)"

# admitted — the precondition of everything below it
if [ -z "$BLOCK_LINE" ]; then
  record "admitted — a granted \"$CALLER_ROLE\" spawned a researcher and blocked on it" 0 \
    "no \"nested spawn: caller blocks until its child ends\" line in $SLICE_FILE — $LOOP_REASON"
  say ""
  say "the nested spawn never happened — nothing below it can be observed"
  capture_session "$SID" primary > /dev/null
  say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ==="
  exit 1
elif [ "$BLOCK_AGENT" = "$CALLER_ROLE" ]; then
  record "admitted — a granted \"$CALLER_ROLE\" spawned a researcher and blocked on it" 1 "$BLOCK_LINE"
else
  record "admitted — a granted \"$CALLER_ROLE\" spawned a researcher and blocked on it" 0 \
    "the blocking caller is a \"$BLOCK_AGENT\", not the \"$CALLER_ROLE\" this run spawned: $BLOCK_LINE"
fi

# survives — nothing was torn down while the child ran
if [ "$PROBE_FAILS" = 0 ] && [ "$PROBE_ROUNDS" -ge 1 ]; then
  record "survives — orchestrator, blocked caller and child all answered 200 for the whole wait" 1 \
    "$PROBE_ROUNDS probe rounds at ${PROBE_S}s, every one 200/200/200 (primary $SID, caller $CALLER_SID, child $CHILD_SID)"
elif [ "$PROBE_ROUNDS" = 0 ]; then
  record "survives — orchestrator, blocked caller and child all answered 200 for the whole wait" 0 \
    "the child ended before a single probe round — the window could not be observed at PROBE_S=$PROBE_S"
else
  record "survives — orchestrator, blocked caller and child all answered 200 for the whole wait" 0 "$PROBE_EVIDENCE"
fi

# The child's ending, and what the caller was billed for it.
if [ -n "$END_LINE" ]; then
  note "the child's ending, as the caller was told it" \
    "status=$(log_field "$END_LINE" status) waitedMs=$(log_field "$END_LINE" waitedMs) nestedRuns=$(log_field "$END_LINE" nestedRuns) nestedTokens=$(log_field "$END_LINE" nestedTokens)"
else
  note "the child's ending, as the caller was told it" \
    "no \"nested spawn: child ended\" line — $LOOP_REASON"
fi

# Whether the idle-hold in onSessionIdle was reached at all. Recorded, not
# asserted: it is the belt to the blocking spawn's braces — a caller blocked
# inside a tool call has no reason to go idle, so an absent line means the
# blocking shape held on its own and NOT that the hold is broken.
IDLE_HELD=$(count_in "$SLICE_FILE" "idle held: subagent is waiting on a live child")
note "the idle-hold for a caller with a live child" \
  "$IDLE_HELD lines holding \"idle held: subagent is waiting on a live child\" in the slice"

# The caller now has its tool result and finishes; the orchestrator is woken.
if ! wait_for_pattern "parent notified" "notified primary of completion .*\"parentID\":\"$SID\"" "$STEP_TIMEOUT_S"; then
  say "[$PREFIX] WARNING: no completion notice for parentID=$SID yet — $WAIT_REASON"
fi
NOTIFY_LINE=$WAIT_LINE
CALLER_HANDLE=$(log_field "$NOTIFY_LINE" handle)

# Let the orchestrator's post-wake turn finish before the transcripts are taken.
PREV=-1; STABLE_SINCE=$(date +%s)
SETTLE_DEADLINE=$(( $(date +%s) + STEP_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$SETTLE_DEADLINE" ]; do
  COUNT=$(curl -s -m 30 "$BASE/session/$SID/message" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo -1)
  NOW=$(date +%s)
  if [ "$COUNT" = "$PREV" ]; then
    [ "$((NOW - STABLE_SINCE))" -ge 20 ] && { say "[$PREFIX] primary settled at $COUNT messages $(date +%H:%M:%S)"; break; }
  else
    STABLE_SINCE=$NOW; PREV=$COUNT
  fi
  sleep 5
done

CALLER_FLAT=$(capture_session "$CALLER_SID" caller)
PRIMARY_FLAT=$(capture_session "$SID" primary)
CHILD_FLAT=$(capture_session "$CHILD_SID" child)

# result — the researcher's reply is the caller's own tool result.
# `nestedSpawnOutput` renders the child as `<handle> (<agent>)`, so the literal
# below is the exact head of that tool result for this run's child.
RESULT_HEAD="$CHILD_HANDLE (researcher) finished and is gone. Its reply:"
if [ "$(count_in "$CALLER_FLAT" "$RESULT_HEAD")" -gt 0 ] && [ "$(count_in "$CALLER_FLAT" "$MARKER")" -gt 0 ]; then
  record "result — the child's answer came back as the result of the caller's own spawn call" 1 \
    "$(first_in "$CALLER_FLAT" "$RESULT_HEAD")"
else
  record "result — the child's answer came back as the result of the caller's own spawn call" 0 \
    "lines holding \"$RESULT_HEAD\": $(count_in "$CALLER_FLAT" "$RESULT_HEAD"), lines holding \"$MARKER\": $(count_in "$CALLER_FLAT" "$MARKER") in $CALLER_FLAT — both must be > 0"
fi

# Whether that tool call is also TAGGED nested in the message the API returns is
# recorded, not asserted: the tag is what the TUI keys off, but a plugin tool's
# `metadata` is opencode's to surface and this driver does not pin its shape.
CALLER_RAW="$OUT_DIR/$PREFIX.caller.messages.json"
if [ "$(count_in "$CALLER_RAW" '"nested":true')" -gt 0 ] || [ "$(count_in "$CALLER_FLAT" '"nested": true')" -gt 0 ]; then
  note "the nested tool-call metadata" "the caller's spawn call carries nested=true in the message API"
else
  note "the nested tool-call metadata" \
    "no nested=true in $CALLER_RAW — the tool's metadata is not surfaced by this opencode's message API"
fi

# not-a-wake — the caller was never sent a completion notice for its child.
WAKE_IN_CALLER=$(count_in "$CALLER_FLAT" "🔔 agent-intercom: your subagent")
if [ "$WAKE_IN_CALLER" = 0 ]; then
  record "not-a-wake — the caller's transcript holds no completion notice at all" 1 \
    "0 occurrences of \"🔔 agent-intercom: your subagent\" in $CALLER_FLAT"
else
  record "not-a-wake — the caller's transcript holds no completion notice at all" 0 \
    "$WAKE_IN_CALLER occurrences — the child's result reached the caller as a wake, not as its tool result: $(first_in "$CALLER_FLAT" "🔔 agent-intercom: your subagent")"
fi

# target — the wrong target, refused, word for word out of src/tools.js.
TARGET_REFUSAL="Spawn refused: a subagent may spawn a \"researcher\" and nothing else"
if [ "$(count_in "$CALLER_FLAT" "$TARGET_REFUSAL")" -gt 0 ]; then
  record "target — the granted caller's spawn of a \"$WRONG_TARGET\" was refused with the refusal the code produces" 1 \
    "$(first_in "$CALLER_FLAT" "$TARGET_REFUSAL")"
else
  record "target — the granted caller's spawn of a \"$WRONG_TARGET\" was refused with the refusal the code produces" 0 \
    "the literal \"$TARGET_REFUSAL\" does not occur in $CALLER_FLAT — either the caller never attempted it, or it was refused with different words"
fi

# woken — the orchestrator got the ordinary completion notice for the caller.
WAKE_HEAD="🔔 agent-intercom: your subagent \"$CALLER_HANDLE\" ($CALLER_ROLE) has finished and been destroyed."
if [ -n "$CALLER_HANDLE" ] && [ "$(count_in "$PRIMARY_FLAT" "$WAKE_HEAD")" -gt 0 ]; then
  record "woken — the orchestrator was woken the ordinary way once the caller finished" 1 \
    "$(first_in "$PRIMARY_FLAT" "$WAKE_HEAD")"
else
  record "woken — the orchestrator was woken the ordinary way once the caller finished" 0 \
    "no \"$WAKE_HEAD\" in $PRIMARY_FLAT (handle from the log: \"${CALLER_HANDLE:-none}\")"
fi

# nested-line — that notice bills the delegation.
NESTED_LINE_HEAD="⤷ nested: 1 run, "
NESTED_LINE_TAIL="(not counted in the figure above)."
if [ "$(count_in "$PRIMARY_FLAT" "$NESTED_LINE_HEAD")" -gt 0 ] &&
   [ "$(count_in "$PRIMARY_FLAT" "$NESTED_LINE_TAIL")" -gt 0 ]; then
  record "nested-line — the completion notice carries the ⤷ nested: line for the one nested run" 1 \
    "$(first_in "$PRIMARY_FLAT" "$NESTED_LINE_HEAD")"
else
  record "nested-line — the completion notice carries the ⤷ nested: line for the one nested run" 0 \
    "\"$NESTED_LINE_HEAD\" occurs $(count_in "$PRIMARY_FLAT" "$NESTED_LINE_HEAD")x and \"$NESTED_LINE_TAIL\" $(count_in "$PRIMARY_FLAT" "$NESTED_LINE_TAIL")x in $PRIMARY_FLAT"
fi

# gone — both subagent sessions are deleted, child included. A live child left
# behind, or a caller deleted before its child, is break 2 of the concept.
CODE_CALLER_AFTER=$(http_code "$BASE/session/$CALLER_SID")
CODE_CHILD_AFTER=$(http_code "$BASE/session/$CHILD_SID")
if [ "$CODE_CALLER_AFTER" != 200 ] && [ "$CODE_CHILD_AFTER" != 200 ]; then
  record "gone — both subagent sessions are deleted afterwards" 1 \
    "GET /session/$CALLER_SID -> $CODE_CALLER_AFTER, GET /session/$CHILD_SID -> $CODE_CHILD_AFTER (neither is 200)"
else
  record "gone — both subagent sessions are deleted afterwards" 0 \
    "GET /session/$CALLER_SID -> $CODE_CALLER_AFTER, GET /session/$CHILD_SID -> $CODE_CHILD_AFTER (a 200 means the session survived its teardown)"
fi

# No ending path may have gone through the watchdog or an error, and no teardown
# may have hit a live child: break 3 of the concept shows as the timeout line
# (the parent reaped while it waits), break 2 as the FOREIGN KEY failure the
# cascade produces when it wipes a streaming child's rows.
refresh_slice
TIMEOUTS=$(count_in "$SLICE_FILE" "subagent timed out (inactivity)")
LLM_ERRORS=$(count_in "$SLICE_FILE" "subagent llm error")
FK_ERRORS=$(count_in "$SERVER_LOG" "FOREIGN KEY")
if [ "$TIMEOUTS" = 0 ] && [ "$LLM_ERRORS" = 0 ] && [ "$FK_ERRORS" = 0 ]; then
  record "clean — no inactivity timeout, no subagent llm error, no FOREIGN KEY failure" 1 \
    "0 lines holding \"subagent timed out (inactivity)\" or \"subagent llm error\" in $SLICE_FILE, 0 holding \"FOREIGN KEY\" in $SERVER_LOG"
else
  record "clean — no inactivity timeout, no subagent llm error, no FOREIGN KEY failure" 0 \
    "timeouts=$TIMEOUTS llmErrors=$LLM_ERRORS foreignKey=$FK_ERRORS — the parent was reaped while waiting, or a teardown hit a live child"
fi

# ---------- phase 2: the denied role ---------------------------------------

say ""
say "[$PREFIX] phase 2: a \"$DENIED_ROLE\" attempts a spawn $(date +%H:%M:%S)"

DENIED_SID=$(new_session "$PREFIX-denied")
[ -n "$DENIED_SID" ] || die "the server did not return a session id for phase 2"
echo "$DENIED_SID" > "$OUT_DIR/$PREFIX.denied.sid"

DENIED_TASK="Do exactly one thing and nothing else: call spawn(\"researcher\", \"Reply with exactly this one line: $MARKER\") exactly once. If the call is refused, reply with 'REFUSED: ' followed by the refusal text word for word. If you have no spawn tool available at all, reply with exactly: NO SPAWN TOOL. Do not use any other tool, do not generate anything, do not read or write any file."
TURN2="Call spawn(\"$DENIED_ROLE\", \"$DENIED_TASK\") exactly once, passing that prompt through unchanged. That is your entire task. Do not spawn anything else, do not call list(). End your turn as soon as spawn returns."

# Backgrounded and then watched, for the same reason as phase 1: the denied
# role's session is deleted the instant it finishes, and its transcript is the
# only place the refusal it saw — or the absence of a spawn tool — is recorded.
post_prompt "$DENIED_SID" "$TURN2" "$OUT_DIR/$PREFIX.turn2.json" &
DENIED_POST_PID=$!

DENIED_CHILD_SID=""
GRANDCHILDREN=""
if wait_for_pattern "the denied role was spawned" "spawned .*\"agent\":\"$DENIED_ROLE\"" "$STEP_TIMEOUT_S"; then
  DENIED_CHILD_SID=$(log_field "$WAIT_LINE" sessionID)
  say "[$PREFIX] $DENIED_ROLE session=$DENIED_CHILD_SID $(date +%H:%M:%S)"
  DENIED_DEADLINE=$(( $(date +%s) + STEP_TIMEOUT_S ))
  while :; do
    capture_session "$DENIED_CHILD_SID" denied > /dev/null
    # Read while the session is still there: a child spawned by it would be
    # deleted along with it, and an empty list taken afterwards would prove
    # nothing.
    ROUND_CHILDREN=$(children_of "$DENIED_CHILD_SID")
    [ -n "$ROUND_CHILDREN" ] && GRANDCHILDREN="$ROUND_CHILDREN"
    [ "$(http_code "$BASE/session/$DENIED_CHILD_SID")" != 200 ] && break
    e2e_server_alive || break
    [ "$(date +%s)" -ge "$DENIED_DEADLINE" ] && break
    sleep "$PROBE_S"
  done
else
  say "[$PREFIX] WARNING: the orchestrator never spawned a $DENIED_ROLE — $WAIT_REASON"
fi
wait "$DENIED_POST_PID" 2>/dev/null
say "[$PREFIX] phase 2 done $(date +%H:%M:%S)"

DENIED_FLAT="$OUT_DIR/$PREFIX.denied.transcript.txt"
[ -f "$DENIED_FLAT" ] || DENIED_FLAT=""
capture_session "$DENIED_SID" denied-primary > /dev/null

# denied — nothing was spawned under it. Read off the server's own child list
# while the session was alive, so the proof is the absence of a session and not
# the model's account of itself.
if [ -z "$DENIED_CHILD_SID" ]; then
  record "denied — a \"$DENIED_ROLE\" spawned no session of its own" 0 \
    "phase 2 never produced a \"$DENIED_ROLE\" subagent; nothing could be observed (no \"spawned\" line for it in $SLICE_FILE)"
elif [ -z "$GRANDCHILDREN" ]; then
  record "denied — a \"$DENIED_ROLE\" spawned no session of its own" 1 \
    "the server reports no session with parentID=$DENIED_CHILD_SID"
else
  record "denied — a \"$DENIED_ROLE\" spawned no session of its own" 0 \
    "a child session exists under the $DENIED_ROLE: $(echo "$GRANDCHILDREN" | tr '\n' ' ')"
fi

# WHICH layer refused it. All three are legitimate — the concept names the
# schema strip as the primary defense and the other two as defense in depth —
# so the run records the one that fired instead of asserting a particular one.
CALLER_GATE_REFUSAL="You are a subagent — you cannot spawn other agents."
DENY_MAP_REFUSAL="This tool is in the agent's deny map."
LAYER="none identified"
LAYER_EVIDENCE="no refusal text and no spawn tool call found in ${DENIED_FLAT:-(no transcript)}"
if [ -n "$DENIED_FLAT" ]; then
  if [ "$(count_in "$DENIED_FLAT" "$CALLER_GATE_REFUSAL")" -gt 0 ]; then
    LAYER="3 — spawnHandler's caller gate (src/tools.js nestedSpawnRefusal)"
    LAYER_EVIDENCE=$(first_in "$DENIED_FLAT" "$CALLER_GATE_REFUSAL")
  elif [ "$(count_in "$DENIED_FLAT" "$DENY_MAP_REFUSAL")" -gt 0 ]; then
    LAYER="2 — the runtime tool guard (src/hooks.js checkToolPermission)"
    LAYER_EVIDENCE=$(first_in "$DENIED_FLAT" "$DENY_MAP_REFUSAL")
  elif [ "$(count_in "$DENIED_FLAT" "tool=spawn")" = 0 ]; then
    LAYER="1 — the schema strip (Permission.disabled); the role never saw a spawn tool"
    LAYER_EVIDENCE="no part with tool=spawn in $DENIED_FLAT"
  fi
fi
note "which layer refused the \"$DENIED_ROLE\"" "layer $LAYER: $LAYER_EVIDENCE"

# Whichever layer fired, the refusal must have been a refusal and not a crash.
if [ "$LAYER" = "none identified" ]; then
  record "denied — the refusal is one of the three layers the concept names, with its own text" 0 \
    "$LAYER_EVIDENCE"
else
  record "denied — the refusal is one of the three layers the concept names, with its own text" 1 \
    "layer $LAYER"
fi

# ---------- todo file ------------------------------------------------------

if [ "$TODO_EXISTED" = 1 ]; then
  TODO_SUM_AFTER=$(md5sum "$PROJECT_DIR/$TODO_BAK_NAME" 2>/dev/null | cut -d' ' -f1)
  if [ "$TODO_SUM_AFTER" = "$TODO_SUM_BEFORE" ]; then
    record "todo — the nested run ticked nothing: $TODO_BAK_NAME is byte-identical" 1 \
      "md5 $TODO_SUM_BEFORE before and after"
  else
    record "todo — the nested run ticked nothing: $TODO_BAK_NAME is byte-identical" 0 \
      "md5 $TODO_SUM_BEFORE before, $TODO_SUM_AFTER after — restored from $TODO_BAK in cleanup"
  fi
else
  TODO_AFTER=$(find "$PROJECT_DIR" -maxdepth 1 -type f -iregex '.*/todos?\.md' -printf '%f\n' 2>/dev/null | sort)
  if [ -z "$TODO_AFTER" ]; then
    record "todo — the nested run ticked nothing: still no todo file in the project" 1 \
      "no todo.md / todos.md in $PROJECT_DIR, as before the run"
  else
    record "todo — the nested run ticked nothing: still no todo file in the project" 0 \
      "the run created $(echo "$TODO_AFTER" | tr '\n' ' ') in $PROJECT_DIR"
  fi
fi

note_uncovered "the nested quota's own refusal (maxNestedSpawns exhausted)" \
  "it needs a caller that spawns $MAX_NESTED_SPAWNS researchers and then a further one; test/nested-delegation.test.js covers nestedQuotaDecision and the refusal text against the registry"
note_uncovered "the TUI's rendering of the grandchild row" \
  "it needs a screenshot of the rendered sidebar, which this driver does not take"

# ---------- verdict --------------------------------------------------------

say ""
say "=== $((ASSERTED - FAILURES))/$ASSERTED asserted criteria passed ===" | tee -a "$REPORT_FILE"
[ "$FAILURES" = 0 ] && exit 0
exit 1
