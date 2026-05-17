#!/bin/bash
# Usage: run-task.sh <agent> <task-text> <out-prefix>
# Sends orchestrator a prompt to spawn one subagent with the given task,
# then waits for the orchestrator session to fully settle (no new messages
# for 20s) so the post-wake turn is captured.
set -e
AGENT="$1"
TASK="$2"
PREFIX="$3"
OUTDIR=/tmp/agent-task-tests
BASE=http://localhost:4567

PROMPT_TEXT=$(jq -Rn --arg t "spawn(\"$AGENT\", \"$TASK\") — that is your entire task. Do not do anything else. End the turn after spawn returns." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=/home/wu/opencode-agent-intercom" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

curl -s --max-time 600 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.orch-initial.json" 2>&1

T1=$(date +%s)
echo "[$PREFIX] orchestrator initial turn done $(date +%H:%M:%S) ($((T1-T0))s)"

# Wait for settle: poll message count, exit when stable for 20s
PREV_COUNT=-1
STABLE_SINCE=0
DEADLINE=$(( $(date +%s) + 480 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  COUNT=$(curl -s "$BASE/session/$SID/message" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "-1")
  NOW=$(date +%s)
  if [ "$COUNT" = "$PREV_COUNT" ]; then
    if [ "$((NOW - STABLE_SINCE))" -ge 25 ]; then
      echo "[$PREFIX] settled at $COUNT messages $(date +%H:%M:%S)"
      break
    fi
  else
    STABLE_SINCE=$NOW
    PREV_COUNT=$COUNT
  fi
  sleep 5
done

# Save full session messages
curl -s "$BASE/session/$SID/message" > "$OUTDIR/$PREFIX.full-messages.json"
T2=$(date +%s)
echo "[$PREFIX] total $((T2-T0))s, $(date +%H:%M:%S)"
