// Shell-level tests for the evidence readers of the three role drivers.
// `refuter-task.sh`, `releaser-task.sh` and `verifier-task.sh` decide pass or
// fail from what `test/e2e/lib/wake-reply.py`, `final-reply.py`,
// `refuter-reply.py`, `releaser-reply.py` and `verifier-reply.py` read out of a
// captured session and its final reply, so those five are
// driven here with built replies — no server, no model, no cost — and pinned on
// the verdicts the criteria rest on. The shell helpers of `lib/role-run.sh`
// that pick the reply and the files a scope check leaves out run here on built
// captures and directories. The drivers themselves are held to parse and to
// run in the suite.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const E2E = resolve(import.meta.dirname, "e2e")
const FINAL_REPLY = join(E2E, "lib/final-reply.py")
const WAKE_REPLY = join(E2E, "lib/wake-reply.py")
const ROLE_RUN = join(E2E, "lib/role-run.sh")
const REFUTER_READER = join(E2E, "lib/refuter-reply.py")
const RELEASER_READER = join(E2E, "lib/releaser-reply.py")
const VERIFIER_READER = join(E2E, "lib/verifier-reply.py")
const RUN_ALL = readFileSync(join(E2E, "run-all.sh"), "utf8")

const HAVE_PYTHON = spawnSync("python3", ["--version"]).status === 0

function runOn(reader, name, content) {
  const dir = mkdtempSync(join(tmpdir(), "role-reader-"))
  const file = join(dir, name)
  writeFileSync(file, content)
  const run = spawnSync("python3", [reader, file], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  return run
}

function figures(reader, reply) {
  const run = runOn(reader, "reply.txt", reply)
  assert.equal(run.status, 0, `reader failed: ${run.stderr}`)
  const out = {}
  for (const line of run.stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

// ---- final-reply.py --------------------------------------------------------

test("final-reply.py prints the text of the newest assistant message that has any", { skip: !HAVE_PYTHON }, () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "brief" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "first answer" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash" }, { type: "text", text: "Claims: 1" }, { type: "text", text: "1 holds" }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "read" }, { type: "text", text: "   " }] },
  ]
  const run = runOn(FINAL_REPLY, "messages.json", JSON.stringify(messages))
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, "Claims: 1\n1 holds\n")
})

test("final-reply.py exits 1 on a capture with no assistant text", { skip: !HAVE_PYTHON }, () => {
  const run = runOn(FINAL_REPLY, "messages.json", JSON.stringify([{ info: { role: "user" }, parts: [{ type: "text", text: "x" }] }]))
  assert.equal(run.status, 1)
  assert.equal(runOn(FINAL_REPLY, "messages.json", "not json").status, 1)
})

// ---- wake-reply.py ---------------------------------------------------------

const RELEASER_RESULT = [
  "Blocked: Step 5 check failed — `dist/release-notes.txt` does not exist.",
  "",
  "Release: stopped at step 5 — 6 steps",
  "- 1 ok — sh build.sh — exit 0",
].join("\n")

function wakeNotice(handle, result, tail) {
  return (
    `🔔 agent-intercom: your subagent "${handle}" (releaser) came back BLOCKED and was destroyed.\n` +
    `Its result:\n${result}\n${tail}\n📏 run-size: 9.3k of the 130.0k releaser budget — ok.\n`
  )
}

const PRIMARY_WITH_NOTICE = [
  { info: { role: "user" }, parts: [{ type: "text", text: "Call spawn(\"releaser\", \"Carry out RELEASE.md\")" }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Spawned." }] },
  {
    info: { role: "user" },
    parts: [{ type: "text", text: wakeNotice("releaser#1", RELEASER_RESULT, "⚠️ This is a DECISION for you, not a failed run to retry.") }],
  },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Repeating it: Release: done — 6 steps" }] },
]

function runArgs(script, args, files) {
  const dir = mkdtempSync(join(tmpdir(), "role-reader-"))
  const paths = {}
  for (const [name, content] of Object.entries(files)) {
    paths[name] = join(dir, name)
    writeFileSync(paths[name], content)
  }
  const run = spawnSync("python3", [script, ...args.map((a) => paths[a] ?? a)], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  return run
}

test("wake-reply.py prints the result block of the handle's wake notice, without the notice's tail", { skip: !HAVE_PYTHON }, () => {
  const run = runArgs(WAKE_REPLY, ["primary.json", "releaser#1"], { "primary.json": JSON.stringify(PRIMARY_WITH_NOTICE) })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, RELEASER_RESULT + "\n")
})

test("wake-reply.py stops at the tail of a held session's notice and reads only the named handle", { skip: !HAVE_PYTHON }, () => {
  const held =
    `🔔 agent-intercom: your subagent "refuter#2" (refuter) has finished. Its session is being HELD, not destroyed.\n` +
    `Its result:\nClaims: 1 — 1 hold, 0 false, 0 not checkable\n1 holds — a.js:1\n` +
    `Use this to report back to the user. The session is NOT gone.\n`
  const other = wakeNotice("refuter#1", "Claims: 9", "Use this to report back to the user.")
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: other }] },
    { info: { role: "user" }, parts: [{ type: "text", text: held }] },
  ]
  const run = runArgs(WAKE_REPLY, ["primary.json", "refuter#2"], { "primary.json": JSON.stringify(messages) })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stdout, "Claims: 1 — 1 hold, 0 false, 0 not checkable\n1 holds — a.js:1\n")
})

test("wake-reply.py exits 1 where no wake notice carries a result for the handle", { skip: !HAVE_PYTHON }, () => {
  const run = runArgs(WAKE_REPLY, ["primary.json", "verifier#1"], { "primary.json": JSON.stringify(PRIMARY_WITH_NOTICE) })
  assert.equal(run.status, 1)
  assert.equal(runArgs(WAKE_REPLY, ["primary.json", "releaser#1"], { "primary.json": "not json" }).status, 1)
})

// The subagent's own session is deleted when it ends, so its last capture can
// stop short of the final text; the wake notice is read first.
function readReply(files) {
  const dir = mkdtempSync(join(tmpdir(), "role-run-"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  const script =
    `. "${ROLE_RUN}"; MR_OUT_DIR="${dir}"; MR_PREFIX=p; RR_SUB_HANDLE="releaser#1"; ` +
    `RR_SUB_RAW="${dir}/p.subagent.messages.json"; RR_PRIMARY_FLAT="${dir}/p.primary.transcript.txt"; ` +
    `RR_REPLY_FILE="${dir}/p.reply.txt"; rr_read_reply; printf '%s\n' "$RR_REPLY_SOURCE"; cat "$RR_REPLY_FILE"`
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(run.status, 0, run.stderr)
  const [source, ...reply] = run.stdout.split("\n")
  return { source, reply: reply.join("\n") }
}

const TRUNCATED_SUBAGENT = JSON.stringify([
  { info: { role: "user" }, parts: [{ type: "text", text: "Carry out RELEASE.md" }] },
  { info: { role: "assistant" }, parts: [{ type: "text", text: "Step 1 ok (version 1.42.650). Step 2 — set the version:" }] },
])

test("rr_read_reply reads the wake notice before a subagent capture that stops short of the reply", { skip: !HAVE_PYTHON }, () => {
  const { source, reply } = readReply({
    "p.primary.messages.json": JSON.stringify(PRIMARY_WITH_NOTICE),
    "p.subagent.messages.json": TRUNCATED_SUBAGENT,
    "p.primary.transcript.txt": "flat",
  })
  assert.equal(source, "the wake notice in the primary")
  assert.equal(reply, RELEASER_RESULT + "\n")
})

test("rr_read_reply falls back to the subagent's capture, then to the whole primary transcript", { skip: !HAVE_PYTHON }, () => {
  const noNotice = JSON.stringify(PRIMARY_WITH_NOTICE.slice(0, 2))
  const own = readReply({
    "p.primary.messages.json": noNotice,
    "p.subagent.messages.json": TRUNCATED_SUBAGENT,
    "p.primary.transcript.txt": "flat",
  })
  assert.equal(own.source, "the subagent's own session")
  assert.equal(own.reply, "Step 1 ok (version 1.42.650). Step 2 — set the version:\n")
  const flat = readReply({ "p.primary.messages.json": noNotice, "p.primary.transcript.txt": "flat transcript\n" })
  assert.equal(flat.source, "the whole primary transcript")
  assert.equal(flat.reply, "flat transcript\n")
})

test("the role drivers take the reply role-run.sh picked", () => {
  for (const name of ["refuter-task.sh", "releaser-task.sh"]) {
    assert.match(readFileSync(join(E2E, name), "utf8"), /^REPLY_SOURCE="\$RR_REPLY_SOURCE"$/m, name)
  }
  assert.match(readFileSync(join(E2E, "verifier-task.sh"), "utf8"), /^  VF_REPLY_SOURCE="\$RR_REPLY_SOURCE"$/m)
})

// ---- the plugin's own project documents ------------------------------------

function scaffold(names) {
  const dir = mkdtempSync(join(tmpdir(), "role-scaffold-"))
  for (const name of names) writeFileSync(join(dir, name), "")
  const run = spawnSync("bash", ["-c", `. "${ROLE_RUN}"; rr_plugin_scaffold "$1"; echo "re=$(rr_plugin_scaffold_re "$1")"`, "x", dir], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split("\n")
  return { names: lines.slice(0, -1), re: lines.at(-1).slice(3) }
}

test("rr_plugin_scaffold names the documents the plugin writes where they are absent", () => {
  const empty = scaffold([])
  assert.deepEqual(empty.names, ["PROJECT.md", "ARCHITECTURE.md", "TODO.md"])
  assert.equal(empty.re, "^(PROJECT\\.md|ARCHITECTURE\\.md|TODO\\.md)$")
  assert.deepEqual(scaffold(["PROJECT.md", "Todos.md"]).names, ["ARCHITECTURE.md"], "a todo file in any casing keeps TODO.md in the check")
  const full = scaffold(["PROJECT.md", "ARCHITECTURE.md", "todo.md"])
  assert.deepEqual(full.names, [])
  assert.doesNotMatch("PROJECT.md", new RegExp(full.re), "nothing is left out where every document is already there")
})

test("the refuter's untouched and the releaser's scope checks leave the plugin's documents out", () => {
  const refuter = readFileSync(join(E2E, "refuter-task.sh"), "utf8")
  assert.match(refuter, /^SCAFFOLD_RE=\$\(rr_plugin_scaffold_re "\$MR_PROJECT_DIR"\)$/m)
  assert.match(refuter, /^FINGERPRINT_SKIP=".*\|\$SCAFFOLD_RE"$/m)
  assert.ok(refuter.indexOf("SCAFFOLD_RE=") < refuter.indexOf("FINGERPRINT_BEFORE="), "the documents are taken before the run")
  const releaser = readFileSync(join(E2E, "releaser-task.sh"), "utf8")
  assert.match(releaser, /^SCAFFOLD_RE=\$\(rr_plugin_scaffold_re "\$PROJECT"\)$/m)
  assert.match(releaser, /grep -vE "\^\(dist\|work\|\\\\\.opencode\)\/\|\$SCAFFOLD_RE"/)
  assert.ok(releaser.indexOf("SCAFFOLD_RE=") < releaser.indexOf("rr_run_role releaser"), "the documents are taken before the run")
})

// ---- verifier leg 4 --------------------------------------------------------

test("verifier leg 4 hides the browser cache and fails a pw run that clears PLAYWRIGHT_BROWSERS_PATH", () => {
  const src = readFileSync(join(E2E, "verifier-task.sh"), "utf8")
  assert.ok(
    src.indexOf("\nvf_hide_browser_cache\n") >= 0 &&
      src.indexOf("\nvf_hide_browser_cache\n") < src.indexOf('vf_start_server legC "PLAYWRIGHT_BROWSERS_PATH=$NO_BROWSERS"'),
    "the cache is hidden before server C starts",
  )
  const pattern = /^VF_ENV_ESCAPE='([^']*)'$/m.exec(src)
  assert.ok(pattern, "leg 4 names the escape it checks for")
  const input = (command) => `input=${JSON.stringify({ command })}`
  const lines = [
    input("env -u PLAYWRIGHT_BROWSERS_PATH pw start 2>&1 | tail -20"),
    input("unset PLAYWRIGHT_BROWSERS_PATH; pw start"),
    input("PLAYWRIGHT_BROWSERS_PATH=/home/u/.cache/ms-playwright pw start"),
    input("echo $PLAYWRIGHT_BROWSERS_PATH; pw start"),
    "PLAYWRIGHT_BROWSERS_PATH=/tmp/no-browsers",
  ]
  const run = spawnSync("grep", ["-E", "--", pattern[1]], { input: lines.join("\n") + "\n", encoding: "utf8" })
  assert.deepEqual(run.stdout.trim().split("\n"), lines.slice(0, 3))
})

test("verifier leg 4 fails a bash call that installs or launches a browser, not one that looks at it", () => {
  const src = readFileSync(join(E2E, "verifier-task.sh"), "utf8")
  const pattern = /^VF_BROWSER_ESCAPE='([^']*)'$/m.exec(src)
  assert.ok(pattern, "leg 4 names the browser escape it checks for")
  assert.match(src, /mr_record "leg4 browser — [^"]*" \\\n    "\$\(\[ -z "\$BROWSER" \]/)
  const input = (command) => `input=${JSON.stringify({ command })}`
  const flat = (command) => `input={"command": ${JSON.stringify(command)}, "workdir": "/tmp/project"}`
  const uses = [
    input("npx playwright install chromium 2>&1 | tail -3"),
    flat("cd /tmp && npx -y playwright@1.50.0 install --with-deps chromium"),
    input("python3 -m playwright install chromium"),
    flat("/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome --headless --dump-dom http://127.0.0.1:8765/"),
    flat("timeout 20 ~/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell --screenshot http://127.0.0.1:8765/"),
    flat("python3 -m http.server 8765 & sleep 1; chromium --headless --dump-dom http://127.0.0.1:8765/"),
  ]
  const looks = [
    flat("ls ~/.cache/ms-playwright 2>/dev/null; du -sh ~/.cache/ms-playwright 2>/dev/null"),
    flat('whoami; echo HOME=$HOME; ls -la $HOME 2>/dev/null | head -20; ls /home 2>/dev/null; find / -maxdepth 6 -name "ms-playwright*" -o -maxdepth 6 -name "chromium-*" -type d 2>/dev/null | head'),
    flat('ls -la $HOME/.cache/ 2>/dev/null; ls -la $HOME/.cache/ms-playwright 2>/dev/null; ls -la $HOME/.cache/ms-playwright-mcp 2>/dev/null | head; pgrep -af "playwright install" | head'),
    flat('pw status 2>&1 | head -5; echo "exit=$?"; env | grep -i -E "playwright|pw_" ; ls /home/wu/.cache/ms-playwright/'),
    flat('sleep 170; tail -12 /tmp/opencode/pwstart.log; pgrep -af "pw.js|playwright install" | head -3'),
    flat('grep -i -E "error|EACCES|failed|download" /tmp/opencode/pwstart2.log | head -5; pkill -f "playwright install" ; pkill -f "pw.js start"; sleep 1; pgrep -af "playwright install|pw.js" | grep -v pgrep | head -3; echo "cleaned-procs"'),
    flat('pgrep -af "playwright install" | grep -v grep | head -3; echo "---"; pgrep -af "pw.js" | head -3; echo "---"; pw stop 2>&1 | tail -2; pkill -f "http.server 8765"; sleep 1; pgrep -af "http.server 8765" | head -2; echo "cleanup-done"'),
    input("ls /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome"),
    input('pgrep -af "http.server 8765|playwright|chromium" | head -20'),
    `input=${JSON.stringify({ filePath: "/home/u/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell" })}`,
    input("pw start"),
    "the text says npx playwright install",
  ]
  const run = spawnSync("grep", ["-E", "--", pattern[1]], { input: [...uses, ...looks].join("\n") + "\n", encoding: "utf8" })
  assert.deepEqual(run.stdout.trim().split("\n"), uses)
})

test("verifier leg 4 leaves PLAYWRIGHT_BROWSERS_PATH to the env criterion alone", () => {
  const src = readFileSync(join(E2E, "verifier-task.sh"), "utf8")
  const pattern = /^VF_BROWSER_ESCAPE='([^']*)'$/m.exec(src)
  assert.ok(!pattern[1].includes("PLAYWRIGHT_BROWSERS_PATH"))
})

// ---- verifier leg 2 --------------------------------------------------------

test("verifier leg 2 counts a screenshot written after the leg started, so an overwritten one counts", () => {
  const src = readFileSync(join(E2E, "verifier-task.sh"), "utf8")
  assert.doesNotMatch(src, /SHOTS_BEFORE|SHOTS_AFTER/, "no count of PNG files before and after")
  const touch = src.indexOf('touch "$LEG2_START"')
  assert.ok(touch >= 0 && touch < src.indexOf('vf_run_leg leg2 "$BRIEF_CANVAS"'), "the leg's start is marked before its verifier runs")
  assert.match(src, /SHOTS=\$\(find "\$PROJECT\/work" -path '\*\/verify-\*\/\*\.png' -newer "\$LEG2_START"/)
  assert.match(src, /"\$\(\[ -n "\$SHOTS" \] && echo 1 \|\| echo 0\)"/)
})

// ---- rr_run_role state -----------------------------------------------------

// rr_run_role with the midrun-common.sh helpers stubbed: the spawn is seen,
// the finish window is 0 s, so the subagent does not end in time.
function runRoleTimedOut(preset) {
  const dir = mkdtempSync(join(tmpdir(), "role-run-"))
  const script = `
    mr_debug_start() { :; }
    mr_new_session() { echo ses_primary; }
    mr_say() { echo "SAY $*"; }
    mr_post_prompt() { :; }
    mr_wait_for_pattern() { MR_WAIT_LINE=line; return 0; }
    mr_log_field() { echo "sub_$2"; }
    mr_capture() { : > "$MR_OUT_DIR/$MR_PREFIX.$2.transcript.txt"; echo "$MR_OUT_DIR/$MR_PREFIX.$2.transcript.txt"; }
    MR_OUT_DIR="$1"; MR_PREFIX=p; MR_POLL_S=0
    . "${ROLE_RUN}"
    ${preset}
    rr_run_role verifier "brief" 1 1 0 0
    echo "ENDED=[$RR_ENDED] SUB=[$RR_SUB_SID]"
  `
  const run = spawnSync("bash", ["-c", script, "x", dir], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout
}

test("rr_run_role starts each call with empty outputs, so a leg that times out reports the timeout", { skip: !HAVE_PYTHON }, () => {
  const out = runRoleTimedOut('RR_ENDED="its session is gone (HTTP 404)"; RR_REPLY_SOURCE=stale')
  assert.match(out, /ENDED=\[\] SUB=\[sub_sessionID\]/)
  assert.match(out, /SAY \[p\] subagent did not end within 0s/)
  assert.doesNotMatch(out, /subagent ended: its session is gone/)
})

// ---- leftover processes ----------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("rr_stop_session_procs stops detached processes of the subagent's session and no other", { skip: process.platform !== "linux" }, () => {
  const sid = `ses_rrtest${process.pid}${Date.now()}`
  const start = (session) => {
    const r = spawnSync(
      "bash",
      ["-c", 'PW_SESSION="$1" setsid sleep 60 </dev/null >/dev/null 2>&1 & echo $!; disown', "x", session],
      { encoding: "utf8" },
    )
    return Number(r.stdout.trim())
  }
  const mine = start(sid)
  const other = start(`${sid}x`)
  try {
    assert.ok(alive(mine) && alive(other))
    const run = spawnSync("bash", ["-c", `mr_say() { echo "SAY $*"; }; . "${ROLE_RUN}"; rr_stop_session_procs "" "$1"`, "x", sid], {
      encoding: "utf8",
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, new RegExp(`SAY processes the subagent session\\(s\\) left running stopped: ${mine}\\b`))
    assert.equal(alive(mine), false, "the session's detached process is stopped")
    assert.equal(alive(other), true, "a process of another session keeps running")
  } finally {
    for (const pid of [mine, other]) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
})

test("the role drivers' cleanup stops the processes their subagent sessions left", () => {
  for (const name of ["refuter-task.sh", "releaser-task.sh"]) {
    const src = readFileSync(join(E2E, name), "utf8")
    const cleanup = src.slice(src.indexOf("cleanup() {"), src.indexOf("trap cleanup EXIT"))
    assert.match(cleanup, /^  rr_stop_session_procs "\$RR_SUB_SID"$/m, name)
  }
  const verifier = readFileSync(join(E2E, "verifier-task.sh"), "utf8")
  const cleanup = verifier.slice(verifier.indexOf("cleanup() {"), verifier.indexOf("trap cleanup EXIT"))
  assert.match(cleanup, /^  rr_stop_session_procs \$VF_SUB_SIDS \$RR_SUB_SID$/m)
  assert.ok(cleanup.indexOf("e2e_server_stop") < cleanup.indexOf("rr_stop_session_procs"), "after the server is down")
})

// ---- refuter-reply.py ------------------------------------------------------

const REFUTER_PASS = [
  "Claims: 3 — 1 hold, 2 false, 0 not checkable",
  "1 holds — src/settings.js:295 — export const DEFAULT_MAX_NESTED_SPAWNS = 2",
  "2 false — src/settings.js:295 — only DEFAULT_MAX_NESTED_SPAWNS stands there",
  "3 false — test/entry-lifecycle.test.js:150 — spawnCapDecision(PRIMARY, 1)",
].join("\n")

test("refuter-reply.py reads the head and each verdict of the claim form", { skip: !HAVE_PYTHON }, () => {
  const out = figures(REFUTER_READER, REFUTER_PASS)
  assert.equal(out.head_ok, "1")
  assert.equal(out.claim1_verdict, "holds")
  assert.equal(out.claim2_verdict, "false")
  assert.equal(out.claim2_refs, "src/settings.js:295")
  assert.equal(out.claim3_verdict, "false")
  assert.equal(out.claim3_ref_outside_tools, "1")
})

test("refuter-reply.py fails a universal claim answered from src/tools.js alone", { skip: !HAVE_PYTHON }, () => {
  const out = figures(
    REFUTER_READER,
    "Claims: 3 — 2 hold, 1 false, 0 not checkable\n1 holds — src/settings.js:295 — x\n2 false — src/settings.js:1 — y\n3 holds — src/tools.js:690 — spawnCapDecision(",
  )
  assert.equal(out.head_ok, "0", "the counts are not 1 hold, 2 false")
  assert.equal(out.claim3_verdict, "holds")
  assert.equal(out.claim3_ref_outside_tools, "0")
})

test("refuter-reply.py takes the numbered and bulleted spellings of a claim line", { skip: !HAVE_PYTHON }, () => {
  const out = figures(REFUTER_READER, "`Claims: 3 — 1 hold, 2 false, 0 not checkable`\n- 1. holds — a.js:1 — x\n**2 false** — b.js:2 — y\n3) not checkable — n/a — runtime")
  assert.equal(out.head_ok, "1")
  assert.equal(out.claim1_verdict, "holds")
  assert.equal(out.claim2_verdict, "false")
  assert.equal(out.claim3_verdict, "not checkable")
})

// ---- releaser-reply.py -----------------------------------------------------

test("releaser-reply.py reads the stop and every step's status", { skip: !HAVE_PYTHON }, () => {
  const out = figures(
    RELEASER_READER,
    [
      "Blocked: release stopped at step 5 — 6 steps",
      "1 ok — sh build.sh — dist/build.txt exists (printed 1.42.317)",
      "2 ok — edit manifest.json version → 1.42.317 — grep printed 1",
      "3 ok — git commit -m 'release 1.42.317' — abc1234 release 1.42.317",
      "4 ok — git push origin main — ls-remote matches HEAD",
      "5 fail — ls dist — test -f dist/release-notes.txt exit 1",
      "6 not run — sh announce.sh — —",
    ].join("\n"),
  )
  assert.equal(out.head_ok, "1")
  assert.equal(out.head, "Blocked: release stopped at step 5 — 6 steps")
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((k) => out[`step${k}`]),
    ["ok", "ok", "ok", "ok", "fail", "not run"],
  )
})

test("releaser-reply.py does not take a run that went on past the failure for a stop", { skip: !HAVE_PYTHON }, () => {
  const out = figures(RELEASER_READER, "Release: done — 6 steps\n5 ok — ls dist — made the notes\n6 ok — sh announce.sh — ok")
  assert.equal(out.head_ok, "0")
  assert.equal(out.step5, "ok")
  assert.equal(out.step1, "")
})

test("releaser-reply.py takes only the Blocked: head the releaser's prompt sets for a stop", { skip: !HAVE_PYTHON }, () => {
  assert.equal(figures(RELEASER_READER, "Release: stopped at step 5 — 6 steps\n5 fail — ls dist — exit 1").head_ok, "0")
  assert.equal(figures(RELEASER_READER, "Blocked: no procedure file").head, "Blocked: no procedure file")
})

// ---- the drivers -----------------------------------------------------------

test("the role drivers and their library parse", () => {
  for (const name of ["refuter-task.sh", "releaser-task.sh", "verifier-task.sh", "lib/role-run.sh"]) {
    const r = spawnSync("bash", ["-n", join(E2E, name)], { encoding: "utf8" })
    assert.equal(r.status, 0, `bash -n ${name}: ${r.stderr}`)
  }
})

test("run-all.sh: both role drivers run in the suite and their status decides the exit code", () => {
  assert.match(RUN_ALL, /"\$HERE\/refuter-task\.sh" \|\| ASSERTING_FAILED=/)
  assert.match(RUN_ALL, /"\$HERE\/releaser-task\.sh" \|\| ASSERTING_FAILED=/)
  assert.ok(RUN_ALL.includes("21-refuter.report.txt"), "the suite's failure line names no report for the refuter")
  assert.ok(RUN_ALL.includes("22-releaser.report.txt"), "the suite's failure line names no report for the releaser")
})

test("run-all.sh: the verifier driver runs in the suite and its status decides the exit code", () => {
  assert.match(RUN_ALL, /"\$HERE\/verifier-task\.sh" \|\| ASSERTING_FAILED=/)
  assert.ok(RUN_ALL.includes("23-verifier.report.txt"), "the suite's failure line names no report for the verifier")
  assert.ok(
    RUN_ALL.indexOf('"$HERE/verifier-task.sh"') > RUN_ALL.indexOf("e2e_server_stop\n\n# The fourth mid-run driver"),
    "the verifier driver runs after the suite server is stopped",
  )
})

// ---- verifier-reply.py -----------------------------------------------------

test("verifier-reply.py reads the head, the first verdict and the quoted page error", { skip: !HAVE_PYTHON }, () => {
  const out = figures(
    VERIFIER_READER,
    "`Checks: 1 — 0 pass, 1 fail, 0 not run`\n- 1 FAIL — pw goto http://127.0.0.1:8765/index.html — exit 0 — [pageerror] Cannot read properties of null (reading 'textContent')\n",
  )
  assert.equal(out.head_ok, "1")
  assert.deepEqual([out.checks, out.pass, out.fail, out.not_run], ["1", "0", "1", "0"])
  assert.equal(out.verdict1, "FAIL")
  assert.equal(out.pageerror, "1")
  assert.match(out.pageerror_line, /\[pageerror\] Cannot read properties of null/)
  assert.equal(out.any_pass, "0")
})

test("verifier-reply.py reads a NOT RUN for no vision and names what the screenshot showed", { skip: !HAVE_PYTHON }, () => {
  const blind = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 0 fail, 1 not run\n1 NOT RUN — pw screenshot work/verify-1/canvas.png — exit 0 — reason: no vision\n")
  assert.equal(blind.verdict1, "NOT RUN")
  assert.equal(blind.no_vision, "1")
  assert.equal(blind.any_pass, "0")

  const seen = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 1 fail, 0 not run\n1 FAIL — screenshot work/verify-1/canvas.png shows a red box with the word BROKEN, no green banner\n")
  assert.equal(seen.verdict1, "FAIL")
  assert.equal(seen.red_or_broken, "1")
})

test("verifier-reply.py counts a PASS verdict on a check line, and a reply without the head", { skip: !HAVE_PYTHON }, () => {
  const passed = figures(VERIFIER_READER, "Checks: 1 — 1 pass, 0 fail, 0 not run\n1 PASS — looks fine\n")
  assert.equal(passed.any_pass, "1")
  const headless = figures(VERIFIER_READER, "I checked the page.\n1 PASS — the banner is there\n")
  assert.equal(headless.head_ok, "0")
  assert.equal(headless.verdict1, "PASS")
  assert.equal(headless.any_pass, "1")
})

test("verifier-reply.py reads the verdict where the reply form puts it", { skip: !HAVE_PYTHON }, () => {
  const titled = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 1 fail, 0 not run\n\n**Check: /index.html loads without a page error** — **FAIL**\n- Commands: pw start\n")
  assert.equal(titled.verdict1, "FAIL")
  const numbered = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 0 fail, 1 not run\n\n- **Check 1: `/index.html` loads without a page error (pw console `[pageerror]` lines)** — **NOT RUN** (no browser).\n")
  assert.equal(numbered.verdict1, "NOT RUN")
  const labelled = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 1 fail, 0 not run\n- Command: `pw start`; `pw goto http://127.0.0.1:8765/canvas.html` (all exited 0). Evidence: screenshot shows a red banner labeled “BROKEN,” not a green OK banner. Verdict: FAIL.\n")
  assert.equal(labelled.verdict1, "FAIL")
  const passed = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 0 fail, 0 not run\n- Verdict: **PASS** — the banner is green\n")
  assert.equal(passed.any_pass, "1")
})

test("verifier-reply.py reads no PASS out of the prose of a NOT RUN or a FAIL", { skip: !HAVE_PYTHON }, () => {
  const leg3 = figures(
    VERIFIER_READER,
    "Checks: 1 — 0 pass, 0 fail, 1 not run\n\n**Check: /canvas.html shows a green OK banner (judged from screenshot)**\n- Commands: `pw screenshot work/verify-canvas/canvas.png` exit 0.\n- Verdict: **NOT RUN** — reason: no vision. The check was briefed as a judgment on the screenshot, and reading the PNG back gave `ERROR: Cannot read image (this model does not support image input)`. I never saw the rendered frame, so I cannot call it PASS or FAIL. A sighted judge needs to look at `work/verify-canvas/canvas.png`.\n",
  )
  assert.equal(leg3.verdict1, "NOT RUN")
  assert.equal(leg3.any_pass, "0")
  const prose = figures(VERIFIER_READER, "Checks: 1 — 0 pass, 1 fail, 0 not run\n1 FAIL — the page error below\nA rerun would PASS once #missing exists.\n")
  assert.equal(prose.verdict1, "FAIL")
  assert.equal(prose.any_pass, "0")
})

// The claim the refuter is asked to call false stands nowhere in the tree, so
// the driver may not spell it out either.
test("refuter-task.sh does not carry the absent symbol it asks about", () => {
  const src = readFileSync(join(E2E, "refuter-task.sh"), "utf8")
  const assembled = /ABSENT_SYMBOL="([^"]*)""([^"]*)"/.exec(src)
  assert.ok(assembled, "the symbol is assembled at run time")
  assert.ok(!src.includes(assembled[1] + assembled[2]), "the driver spells the absent symbol out")
})
