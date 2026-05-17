#!/bin/bash
# Runs all 8 single-agent end-to-end tests + the multi-agent test, writes
# captures under ./out for diffing against ./golden.
#
# Prerequisites:
#   1. `opencode serve --port 4567` running with this plugin and LOG_REQUESTS=1
#      (see ../README.md → "How to run"). Easiest: run from this plugin's repo
#      root so opencode picks it up as the project.
#   2. jq, python3, curl on PATH.
#   3. A local LLM provider opencode can reach (defaults to localhost:8080).
#
# Env (passed through to run-task.sh / multi-task.sh):
#   OPENCODE_URL, PROJECT_DIR, OUT_DIR
set -e
HERE=$(dirname "$0")
"$HERE/run-task.sh" planner    "Reconstruct briefly what src/state.js does. Reply in 5 short lines, no preamble." 02-planner
"$HERE/run-task.sh" coder      "In src/log.js, what does the errMsg function do? Reply in 2 sentences. Do not modify any file." 03-coder
"$HERE/run-task.sh" debugger   "Run \"npm run check\" in this directory and report whether it passes. If it does, say 'check: green'." 04-debugger
"$HERE/run-task.sh" reviewer   "Briefly review src/log.js. List 2 findings (severity-tagged), or say 'no issues'. Write the result to reviews/test-review-log.md." 05-reviewer
"$HERE/run-task.sh" documenter "Read README.md and tell me in 3 bullets what this plugin does. Do not modify." 06-documenter
"$HERE/run-task.sh" researcher "What is the current latest stable version of Node.js as of today? Reply in one sentence with a URL source." 07-researcher
"$HERE/run-task.sh" designer   "Generate a flat icon for a CLI orchestration tool — modern, minimal, dark theme. Save to designs/test-orchestrator-icon.jpg, 512x512." 08-designer
"$HERE/run-task.sh" gitter     "Show me the style of the last 5 commits in this repo. Report subject style, language, and whether bodies are used. Do NOT make any new commit." 09-gitter
"$HERE/multi-task.sh"
