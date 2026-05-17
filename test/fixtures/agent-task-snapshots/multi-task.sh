#!/bin/bash
set -e
OUTDIR=/tmp/agent-task-tests
BASE=http://localhost:4567
PREFIX=10-multi

PROMPT_TEXT=$(jq -Rn --arg t "We want to add a small bytes(n) byte formatter to src/format.js (like the existing tokens() function but for bytes — e.g. 1536 → '1.5 KB'). Work through this WITH the appropriate subagents: (1) planner writes a brief plan; (2) coder implements it AND runs tests; (3) reviewer checks the result; (4) gitter proposes a commit message in this repo's style but does NOT commit. Coordinate the steps." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=/home/wu/opencode-agent-intercom" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

curl -s --max-time 1200 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.initial.json" 2>&1
T1=$(date +%s); echo "[$PREFIX] orch initial done $(date +%H:%M:%S) ($((T1-T0))s)"

# settle: poll until stable for 30s, or 20min
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
