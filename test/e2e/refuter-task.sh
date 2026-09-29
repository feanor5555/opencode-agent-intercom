#!/bin/bash
# Refuter end-to-end driver.
#
# Hands the `refuter` role a numbered list of three claims about THIS
# repository through a real orchestrator on a real `opencode serve`, and
# asserts that it answers in its claim form, decides each claim the way the
# tree decides it, and changes no file.
#
# The three claims:
#
#   1  true       `DEFAULT_MAX_NESTED_SPAWNS` is 2 in src/settings.js
#   2  false      a constant that stands nowhere in the tree is exported from
#                 src/settings.js
#   3  universal  "only src/tools.js calls `spawnCapDecision`" — false: the
#      and false  unit tests call it as well
#
# The third is the one the role exists for: a search that stops at the first
# hit (src/tools.js) answers `holds`; only a search over the whole tree finds
# the test files that make it false.
#
# Asserted criteria:
#
#   spawned      a refuter was spawned
#   head         the first line of its reply is
#                `Claims: 3 — 1 hold, 2 false, 0 not checkable`
#   claim-1      claim 1 is answered `holds`
#   claim-2      claim 2 is answered `false` with a path:line
#   claim-3      claim 3 is answered `false` with a path:line outside
#                src/tools.js
#   untouched    no file of the repository changed outside `work/`, the
#                project documents the plugin writes where they are absent
#                (PROJECT.md, ARCHITECTURE.md, TODO.md) left out
#   model-pin    every captured assistant turn ran on E2E_MODEL
#
# Opt-in, like every driver here: it talks to a real opencode, spends real
# model tokens, and is never run by `npm test`.
#
# It uses a server it does NOT own — run-all.sh's, or one started by hand —
# exactly like ask-task.sh. Its sessions are created against this repository
# (REFUTER_PROJECT_DIR), because the claims are about it.
#
# Usage:
#   bash test/e2e/refuter-task.sh                    # against OPENCODE_URL
#   OUT_DIR=/somewhere/kept bash test/e2e/refuter-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL         http://localhost:4567  the running server
#   REFUTER_PROJECT_DIR  this repository         the tree the claims are about
#   OUT_DIR              ./out                   captures and the report
#   E2E_MODEL            cliproxy/qwen3.8-flash-medium  the pin
#   MIDRUN_POLL_S        2                       poll cadence
#   SPAWN_TIMEOUT_S      180                     wait for the spawn
#   TURN_TIMEOUT_S       900                     per blocking prompt POST
#   FINISH_TIMEOUT_S     900                     wait for the refuter to end
#   SETTLE_TIMEOUT_S     420                     wait for the primary to settle
#
# Exit codes:
#   0  every asserted criterion passed
#   1  at least one criterion failed
#   2  preflight or setup error — nothing was asserted
#
# Prerequisites: curl, python3, git, a server on OPENCODE_URL with this plugin
# loaded, and the plugin's debug log switched on.
#
# NOT `set -e`: a failed criterion must be reported with its evidence and the
# cleanup must still run.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/../.." && pwd)
PROJECT_DIR=${REFUTER_PROJECT_DIR:-$REPO_ROOT}
export PROJECT_DIR
. "$HERE/lib/midrun-common.sh"
. "$HERE/lib/role-run.sh"

SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-900}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}

# Put together at run time, so this file does not carry the name it claims
# stands nowhere.
ABSENT_SYMBOL="DEFAULT_MAX_NESTED_SPAWN""_DEPTH"

mr_init 21-refuter
mr_check_settings skip-midrun
command -v git >/dev/null || mr_die "git is not on PATH"
git -C "$MR_PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  mr_die "$MR_PROJECT_DIR is not a git work tree — the untouched criterion reads git status"

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  [ -n "$RR_SID" ] && mr_say "primary session delete $RR_SID -> HTTP $(mr_delete_session "$RR_SID")"
  rr_stop_session_procs "$RR_SUB_SID"
  mr_refresh_slice
  mr_say "report:      $MR_REPORT_FILE"
  mr_say "captures:    $MR_OUT_DIR/$MR_PREFIX.*.messages.json / .transcript.txt / .reply.txt"
  mr_say "debug slice: $MR_SLICE_FILE"
  [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- the ground truth, checked before the run ------------------------

# The claims are only a test while the tree still decides them the way this
# driver expects; a tree that moved on is a setup error, not a failed refuter.
TRUE_LINE=$(grep -n '^export const DEFAULT_MAX_NESTED_SPAWNS = 2$' "$MR_PROJECT_DIR/src/settings.js" | cut -d: -f1)
[ -n "$TRUE_LINE" ] ||
  mr_die "src/settings.js no longer carries 'export const DEFAULT_MAX_NESTED_SPAWNS = 2' — claim 1 is not true any more"
if grep -rqF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=work --exclude-dir=out -- "$ABSENT_SYMBOL" "$MR_PROJECT_DIR"; then
  mr_die "$ABSENT_SYMBOL stands somewhere in the tree — claim 2 is not false any more"
fi
OTHER_CALLERS=$(grep -rlF --include='*.js' --exclude-dir=node_modules -- "spawnCapDecision(" "$MR_PROJECT_DIR/test" 2>/dev/null | sed "s#^$MR_PROJECT_DIR/##" | sort | tr '\n' ' ')
[ -n "$OTHER_CALLERS" ] ||
  mr_die "no file under test/ calls spawnCapDecision — claim 3 is not false any more"

# Everything a change to the tree outside work/ would move: the status lines,
# the tracked diff, and the content of every untracked file. Left out besides
# work/: the default out dir test/e2e/out/ and .opencode/, which this driver
# and opencode itself write into, and the project documents the plugin writes
# on the primary's turn where they are absent before the run
# (rr_plugin_scaffold); the refuter's own result file belongs under work/.
SCAFFOLD=$(rr_plugin_scaffold "$MR_PROJECT_DIR" | tr '\n' ' ')
SCAFFOLD_RE=$(rr_plugin_scaffold_re "$MR_PROJECT_DIR")
STATUS_SKIP="^.. ${SCAFFOLD_RE#^}"
FINGERPRINT_SKIP="^(work|test/e2e/out|\\.opencode)/|$SCAFFOLD_RE"
SCAFFOLD_PATHSPEC=()
for f in $SCAFFOLD; do SCAFFOLD_PATHSPEC+=(":(exclude)$f"); done
repo_fingerprint() {
  (
    cd "$MR_PROJECT_DIR" || exit 1
    git status --porcelain=v1 -uall | cut -c4- | grep -vE "$FINGERPRINT_SKIP"
    git diff HEAD --no-ext-diff --binary -- . ':(exclude)work' ':(exclude)test/e2e/out' ':(exclude).opencode' "${SCAFFOLD_PATHSPEC[@]}" | sha256sum
    git ls-files -o --exclude-standard | grep -vE "$FINGERPRINT_SKIP" | sort | while IFS= read -r f; do sha256sum -- "$f"; done
  ) | sha256sum | cut -d' ' -f1
}
FINGERPRINT_BEFORE=$(repo_fingerprint)
STATUS_BEFORE="$MR_OUT_DIR/$MR_PREFIX.status-before.txt"
git -C "$MR_PROJECT_DIR" status --porcelain=v1 -uall | grep -vE "$STATUS_SKIP" > "$STATUS_BEFORE"

BRIEFING="Check these claims about this repository and give each one your verdict.
1. src/settings.js sets DEFAULT_MAX_NESTED_SPAWNS to 2.
2. src/settings.js exports a constant named $ABSENT_SYMBOL.
3. Only src/tools.js calls spawnCapDecision."

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
server              $MR_BASE   (not owned by this driver)
project dir         $MR_PROJECT_DIR
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
claim 1 (holds)     src/settings.js:$TRUE_LINE
claim 2 (false)     $ABSENT_SYMBOL stands nowhere in the tree
claim 3 (false)     also called from: $OTHER_CALLERS
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- the run ---------------------------------------------------------

if ! rr_run_role refuter "$BRIEFING" "$SPAWN_TIMEOUT_S" "$TURN_TIMEOUT_S" "$FINISH_TIMEOUT_S" "$SETTLE_TIMEOUT_S"; then
  mr_record "spawned — a refuter was spawned" 0 "no refuter was spawned at all: $MR_WAIT_REASON"
  mr_verdict
  exit 1
fi
mr_record "spawned — a refuter was spawned" 1 "$RR_SUB_HANDLE session=$RR_SUB_SID"

# ---------- the evidence ----------------------------------------------------

REPLY_SOURCE="$RR_REPLY_SOURCE"

ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
python3 "$HERE/lib/refuter-reply.py" "$RR_REPLY_FILE" > "$ANALYSIS" 2>/dev/null
mr_load_kv "$ANALYSIS" R_
: "${R_head:=}" "${R_head_ok:=0}"
: "${R_claim1_line:=}" "${R_claim1_verdict:=}" "${R_claim1_refs:=}"
: "${R_claim2_line:=}" "${R_claim2_verdict:=}" "${R_claim2_refs:=}"
: "${R_claim3_line:=}" "${R_claim3_verdict:=}" "${R_claim3_refs:=}" "${R_claim3_ref_outside_tools:=0}"

mr_record "head — the reply opens with Claims: 3 — 1 hold, 2 false, 0 not checkable" \
  "$([ "$R_head_ok" = 1 ] && echo 1 || echo 0)" \
  "${R_head:-no Claims: line in $REPLY_SOURCE}"

mr_record "claim-1 — the true claim holds" \
  "$([ "$R_claim1_verdict" = holds ] && echo 1 || echo 0)" \
  "${R_claim1_line:-no line for claim 1}"

mr_record "claim-2 — the absent symbol is false, with a path:line" \
  "$([ "$R_claim2_verdict" = false ] && [ -n "$R_claim2_refs" ] && echo 1 || echo 0)" \
  "${R_claim2_line:-no line for claim 2}"

mr_record "claim-3 — the universal claim is false, with a path:line outside src/tools.js" \
  "$([ "$R_claim3_verdict" = false ] && [ "$R_claim3_ref_outside_tools" = 1 ] && echo 1 || echo 0)" \
  "${R_claim3_line:-no line for claim 3} (callers outside src/tools.js: $OTHER_CALLERS)"

FINGERPRINT_AFTER=$(repo_fingerprint)
STATUS_AFTER="$MR_OUT_DIR/$MR_PREFIX.status-after.txt"
git -C "$MR_PROJECT_DIR" status --porcelain=v1 -uall | grep -vE "$STATUS_SKIP" > "$STATUS_AFTER"
if [ "$FINGERPRINT_BEFORE" = "$FINGERPRINT_AFTER" ]; then
  mr_record "untouched — no file changed outside work/" 1 "repository fingerprint $FINGERPRINT_AFTER before and after${SCAFFOLD:+ (plugin-written, left out: $SCAFFOLD)}"
else
  mr_record "untouched — no file changed outside work/" 0 \
    "fingerprint moved; status lines that differ: $(diff "$STATUS_BEFORE" "$STATUS_AFTER" | grep -E '^[<>]' | tr '\n' ' ' | cut -c1-240) — a changed already-modified file shows only in the fingerprint"
fi

mr_note "where the reply was read" "$REPLY_SOURCE: $RR_REPLY_FILE"
mr_note "how the refuter ended" "${RR_ENDED:-it did not end within ${FINISH_TIMEOUT_S}s}"

mr_model_audit

mr_verdict
