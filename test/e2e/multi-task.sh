#!/bin/bash
# Multi-agent end-to-end test harness.
# Asks the orchestrator to drive a planner → coder → reviewer → gitter
# pipeline that adds a small `bytes(n)` formatter to src/format.js. Validates
# that small-LLM subagents can collaborate on a vertical slice end-to-end.
#
# Env (optional):
#   OPENCODE_URL    default http://localhost:4567
#   PROJECT_DIR     default $HOME/testopencode
#   OUT_DIR         default ./out
#   E2E_MODEL       default openai/gpt-5.6-luna (provider/model for this run)
#
# It uses a server somebody else owns and writes no configuration of its own;
# the isolation of that server's configuration belongs to whoever starts it.
# What it asserts itself is the model: every assistant message of the primary
# session, and of every subagent session it could read while that subagent was
# alive, has to name E2E_MODEL, or the driver exits 1.
#
# Expected outcome: 90+ messages, four spawn calls (planner, coder, reviewer,
# gitter) all status=completed, bytes() exists in src/format.js, 5 new tests in
# test/plugin.test.js, no commit performed.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/config-isolation.sh"
BASE=${OPENCODE_URL:-http://localhost:4567}
PROJECT=${PROJECT_DIR:-$HOME/testopencode}
OUTDIR=${OUT_DIR:-$(dirname "$0")/out}
e2e_resolve_model || exit 2
MODEL="$E2E_MODEL_REF"
MODEL_PROVIDER="$E2E_MODEL_PROVIDER"
MODEL_ID="$E2E_MODEL_ID"
PREFIX=10-multi
mkdir -p "$OUTDIR"
OUTDIR=$(cd "$OUTDIR" && pwd)

# Four subagent sessions, each deleted when it finishes: their transcripts are
# snapshotted while they live, off the session ids the plugin's debug log names.
DEBUG_LOG=$(e2e_debug_log)
SLICE_FILE="$OUTDIR/$PREFIX.debug-slice.log"
LOG_OFFSET=$(stat -c %s "$DEBUG_LOG" 2>/dev/null || echo 0)

snapshot_subagents() {
  tail -c "+$((LOG_OFFSET + 1))" "$DEBUG_LOG" > "$SLICE_FILE" 2>/dev/null || : > "$SLICE_FILE"
  local sid
  for sid in $(e2e_audit_subagent_sids "$SLICE_FILE"); do
    e2e_audit_fetch_sessions "$BASE" "$OUTDIR/$PREFIX" "$sid" > /dev/null
  done
}

PROMPT_TEXT=$(jq -Rn --arg t "We want to add a small bytes(n) byte formatter to src/format.js (like the existing tokens() function but for bytes — e.g. 1536 → '1.5 KB'). Work through this WITH the appropriate subagents: (1) planner writes a brief plan; (2) coder implements it AND runs tests; (3) reviewer checks the result; (4) gitter proposes a commit message in this repo's style but does NOT commit. Coordinate the steps." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID model=$MODEL start $(date +%H:%M:%S)"

curl -s --max-time 1200 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"model\":{\"providerID\":\"$MODEL_PROVIDER\",\"modelID\":\"$MODEL_ID\"},\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.initial.json" 2>&1
T1=$(date +%s); echo "[$PREFIX] orch initial done $(date +%H:%M:%S) ($((T1-T0))s)"

PREV=-1; STABLE_SINCE=0
DEADLINE=$(( $(date +%s) + 1200 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  snapshot_subagents
  COUNT=$(curl -s "$BASE/session/$SID/message" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
  NOW=$(date +%s)
  if [ "$COUNT" = "$PREV" ]; then
    [ "$((NOW - STABLE_SINCE))" -ge 35 ] && { echo "[$PREFIX] settled at $COUNT msgs $(date +%H:%M:%S)"; break; }
  else STABLE_SINCE=$NOW; PREV=$COUNT; fi
  sleep 8
done
curl -s "$BASE/session/$SID/message" > "$OUTDIR/$PREFIX.full.json"
e2e_audit_record "$OUTDIR/$PREFIX.full.json"
snapshot_subagents
T2=$(date +%s); echo "[$PREFIX] total $((T2-T0))s"

# Which model answered, over the captures this run recorded as it wrote them —
# never a glob over the out directory, which also holds what earlier runs left
# there. A turn on anything but the pin fails the driver.
e2e_audit_recorded "$PREFIX" "$OUTDIR/$PREFIX.model-audit.txt"
