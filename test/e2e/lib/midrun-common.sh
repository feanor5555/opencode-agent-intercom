#!/bin/bash
# Shared ground for the two mid-run-channel drivers, `message-task.sh` and
# `ask-task.sh`.
#
# Sourced, never executed:
#
#   HERE=$(cd "$(dirname "$0")" && pwd)
#   . "$HERE/lib/midrun-common.sh"
#
# It owns what both drivers do identically — the report lines, the session
# calls, the capture of a subagent session that is about to be deleted, and the
# slice of the plugin's debug log — and nothing that differs between them: the
# prompts, the criteria and the evidence stay in each driver, where a reader
# looks for them.
#
# Unlike `server-lifecycle.sh` this library starts NO server. Both drivers run
# against a server somebody else owns — `run-all.sh`'s, or one the caller
# started — exactly like `run-task.sh` and `multi-task.sh`, and for the same
# reason: the mid-run channel needs no setting changed and no isolated
# instance, so a server of its own would only cost a second startup.
#
# State the functions keep, set by `mr_init`:
#
#   MR_PREFIX       the driver's capture prefix, e.g. 13-message
#   MR_BASE         the server URL
#   MR_PROJECT_DIR  the directory sessions are created against
#   MR_OUT_DIR      absolute out dir
#   MR_REPORT_FILE  the run's report
#   MR_ASSERTED     criteria asserted so far
#   MR_FAILURES     of those, failed
#   MR_MODEL_PROVIDER / MR_MODEL_ID   split out of E2E_MODEL
#   MR_DEBUG_LOG / MR_SLICE_FILE / MR_LOG_OFFSET   the plugin's log and the
#                   byte the driver started reading it at
#   MR_WAIT_LINE / MR_WAIT_LINENO / MR_WAIT_REASON  the last log wait's outcome
#
# Requires: curl, python3.

MR_PREFIX=""
MR_BASE=""
MR_PROJECT_DIR=""
MR_OUT_DIR=""
MR_REPORT_FILE=""
MR_ASSERTED=0
MR_FAILURES=0
MR_MODEL_PROVIDER=""
MR_MODEL_ID=""
MR_DEBUG_LOG="$HOME/.cache/opencode-agent-intercom/debug.log"
MR_SLICE_FILE=""
MR_LOG_OFFSET=0
MR_LOG_TRUNCATED=0
MR_WAIT_LINE=""
MR_WAIT_LINENO=0
MR_WAIT_REASON=""
MR_POLL_S=${MIDRUN_POLL_S:-2}

# ---------- reporting ------------------------------------------------------

mr_say() { printf '%s\n' "$*"; }

# One asserted criterion: name, 1|0, and the evidence line that decided it.
# Same shape as nested-task.sh, so one reader reads every driver's report.
mr_record() {
  local name="$1" ok="$2" evidence="$3"
  MR_ASSERTED=$((MR_ASSERTED + 1))
  if [ "$ok" = 1 ]; then
    printf 'PASS  %s\n      %s\n' "$name" "$evidence" | tee -a "$MR_REPORT_FILE"
  else
    MR_FAILURES=$((MR_FAILURES + 1))
    printf 'FAIL  %s\n      %s\n' "$name" "$evidence" | tee -a "$MR_REPORT_FILE"
  fi
}

# Something the run OBSERVED but does not judge. Not counted.
mr_note() {
  printf 'NOTE  %s\n      %s\n' "$1" "$2" | tee -a "$MR_REPORT_FILE"
}

# A criterion this driver deliberately does not assert, named so its absence is
# not mistaken for a pass.
mr_note_uncovered() {
  printf 'NOT ASSERTED  %s\n      %s\n' "$1" "$2" | tee -a "$MR_REPORT_FILE"
}

# A setup error: nothing was asserted, so the run says so and exits 2.
mr_die() {
  mr_say "SETUP ERROR: $*"
  exit 2
}

# The closing line and the driver's exit code: 0 when every criterion passed.
mr_verdict() {
  mr_say ""
  mr_say "=== $((MR_ASSERTED - MR_FAILURES))/$MR_ASSERTED asserted criteria passed ==="
  [ "$MR_FAILURES" = 0 ]
}

# ---------- setup ----------------------------------------------------------

# Resolves the shared environment contract and the report file.
# Usage: mr_init <prefix>
mr_init() {
  MR_PREFIX="$1"
  MR_BASE=${OPENCODE_URL:-http://localhost:4567}
  MR_PROJECT_DIR=${PROJECT_DIR:-$HOME/testopencode}
  local out=${OUT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/out}
  mkdir -p "$out" || mr_die "cannot create $out"
  MR_OUT_DIR=$(cd "$out" && pwd)
  MR_REPORT_FILE="$MR_OUT_DIR/$MR_PREFIX.report.txt"
  MR_SLICE_FILE="$MR_OUT_DIR/$MR_PREFIX.debug-slice.log"
  : > "$MR_REPORT_FILE"

  local model=${E2E_MODEL:-xai/grok-4.6}
  MR_MODEL_PROVIDER=${model%%/*}
  MR_MODEL_ID=${model#*/}
  [ -n "$MR_MODEL_PROVIDER" ] && [ "$MR_MODEL_ID" != "$model" ] && [ -n "$MR_MODEL_ID" ] ||
    mr_die "E2E_MODEL must be a provider/model pair (got: $model)"

  for tool in curl python3; do
    command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
  done
  [ -d "$MR_PROJECT_DIR" ] || mr_die "PROJECT_DIR does not exist: $MR_PROJECT_DIR"

  curl -fsS -m 5 "$MR_BASE/global/health" > "$MR_OUT_DIR/$MR_PREFIX.health.json" 2>/dev/null ||
    mr_die "nothing answers on $MR_BASE — this driver uses a server it does not own. Run it through test/e2e/run-all.sh, or start one yourself (opencode serve --port 4567 --hostname 127.0.0.1 in $MR_PROJECT_DIR) and set OPENCODE_URL."

  [ "${OPENCODE_AGENT_INTERCOM_DEBUG:-1}" != 0 ] ||
    mr_die "OPENCODE_AGENT_INTERCOM_DEBUG=0 switches the plugin's log off; this driver reads the spawned subagent's session id out of it"
}

# Refuses the two settings under which the scenario cannot happen at all:
# the channel switched off, and an endless threshold this run would cross —
# a cycle freezes every spawn from the moment it is scheduled.
# Usage: mr_check_settings
mr_check_settings() {
  local line
  line=$(python3 - "$HOME/.config/opencode/agent-intercom.json" <<'PY'
import json, os, sys

try:
    with open(sys.argv[1]) as handle:
        raw = json.load(handle)
    raw = raw if isinstance(raw, dict) else {}
except Exception:
    raw = {}


def flag(key, env, default):
    value = raw.get(key)
    if isinstance(value, bool):
        return value
    seen = os.environ.get(env)
    if seen is not None:
        seen = seen.strip()
        if seen == "1":
            return True
        if seen == "0":
            return False
    return default


def num(key, env, default):
    value = raw.get(key)
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    seen = os.environ.get(env)
    if seen and seen.strip().isdigit():
        return int(seen)
    return default


mid = flag("midRunMessaging", "OPENCODE_AGENT_INTERCOM_MID_RUN_MESSAGING", True)
endless = flag("endlessMode", "OPENCODE_AGENT_INTERCOM_ENDLESS_MODE", True)
mode = raw.get("agentMode") or os.environ.get("OPENCODE_AGENT_INTERCOM_AGENT_MODE") or "orchestrator"
print(
    "true" if mid else "false",
    num("answerWaitMs", "OPENCODE_AGENT_INTERCOM_ANSWER_WAIT_MS", 300000),
    num("maxMessageTokens", "OPENCODE_AGENT_INTERCOM_MAX_MESSAGE_TOKENS", 1000),
    num("maxSubagentToolCallMs", "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_TOOL_CALL_MS", 660000),
    "true" if endless else "false",
    num("endlessContext", "OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT", 250000),
    mode,
)
PY
  )
  read -r MR_MID_RUN MR_ANSWER_WAIT_MS MR_MAX_MESSAGE_TOKENS MR_MAX_TOOL_CALL_MS MR_ENDLESS_MODE MR_ENDLESS_CONTEXT MR_AGENT_MODE <<< "$line"
  [ -n "${MR_AGENT_MODE:-}" ] || mr_die "could not resolve the plugin settings — python3 returned: '$line'"
  [ "$MR_MID_RUN" = true ] ||
    mr_die "midRunMessaging is off in ~/.config/opencode/agent-intercom.json — neither message nor ask is registered, so there is no channel to observe"
  [ "$MR_AGENT_MODE" = orchestrator ] ||
    mr_die "agentMode is \"$MR_AGENT_MODE\" — in solo mode no subagent starts and neither tool is registered"
  if [ "$MR_ENDLESS_MODE" = true ] && [ "$MR_ENDLESS_CONTEXT" -gt 0 ] && [ "$MR_ENDLESS_CONTEXT" -lt 40000 ]; then
    mr_die "endlessMode is on with endlessContext=$MR_ENDLESS_CONTEXT — a cycle would fire inside this run and freeze the spawn it asserts"
  fi
}

# ---------- sessions -------------------------------------------------------

mr_new_session() {
  curl -s -m 30 -X POST "$MR_BASE/session?directory=$MR_PROJECT_DIR" \
    -H 'content-type: application/json' -d "{\"title\":\"$1\"}" |
    python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null
}

# One prompt to the orchestrator session. Blocks for that turn; run it in the
# background where the driver has to watch the subagent while the turn runs.
# Usage: mr_post_prompt <sid> <text> <outfile> [timeout_s]
mr_post_prompt() {
  local sid="$1" text="$2" outfile="$3" timeout="${4:-900}"
  local body
  body=$(python3 -c 'import json,sys; print(json.dumps({"agent":"orchestrator","model":{"providerID":sys.argv[2],"modelID":sys.argv[3]},"parts":[{"type":"text","text":sys.argv[1]}]}))' \
    "$text" "$MR_MODEL_PROVIDER" "$MR_MODEL_ID")
  curl -s --max-time "$timeout" -X POST "$MR_BASE/session/$sid/message" \
    -H 'content-type: application/json' -d "$body" > "$outfile" 2>&1
}

mr_delete_session() {
  [ -z "$1" ] && return 0
  curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$MR_BASE/session/$1" 2>/dev/null
}

# ---------- capture --------------------------------------------------------

# Snapshots one session's message tree and, beside it, a flat text rendering of
# everything that session ever said or was told. A subagent session is DELETED
# the moment it finishes, so these two files are the only surviving record of
# what it did: a 404 or an empty list must never overwrite a snapshot taken
# while the session was alive, and the last non-empty one is what counts.
#
# Usage: mr_capture <sid> <name>   → prints the flat transcript's path
mr_capture() {
  local sid="$1" name="$2"
  local raw="$MR_OUT_DIR/$MR_PREFIX.$name.messages.json"
  local flat="$MR_OUT_DIR/$MR_PREFIX.$name.transcript.txt"
  local tmp="$raw.tmp"
  [ -f "$flat" ] || : > "$flat"
  curl -s -m 60 "$MR_BASE/session/$sid/message" > "$tmp" 2>/dev/null
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
mr_count_in() {
  local file="$1" needle="$2"
  [ -f "$file" ] || { printf '0'; return; }
  grep -c -F -- "$needle" "$file" 2>/dev/null || true
}

# The first line holding a fixed string, trimmed to one evidence line.
mr_first_in() {
  local file="$1" needle="$2"
  [ -f "$file" ] || return 0
  grep -m1 -F -- "$needle" "$file" 2>/dev/null | cut -c1-240
}

# Loads `key=value` lines — what the two evidence readers under lib/ print —
# into shell variables under a prefix: `mr_load_kv out.txt A_` sets A_parsed,
# A_framed_time and so on. Keys are restricted to the readers' own alphabet, so
# a malformed line can define nothing unexpected.
mr_load_kv() {
  local file="$1" prefix="$2" key value
  while IFS='=' read -r key value; do
    case "$key" in
      [a-z_]*) ;;
      *) continue ;;
    esac
    printf -v "$prefix$key" '%s' "$value"
  done < "$file"
}

# ---------- the plugin's debug log ------------------------------------------

# The plugin appends to ~/.cache/opencode-agent-intercom/debug.log forever. The
# driver never truncates it: it records the size it found and reads only what is
# appended from there on, so a shared server's earlier runs stay out of the
# slice.
mr_debug_start() {
  MR_LOG_OFFSET=$(stat -c %s "$MR_DEBUG_LOG" 2>/dev/null || echo 0)
}

mr_refresh_slice() {
  local cur
  cur=$(stat -c %s "$MR_DEBUG_LOG" 2>/dev/null || echo 0)
  if [ "$cur" -lt "$MR_LOG_OFFSET" ]; then
    MR_LOG_TRUNCATED=1
    MR_LOG_OFFSET=0
  fi
  tail -c "+$((MR_LOG_OFFSET + 1))" "$MR_DEBUG_LOG" > "$MR_SLICE_FILE" 2>/dev/null ||
    : > "$MR_SLICE_FILE"
}

# Waits for one line in the slice. 0 with MR_WAIT_LINE set, or 1 with
# MR_WAIT_REASON set. Never returns 0 on a timeout.
# Usage: mr_wait_for_pattern <label> <pattern> <timeout_s>
mr_wait_for_pattern() {
  local label="$1" pattern="$2" timeout="$3"
  local deadline=$(( $(date +%s) + timeout )) hit
  MR_WAIT_LINE=""; MR_WAIT_LINENO=0; MR_WAIT_REASON=""
  while :; do
    mr_refresh_slice
    hit=$(grep -nE -m1 -- "$pattern" "$MR_SLICE_FILE")
    if [ -n "$hit" ]; then
      MR_WAIT_LINENO=${hit%%:*}
      MR_WAIT_LINE=${hit#*:}
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      MR_WAIT_REASON="no line matching /$pattern/ within ${timeout}s while waiting for \"$label\" — last log line: $(tail -n 1 "$MR_SLICE_FILE")"
      return 1
    fi
    sleep "$MR_POLL_S"
  done
}

# The value of one key out of the JSON tail of a debug-log line.
mr_log_field() {
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
