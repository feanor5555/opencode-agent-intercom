#!/bin/bash
# Single-agent end-to-end test harness.
# Sends the orchestrator a one-line prompt that spawns ONE subagent with the
# given task, then polls until the orchestrator session settles (no new
# messages for 25 s) so the post-wake turn is captured.
#
# Usage: run-task.sh <agent> <task-text> <out-prefix>
# Env (optional):
#   OPENCODE_URL    default http://localhost:4567
#   PROJECT_DIR     default /home/wu/opencode-agent-intercom — passed as
#                   ?directory= so subagent `read` calls land on a real path
#                   inside the session's project (opencode 1.15 stalls reads
#                   outside the session directory on a permission prompt).
#   OUT_DIR         default ./out (created if missing)
set -e
AGENT="$1"
TASK="$2"
PREFIX="$3"
[ -z "$PREFIX" ] && { echo "usage: $0 <agent> <task> <prefix>" >&2; exit 2; }
BASE=${OPENCODE_URL:-http://localhost:4567}
PROJECT=${PROJECT_DIR:-/home/wu/opencode-agent-intercom}
OUTDIR=${OUT_DIR:-$(dirname "$0")/out}
mkdir -p "$OUTDIR"

PROMPT_TEXT=$(jq -Rn --arg t "spawn(\"$AGENT\", \"$TASK\") — that is your entire task. Do not do anything else. End the turn after spawn returns." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID start $(date +%H:%M:%S)"

curl -s --max-time 600 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.orch-initial.json" 2>&1
T1=$(date +%s)
echo "[$PREFIX] orchestrator initial turn done $(date +%H:%M:%S) ($((T1-T0))s)"

PREV_COUNT=-1
STABLE_SINCE=0
DEADLINE=$(( $(date +%s) + 480 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  COUNT=$(curl -s "$BASE/session/$SID/message" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
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

curl -s "$BASE/session/$SID/message" > "$OUTDIR/$PREFIX.full-messages.json"
T2=$(date +%s)
echo "[$PREFIX] total $((T2-T0))s, $(date +%H:%M:%S)"
