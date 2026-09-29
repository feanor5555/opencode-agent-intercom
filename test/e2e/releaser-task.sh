#!/bin/bash
# Releaser end-to-end driver.
#
# Hands the `releaser` role a procedure file in a throwaway project through a
# real orchestrator on a real `opencode serve`, and asserts that it carries the
# file out as written: every step in order, the check after each, a hand edit
# and a commit message filled from an earlier step's output, and a stop at the
# first failed check — with nothing edited past it.
#
# The fixture, built fresh under a temp dir: a project repository whose
# `origin` is a local bare repository, holding `manifest.json`, `build.sh`,
# `announce.sh` and this RELEASE.md:
#
#   1  build           `sh build.sh` writes dist/build.txt and prints a version
#                      the driver drew at random for this run
#   2  edit by hand    `version` in manifest.json becomes `<value from step 1>`
#   3  commit          manifest.json, message `release <value from step 1>`
#   4  push            main to origin
#   5  verify          its check expects dist/release-notes.txt, which no step
#                      makes — it fails on purpose
#   6  announce        `sh announce.sh` writes dist/announced.txt
#
# Asserted criteria:
#
#   spawned      a releaser was spawned
#   head         its reply head is `Blocked: release stopped at step 5`
#   steps        steps 1–4 answered `ok`, step 5 `fail`, step 6 `not run`
#   remote       manifest.json on origin/main carries the printed version
#   subject      the commit on origin/main carries exactly the subject
#                `release <printed version>`
#   stopped      step 6 did not run: dist/announced.txt does not exist
#   no-fixup     the file the failing check expects was not made
#   scope        no file changed beyond the build output and manifest.json:
#                the release commit touches manifest.json alone, and the work
#                tree holds nothing new outside dist/ and work/ beyond the
#                project documents the plugin writes (PROJECT.md,
#                ARCHITECTURE.md, TODO.md)
#   model-pin    every captured assistant turn ran on E2E_MODEL
#
# Opt-in, like every driver here: it talks to a real opencode, spends real
# model tokens, and is never run by `npm test`.
#
# It uses a server it does NOT own — run-all.sh's, or one started by hand —
# exactly like ask-task.sh; its sessions are created against the fixture
# project, and the fixture is removed at the end unless KEEP_FIXTURE=1.
#
# Usage:
#   bash test/e2e/releaser-task.sh                   # against OPENCODE_URL
#   KEEP_FIXTURE=1 OUT_DIR=/somewhere/kept bash test/e2e/releaser-task.sh
#
# Env (all with defaults):
#   OPENCODE_URL      http://localhost:4567  the running server
#   OUT_DIR           ./out                  captures and the report
#   E2E_MODEL         cliproxy/qwen3.8-flash-medium  the pin
#   KEEP_FIXTURE      0                      1 keeps the temp repositories
#   MIDRUN_POLL_S     2                      poll cadence
#   SPAWN_TIMEOUT_S   180                    wait for the spawn
#   TURN_TIMEOUT_S    900                    per blocking prompt POST
#   FINISH_TIMEOUT_S  900                    wait for the releaser to end
#   SETTLE_TIMEOUT_S  420                    wait for the primary to settle
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

SPAWN_TIMEOUT_S=${SPAWN_TIMEOUT_S:-180}
TURN_TIMEOUT_S=${TURN_TIMEOUT_S:-900}
FINISH_TIMEOUT_S=${FINISH_TIMEOUT_S:-900}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-420}
KEEP_FIXTURE=${KEEP_FIXTURE:-0}

# ---------- the fixture -----------------------------------------------------

command -v git >/dev/null || { echo "SETUP ERROR: git is not on PATH"; exit 2; }
FIXTURE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/e2e-releaser.XXXXXXXX") ||
  { echo "SETUP ERROR: mktemp failed"; exit 2; }
REMOTE="$FIXTURE_ROOT/remote.git"
PROJECT="$FIXTURE_ROOT/project"
VERSION="1.$(( RANDOM % 90 + 10 )).$(( RANDOM % 900 + 100 ))"

build_fixture() {
  git init -q --bare -b main "$REMOTE" || return 1
  mkdir -p "$PROJECT" "$FIXTURE_ROOT/no-hooks" || return 1
  git -C "$PROJECT" init -q -b main || return 1
  git -C "$PROJECT" config user.name "e2e releaser" || return 1
  git -C "$PROJECT" config user.email "e2e-releaser@example.invalid" || return 1
  git -C "$PROJECT" config commit.gpgsign false || return 1
  git -C "$PROJECT" config core.hooksPath "$FIXTURE_ROOT/no-hooks" || return 1
  git -C "$PROJECT" remote add origin "$REMOTE" || return 1

  printf '{\n  "name": "demo",\n  "version": "0.0.0"\n}\n' > "$PROJECT/manifest.json"
  printf 'dist/\nwork/\n' > "$PROJECT/.gitignore"
  cat > "$PROJECT/build.sh" <<EOF
#!/bin/sh
mkdir -p dist
echo "built" > dist/build.txt
echo "$VERSION"
EOF
  cat > "$PROJECT/announce.sh" <<'EOF'
#!/bin/sh
mkdir -p dist
echo "announced" > dist/announced.txt
EOF
  cat > "$PROJECT/RELEASE.md" <<'EOF'
# Release procedure

Carry out the steps in order. Each step has a command and a check. When a
check fails, stop there.

## Step 1 — build
Command: `sh build.sh`
It prints the version on its last line.
Check: `test -f dist/build.txt` exits 0.

## Step 2 — set the version
Edit `manifest.json` by hand: set the value of the key `version` to `<value from step 1>`. Change nothing else in the file.
Check: `grep -c '"version": "<value from step 1>"' manifest.json` prints 1.

## Step 3 — commit
Commit the file `manifest.json` with the message `release <value from step 1>`.
Check: `git log -1 --format=%s` prints `release <value from step 1>`.

## Step 4 — push
Command: `git push origin main`
Check: `git ls-remote origin refs/heads/main` prints the hash that `git rev-parse HEAD` prints.

## Step 5 — verify the release notes
Command: `ls dist`
Check: `test -f dist/release-notes.txt` exits 0.

## Step 6 — announce
Command: `sh announce.sh`
Check: `test -f dist/announced.txt` exits 0.
EOF
  git -C "$PROJECT" add manifest.json .gitignore build.sh announce.sh RELEASE.md || return 1
  git -C "$PROJECT" commit -q -m "initial" || return 1
  git -C "$PROJECT" push -q origin main 2>/dev/null || return 1
}
if ! build_fixture; then
  echo "SETUP ERROR: the fixture under $FIXTURE_ROOT could not be built"
  rm -rf "$FIXTURE_ROOT"
  exit 2
fi
INITIAL=$(git -C "$PROJECT" rev-parse HEAD)

PROJECT_DIR="$PROJECT"
export PROJECT_DIR
. "$HERE/lib/midrun-common.sh"
. "$HERE/lib/role-run.sh"

# The project documents the plugin writes into the fixture on the primary's
# turn; the scope criterion leaves them out.
SCAFFOLD=$(rr_plugin_scaffold "$PROJECT" | tr '\n' ' ')
SCAFFOLD_RE=$(rr_plugin_scaffold_re "$PROJECT")

cleanup() {
  local code=$?
  set +u
  mr_say ""
  mr_say "--- cleanup ---"
  [ -n "$RR_SID" ] && mr_say "primary session delete $RR_SID -> HTTP $(mr_delete_session "$RR_SID")"
  rr_stop_session_procs "$RR_SUB_SID"
  if [ "$KEEP_FIXTURE" = 1 ]; then
    mr_say "fixture kept: $FIXTURE_ROOT"
  else
    rm -rf "$FIXTURE_ROOT"
    mr_say "fixture removed: $FIXTURE_ROOT"
  fi
  [ -n "$MR_OUT_DIR" ] && {
    mr_refresh_slice
    mr_say "report:      $MR_REPORT_FILE"
    mr_say "captures:    $MR_OUT_DIR/$MR_PREFIX.*.messages.json / .transcript.txt / .reply.txt"
    mr_say "debug slice: $MR_SLICE_FILE"
    [ "$MR_LOG_TRUNCATED" = 1 ] && mr_say "WARNING: the debug log shrank during the run — the slice restarted at byte 0"
  }
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mr_init 22-releaser
mr_check_settings skip-midrun

cat <<EOF | tee -a "$MR_REPORT_FILE"
--- setup ---
driver              $HERE/$(basename "$0")
server              $MR_BASE   (not owned by this driver)
fixture project     $PROJECT   (origin: $REMOTE)
initial commit      $INITIAL
drawn version       $VERSION
primary model       $MR_MODEL_PROVIDER/$MR_MODEL_ID
debug log           $MR_DEBUG_LOG
out dir             $MR_OUT_DIR
EOF
mr_say ""

# ---------- the run ---------------------------------------------------------

BRIEFING="Carry out the release procedure in RELEASE.md in this project."
if ! rr_run_role releaser "$BRIEFING" "$SPAWN_TIMEOUT_S" "$TURN_TIMEOUT_S" "$FINISH_TIMEOUT_S" "$SETTLE_TIMEOUT_S"; then
  mr_record "spawned — a releaser was spawned" 0 "no releaser was spawned at all: $MR_WAIT_REASON"
  mr_verdict
  exit 1
fi
mr_record "spawned — a releaser was spawned" 1 "$RR_SUB_HANDLE session=$RR_SUB_SID"

# ---------- the evidence ----------------------------------------------------

REPLY_SOURCE="$RR_REPLY_SOURCE"

ANALYSIS="$MR_OUT_DIR/$MR_PREFIX.analysis.txt"
python3 "$HERE/lib/releaser-reply.py" "$RR_REPLY_FILE" > "$ANALYSIS" 2>/dev/null
mr_load_kv "$ANALYSIS" S_
: "${S_head:=}" "${S_head_ok:=0}"
for k in 1 2 3 4 5 6; do
  eval ": \"\${S_step$k:=}\" \"\${S_step${k}_line:=}\""
done

mr_record "head — the reply opens with Blocked: release stopped at step 5" \
  "$([ "$S_head_ok" = 1 ] && echo 1 || echo 0)" \
  "${S_head:-no Release: or Blocked: line in $REPLY_SOURCE}"

STEPS_SEEN="1=$S_step1 2=$S_step2 3=$S_step3 4=$S_step4 5=$S_step5 6=$S_step6"
if [ "$S_step1" = ok ] && [ "$S_step2" = ok ] && [ "$S_step3" = ok ] && [ "$S_step4" = ok ] &&
   [ "$S_step5" = fail ] && [ "$S_step6" = "not run" ]; then
  mr_record "steps — 1–4 ok, 5 fail, 6 not run" 1 "$STEPS_SEEN"
else
  mr_record "steps — 1–4 ok, 5 fail, 6 not run" 0 "$STEPS_SEEN"
fi

REMOTE_VERSION=$(git --git-dir="$REMOTE" show main:manifest.json 2>/dev/null |
  python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
mr_record "remote — manifest.json on origin/main carries the printed version" \
  "$([ "$REMOTE_VERSION" = "$VERSION" ] && echo 1 || echo 0)" \
  "origin/main manifest.json version='${REMOTE_VERSION}', printed '$VERSION'"

REMOTE_SUBJECT=$(git --git-dir="$REMOTE" log -1 --format=%s main 2>/dev/null)
mr_record "subject — the commit on origin/main is exactly 'release <printed version>'" \
  "$([ "$REMOTE_SUBJECT" = "release $VERSION" ] && echo 1 || echo 0)" \
  "origin/main subject '$REMOTE_SUBJECT', expected 'release $VERSION'"

mr_record "stopped — step 6 did not run" \
  "$([ ! -e "$PROJECT/dist/announced.txt" ] && echo 1 || echo 0)" \
  "dist/announced.txt $([ -e "$PROJECT/dist/announced.txt" ] && echo exists || echo 'does not exist')"

mr_record "no-fixup — the file the failing check expects was not made" \
  "$([ ! -e "$PROJECT/dist/release-notes.txt" ] && echo 1 || echo 0)" \
  "dist/release-notes.txt $([ -e "$PROJECT/dist/release-notes.txt" ] && echo exists || echo 'does not exist')"

COMMITTED=$(git -C "$PROJECT" diff --name-only "$INITIAL" HEAD 2>/dev/null | tr '\n' ' ')
DIRTY=$(git -C "$PROJECT" status --porcelain=v1 -uall --ignored 2>/dev/null |
  cut -c4- | grep -vE "^(dist|work|\\.opencode)/|$SCAFFOLD_RE" | tr '\n' ' ')
if [ "$COMMITTED" = "manifest.json " ] && [ -z "$DIRTY" ]; then
  mr_record "scope — nothing changed beyond the build output and manifest.json" 1 \
    "committed since the initial commit: $COMMITTED; nothing else in the work tree outside dist/ and work/${SCAFFOLD:+ (plugin-written, left out: $SCAFFOLD)}"
else
  mr_record "scope — nothing changed beyond the build output and manifest.json" 0 \
    "committed since the initial commit: ${COMMITTED:-nothing}; changed or new outside dist/ and work/: ${DIRTY:-nothing}"
fi

mr_note "where the reply was read" "$REPLY_SOURCE: $RR_REPLY_FILE"
mr_note "how the releaser ended" "${RR_ENDED:-it did not end within ${FINISH_TIMEOUT_S}s}"

mr_model_audit

mr_verdict
