#!/bin/bash
# Multi-agent end-to-end test harness.
# Asks the orchestrator to drive a planner → coder → reviewer → gitter
# pipeline that adds a small `bytes(n)` formatter to src/format.js. Validates
# that small-LLM subagents can collaborate on a vertical slice end-to-end.
#
# Env (optional):
#   OPENCODE_URL    default http://localhost:4567
#   PROJECT_DIR     default /home/wu/opencode-agent-intercom
#   OUT_DIR         default ./out
#
# Expected golden output: see ./golden/10-multi.full.json — 90+ messages,
# four spawn calls (planner, coder, reviewer, gitter) all status=completed,
# bytes() exists in src/format.js, 5 new tests in test/plugin.test.js, no
# commit performed.
set -e
BASE=${OPENCODE_URL:-http://localhost:4567}
PROJECT=${PROJECT_DIR:-/home/wu/opencode-agent-intercom}
OUTDIR=${OUT_DIR:-$(dirname "$0")/out}
PREFIX=10-multi
mkdir -p "$OUTDIR"

PROMPT_TEXT=$(jq -Rn --arg t "We want to add a small bytes(n) byte formatter to src/format.js (like the existing tokens() function but for bytes — e.g. 1536 → '1.5 KB'). Work through this WITH the appropriate subagents: (1) planner writes a brief plan; (2) coder implements it AND runs tests; (3) reviewer checks the result; (4) gitter proposes a commit message in this repo's style but does NOT commit. Coordinate the steps." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

curl -s --max-time 1200 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.initial.json" 2>&1
T1=$(date +%s); echo "[$PREFIX] orch initial done $(date +%H:%M:%S) ($((T1-T0))s)"

PREV=-1; STABLE_SINCE=0
DEADLINE=$(( $(date +%s) + 1200 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  COUNT=$(curl -s "$BASE/session/$SID/message" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
  NOW=$(date +%s)
  if [ "$COUNT" = "$PREV" ]; then
    [ "$((NOW - STABLE_SINCE))" -ge 35 ] && { echo "[$PREFIX] settled at $COUNT msgs $(date +%H:%M:%S)"; break; }
  else STABLE_SINCE=$NOW; PREV=$COUNT; fi
  sleep 8
done
curl -s "$BASE/session/$SID/message" > "$OUTDIR/$PREFIX.full.json"
T2=$(date +%s); echo "[$PREFIX] total $((T2-T0))s"
