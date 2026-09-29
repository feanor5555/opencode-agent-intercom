#!/bin/bash
# Shared ground for the role drivers, `refuter-task.sh` and `releaser-task.sh`:
# one orchestrator turn that spawns ONE subagent of a named role, followed until
# the subagent has ended and the primary has settled, with the subagent's own
# session captured while it was alive and its reply read off the primary's
# wake notice.
#
# Sourced, never executed, after `lib/midrun-common.sh`:
#
#   HERE=$(cd "$(dirname "$0")" && pwd)
#   . "$HERE/lib/midrun-common.sh"
#   . "$HERE/lib/role-run.sh"
#
# It owns the run and nothing that judges it: the briefing, the fixture and the
# criteria stay in each driver.
#
# State it sets:
#
#   RR_SID          the primary session
#   RR_SUB_SID      the subagent's session ("" where none was spawned)
#   RR_SUB_HANDLE   the subagent's handle
#   RR_ENDED        how the subagent ended, "" where it did neither in time
#   RR_PRIMARY_FLAT the primary's flat transcript
#   RR_SUB_RAW      the subagent's last captured message tree
#   RR_SUB_FLAT     the subagent's flat transcript
#   RR_REPLY_FILE   the subagent's final reply (rr_read_reply), or empty
#   RR_REPLY_SOURCE where that reply was read
#
# Each rr_run_role call starts them all empty, so a driver running several
# legs reads only what its current leg set.
#
# Requires: curl, python3.

# Empties every RR_* output above.
rr_reset() {
  RR_SID=""
  RR_SUB_SID=""
  RR_SUB_HANDLE=""
  RR_ENDED=""
  RR_PRIMARY_FLAT=""
  RR_SUB_RAW=""
  RR_SUB_FLAT=""
  RR_REPLY_FILE=""
  RR_REPLY_SOURCE=""
}
rr_reset

# Prints the pids of this user's processes whose environment carries
# PW_SESSION=<sid> for one of the given subagent sessions. The plugin's
# shell.env hook (src/shellenv.js) puts that variable into every shell call of
# a subagent it tracks, and every process the call starts inherits it —
# detached ones (`setsid … & disown`, a `pw` daemon, `npx playwright install`)
# included. A session id is unique, so no process of another session, of the
# user's own opencode or of the user's own `pw` carries it.
# Usage: rr_session_pids <sid>...
rr_session_pids() {
  local sid proc pid
  local -a pats=()
  for sid in "$@"; do
    [ -n "$sid" ] && pats+=(-e "PW_SESSION=$sid")
  done
  [ "${#pats[@]}" -gt 0 ] || return 0
  for proc in /proc/[0-9]*; do
    pid=${proc#/proc/}
    [ "$pid" = "$$" ] && continue
    [ -O "$proc" ] || continue
    grep -qzxF "${pats[@]}" "$proc/environ" 2>/dev/null && echo "$pid"
  done
}

# Stops every process rr_session_pids finds for the given subagent sessions:
# TERM, up to 5 s for them to go, then KILL for the rest.
# Usage: rr_stop_session_procs <sid>...
rr_stop_session_procs() {
  local pids left pid i
  pids=$(rr_session_pids "$@" | tr '\n' ' ')
  [ -n "${pids// /}" ] || return 0
  kill -TERM $pids 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do
    left=""
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && left="$left $pid"; done
    [ -z "$left" ] && break
    sleep 0.5
  done
  [ -n "$left" ] && kill -KILL $left 2>/dev/null
  mr_say "processes the subagent session(s) left running stopped: $pids"
}

# Prints, one per line, the project documents the plugin itself writes into
# <dir> on the primary's turn (ensureProjectFiles, src/project.js) and that are
# absent from <dir> now: PROJECT.md, ARCHITECTURE.md, and TODO.md where <dir>
# holds no todo file (todo.md / todos.md in any casing). Taken before the run,
# these are the files a scope check leaves out; a file already there is the
# plugin's to leave alone and stays in the check.
# Usage: rr_plugin_scaffold <dir>
rr_plugin_scaffold() {
  local dir="$1" name
  for name in PROJECT.md ARCHITECTURE.md; do
    [ -e "$dir/$name" ] || [ -L "$dir/$name" ] || echo "$name"
  done
  if ! ls -A "$dir" 2>/dev/null | grep -qiE '^todos?\.md$'; then
    echo TODO.md
  fi
}

# The same names as an anchored alternation for `grep -E` over paths relative
# to <dir>, or a pattern that matches nothing where none is absent.
# Usage: rr_plugin_scaffold_re <dir>
rr_plugin_scaffold_re() {
  local names
  names=$(rr_plugin_scaffold "$1" | sed 's/\./\\./g' | paste -sd'|')
  if [ -n "$names" ]; then
    echo "^($names)\$"
  else
    echo '^$.'
  fi
}

# Spawns one subagent of <agent> with <briefing> through the orchestrator and
# follows it to its end. 0 when a subagent was spawned, 1 when none was — the
# driver records that as its first failed criterion.
# Usage: rr_run_role <agent> <briefing> <spawn_timeout_s> <turn_timeout_s> <finish_timeout_s> <settle_timeout_s>
rr_run_role() {
  local agent="$1" briefing="$2" spawn_timeout="$3" turn_timeout="$4" finish_timeout="$5" settle_timeout="$6"
  local turn turn_pid deadline code prev count stable_since now

  rr_reset
  turn=$(python3 -c 'import json,sys; print("Call spawn(" + json.dumps(sys.argv[1]) + ", " + json.dumps(sys.argv[2]) + ") exactly once, passing that prompt through unchanged, then end your turn. Do nothing else: no other spawn, no abort, no list(). When the subagent reports back, repeat its reply to me word for word and end your turn.")' \
    "$agent" "$briefing")

  mr_debug_start
  RR_SID=$(mr_new_session "$MR_PREFIX")
  [ -n "$RR_SID" ] || mr_die "the server did not return a session id"
  echo "$RR_SID" > "$MR_OUT_DIR/$MR_PREFIX.sid"
  mr_say "[$MR_PREFIX] primary=$RR_SID start $(date +%H:%M:%S)"

  mr_post_prompt "$RR_SID" "$turn" "$MR_OUT_DIR/$MR_PREFIX.turn1.json" "$turn_timeout" &
  turn_pid=$!

  if mr_wait_for_pattern "the $agent was spawned" "spawned .*\"agent\":\"$agent\"" "$spawn_timeout"; then
    RR_SUB_SID=$(mr_log_field "$MR_WAIT_LINE" sessionID)
    RR_SUB_HANDLE=$(mr_log_field "$MR_WAIT_LINE" handle)
    mr_say "[$MR_PREFIX] subagent=$RR_SUB_HANDLE session=$RR_SUB_SID $(date +%H:%M:%S)"
  else
    wait "$turn_pid" 2>/dev/null
    RR_PRIMARY_FLAT=$(mr_capture "$RR_SID" primary)
    return 1
  fi

  # A finished subagent's session is DELETED by the plugin, so this loop is
  # the only chance to capture its session. It ends on either way a run
  # ends: the session stops answering, or the plugin reports the completion to
  # this primary (retention on: the session is held, not deleted).
  deadline=$(( $(date +%s) + finish_timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    mr_capture "$RR_SUB_SID" subagent > /dev/null
    mr_refresh_slice
    code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$MR_BASE/session/$RR_SUB_SID" 2>/dev/null)
    if [ "$code" != 200 ]; then
      RR_ENDED="its session is gone (HTTP $code)"
      break
    fi
    if grep -qE -- "notified primary of completion .*\"parentID\":\"$RR_SID\"" "$MR_SLICE_FILE"; then
      sleep "$MR_POLL_S"
      mr_capture "$RR_SUB_SID" subagent > /dev/null
      RR_ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
      break
    fi
    sleep "$MR_POLL_S"
  done
  if [ -n "$RR_ENDED" ]; then
    mr_say "[$MR_PREFIX] subagent ended: $RR_ENDED $(date +%H:%M:%S)"
  else
    mr_say "[$MR_PREFIX] subagent did not end within ${finish_timeout}s — captures may be short of its last step"
  fi

  wait "$turn_pid" 2>/dev/null

  prev=-1; stable_since=$(date +%s)
  deadline=$(( $(date +%s) + settle_timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    count=$(curl -s -m 30 "$MR_BASE/session/$RR_SID/message" |
      python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
    now=$(date +%s)
    if [ "$count" = "$prev" ]; then
      [ "$((now - stable_since))" -ge 25 ] && { mr_say "[$MR_PREFIX] primary settled at $count messages $(date +%H:%M:%S)"; break; }
    else
      stable_since=$now; prev=$count
    fi
    sleep "$MR_POLL_S"
  done

  RR_PRIMARY_FLAT=$(mr_capture "$RR_SID" primary)
  RR_SUB_RAW="$MR_OUT_DIR/$MR_PREFIX.subagent.messages.json"
  RR_SUB_FLAT="$MR_OUT_DIR/$MR_PREFIX.subagent.transcript.txt"
  RR_REPLY_FILE="$MR_OUT_DIR/$MR_PREFIX.reply.txt"
  rr_read_reply
  return 0
}

# Fills RR_REPLY_FILE and RR_REPLY_SOURCE. The wake notice in the primary is
# read first: it carries the reply the plugin read off the finished session,
# while the subagent's own capture is only the last poll before its session
# was deleted and can stop short of the final text. The own capture and then
# the whole primary transcript stand in where no wake notice carries a result.
rr_read_reply() {
  local lib primary_raw
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  primary_raw="$MR_OUT_DIR/$MR_PREFIX.primary.messages.json"
  if [ -f "$primary_raw" ] &&
     python3 "$lib/wake-reply.py" "$primary_raw" "$RR_SUB_HANDLE" > "$RR_REPLY_FILE" 2>/dev/null &&
     [ -s "$RR_REPLY_FILE" ]; then
    RR_REPLY_SOURCE="the wake notice in the primary"
    return 0
  fi
  if [ -f "$RR_SUB_RAW" ] &&
     python3 "$lib/final-reply.py" "$RR_SUB_RAW" > "$RR_REPLY_FILE" 2>/dev/null &&
     [ -s "$RR_REPLY_FILE" ]; then
    RR_REPLY_SOURCE="the subagent's own session"
    return 0
  fi
  RR_REPLY_SOURCE="the whole primary transcript"
  cp "$RR_PRIMARY_FLAT" "$RR_REPLY_FILE" 2>/dev/null || : > "$RR_REPLY_FILE"
}
