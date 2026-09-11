#!/bin/bash
# Single-agent end-to-end test harness.
# Sends the orchestrator a one-line prompt that spawns ONE subagent with the
# given task, then polls until the orchestrator session settles (no new
# messages for 25 s) so the post-wake turn is captured.
#
# It uses a server somebody else owns — run-all.sh's, or one the caller started
# — and writes no configuration of its own. The isolation of that server's
# configuration belongs to whoever starts it; this driver inherits the
# E2E_ISO_* variables run-all.sh exports.
#
# What it does assert on its own: the model. Every assistant message of the
# orchestrator session, and of every subagent session it could still read while
# it was alive, has to name E2E_MODEL. A turn answered by another model exits
# the driver 1 — the pin is what keeps a run off the machine's own per-agent
# model choices, and an unaudited run would not show that it held.
#
# Usage: run-task.sh <agent> <task-text> <out-prefix>
# Env (optional):
#   OPENCODE_URL    default http://localhost:4567
#   PROJECT_DIR     default $HOME/testopencode — passed as
#                   ?directory= so subagent `read` calls land on a real path
#                   inside the session's project (opencode 1.15 stalls reads
#                   outside the session directory on a permission prompt).
#   OUT_DIR         default ./out (created if missing)
#   E2E_MODEL       default openai/gpt-5.6-luna (provider/model for this run)
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/config-isolation.sh"

AGENT="$1"
TASK="$2"
PREFIX="$3"
[ -z "$PREFIX" ] && { echo "usage: $0 <agent> <task> <prefix>" >&2; exit 2; }
BASE=${OPENCODE_URL:-http://localhost:4567}
PROJECT=${PROJECT_DIR:-$HOME/testopencode}
OUTDIR=${OUT_DIR:-$(dirname "$0")/out}
e2e_resolve_model || exit 2
MODEL="$E2E_MODEL_REF"
MODEL_PROVIDER="$E2E_MODEL_PROVIDER"
MODEL_ID="$E2E_MODEL_ID"
mkdir -p "$OUTDIR"
OUTDIR=$(cd "$OUTDIR" && pwd)

# The subagent this run spawns is deleted the moment it finishes, so its
# transcript is read while it is alive: the plugin names every subagent session
# in its own debug log, and the settle loop below snapshots each one it finds.
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

PROMPT_TEXT=$(jq -Rn --arg t "spawn(\"$AGENT\", \"$TASK\") — that is your entire task. Do not do anything else. End the turn after spawn returns." '$t')

T0=$(date +%s)
SID=$(curl -s -X POST "$BASE/session?directory=$PROJECT" -H 'content-type: application/json' \
  -d "{\"title\":\"$PREFIX\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "$SID" > "$OUTDIR/$PREFIX.sid"
echo "[$PREFIX] primary=$SID model=$MODEL start $(date +%H:%M:%S)"

curl -s --max-time 600 -X POST "$BASE/session/$SID/message" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"orchestrator\",\"model\":{\"providerID\":\"$MODEL_PROVIDER\",\"modelID\":\"$MODEL_ID\"},\"parts\":[{\"type\":\"text\",\"text\":$PROMPT_TEXT}]}" \
  > "$OUTDIR/$PREFIX.orch-initial.json" 2>&1
T1=$(date +%s)
echo "[$PREFIX] orchestrator initial turn done $(date +%H:%M:%S) ($((T1-T0))s)"

PREV_COUNT=-1
STABLE_SINCE=0
DEADLINE=$(( $(date +%s) + 480 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  snapshot_subagents
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
snapshot_subagents
T2=$(date +%s)
echo "[$PREFIX] total $((T2-T0))s, $(date +%H:%M:%S)"

# Which model answered. Fails the driver, and with it the suite: a run on the
# machine's own per-agent choice proves nothing about the pinned one.
e2e_model_audit "$PREFIX" "$OUTDIR/$PREFIX.model-audit.txt" \
  "$OUTDIR/$PREFIX.full-messages.json" "$OUTDIR/$PREFIX".audit-*.json
