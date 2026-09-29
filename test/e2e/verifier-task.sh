#!/bin/bash
# Verifier end-to-end driver.
#
# Hands the `verifier` role checks on a throwaway web project through a real
# orchestrator on a real `opencode serve`, and asserts that it runs the page in
# a real browser through the plugin's own `pw`, judges what it sees, and never
# reports a check it could not run or could not see as PASS.
#
# The fixture, built fresh under a temp dir and committed to a git repository
# of its own so the run can show no tracked file changed:
#
#   AGENTS.md    serve with `python3 -m http.server <port>` from this
#                directory, open /index.html
#   index.html   loads app.js, whose code throws in the browser
#                (`document.querySelector("#missing").textContent`) and which
#                imports fine under node — a run through node sees no error
#   app.js       that module; package.json makes it an ES module for node
#   canvas.html  draws a red rectangle with the word BROKEN on a <canvas>,
#                with no DOM text a script could read back
#
# Four legs, three servers this driver starts and stops itself — the verifier's
# model is a pin in llm-models.json, read at server start, and leg 4 needs a
# server environment without a browser:
#
#   leg 1  index.html, "loads without a page error", verifier on E2E_MODEL.
#          Asserted: spawned, head, 1 fail, the [pageerror] line quoted, and
#          `pw start` answered in the verifier's shell (the plugin's `pw` on
#          its PATH).
#   leg 3  canvas.html, "shows a green OK banner", verifier on E2E_MODEL where
#          that model declares no image input. Asserted: NOT RUN, "no vision"
#          given as the reason, no PASS. Reported SKIP where E2E_MODEL sees.
#   leg 2  the same check, verifier pinned to E2E_VISION_MODEL. Asserted: FAIL,
#          a screenshot under work/verify-*/ written in this leg, the reply
#          naming red or BROKEN.
#          Reported SKIP where E2E_VISION_MODEL is unset.
#   leg 4  the leg-1 check with PLAYWRIGHT_BROWSERS_PATH pointed at an empty,
#          read-only directory, so `pw start` finds no Chromium and cannot
#          download one into it, and the isolated home's cache without
#          Playwright's default browser directory, so unsetting the variable
#          finds none either. Asserted: NOT RUN, no PASS, no bash call
#          that clears or re-points PLAYWRIGHT_BROWSERS_PATH, and no bash call
#          that runs `playwright install` or launches a browser binary.
#
# Over the whole run: no tracked fixture file changed (untouched), and per leg
# every captured assistant turn ran on the model pinned for its agent
# (model-pin). Cleanup stops every process a verifier's shell left running,
# found by its session's PW_SESSION (rr_stop_session_procs).
#
# Opt-in, like every driver here: it talks to a real opencode, spends real
# model tokens, and is never run by `npm test`.
#
# Usage:
#   bash test/e2e/verifier-task.sh
#   E2E_VISION_MODEL=cliproxy/gpt-6-luna bash test/e2e/verifier-task.sh
#   KEEP_FIXTURE=1 OUT_DIR=/somewhere/kept bash test/e2e/verifier-task.sh
#
# Env (all with defaults):
#   VERIFIER_PORT          4614   port for the servers this driver starts
#   VERIFIER_HTTP_PORT     8765   port the fixture's AGENTS.md serves the page on
#   E2E_MODEL              cliproxy/qwen3.8-flash-medium  the pin
#   E2E_VISION_MODEL       unset  a model with image input (provider/model),
#                                 taken as given; the verifier's pin in leg 2
#   OUT_DIR                ./out  captures and the report
#   KEEP_FIXTURE           0      1 keeps the temp project
#   MIDRUN_POLL_S          2      poll cadence
#   SERVER_START_TIMEOUT_S 60     readiness probe budget per server
#   SPAWN_TIMEOUT_S        180    wait for the spawn
#   TURN_TIMEOUT_S         900    per blocking prompt POST
#   FINISH_TIMEOUT_S       900    wait for the verifier to end
#   SETTLE_TIMEOUT_S       420    wait for the primary to settle
#
# Exit codes:
#   0  every asserted criterion passed (a skipped leg asserts nothing)
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, git, setsid, an `opencode` on PATH, a provider
# serving E2E_MODEL (and E2E_VISION_MODEL where set) configured in the
# machine's opencode.json, the plugin's Chromium installed, and the plugin's
# debug log switched on.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

PREFIX=23-verifier
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

PORT=${VERIFIER_PORT:-4614}
HTTP_PORT=${VERIFIER_HTTP_PORT:-8765}
KEEP_FIXTURE=${KEEP_FIXTURE:-0}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-900}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}

# ---------- the fixture -----------------------------------------------------

for tool in curl python3 git setsid node; do
  command -v "$tool" >/dev/null || { echo "SETUP ERROR: $tool is not on PATH"; exit 2; }
done
command -v opencode >/dev/null || { echo "SETUP ERROR: opencode is not on PATH — this driver starts servers of its own"; exit 2; }

FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/e2e-verifier.XXXXXXXX") ||
  { echo "SETUP ERROR: mktemp failed"; exit 2; }
PROJECT="$FIXTURE_ROOT/project"
NO_BROWSERS="$FIXTURE_ROOT/no-browsers"

build_fixture() {
  mkdir -p "$PROJECT" "$NO_BROWSERS" "$FIXTURE_ROOT/no-hooks" || return 1
  chmod 555 "$NO_BROWSERS" || return 1
  git -C "$PROJECT" init -q -b main || return 1
  git -C "$PROJECT" config user.name "e2e verifier" || return 1
  git -C "$PROJECT" config user.email "e2e-verifier@example.invalid" || return 1
  git -C "$PROJECT" config commit.gpgsign false || return 1
  git -C "$PROJECT" config core.hooksPath "$FIXTURE_ROOT/no-hooks" || return 1

  cat > "$PROJECT/AGENTS.md" <<EOF
# Demo page

Serve it with \`python3 -m http.server $HTTP_PORT\` from this directory, then
open \`http://127.0.0.1:$HTTP_PORT/index.html\`. The other page is
\`http://127.0.0.1:$HTTP_PORT/canvas.html\`.
EOF
  printf '{ "name": "demo-page", "type": "module" }\n' > "$PROJECT/package.json"
  printf 'work/\n' > "$PROJECT/.gitignore"
  cat > "$PROJECT/app.js" <<'EOF'
export function title() {
  return document.querySelector("#missing").textContent
}

if (typeof document !== "undefined") {
  document.querySelector("#out").textContent = title()
}
EOF
  cat > "$PROJECT/index.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Demo</title></head>
  <body>
    <h1>Demo</h1>
    <p id="out">loading</p>
    <script type="module" src="app.js"></script>
  </body>
</html>
EOF
  cat > "$PROJECT/canvas.html" <<'EOF'
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Status</title></head>
  <body style="margin:0;background:#ffffff">
    <canvas id="view" width="800" height="400"></canvas>
    <script>
      const ctx = document.getElementById("view").getContext("2d")
      ctx.fillStyle = "#d00000"
      ctx.fillRect(40, 40, 720, 320)
      ctx.fillStyle = "#ffffff"
      ctx.font = "bold 96px sans-serif"
      ctx.fillText("BROKEN", 210, 240)
    </script>
  </body>
</html>
EOF
  git -C "$PROJECT" add AGENTS.md package.json .gitignore app.js index.html canvas.html || return 1
  git -C "$PROJECT" commit -q -m "initial" || return 1
  # The trap the role exists for: under node the module imports fine.
  (cd "$PROJECT" && node -e 'import("./app.js").then(() => process.exit(0), () => process.exit(1))') || return 1
}
if ! build_fixture; then
  echo "SETUP ERROR: the fixture under $FIXTURE_ROOT could not be built"
  chmod 755 "$NO_BROWSERS" 2>/dev/null
  rm -rf "$FIXTURE_ROOT"
  exit 2
fi

PROJECT_DIR="$PROJECT"
export PROJECT_DIR

. "$HERE/server-lifecycle.sh"
. "$HERE/lib/midrun-common.sh"
. "$HERE/lib/role-run.sh"

BASE=$(e2e_server_url "$PORT")
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || { echo "SETUP ERROR: cannot create $OUT_PRE"; exit 2; }
OUT_PRE=$(cd "$OUT_PRE" && pwd)

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"
e2e_resolve_vision_model || mr_die "E2E_VISION_MODEL does not name a usable model"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  mr_die "something already answers on $BASE — stop it, or set VERIFIER_PORT to a free port"
fi
if curl -sS -m 3 -o /dev/null "http://127.0.0.1:$HTTP_PORT/" 2>/dev/null; then
  mr_die "something already answers on port $HTTP_PORT — the fixture's AGENTS.md serves the page there; set VERIFIER_HTTP_PORT to a free port"
fi

e2e_iso_create "$PLUGIN_ROOT" \
  '{"maxSubagents":8,"maxContext":130000,"compaction":false,"endlessMode":false,"agentMode":"orchestrator","maxRetainedSubagents":0}' ||
  mr_die "could not build the isolated opencode configuration"

VF_SUB_SIDS=""
VF_PRIMARY_SIDS=""

# The pw daemon of one verifier session, stopped by its pid file: the daemon
# is named after the session (bin/pw.js), so no other daemon is touched.
vf_stop_pw_daemon() {
  local sid="$1" runtime pidfile pid
  runtime="${XDG_RUNTIME_DIR:-$HOME/.cache}/opencode-agent-intercom"
  pidfile="$runtime/pw-$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-' | cut -c1-64).pid"
  [ -f "$pidfile" ] || return 0
  pid=$(cat "$pidfile" 2>/dev/null)
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && mr_say "pw daemon of $sid stopped (pid $pid)"
  return 0
}

# Whatever the verifier left serving the fixture's port.
vf_stop_fixture_http() {
  local pids
  pids=$(pgrep -f "http.server $HTTP_PORT" 2>/dev/null | tr '\n' ' ')
  [ -n "$pids" ] || return 0
  kill -TERM $pids 2>/dev/null
  mr_say "fixture http server stopped (pid $pids)"
}

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  local s
  for s in $VF_PRIMARY_SIDS; do
    e2e_server_alive || break
    mr_say "primary session delete $s -> HTTP $(mr_delete_session "$s")"
  done
  e2e_server_stop
  rr_stop_session_procs $VF_SUB_SIDS $RR_SUB_SID
  e2e_iso_remove
  for s in $VF_SUB_SIDS; do vf_stop_pw_daemon "$s"; done
  vf_stop_fixture_http
  chmod 755 "$NO_BROWSERS" 2>/dev/null
  if [ "$KEEP_FIXTURE" = 1 ]; then
    mr_say "fixture kept: $FIXTURE_ROOT"
  else
    rm -rf "$FIXTURE_ROOT"
    mr_say "fixture removed: $FIXTURE_ROOT"
  fi
  [ -n "$MR_OUT_DIR" ] && {
    mr_say "report:      $MR_REPORT_FILE"
    mr_say "captures:    $MR_OUT_DIR/$PREFIX-leg*.messages.json / .transcript.txt / .reply.txt"
    mr_say "debug slice: $MR_SLICE_FILE"
  }
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Starts the server for one leg on the isolated configuration as it stands,
# with the extra environment assignments given.
# Usage: vf_start_server <label> [NAME=value ...]
vf_start_server() {
  local label="$1"
  shift
  local saved=("${E2E_SERVER_ENV[@]}")
  E2E_SERVER_ENV+=("$@")
  e2e_server_start "$PORT" "$PROJECT" "$OUT_PRE/$PREFIX-$label.server.log" "$OUT_PRE/$PREFIX-$label.serverpid" ||
    mr_die "could not start opencode on $BASE — see $OUT_PRE/$PREFIX-$label.server.log"
  E2E_SERVER_ENV=("${saved[@]}")
  e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_PRE/$PREFIX-$label.health.json" ||
    mr_die "opencode on $BASE did not become ready — see $OUT_PRE/$PREFIX-$label.server.log"
}

# One leg: spawn a verifier with <briefing>, read its reply. Leaves the reader's
# figures in V_* and the capture prefix in MR_PREFIX. 1 where no verifier was
# spawned (recorded as a failed criterion).
# Usage: vf_run_leg <leg> <briefing>
vf_run_leg() {
  local leg="$1" briefing="$2" analysis
  MR_PREFIX="$PREFIX-$leg"
  : > "$E2E_AUDIT_MANIFEST"
  mr_say ""
  mr_say "--- $leg ---"
  if ! rr_run_role verifier "$briefing" "$SPAWN_TIMEOUT_S" "$TURN_TIMEOUT_S" "$FINISH_TIMEOUT_S" "$SETTLE_TIMEOUT_S"; then
    VF_PRIMARY_SIDS="$VF_PRIMARY_SIDS $RR_SID"
    mr_record "$leg spawned — a verifier was spawned" 0 "no verifier was spawned at all: $MR_WAIT_REASON"
    return 1
  fi
  VF_PRIMARY_SIDS="$VF_PRIMARY_SIDS $RR_SID"
  VF_SUB_SIDS="$VF_SUB_SIDS $RR_SUB_SID"
  mr_record "$leg spawned — a verifier was spawned" 1 "$RR_SUB_HANDLE session=$RR_SUB_SID"
  VF_REPLY_SOURCE="$RR_REPLY_SOURCE"
  analysis="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
  python3 "$HERE/lib/verifier-reply.py" "$RR_REPLY_FILE" > "$analysis" 2>/dev/null
  V_head="" V_head_ok=0 V_checks="" V_pass="" V_fail="" V_not_run="" V_verdict1="" V_verdict1_line=""
  V_pageerror=0 V_pageerror_line="" V_red_or_broken=0 V_no_vision=0 V_any_pass=0
  mr_load_kv "$analysis" V_
  mr_note "$leg reply" "$VF_REPLY_SOURCE: $RR_REPLY_FILE — ${V_head:-no Checks: line}"
  mr_note "$leg ended" "${RR_ENDED:-it did not end within ${FINISH_TIMEOUT_S}s}"
  return 0
}

# The leg's model audit over its own captures, under the pins now in force.
vf_leg_audit() {
  local leg="$1" ok=0
  e2e_audit_recorded "$PREFIX-$leg" /dev/null > /dev/null 2>&1 && ok=1
  mr_record "$leg model-pin" "$ok" "$E2E_AUDIT_LINE"
}

BRIEF_PAGEERROR="Check the page /index.html of this project in a real browser; AGENTS.md says how to serve it. One check: the page loads without a page error. Quote every [pageerror] line that pw console shows."
BRIEF_CANVAS="Check the page /canvas.html of this project in a real browser; AGENTS.md says how to serve it. One check: the page shows a green OK banner. Take a screenshot and judge the check by what you see on it."

# ---------- server A: legs 1 and 3, the verifier on E2E_MODEL ----------------

mr_debug_start
vf_start_server legA
OPENCODE_URL="$BASE"
export OPENCODE_URL
LOG_OFFSET_KEPT=$MR_LOG_OFFSET
mr_init "$PREFIX"
MR_LOG_OFFSET=$LOG_OFFSET_KEPT
mr_check_settings skip-midrun

E2E_SEES=0
e2e_model_has_image_input "$E2E_MODEL_REF" && E2E_SEES=1

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
server              opencode serve --port $PORT --hostname 127.0.0.1   (owned by this driver, restarted per pin)
fixture project     $PROJECT   (served on port $HTTP_PORT per its AGENTS.md)
no-browser dir      $NO_BROWSERS   (empty, read-only; leg 4's PLAYWRIGHT_BROWSERS_PATH)
isolated config     $E2E_ISO_OPENCODE_DIR   (the machine's ~/.config/opencode is not written)
E2E_MODEL           $E2E_MODEL_REF   (declares image input: $([ "$E2E_SEES" = 1 ] && echo yes || echo no))
E2E_VISION_MODEL    ${E2E_VISION_MODEL_REF:-unset}
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF

if vf_run_leg leg1 "$BRIEF_PAGEERROR"; then
  mr_record "leg1 head — the reply opens with a Checks: line" \
    "$([ "$V_head_ok" = 1 ] && echo 1 || echo 0)" "${V_head:-no Checks: line}"
  mr_record "leg1 fail — the page error makes the check FAIL" \
    "$([ "$V_fail" = 1 ] && [ "$V_any_pass" = 0 ] && echo 1 || echo 0)" \
    "head '${V_head}', first check line '${V_verdict1_line}'"
  mr_record "leg1 pageerror — the [pageerror] line is quoted" \
    "$([ "$V_pageerror" = 1 ] && echo 1 || echo 0)" "${V_pageerror_line:-no [pageerror] line in the reply}"
  PW_STARTED=$(mr_first_in "$RR_SUB_FLAT" "pw: daemon started")
  mr_record "leg1 pw — pw start answered in the verifier's shell" \
    "$([ -n "$PW_STARTED" ] && echo 1 || echo 0)" \
    "${PW_STARTED:-no 'pw: daemon started' in $RR_SUB_FLAT}"
fi
vf_leg_audit leg1

if [ "$E2E_SEES" = 1 ]; then
  mr_note_uncovered "leg3 — a verifier on a model without image input" \
    "SKIP: E2E_MODEL $E2E_MODEL_REF declares image input"
elif vf_run_leg leg3 "$BRIEF_CANVAS"; then
  mr_record "leg3 not-run — the look it cannot take is NOT RUN" \
    "$([ "$V_verdict1" = "NOT RUN" ] && echo 1 || echo 0)" "first check line '${V_verdict1_line}'"
  mr_record "leg3 reason — no vision is given as the reason" \
    "$([ "$V_no_vision" = 1 ] && echo 1 || echo 0)" "reply $RR_REPLY_FILE"
  mr_record "leg3 no-pass — nothing it could not see is PASS" \
    "$([ "$V_any_pass" = 0 ] && echo 1 || echo 0)" "head '${V_head}'"
  vf_leg_audit leg3
fi

e2e_server_stop

# ---------- server B: leg 2, the verifier on E2E_VISION_MODEL ----------------

if [ -z "$E2E_VISION_MODEL_REF" ]; then
  mr_note_uncovered "leg2 — a verifier that sees the screenshot" "SKIP: no E2E_VISION_MODEL"
else
  e2e_iso_pin_agent verifier "$E2E_VISION_MODEL_REF" || mr_die "could not pin the verifier to $E2E_VISION_MODEL_REF"
  vf_start_server legB
  # Leg 3 ran on the same fixture and may have left a screenshot where this
  # leg's verifier writes its own, so a screenshot counts by its time: one
  # written after this leg started.
  LEG2_START="$FIXTURE_ROOT/leg2.start"
  touch "$LEG2_START"
  if vf_run_leg leg2 "$BRIEF_CANVAS"; then
    SHOTS=$(find "$PROJECT/work" -path '*/verify-*/*.png' -newer "$LEG2_START" 2>/dev/null | tr '\n' ' ')
    mr_record "leg2 fail — the red BROKEN canvas FAILs the green-banner check" \
      "$([ "$V_verdict1" = FAIL ] && [ "$V_any_pass" = 0 ] && echo 1 || echo 0)" "first check line '${V_verdict1_line}'"
    mr_record "leg2 screenshot — a screenshot written in this leg stands under work/verify-*/" \
      "$([ -n "$SHOTS" ] && echo 1 || echo 0)" "${SHOTS:-no work/verify-*/*.png in $PROJECT written after this leg started}"
    mr_record "leg2 seen — the evidence names red or BROKEN" \
      "$([ "$V_red_or_broken" = 1 ] && echo 1 || echo 0)" "reply $RR_REPLY_FILE"
    vf_leg_audit leg2
  fi
  e2e_server_stop
  e2e_iso_pin_agent verifier "$E2E_MODEL_REF" || mr_die "could not pin the verifier back to $E2E_MODEL_REF"
fi

# ---------- server C: leg 4, no Chromium reachable ---------------------------

# The isolated home's .cache is a link to the machine's, where Playwright's
# default browser directory (ms-playwright) holds the installed Chromium. For
# leg 4 it becomes a directory of links to every entry of the machine's cache
# except that one, so a pw run with PLAYWRIGHT_BROWSERS_PATH unset finds no
# browser either. Everything else under .cache — the plugin's debug log and pw
# runtime files, opencode's own cache — stays the machine's.
vf_hide_browser_cache() {
  local iso="$E2E_ISO_HOME/.cache" real entry
  [ "${E2E_ISO_OWNER:-}" = "$$" ] || mr_die "the isolated home $E2E_ISO_HOME was not built by this driver — leg 4 cannot hide the browser cache in it"
  [ -L "$iso" ] || return 0
  real=$(readlink -f "$iso") || mr_die "cannot resolve $iso"
  rm -- "$iso" && mkdir -- "$iso" || mr_die "cannot replace the link $iso with a directory"
  for entry in "$real"/* "$real"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "$(basename "$entry")" = ms-playwright ] && continue
    ln -s -- "$entry" "$iso/" || mr_die "cannot link $entry into $iso"
  done
  mr_say "leg 4: $iso holds the machine's cache without ms-playwright"
}

# A bash call of the verifier that clears or re-points PLAYWRIGHT_BROWSERS_PATH
# instead of running pw with the environment as given.
VF_ENV_ESCAPE='^input=.*(env[^|;&]* -u *PLAYWRIGHT_BROWSERS_PATH|unset +PLAYWRIGHT_BROWSERS_PATH|PLAYWRIGHT_BROWSERS_PATH=|env +-i\b)'

# A bash call of the verifier that uses a browser past pw: `playwright install`
# run as a command, or a browser binary launched as a command (by path or by
# name). A command starts at the head of the call or after `;`, `&`, `|` with a
# space behind it, `(` or a line break, and may carry sudo/nohup/exec/setsid/
# timeout/env in front of it. A path or name in an argument — `ls`, `du`,
# `find`, `pgrep`, `pkill` looking at or cleaning up after a browser — is no
# use. Clearing or re-pointing PLAYWRIGHT_BROWSERS_PATH is VF_ENV_ESCAPE's.
VF_BROWSER_ESCAPE='^input=.*("command": ?"|[;&|][[:space:]]+|[(][[:space:]]*|\\n[[:space:]]*)((sudo|nohup|exec|setsid|timeout +[0-9.]+[smhd]?|env( +[A-Za-z_][A-Za-z0-9_]*=[^ ]*)*) +)*((((npx|bunx|pnpx|pnpm( +exec| +dlx)?|yarn( +dlx)?)( +-[^ ]+)* +|python3? +-m +)?([^ ;&|"]*/)?playwright(@[^ ]+)?( +-[^ ]+)* +install\b)|([^ ;&|"]*/)?(chrome|chromium|chromium-browser|google-chrome|headless_shell|chrome-headless-shell)([ ;&|"]|\\|$))'

vf_hide_browser_cache
vf_start_server legC "PLAYWRIGHT_BROWSERS_PATH=$NO_BROWSERS"
if vf_run_leg leg4 "$BRIEF_PAGEERROR"; then
  mr_record "leg4 not-run — with no browser the check is NOT RUN" \
    "$([ "$V_verdict1" = "NOT RUN" ] && echo 1 || echo 0)" "first check line '${V_verdict1_line}'"
  mr_record "leg4 no-pass — nothing it could not run is PASS" \
    "$([ "$V_any_pass" = 0 ] && echo 1 || echo 0)" "head '${V_head}'"
  ESCAPE=$(grep -m1 -E -- "$VF_ENV_ESCAPE" "$RR_SUB_FLAT" 2>/dev/null | cut -c1-240)
  mr_record "leg4 env — pw ran with the environment as given" \
    "$([ -z "$ESCAPE" ] && echo 1 || echo 0)" \
    "${ESCAPE:-no bash call in $RR_SUB_FLAT clears or re-points PLAYWRIGHT_BROWSERS_PATH}"
  BROWSER=$(grep -m1 -E -- "$VF_BROWSER_ESCAPE" "$RR_SUB_FLAT" 2>/dev/null | cut -c1-240)
  mr_record "leg4 browser — no bash call uses a browser past pw" \
    "$([ -z "$BROWSER" ] && echo 1 || echo 0)" \
    "${BROWSER:-no bash call in $RR_SUB_FLAT runs playwright install or launches a browser binary}"
fi
vf_leg_audit leg4
e2e_server_stop

# ---------- over the whole run ----------------------------------------------

CHANGED=$(git -C "$PROJECT" status --porcelain=v1 2>/dev/null | grep -v '^??' | tr '\n' ' ')
mr_record "untouched — no tracked fixture file changed" \
  "$([ -z "$CHANGED" ] && echo 1 || echo 0)" "${CHANGED:-git status shows no tracked file changed}"

mr_verdict
