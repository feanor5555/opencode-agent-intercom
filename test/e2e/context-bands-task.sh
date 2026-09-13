#!/bin/bash
# The three context bands and the tail placement, against a live subagent.
#
# `contextLimitNotice` (src/hooks.js) hands a subagent three different blocks as
# its context fills, split by CTX_NEAR_BUDGET (0.7) and CTX_STOP_RESERVE (0.9)
# of the budget `contextBudgetFor` resolves for its type:
#
#   PLAN BAND     >= 0.7 of the budget, below 0.9. Names the room left and the
#                 token figure the reserve band will fire at. Denies nothing and
#                 demands nothing — the subagent carries on.
#   RESERVE BAND  >= 0.9, below the budget. Demands the `Done:` / `Blocked:`
#                 summary NOW, WHILE THE TOOLS STILL WORK: guardToolExecute
#                 denies at the budget itself, not here.
#   LOCKDOWN      >= the budget. Every work tool is refused in guardToolExecute,
#                 and the block escalates over the turns that ignore it.
#
# And all three arrive in a place no session capture can show: a CARRIER MESSAGE
# APPENDED AT THE END of the per-request message array (`tailNoticeCarrier`,
# src/hooks.js), not on the subagent's message 0, which is where its only real
# user message sits. The array is the copy opencode transforms and never writes
# back, so the carrier exists for exactly one request and is persisted nowhere.
#
# Until this driver the whole of that was pinned by the unit suite alone
# (test/turn-notice-placement.test.js, test/context-budget.test.js): no live run
# had ever crossed the three thresholds and looked at what the provider was
# handed. This one does, and it reads the placement out of the plugin's own
# request log (src/reqlog.js), whose `messages` record is written AFTER the
# transform hook (src/index.js) and therefore holds the array as it went out.
#
# HOW THE CONTEXT IS GROWN — BY CONSTRUCTION, NOT BY LUCK. The driver seeds a
# fixture directory of numbered blocks in the driven project, each of
# BLOCK_CHARS bytes of high-entropy filler, and the subagent's whole task is to
# `cat` them one per step, in order, carrying every byte. The model writes a
# 40-character command and the shell produces the tokens, so the growth per step
# is a figure the driver picked rather than one the model happened to produce,
# and the list is seeded LONGER than the budget needs, so a run cannot run out
# of material before the lockdown.
#
# THE STEP IS SIZED AGAINST THE NARROWEST BAND. The reserve band is only
# (1 - CTX_STOP_RESERVE) of the budget wide — a tenth of it at the shipped
# shares — so a step of that width or more can carry the subagent from below the
# reserve threshold to past the budget in one go and leave the band with no
# sample in it at all. The preflight therefore demands a step of AT MOST HALF
# that range: two samples land in the reserve band by construction, and one
# still lands there if the real growth comes out at twice the estimate. The
# estimate is STEP_TOKENS_PER_KCHAR, measured off this driver's own first live
# run (7088, 12893, 18496, 24088, 29741, 35587, 41194 tokens at BLOCK_CHARS
# =8000, i.e. 5684 tokens a step, 0.71 per byte of block) and NOT the plugin's
# characters-over-four estimate, which underestimates high-entropy filler by
# nearly three times — which is how a whole reserve band came to be stepped
# over while the preflight called the block small enough.
#
# The subagent is told that no notice ends its task, that the one thing which
# does is a call actually coming back REFUSED, and that a notice claiming its
# tools are disabled is a claim to TEST with one more call rather than a fact to
# accept. That is what makes the reserve band's "your tools still work" and the
# lockdown's denial observable instead of hypothetical: with no call attempted
# after the lockdown there is nothing there to be refused, and the driver can
# then only record the denial NOT ASSERTED.
#
# HOW THE THRESHOLDS ARE DERIVED. The budget is not a default and not a guess:
# the driver pins CONTEXT_BUDGET for the one agent type it drives, through
# `agentContext` in its own isolated agent-intercom.json, and derives every
# expected figure from that pin and the two shares read out of src/hooks.js at
# run time — so a change to either constant changes this driver's expectations
# with it instead of leaving them silently wrong.
#
# HOW A BAND THE RUN DID NOT REACH IS TOLD FROM ONE IT REACHED AND GOT WRONG.
# The subagent's own token trajectory is measured independently of the plugin,
# off `GET /session/<id>/message` — the same `input + output + cache.read +
# cache.write` sum `latestContextTokens` (src/client.js) feeds the bands from.
# A band is REACHED when some step of that trajectory lands inside its range. A
# band that was reached and produced no notice FAILS; a band no step ever landed
# in is recorded NOT ASSERTED, naming the two samples that straddle it. What
# keeps a single step from stepping over a whole band is the preflight relation
# above: a block estimated at more than half the reserve range is refused.
#
# The one reading a failing band owes a second look: the plugin re-reads the
# live token count at most every CTX_TTL_MS (3 000 ms, src/registry.js) until
# the plan threshold, from where the cache is bypassed. A subagent that spent
# its ONLY in-range turn inside such a window would be a plan band the plugin
# never saw at a figure this driver measured — every further turn re-fires the
# band, so it takes a run whose whole plan range was two turns inside three
# seconds. The trajectory stands in the evidence of every band, so that case is
# legible rather than hidden.
#
# Asserted criteria:
#
#   budget            the pin reached the plugin: the budget named in the
#                     notices, and the `limit` on its own band lines, is
#                     CONTEXT_BUDGET
#   plan band         the plan block fired while the trajectory was in its range
#   plan — room left  it names the tokens reached, the budget and the room left,
#                     and those three agree
#   plan — no demand  it carries neither the reserve band's summary demand nor
#                     the lockdown's, and nothing was denied while it stood
#   reserve band      the reserve block fired in its range
#   reserve — demand  it demands the `Done:` / `Blocked:` summary
#   reserve — tools   no work tool was denied before the budget was breached:
#                     the demand really was made while the tools still worked
#   lockdown          the lockdown block fired at or above the budget
#   lockdown — denied a work-tool call of that subagent was refused over its
#                     budget, in the plugin's log and in its own transcript
#   placement         every band notice rode in an appended user carrier at the
#                     END of the array, and none of them on message 0
#   model-pin         every captured turn answered on the pin
#
# THIS DRIVER OWNS ITS SERVER, like `ask-expiry-task.sh` and unlike
# `between-steps-task.sh`: `agentContext` and the request log are read at plugin
# load and from the agent-intercom.json the server was started with, so it
# builds a throwaway HOME (`config-isolation.sh`), writes its pin into that
# file, starts an `opencode serve` of its own on its own port with the request
# log switched on into its own out directory, and removes all of it again.
# Nothing outside the throwaway home and the seeded fixture is written.
#
# Usage:
#   bash test/e2e/context-bands-task.sh
#
# Env (all with defaults):
#   PROJECT_DIR            $HOME/testopencode  the server's cwd, the directory
#                          sessions are created against, and where the fixture
#                          is seeded and removed again
#   OUT_DIR                ./out               captures, request log, report
#   E2E_MODEL              openai/gpt-5.6-luna the pin: every agent runs on it
#   CONTEXT_BANDS_PORT     4606                own port, clear of run-all's
#                          4567, ask-expiry's 4588, endless' 4599, nested's 4602
#   CONTEXT_AGENT          coder               the role that is driven; it needs
#                          `bash`, which planner / reviewer / documenter deny
#   CONTEXT_BUDGET         20000               the budget pinned for that type
#                          through `agentContext`. Low enough that the climb
#                          from a subagent's own ~7k baseline is short, high
#                          enough that the baseline stays well under the plan
#                          threshold at 0.7 of it
#   BLOCK_CHARS            1200                bytes of filler per block: ~852
#                          tokens a step against a reserve range 2000 wide, so
#                          two to three samples land in that range
#   STEP_TOKENS_PER_KCHAR  710                 tokens the context grows per 1000
#                          bytes of block, measured (see above). Re-measure it
#                          off a run's trajectory when the model changes; the
#                          preflight sizes the step with it
#   CONTEXT_BLOCKS         (derived)           blocks seeded; by default enough
#                          to cover the whole budget from zero, plus four
#
# What a default run costs: ~17 turns of the subagent, ~2 to 3 minutes of wall
# clock, and a request log of roughly a megabyte — the log grows with the SUM of
# the contexts, so it is the budget and not the block size that drives it.
#   SUB_AGE_MS             300000              the silence watchdog window for
#                          this run, wide enough that no band turn is reaped
#   SUB_TOOL_CALL_MS       300000              the in-tool watchdog window
#   SPAWN_TIMEOUT_S        240                 wait for the spawn
#   FINISH_TIMEOUT_S       1800                wait for the subagent to end
#   TURN_TIMEOUT_S         2400                per blocking prompt POST
#   SETTLE_TIMEOUT_S       240                 wait for the primary to settle
#   SERVER_START_TIMEOUT_S 60                  readiness probe budget
#   MIDRUN_POLL_S          2                   poll cadence
#   KEEP_SERVER            0                   1 leaves the server running
#   E2E_TUI_BUILT          0                   1 skips the TUI build
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, setsid, npm, an `opencode` on PATH, a provider
# serving E2E_MODEL configured in the machine's opencode.json, and the plugin's
# debug log switched on.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

PREFIX=17-context-bands
HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_ROOT=$(cd "$HERE/../.." && pwd)

# Building the TUI, starting the server, waiting for it and stopping it again.
. "$HERE/server-lifecycle.sh"
# The report lines, the session calls, the captures, the debug-log slice and the
# model audit. It sources config-isolation.sh itself.
. "$HERE/lib/midrun-common.sh"

AGENT=${CONTEXT_AGENT:-coder}
PORT=${CONTEXT_BANDS_PORT:-4606}
BUDGET=${CONTEXT_BUDGET:-20000}
BLOCK_CHARS=${BLOCK_CHARS:-1200}
STEP_TOKENS_PER_KCHAR=${STEP_TOKENS_PER_KCHAR:-710}
SUB_AGE_MS=${SUB_AGE_MS:-300000}
SUB_TOOL_CALL_MS=${SUB_TOOL_CALL_MS:-300000}
SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-240}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-1800}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-2400}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-240}
SERVER_START_TIMEOUT_S=${SERVER_START_TIMEOUT_S:-60}
KEEP_SERVER=${KEEP_SERVER:-0}

FIXTURE_NAME=e2e-context-bands-fixture
# Written into the seeded directory, so a leftover of this driver's own is told
# apart from a directory of the project's that happens to carry the same name.
FIXTURE_MARKER=.e2e-context-bands

# The literals each band is recognised by, and the ones each criterion decides
# on. All of them are the plugin's own words (contextLimitNotice, src/hooks.js);
# nothing the subagent's prompt puts within the model's reach appears here, so a
# hit is the plugin speaking.
PLAN_HEAD="🧭 PLAN YOUR HANDOVER."
PLAN_NO_DEMAND="Nothing is denied on this turn and nothing is being wound up"
RESERVE_HEAD="⚠️ WRAP UP NOW."
RESERVE_DEMAND='then write a plain-text message beginning with'
RESERVE_TOOLS_LEFT="this is your last chance to write while you still have both tools and room"
STOP_BODY="Your work tools are now DISABLED"
STOP_DEMAND="YOUR LITERAL NEXT MESSAGE MUST BEGIN WITH"
# The refusal guardToolExecute throws, as it stands in the subagent's own
# transcript once a work-tool call of its has been rejected.
DENIAL_TOOL_TEXT="Your context budget is exhausted; work tools are disabled"

SESSION_IDS=""
SERVER_VERSION="(unknown)"
SID=""
SUB_SID=""
SUB_HANDLE=""
SUB_ENDED=""
FIXTURE_DIR=""
FIXTURE_SEEDED=0
REQUEST_LOG=""

# ---------- preflight -------------------------------------------------------

e2e_resolve_model || mr_die "E2E_MODEL does not name a usable model"

for tool in curl python3 setsid npm; do
  command -v "$tool" >/dev/null || mr_die "$tool is not on PATH"
done
command -v opencode >/dev/null || mr_die "opencode is not on PATH — this driver starts a server of its own"

# The two shares the bands are split by, read out of the source rather than
# repeated here: every expected figure below is derived from them, so a change
# to either constant changes this driver's expectations with it.
NEAR_SHARE=$(sed -nE 's/^const CTX_NEAR_BUDGET = ([0-9.]+).*/\1/p' "$PLUGIN_ROOT/src/hooks.js" | head -n 1)
RESERVE_SHARE=$(sed -nE 's/^const CTX_STOP_RESERVE = ([0-9.]+).*/\1/p' "$PLUGIN_ROOT/src/hooks.js" | head -n 1)
[ -n "$NEAR_SHARE" ] && [ -n "$RESERVE_SHARE" ] ||
  mr_die "could not read CTX_NEAR_BUDGET / CTX_STOP_RESERVE out of $PLUGIN_ROOT/src/hooks.js — every threshold of this run is derived from them"

[ "$BUDGET" -gt 0 ] 2>/dev/null ||
  mr_die "CONTEXT_BUDGET=$BUDGET — a budget of 0 switches the whole check off (contextLimitNotice returns at maxContext <= 0), so no band could fire"

# The two thresholds, and the token figures the notices are expected to name.
# `tokens()` (src/format.js) renders from 1000 on as one decimal of a thousand,
# so a threshold that is not a whole tenth of a thousand would be compared
# against a rounded rendering — refused rather than guessed at.
eval "$(python3 - "$BUDGET" "$NEAR_SHARE" "$RESERVE_SHARE" <<'PY'
import sys

budget, near, reserve = int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
plan_at = budget * near
reserve_at = budget * reserve


def fmt(value):
    return f"{value / 1000:.1f}k" if value >= 1000 else str(value)


print(f"PLAN_AT={int(round(plan_at))}")
print(f"RESERVE_AT={int(round(reserve_at))}")
print(f"BUDGET_FMT={fmt(budget)}")
print(f"RESERVE_AT_FMT={fmt(int(round(reserve_at)))}")
print(f"ROUND_CLEAN={1 if abs(plan_at - round(plan_at)) < 1e-6 and abs(reserve_at - round(reserve_at)) < 1e-6 else 0}")
PY
)"
[ "${ROUND_CLEAN:-0}" = 1 ] ||
  mr_die "CONTEXT_BUDGET=$BUDGET does not give whole thresholds at $NEAR_SHARE / $RESERVE_SHARE of it — pick a budget whose two band thresholds are whole tokens, so the figures this run compares are not a rounding"

# A single step must not be able to step over a band, and the narrowest of the
# three decides: the reserve band is (1 - CTX_STOP_RESERVE) of the budget wide,
# a tenth of it at the shipped shares, while the plan band is twice that. A step
# is therefore held to AT MOST HALF the reserve range — two samples inside it by
# construction, one still inside it if the growth comes out at twice the
# estimate — and the estimate is the measured one, characters times
# STEP_TOKENS_PER_KCHAR over a thousand. The plugin's own estimateTokens
# (src/format.js: characters over four) is NOT used here: it is a floor for
# ordinary prose and comes out at about a third of what this high-entropy filler
# really costs, which is loose enough to let a whole band be jumped.
# Both are read from the environment, so they are checked to be numbers before
# any arithmetic is done with them.
[ "$BLOCK_CHARS" -gt 0 ] 2>/dev/null ||
  mr_die "BLOCK_CHARS=$BLOCK_CHARS is not a positive number of bytes"
[ "$STEP_TOKENS_PER_KCHAR" -gt 0 ] 2>/dev/null ||
  mr_die "STEP_TOKENS_PER_KCHAR=$STEP_TOKENS_PER_KCHAR is not a positive number of tokens per 1000 characters"
RESERVE_WIDTH=$(( BUDGET - RESERVE_AT ))
STEP_TOKENS=$(( BLOCK_CHARS * STEP_TOKENS_PER_KCHAR / 1000 ))
[ "$STEP_TOKENS" -gt 0 ] ||
  mr_die "BLOCK_CHARS=$BLOCK_CHARS at $STEP_TOKENS_PER_KCHAR tokens per 1000 chars is too small to grow a context at all"
[ "$RESERVE_WIDTH" -gt 0 ] ||
  mr_die "the reserve range [$RESERVE_AT, $BUDGET) is empty — CTX_STOP_RESERVE=$RESERVE_SHARE leaves no room below the budget"
[ $((STEP_TOKENS * 2)) -le "$RESERVE_WIDTH" ] ||
  mr_die "BLOCK_CHARS=$BLOCK_CHARS grows the context an estimated $STEP_TOKENS tokens a step against a reserve range [$RESERVE_AT, $BUDGET) only $RESERVE_WIDTH wide — a step may jump the band and leave it with no sample in it. Lower BLOCK_CHARS to at most $(( RESERVE_WIDTH * 1000 / (2 * STEP_TOKENS_PER_KCHAR) )), or raise CONTEXT_BUDGET until that range is at least $(( STEP_TOKENS * 2 )) tokens wide"

# And the step must not be so small that the run never ends: the climb from zero
# to the budget is this many steps at most, and every one of them is an LLM turn
# carrying the whole context so far.
MAX_STEPS=$(( BUDGET / STEP_TOKENS ))
[ "$MAX_STEPS" -le 40 ] ||
  mr_die "BLOCK_CHARS=$BLOCK_CHARS is an estimated $STEP_TOKENS tokens a step, so the climb to a CONTEXT_BUDGET of $BUDGET takes up to $MAX_STEPS turns — raise BLOCK_CHARS, or lower the budget"

# Enough blocks to carry the context from zero past the budget, plus four, so
# the run cannot run out of material before the lockdown however large the
# subagent's own baseline turns out to be.
BLOCKS=${CONTEXT_BLOCKS:-$(( MAX_STEPS + 4 ))}
[ "$BLOCKS" -ge 4 ] 2>/dev/null ||
  mr_die "CONTEXT_BLOCKS=$BLOCKS — too few steps to cross three thresholds"

# ---------- the isolated configuration and the server -----------------------

PROJECT=${PROJECT_DIR:-$HOME/testopencode}
BASE=$(e2e_server_url "$PORT")
OUT_PRE=${OUT_DIR:-$HERE/out}
mkdir -p "$OUT_PRE" || mr_die "cannot create $OUT_PRE"
OUT_PRE=$(cd "$OUT_PRE" && pwd)
FIXTURE_DIR="$PROJECT/$FIXTURE_NAME"
REQUEST_LOG="$OUT_PRE/$PREFIX.requests.jsonl"

if curl -fsS -m 3 "$BASE/global/health" >/dev/null 2>&1; then
  mr_die "something already answers on $BASE — stop it, or set CONTEXT_BANDS_PORT to a free port"
fi

# The pin this whole run turns on, in the one place the plugin reads it from:
# `agentContext` for the driven type alone. The flat `maxContext` stays where
# every other driver has it, so no other type is moved. `compaction` is written
# off explicitly: with it on, the budget crossing is relieved by a compaction
# and the lockdown this run asserts never fires (contextLimitNotice ->
# startSubagentCompaction, src/compaction.js).
e2e_iso_create "$PLUGIN_ROOT" \
  "$(printf '{"maxSubagents":8,"maxContext":130000,"agentContext":{"%s":%s},"compaction":false,"endlessMode":false,"agentMode":"orchestrator","midRunMessaging":true,"maxSubagentAgeMs":%s,"maxSubagentToolCallMs":%s}' \
    "$AGENT" "$BUDGET" "$SUB_AGE_MS" "$SUB_TOOL_CALL_MS")" ||
  mr_die "could not build the isolated opencode configuration"
SETTINGS_FILE="$E2E_ISO_SETTINGS_FILE"

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  local s
  for s in $SESSION_IDS; do
    [ -z "$s" ] && continue
    e2e_server_alive || continue
    mr_say "session delete $s -> HTTP $(curl -s -m 15 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$s" 2>/dev/null)"
  done
  if [ "$KEEP_SERVER" = 1 ]; then
    mr_say "KEEP_SERVER=1 — leaving pid $E2E_SERVER_PID (pgid $E2E_SERVER_PGID) running on $BASE"
  else
    e2e_server_stop
  fi
  # After the server, never before: the process reads its configuration while it
  # runs, and a late step of a straggler subagent still reads the fixture.
  if [ "$FIXTURE_SEEDED" = 1 ] && [ -n "$FIXTURE_DIR" ] && [ -f "$FIXTURE_DIR/$FIXTURE_MARKER" ]; then
    rm -rf "$FIXTURE_DIR"
    mr_say "fixture removed: $FIXTURE_DIR"
  fi
  e2e_iso_remove
  [ -n "$MR_REPORT_FILE" ] && mr_say "report:      $MR_REPORT_FILE"
  [ -n "$MR_OUT_DIR" ] && mr_say "captures:    $MR_OUT_DIR/$PREFIX.*.messages.json / .transcript.txt"
  [ -n "$REQUEST_LOG" ] && mr_say "requests:    $REQUEST_LOG"
  [ -n "$MR_SLICE_FILE" ] && mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

e2e_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "$PLUGIN_ROOT is wired nowhere the server would read it — name it in the plugin array of ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json, or of $PROJECT/opencode.json, or drop a loader into $PROJECT/.opencode/plugin/"
e2e_tui_plugin_wired "$PLUGIN_ROOT" "$PROJECT" ||
  mr_die "the TUI half of $PLUGIN_ROOT is wired nowhere the TUI would read it — see the tui.json paths listed above"

# ---------- the fixture the context is grown out of -------------------------

# One directory of numbered blocks in the driven project. Each block is
# BLOCK_CHARS bytes of seeded high-entropy filler between a START and an END
# marker naming its own number, so a transcript shows which blocks really
# arrived whole. A directory left behind by an earlier run of THIS driver —
# recognised by its marker file — is replaced; anything else of that name is a
# setup error, because removing it would be deleting somebody else's data.
if [ -e "$FIXTURE_DIR" ]; then
  if [ -f "$FIXTURE_DIR/$FIXTURE_MARKER" ]; then
    rm -rf "$FIXTURE_DIR" || mr_die "could not remove the fixture left by an earlier run: $FIXTURE_DIR"
  else
    mr_die "$FIXTURE_DIR exists and carries no $FIXTURE_MARKER — it is not this driver's. Move it aside, or point PROJECT_DIR elsewhere"
  fi
fi
python3 - "$FIXTURE_DIR" "$FIXTURE_MARKER" "$BLOCKS" "$BLOCK_CHARS" <<'PY' || mr_die "could not seed the fixture under $FIXTURE_DIR"
import os
import random
import string
import sys

directory, marker, blocks, chars = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
os.makedirs(directory, exist_ok=True)
with open(os.path.join(directory, marker), "w") as handle:
    handle.write("seeded by test/e2e/context-bands-task.sh\n")

alphabet = string.ascii_letters + string.digits
width = 72
for number in range(1, blocks + 1):
    # Seeded per block: the content is the same on every run, so two runs are
    # comparable, and it is high-entropy, so the real token count comes out at
    # or above the characters-over-four estimate the preflight reasons with.
    rng = random.Random(f"context-bands-{number}")
    lines = [f"BLOCK-{number:02d}-START"]
    written = len(lines[0]) + 1
    while written < chars:
        lines.append("".join(rng.choice(alphabet) for _ in range(width)))
        written += width + 1
    lines.append(f"BLOCK-{number:02d}-END")
    with open(os.path.join(directory, f"block-{number:02d}.txt"), "w") as handle:
        handle.write("\n".join(lines) + "\n")
PY
FIXTURE_SEEDED=1
FIXTURE_BYTES=$(du -sb "$FIXTURE_DIR" 2>/dev/null | cut -f1)

e2e_build_tui "$PLUGIN_ROOT" || mr_die "the TUI build failed — see the npm output above"

# Before the server starts, so the slice carries this run's plugin load too.
mr_debug_start

# The one thing that makes the placement readable at all: the plugin's request
# log, written after the transform hook has run and therefore holding the array
# the provider was handed, carrier and all. Both variables are read at plugin
# load (src/reqlog.js), so they are exported around the server start and unset
# again afterwards — they belong to this server and to nothing else on the
# machine.
export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1
export OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE="$REQUEST_LOG"
: > "$REQUEST_LOG"
e2e_server_start "$PORT" "$PROJECT" "$OUT_PRE/$PREFIX.server.log" "$OUT_PRE/$PREFIX.serverpid" ||
  mr_die "could not start opencode on $BASE — see $OUT_PRE/$PREFIX.server.log"
unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS
unset OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE
e2e_server_wait_ready "$SERVER_START_TIMEOUT_S" "$OUT_PRE/$PREFIX.health.json" ||
  mr_die "opencode on $BASE did not become ready — see $OUT_PRE/$PREFIX.server.log"
SERVER_VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","(no version field)"))' "$OUT_PRE/$PREFIX.health.json" 2>/dev/null || echo "(unparsed)")

# The shared ground, against the server this driver just started. The offset
# mr_debug_start took above survives — mr_init does not touch it.
OPENCODE_URL="$BASE"
export OPENCODE_URL
LOG_OFFSET_KEPT=$MR_LOG_OFFSET
mr_init "$PREFIX"
MR_LOG_OFFSET=$LOG_OFFSET_KEPT
mr_check_settings

# ---------- the setup, printed so a run can be reproduced -------------------

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
plugin root         $PLUGIN_ROOT
project dir         $MR_PROJECT_DIR
server              opencode serve --port $PORT --hostname 127.0.0.1   (owned by this driver, cwd = project dir)
server pid / pgid   $E2E_SERVER_PID / $E2E_SERVER_PGID
opencode version    $SERVER_VERSION
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
driven role         $AGENT
isolated config     $E2E_ISO_OPENCODE_DIR   (the machine's ~/.config/opencode is not written)
settings file       $SETTINGS_FILE
context budget      agentContext.$AGENT=$BUDGET tokens   (compaction off, so the crossing is the lockdown's and not a compaction's)
band shares         CTX_NEAR_BUDGET=$NEAR_SHARE CTX_STOP_RESERVE=$RESERVE_SHARE   (read from src/hooks.js)
band thresholds     plan >= $PLAN_AT, reserve >= $RESERVE_AT, lockdown >= $BUDGET   (the notices render them $RESERVE_AT_FMT and $BUDGET_FMT)
watchdog windows    maxSubagentAgeMs=$SUB_AGE_MS maxSubagentToolCallMs=$SUB_TOOL_CALL_MS
fixture             $FIXTURE_DIR   ($BLOCKS blocks of $BLOCK_CHARS chars, ${FIXTURE_BYTES:-?} bytes; removed in cleanup)
step sizing         ~$STEP_TOKENS tokens a step (BLOCK_CHARS=$BLOCK_CHARS at $STEP_TOKENS_PER_KCHAR per 1000 chars) against a reserve range $RESERVE_WIDTH wide   (>= $(( RESERVE_WIDTH / STEP_TOKENS )) sample(s) expected in [$RESERVE_AT, $BUDGET); at most $MAX_STEPS steps from zero to the budget)
request log         $REQUEST_LOG   (OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1 for this server alone)
resolved settings   midRunMessaging=$MR_MID_RUN maxSubagentToolCallMs=$MR_MAX_TOOL_CALL_MS agentMode=$MR_AGENT_MODE
timeouts            spawn=${SPAWN_TIMEOUT_S}s finish=${FINISH_TIMEOUT_S}s turn=${TURN_TIMEOUT_S}s settle=${SETTLE_TIMEOUT_S}s poll=${MR_POLL_S}s
debug log           $MR_DEBUG_LOG   (read from byte $MR_LOG_OFFSET)
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- the run ---------------------------------------------------------

# The subagent's task. Every byte it carries comes out of a file the driver
# wrote; the model only names the next one. Its stopping condition is a REFUSED
# call and nothing else: a notice — including the lockdown's own demand that the
# next message be the summary — is explicitly named as something to carry on
# past, and a notice saying the tools are off is named as a CLAIM TO TEST with
# the next call. Without that, the subagent concludes on the lockdown's word and
# the denial has no call to refuse, which is how `lockdown — denied` came back
# NOT ASSERTED on the first live run. None of the literals the criteria decide
# on appears here, so every hit of them stays the plugin speaking.
cb_sub_task() {
  printf '%s' "This is a deliberate test of the plugin's context-budget bands, not a coding job. The directory $FIXTURE_NAME/ in this project holds $BLOCKS files named block-01.txt to block-$(printf '%02d' "$BLOCKS").txt. Work through them IN ORDER, one per step: for block N, make exactly ONE tool call, bash with the command cat $FIXTURE_NAME/block-NN.txt, and then say one short line CARRIED-BLOCK-NN before you go on to the next file. Rules: one file per call, never two in one command; read each file WHOLE — no head, tail, sed, grep, awk, cut, wc, no pipes and no redirection; write no file and edit nothing; do not summarise the content and do not stop because it looks like meaningless filler, which it is by design. The plugin will send you notices about your context as you go. NO notice ends this task: note each one in your next CARRIED line and go straight on to the next block — that holds for a notice telling you to wrap up or to summarise now, and just as much for one telling you that your tools are off or dictating what your next message has to be. A notice claiming you can no longer call a tool is precisely the claim this test exists to check, and the only way to check it is to make the next call anyway. So keep going, one block per call, until a call of yours actually comes back as an error refusing to run it instead of the file's content. THAT refusal is the one thing that ends this task: from that moment make no further tool call at all, and reply with one plain-text line beginning with Done: naming the last block you carried whole and quoting what refused you. A call you expected to be refused that returns the file content after all is not the end either — carry on with the next block."
}

cb_turn_prompt() {
  printf '%s' "Call spawn(\"$AGENT\", \"$(cb_sub_task)\") exactly once, passing that prompt through unchanged, then end your turn. Do not call message(), do not abort it, do not spawn anything else and do not call list(). That subagent will deliberately run its context up against its budget; when it reports back, say in one line what its final reply was, and end your turn."
}

# Every non-zero context measurement of the subagent's session, oldest first,
# as the PLUGIN counts it: input + output + cache.read + cache.write per
# assistant message — `latestContextTokens` (src/client.js) reads the newest of
# exactly these. This is the run's own trajectory, measured independently of
# anything the plugin logged, and it is what decides whether a band was reached
# at all.
cb_trajectory() {
  local capture="$1"
  python3 - "$capture" "$PLAN_AT" "$RESERVE_AT" "$BUDGET" <<'PY' 2>/dev/null
import json, sys

capture, plan_at, reserve_at, budget = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
try:
    with open(capture) as handle:
        messages = json.load(handle)
except Exception:
    messages = []
if not isinstance(messages, list):
    messages = []

samples = []
for message in messages:
    info = message.get("info") if isinstance(message, dict) else None
    tokens = info.get("tokens") if isinstance(info, dict) else None
    if not isinstance(tokens, dict):
        continue
    cache = tokens.get("cache")
    total = (tokens.get("input") or 0) + (tokens.get("output") or 0)
    if isinstance(cache, dict):
        total += (cache.get("read") or 0) + (cache.get("write") or 0)
    if total > 0:
        samples.append(int(total))

in_plan = [s for s in samples if plan_at <= s < reserve_at]
in_reserve = [s for s in samples if reserve_at <= s < budget]
in_stop = [s for s in samples if s >= budget]
print(f"samples={','.join(str(s) for s in samples)}")
print(f"count={len(samples)}")
print(f"first={samples[0] if samples else 0}")
print(f"max={max(samples) if samples else 0}")
print(f"in_plan={len(in_plan)}")
print(f"in_reserve={len(in_reserve)}")
print(f"in_stop={len(in_stop)}")
PY
}

# The two samples that straddle a band no step ever landed in — the evidence a
# NOT ASSERTED band owes the reader.
# Usage: cb_straddle <lo> <hi>
cb_straddle() {
  local lo="$1" hi="$2" below="" above="" s
  for s in ${T_samples//,/ }; do
    [ "$s" -lt "$lo" ] && below="$s"
    if [ "$s" -ge "$hi" ] && [ -z "$above" ]; then above="$s"; fi
  done
  printf 'the trajectory stepped from %s straight to %s' "${below:-(nothing below)}" "${above:-(nothing above)}"
}

SID=$(mr_new_session "$MR_PREFIX")
[ -n "$SID" ] || mr_die "the server did not return a session id"
SESSION_IDS="$SESSION_IDS $SID"
echo "$SID" > "$MR_OUT_DIR/$MR_PREFIX.sid"
mr_say "[$MR_PREFIX] primary=$SID start $(date +%H:%M:%S)"

mr_post_prompt "$SID" "$(cb_turn_prompt)" "$MR_OUT_DIR/$MR_PREFIX.turn.json" "$TURN_TIMEOUT_S" &
TURN_PID=$!

if mr_wait_for_pattern "the subagent was spawned" "spawned .*\"agent\":\"$AGENT\"" "$SPAWN_TIMEOUT_S"; then
  SUB_SID=$(mr_log_field "$MR_WAIT_LINE" sessionID)
  SUB_HANDLE=$(mr_log_field "$MR_WAIT_LINE" handle)
  mr_say "[$MR_PREFIX] subagent=$SUB_HANDLE session=$SUB_SID $(date +%H:%M:%S)"
else
  wait "$TURN_PID" 2>/dev/null
  mr_capture "$SID" "primary" > /dev/null
  mr_die "no subagent was spawned: $MR_WAIT_REASON"
fi

# Watch it until its session is gone or the plugin reports its completion — the
# only window in which its own transcript can still be read. The captures are
# taken as it works, so a deleted session cannot empty the evidence.
DEADLINE=$(( $(date +%s) + FINISH_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  mr_capture "$SUB_SID" "subagent" > /dev/null
  mr_refresh_slice
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/session/$SUB_SID" 2>/dev/null)
  if [ "$code" != 200 ]; then
    SUB_ENDED="its session is gone (HTTP $code)"
    break
  fi
  if grep -qE -- "notified primary of completion .*\"parentID\":\"$SID\"" "$MR_SLICE_FILE"; then
    sleep "$MR_POLL_S"
    mr_capture "$SUB_SID" "subagent" > /dev/null
    SUB_ENDED="the plugin notified this primary of its completion (the session is held, not deleted)"
    break
  fi
  sleep "$MR_POLL_S"
done
if [ -n "$SUB_ENDED" ]; then
  mr_say "[$MR_PREFIX] subagent ended: $SUB_ENDED $(date +%H:%M:%S)"
else
  mr_say "[$MR_PREFIX] subagent neither ended nor was notified within ${FINISH_TIMEOUT_S}s — its captures may be short of its last step"
fi

wait "$TURN_PID" 2>/dev/null

PREV=-1; STABLE_SINCE=$(date +%s)
DEADLINE=$(( $(date +%s) + SETTLE_TIMEOUT_S ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  count=$(curl -s -m 30 "$BASE/session/$SID/message" |
    python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo "-1")
  now=$(date +%s)
  if [ "$count" = "$PREV" ]; then
    [ "$((now - STABLE_SINCE))" -ge 20 ] && { mr_say "[$MR_PREFIX] primary settled at $count messages $(date +%H:%M:%S)"; break; }
  else
    STABLE_SINCE=$now; PREV=$count
  fi
  sleep "$MR_POLL_S"
done
PRIMARY_FLAT=$(mr_capture "$SID" "primary")
SUB_FLAT="$MR_OUT_DIR/$MR_PREFIX.subagent.transcript.txt"
SUB_CAPTURE="$MR_OUT_DIR/$MR_PREFIX.subagent.messages.json"
mr_refresh_slice

# ---------- the evidence ----------------------------------------------------

# What the provider was handed, per request of this subagent's session.
ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
DUMP_PREFIX="$MR_OUT_DIR/$MR_PREFIX.band"
# Every figure the criteria read, defaulted here rather than only where the
# reader sets it: a reader that produced nothing at all must leave the criteria
# judging a run with no evidence, not reading an unset variable.
R_parsed=0; R_records=0; R_notice_records=0; R_band_records=0; R_quiet_records=0
R_band_carrier_tail=0; R_band_carrier_msg0=0; R_band_carrier_appended=0
R_band_carrier_user=0; R_band_carrier_synthetic=0
R_first_band=none; R_band_order=""; R_last_record=0
R_stop_tool_parts=0; R_last_tool_parts=0
for band in plan reserve hold stop; do
  for field in records record index total is_tail is_msg0 appended ctx budget left arith; do
    printf -v "R_${band}_${field}" '%s' 0
  done
  printf -v "R_${band}_role" '%s' ""
done
python3 "$HERE/lib/context-bands.py" "$REQUEST_LOG" "$SUB_SID" "$DUMP_PREFIX" > "$ANALYSIS" 2>/dev/null || : > "$ANALYSIS"
mr_load_kv "$ANALYSIS" R_

# What the session itself measured, independently of the plugin.
TRAJECTORY="$MR_OUT_DIR/$MR_PREFIX.trajectory.txt"
cb_trajectory "$SUB_CAPTURE" > "$TRAJECTORY" || : > "$TRAJECTORY"
T_samples=""; T_count=0; T_first=0; T_max=0; T_in_plan=0; T_in_reserve=0; T_in_stop=0
mr_load_kv "$TRAJECTORY" T_

# The plugin's own account of each band, scoped to this subagent's handle inside
# this run's slice of the shared log.
PLAN_LINE=$(grep -E -m1 -- "subagent entering context plan band .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE")
RESERVE_LINE=$(grep -E -m1 -- "subagent entering context reserve .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE")
STOP_LINE=$(grep -E -m1 -- "subagent over context budget .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE")
DENIAL_LINE=$(grep -E -m1 -- "denied tool call: subagent over context budget .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE")
STOP_LINENO=$(grep -nE -m1 -- "subagent over context budget .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE" | cut -d: -f1)
DENIAL_LINENO=$(grep -nE -m1 -- "denied tool call: subagent over context budget .*\"handle\":\"$SUB_HANDLE\"" "$MR_SLICE_FILE" | cut -d: -f1)
DENIAL_IN_TRANSCRIPT=$(mr_count_in "$SUB_FLAT" "$DENIAL_TOOL_TEXT")

mr_say ""
mr_say "[$MR_PREFIX] trajectory: $T_count samples, first=$T_first max=$T_max (plan >= $PLAN_AT, reserve >= $RESERVE_AT, lockdown >= $BUDGET)"
mr_say "[$MR_PREFIX] bands seen in the request log: ${R_band_order:-none} over ${R_records:-0} request(s)"
mr_say ""

# A subagent whose very first measured turn already sits in or above the plan
# band never had a plan band to reach: nothing below could be told apart from a
# plugin that failed to fire, so the run says so and asserts nothing.
if [ "${T_count:-0}" -lt 1 ]; then
  mr_die "the subagent's session carries no token figure at all — nothing was measured to judge a band against. Its capture: $SUB_CAPTURE"
fi
if [ "${T_first:-0}" -ge "$PLAN_AT" ]; then
  mr_die "the subagent's FIRST measured turn already reads $T_first tokens against a pinned budget of $BUDGET (plan band from $PLAN_AT) — its baseline alone fills the budget, so no band could be observed opening. Raise CONTEXT_BUDGET above $(( T_first * 10 / 7 + 1000 ))"
fi

# ---------- the criteria ----------------------------------------------------

# The pin reached the plugin. Read twice over: out of the notices the subagent
# was handed, which are scoped to its session, and off the plugin's own band
# lines, which carry the resolved limit.
BUDGETS_SEEN=""
BUDGETS_OK=1
for b in "${R_plan_budget:-0}" "${R_reserve_budget:-0}" "${R_stop_budget:-0}"; do
  [ "$b" = 0 ] && continue
  BUDGETS_SEEN="$BUDGETS_SEEN $b"
  [ "$b" = "$BUDGET" ] || BUDGETS_OK=0
done
LIMIT_LOGGED=$(mr_log_field "${PLAN_LINE:-${RESERVE_LINE:-$STOP_LINE}}" limit)
if [ -n "$BUDGETS_SEEN" ] && [ "$BUDGETS_OK" = 1 ] && [ "${LIMIT_LOGGED:-0}" = "$BUDGET" ]; then
  mr_record "budget — the pinned per-agent budget is the one the bands act on" 1 \
    "agentContext.$AGENT=$BUDGET; the notices name$BUDGETS_SEEN and the plugin's band line carries \"limit\":$LIMIT_LOGGED"
else
  mr_record "budget — the pinned per-agent budget is the one the bands act on" 0 \
    "expected $BUDGET everywhere; the notices name${BUDGETS_SEEN:- nothing} and the band line \"limit\":${LIMIT_LOGGED:-none} — ${PLAN_LINE:-${RESERVE_LINE:-${STOP_LINE:-no band line for handle $SUB_HANDLE}}}"
fi

# ---------- the plan band ----------------------------------------------------

PLAN_DUMP="$DUMP_PREFIX.plan.txt"
if [ "${T_in_plan:-0}" -ge 1 ]; then
  if [ "${R_plan_records:-0}" -ge 1 ]; then
    mr_record "plan band — the plan block fired while the context was in its range" 1 \
      "$R_plan_records request(s) carried it, first on request $R_plan_record; $T_in_plan measured turn(s) in [$PLAN_AT, $RESERVE_AT); ${PLAN_LINE:-no plugin log line}"

    if [ "${R_plan_arith:-0}" = 1 ] && [ "${R_plan_left:-0}" -gt 0 ]; then
      mr_record "plan — it names the room left, and the figure is right" 1 \
        "\"reached $R_plan_ctx tokens of the $R_plan_budget budget — about $R_plan_left left\", and $R_plan_budget − $R_plan_ctx is that figure to within the 0.1k it is rendered at; the reserve threshold it names: $RESERVE_AT_FMT"
    else
      mr_record "plan — it names the room left, and the figure is right" 0 \
        "ctx=$R_plan_ctx budget=$R_plan_budget left=$R_plan_left arithmetic_ok=${R_plan_arith:-0} — see $PLAN_DUMP"
    fi

    PLAN_CARRIES_NO_DEMAND=1
    grep -qF -- "$PLAN_NO_DEMAND" "$PLAN_DUMP" 2>/dev/null || PLAN_CARRIES_NO_DEMAND=0
    grep -qF -- "$RESERVE_DEMAND" "$PLAN_DUMP" 2>/dev/null && PLAN_CARRIES_NO_DEMAND=0
    grep -qF -- "$STOP_DEMAND" "$PLAN_DUMP" 2>/dev/null && PLAN_CARRIES_NO_DEMAND=0
    # And nothing was denied while it stood: the first denial of this run, if
    # there is one, lies past the line the lockdown opened on.
    PLAN_DENIED_EARLY=0
    if [ -n "$DENIAL_LINENO" ] && { [ -z "$STOP_LINENO" ] || [ "$DENIAL_LINENO" -lt "$STOP_LINENO" ]; }; then
      PLAN_DENIED_EARLY=1
    fi
    if [ "$PLAN_CARRIES_NO_DEMAND" = 1 ] && [ "$PLAN_DENIED_EARLY" = 0 ]; then
      mr_record "plan — it demands nothing and denies nothing" 1 \
        "it carries \"$PLAN_NO_DEMAND\" and neither the reserve band's summary demand nor the lockdown's; no work tool of $SUB_HANDLE was denied before the budget was breached (first denial at slice line ${DENIAL_LINENO:-none}, lockdown at ${STOP_LINENO:-none})"
    else
      mr_record "plan — it demands nothing and denies nothing" 0 \
        "carries_the_no-demand_sentence=$PLAN_CARRIES_NO_DEMAND denied_before_the_budget=$PLAN_DENIED_EARLY (first denial at slice line ${DENIAL_LINENO:-none}, lockdown at ${STOP_LINENO:-none}) — see $PLAN_DUMP"
    fi
  else
    mr_record "plan band — the plan block fired while the context was in its range" 0 \
      "$T_in_plan measured turn(s) sat in [$PLAN_AT, $RESERVE_AT) and no request of session $SUB_SID carried the plan block; bands seen: ${R_band_order:-none}. Trajectory: $T_samples"
    mr_note_uncovered "plan — it names the room left / it demands nothing and denies nothing" \
      "the band was reached and did not fire, so there is no text of it to judge"
  fi
else
  mr_note_uncovered "plan band — the plan block fired while the context was in its range" \
    "NOT REACHED: no measured turn of the subagent landed in [$PLAN_AT, $RESERVE_AT) — $(cb_straddle "$PLAN_AT" "$RESERVE_AT"). Trajectory: $T_samples"
  mr_note_uncovered "plan — it names the room left / it demands nothing and denies nothing" \
    "the band was never reached, so nothing of it was produced to judge"
fi

# ---------- the reserve band -------------------------------------------------

RESERVE_DUMP="$DUMP_PREFIX.reserve.txt"
if [ "${T_in_reserve:-0}" -ge 1 ]; then
  if [ "${R_reserve_records:-0}" -ge 1 ]; then
    mr_record "reserve band — the reserve block fired while the context was in its range" 1 \
      "$R_reserve_records request(s) carried it, first on request $R_reserve_record; $T_in_reserve measured turn(s) in [$RESERVE_AT, $BUDGET); ${RESERVE_LINE:-no plugin log line}"

    RESERVE_DEMANDS=1
    grep -qF -- "$RESERVE_DEMAND" "$RESERVE_DUMP" 2>/dev/null || RESERVE_DEMANDS=0
    grep -qF -- 'Done:' "$RESERVE_DUMP" 2>/dev/null || RESERVE_DEMANDS=0
    if [ "$RESERVE_DEMANDS" = 1 ]; then
      mr_record "reserve — it demands the summary now" 1 \
        "it carries \"$RESERVE_DEMAND\" and the \"Done:\" / \"Blocked:\" opening it demands, at $R_reserve_ctx tokens of $R_reserve_budget with about $R_reserve_left left"
    else
      mr_record "reserve — it demands the summary now" 0 \
        "the reserve block carries no summary demand — see $RESERVE_DUMP"
    fi

    # The band's own claim: the demand is made WHILE THE TOOLS STILL WORK.
    # guardToolExecute denies at the budget, so the evidence is that no work
    # tool of this subagent was refused before the lockdown opened.
    RESERVE_TOOLS_OK=1
    grep -qF -- "$RESERVE_TOOLS_LEFT" "$RESERVE_DUMP" 2>/dev/null || RESERVE_TOOLS_OK=0
    if [ -n "$DENIAL_LINENO" ] && { [ -z "$STOP_LINENO" ] || [ "$DENIAL_LINENO" -lt "$STOP_LINENO" ]; }; then
      RESERVE_TOOLS_OK=0
    fi
    if [ "$RESERVE_TOOLS_OK" = 1 ]; then
      mr_record "reserve — the demand is made while the tools still work" 1 \
        "it says so (\"$RESERVE_TOOLS_LEFT\") and no work-tool call of $SUB_HANDLE was denied before the budget was breached: first denial at slice line ${DENIAL_LINENO:-none}, lockdown at ${STOP_LINENO:-none}"
    else
      mr_record "reserve — the demand is made while the tools still work" 0 \
        "a work tool was denied at slice line ${DENIAL_LINENO:-none}, before the lockdown at ${STOP_LINENO:-none}, or the block does not carry \"$RESERVE_TOOLS_LEFT\" — see $RESERVE_DUMP and ${DENIAL_LINE:-no denial line}"
    fi
  else
    mr_record "reserve band — the reserve block fired while the context was in its range" 0 \
      "$T_in_reserve measured turn(s) sat in [$RESERVE_AT, $BUDGET) and no request of session $SUB_SID carried the reserve block; bands seen: ${R_band_order:-none}. Trajectory: $T_samples"
    mr_note_uncovered "reserve — it demands the summary now / the demand is made while the tools still work" \
      "the band was reached and did not fire, so there is no text of it to judge"
  fi
else
  mr_note_uncovered "reserve band — the reserve block fired while the context was in its range" \
    "NOT REACHED: no measured turn of the subagent landed in [$RESERVE_AT, $BUDGET) — $(cb_straddle "$RESERVE_AT" "$BUDGET"). Trajectory: $T_samples"
  mr_note_uncovered "reserve — it demands the summary now / the demand is made while the tools still work" \
    "the band was never reached, so nothing of it was produced to judge"
fi

# ---------- the lockdown -----------------------------------------------------

STOP_DUMP="$DUMP_PREFIX.stop.txt"
if [ "${T_in_stop:-0}" -ge 1 ]; then
  if [ "${R_stop_records:-0}" -ge 1 ]; then
    mr_record "lockdown — the STOP block fired at or above the budget" 1 \
      "$R_stop_records request(s) carried it, first on request $R_stop_record, at $R_stop_ctx tokens of $R_stop_budget; ${STOP_LINE:-no plugin log line}"

    if [ -n "$DENIAL_LINE" ] || [ "${DENIAL_IN_TRANSCRIPT:-0}" -ge 1 ]; then
      mr_record "lockdown — a work-tool call was denied over the budget" 1 \
        "${DENIAL_LINE:-no plugin log line}; the refusal stands ${DENIAL_IN_TRANSCRIPT:-0} time(s) in the subagent's own transcript as \"$DENIAL_TOOL_TEXT\""
    elif [ "${R_last_tool_parts:-0}" -gt "${R_stop_tool_parts:-0}" ]; then
      mr_record "lockdown — a work-tool call was denied over the budget" 0 \
        "the subagent went on calling work tools after the lockdown (${R_stop_tool_parts:-0} tool parts on the lockdown's own request, ${R_last_tool_parts:-0} on its last) and NONE of them was refused — no denial line for $SUB_HANDLE and nothing in its transcript"
    else
      mr_note_uncovered "lockdown — a work-tool call was denied over the budget" \
        "NOT REACHED: the lockdown fired, and the subagent attempted no further work tool afterwards (${R_stop_tool_parts:-0} tool parts on the lockdown's request, ${R_last_tool_parts:-0} on its last), so no call was there to be denied — its task tells it to test that claim with one more call, and it concluded on the block's word instead"
    fi
  else
    mr_record "lockdown — the STOP block fired at or above the budget" 0 \
      "$T_in_stop measured turn(s) sat at or above $BUDGET and no request of session $SUB_SID carried the STOP block; bands seen: ${R_band_order:-none}. Trajectory: $T_samples"
    mr_note_uncovered "lockdown — a work-tool call was denied over the budget" \
      "the budget was breached and the block did not fire, so the lockdown was never entered"
  fi
else
  mr_note_uncovered "lockdown — the STOP block fired at or above the budget" \
    "NOT REACHED: the subagent's context never reached the $BUDGET-token budget (highest measured turn: $T_max). Trajectory: $T_samples"
  mr_note_uncovered "lockdown — a work-tool call was denied over the budget" \
    "the budget was never breached, so no call could be denied over it"
fi

# ---------- the placement ----------------------------------------------------

# Where every band notice actually sat in the array the provider was handed.
# One criterion over all of them: a single band delivered on message 0 is the
# regression this exists to catch.
if [ "${R_band_records:-0}" -ge 1 ]; then
  if [ "${R_band_carrier_tail:-0}" = "${R_band_records:-0}" ] &&
     [ "${R_band_carrier_appended:-0}" = "${R_band_records:-0}" ] &&
     [ "${R_band_carrier_user:-0}" = "${R_band_records:-0}" ] &&
     [ "${R_band_carrier_msg0:-0}" = 0 ]; then
    mr_record "placement — every band notice rode in an appended carrier at the END of the array" 1 \
      "$R_band_records band notice(s), all of them the last message of their request, all on a message this plugin appended, all \`user\`, none on message 0 (plan at index $R_plan_index of $R_plan_total, reserve at $R_reserve_index of $R_reserve_total, lockdown at $R_stop_index of $R_stop_total)"
  else
    mr_record "placement — every band notice rode in an appended carrier at the END of the array" 0 \
      "of $R_band_records band notice(s): at the tail $R_band_carrier_tail, on an appended carrier $R_band_carrier_appended, role user $R_band_carrier_user, ON MESSAGE 0 $R_band_carrier_msg0 — see $ANALYSIS"
  fi
else
  mr_note_uncovered "placement — every band notice rode in an appended carrier at the END of the array" \
    "no band notice reached the request log for session $SUB_SID at all (${R_records:-0} request(s) logged, ${R_notice_records:-0} of them carrying a notice), so there was no placement to read"
fi

# ---------- what this driver observed but does not judge --------------------

mr_note "the subagent's own context trajectory, measured off its session" \
  "$T_count turn(s): $T_samples — first $T_first, highest $T_max, against plan $PLAN_AT / reserve $RESERVE_AT / budget $BUDGET"
mr_note "the order the bands fired in" \
  "${R_band_order:-none}, over ${R_records:-0} logged request(s) of which ${R_band_records:-0} carried a band"
mr_note "what the subagent finally replied" \
  "$(mr_first_in "$SUB_FLAT" "Done:" || true)"
mr_note "what the primary was told when it finished" \
  "$(mr_first_in "$PRIMARY_FLAT" "🔔 agent-intercom: your subagent" || true)"
mr_note "how many blocks it carried whole" \
  "$(mr_count_in "$SUB_FLAT" "-END") block end marker(s) in its transcript, out of $BLOCKS seeded"

mr_note_uncovered "the compaction HOLD band" \
  "this run pins \`compaction: false\`, so the budget crossing is the lockdown's; the HOLD block a compacting type gets instead is pinned by the unit suite (test/turn-notice-placement.test.js, test/compaction.test.js)"
mr_note_uncovered "the primary's own notice placement" \
  "a primary keeps its block on its last user message and gets no carrier; that half is pinned without a server in test/turn-notice-placement.test.js"
mr_note_uncovered "the denial-loop notice to the parent" \
  "it needs BUDGET_NOTIFY_AFTER over-budget turns in a row and is pinned by test/context-budget.test.js; this run stops the subagent at its first refusal"

# What answered: every session this run captured, the primary's and the
# subagent's.
mr_model_audit

mr_verdict
