#!/bin/bash
# Runs all 8 single-agent end-to-end tests, the multi-agent test and the
# endless-mode cycle, writes captures under ./out for diffing against ./golden.
#
# It owns the server the message-tree drivers use: it builds the TUI half of the
# plugin, starts a fresh `opencode serve` in the configured project, exports
# OPENCODE_URL for the drivers it sequences, and stops that server again on the
# way out — on success, on failure and on interrupt. So the run always tests the
# code in the tree, never whatever build a long-running server happens to carry.
#
# Prerequisites:
#   1. curl, python3, jq, npm, setsid and an `opencode` on PATH.
#   2. A local LLM provider opencode can reach (defaults to localhost:8080).
#
# Env:
#   RUN_ALL_PORT           4567   port for the server this script starts
#   PROJECT_DIR            $HOME/testopencode by default — the project
#                          sessions are created against, passed on to the drivers
#   OUT_DIR                ./out  captures, server log and pid file
#   SERVER_START_TIMEOUT_S 60     readiness probe budget
#
# endless-task.sh runs last and is the one driver that does NOT use this
# server: it starts and stops its own on ENDLESS_PORT (default 4599), because a
# cycle needs endless mode armed with a low threshold. It backs up and restores
# ~/.config/opencode/agent-intercom.json and the todo file of the project it
# drives. See its header for its own parameters.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

# Build the TUI, start the server, wait for it, stop it — shared with
# endless-task.sh.
. "$HERE/server-lifecycle.sh"

PORT=${RUN_ALL_PORT:-4567}
PROJECT=${PROJECT_DIR:-$HOME/testopencode}
OUTDIR=${OUT_DIR:-$HERE/out}
START_TIMEOUT=${SERVER_START_TIMEOUT_S:-60}

mkdir -p "$OUTDIR"
OUTDIR=$(cd "$OUTDIR" && pwd)

# The drivers' env contract (OPENCODE_URL, PROJECT_DIR, OUT_DIR); they stay
# usable standalone against a server somebody else started, so this is the only
# place that binds them to ours. endless-task.sh overrides all three itself.
OPENCODE_URL=$(e2e_server_url "$PORT")
export OPENCODE_URL
export PROJECT_DIR="$PROJECT"
export OUT_DIR="$OUTDIR"

if curl -fsS -m 3 "$OPENCODE_URL/global/health" >/dev/null 2>&1; then
  echo "something already answers on $OPENCODE_URL — stop it, or set RUN_ALL_PORT to a free port" >&2
  exit 2
fi

# The server picks this plugin up from the global opencode config or from the
# project it runs in. Checked before anything is started: with neither wired,
# the server comes up without the `spawn` tool and every driver below would
# fail with nothing saying why.
if ! e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT"; then
  echo "neither $PROJECT nor ${XDG_CONFIG_HOME:-$HOME/.config}/opencode wires $PLUGIN_ROOT — add \"plugin\": [\"$PLUGIN_ROOT\"] to ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json to wire it for every directory, or to $PROJECT/opencode.json for this project alone, or drop a loader into $PROJECT/.opencode/plugin/. Point PROJECT_DIR at a project that has one." >&2
  exit 2
fi

# The sidebar comes from the TUI half, which reads a plugin list of its own:
# the check above says nothing about it, and a run against a TUI-unwired
# machine would show no sidebar while every server-side step passed. The
# function prints the files it looked at and the remedy itself.
if ! e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT"; then
  exit 2
fi

cleanup() {
  local code=$?
  trap - EXIT
  echo ""
  echo "--- stopping the suite server ---"
  e2e_server_stop
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

e2e_build_tui "$PLUGIN_ROOT"

# The request log is what the golden captures were taken with. Set around the
# server start only: it belongs to this server, not to the drivers below or to
# the server endless-task.sh starts for itself.
export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1
e2e_server_start "$PORT" "$PROJECT" "$OUTDIR/00-suite.server.log" "$OUTDIR/00-suite.serverpid"
e2e_server_wait_ready "$START_TIMEOUT" "$OUTDIR/00-suite.health.json"
unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS

"$HERE/run-task.sh" planner    "Reconstruct briefly what src/state.js does. Reply in 5 short lines, no preamble." 02-planner
"$HERE/run-task.sh" coder      "In src/log.js, what does the errMsg function do? Reply in 2 sentences. Do not modify any file." 03-coder
"$HERE/run-task.sh" debugger   "Run \"npm run check\" in this directory and report whether it passes. If it does, say 'check: green'." 04-debugger
"$HERE/run-task.sh" reviewer   "Briefly review src/log.js. List 2 findings (severity-tagged), or say 'no issues'. Write the result to reviews/test-review-log.md." 05-reviewer
"$HERE/run-task.sh" documenter "Read README.md and tell me in 3 bullets what this plugin does. Do not modify." 06-documenter
"$HERE/run-task.sh" researcher "What is the current latest stable version of Node.js as of today? Reply in one sentence with a URL source." 07-researcher
"$HERE/run-task.sh" designer   "Generate a flat icon for a CLI orchestration tool — modern, minimal, dark theme. Save to designs/test-orchestrator-icon.jpg, 512x512." 08-designer
"$HERE/run-task.sh" gitter     "Show me the style of the last 5 commits in this repo. Report subject style, language, and whether bodies are used. Do NOT make any new commit." 09-gitter
"$HERE/multi-task.sh"
"$HERE/endless-task.sh"
