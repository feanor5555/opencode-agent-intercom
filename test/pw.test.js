// `pw`: one daemon per `PW_SESSION`, a console record of what the page prints
// and throws, and the `console` command that reads it.
//
// The pure parts (bin/pw-lib.js) are pinned directly; `pw start` with an empty
// PLAYWRIGHT_BROWSERS_PATH pins the no-browser exit; the daemon test starts two
// real daemons against two `data:` pages and skips with a reason where the
// plugin's Chromium is not installed.
//
// Run: node --test test/pw.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  CONSOLE_RING_LINES,
  DEFAULT_PW_IDLE_EXIT_MS,
  PW_BROWSER_MISSING_LINE,
  consoleLine,
  createConsoleRing,
  formatConsoleRecord,
  pageErrorLine,
  parseConsoleArgs,
  pwIdleExitMs,
  pwPaths,
  pwSessionSuffix,
} from "../bin/pw-lib.js"
import { chromiumInstalled } from "../bin/chromium.js"

const PW = fileURLToPath(new URL("../bin/pw.js", import.meta.url))

test("the socket, pid and log names carry the sanitized session", () => {
  assert.deepEqual(pwPaths("/run/x", "ses_ABC-123"), {
    socket: "/run/x/pw-ses_ABC-123.sock",
    pid: "/run/x/pw-ses_ABC-123.pid",
    log: "/run/x/pw-ses_ABC-123.log",
  })
  assert.equal(pwSessionSuffix("ses/../evil id;rm"), "sesevilidrm")
  assert.equal(pwSessionSuffix("a".repeat(100)).length, 64)
  assert.equal(pwPaths("/run/x", "a".repeat(100)).socket, `/run/x/pw-${"a".repeat(64)}.sock`)
})

test("without a session the names stay pw.sock, pw.pid, pw.log", () => {
  for (const session of [undefined, "", "///"]) {
    assert.deepEqual(pwPaths("/run/x", session), {
      socket: "/run/x/pw.sock",
      pid: "/run/x/pw.pid",
      log: "/run/x/pw.log",
    }, String(session))
  }
})

test("pw console takes --clear and nothing else", () => {
  assert.deepEqual(parseConsoleArgs([]), { request: { cmd: "console", clear: false } })
  assert.deepEqual(parseConsoleArgs(["--clear"]), { request: { cmd: "console", clear: true } })
  assert.match(parseConsoleArgs(["--all"]).error, /unknown argument "--all"/)
})

test("the ring keeps the last 500 lines, oldest first", () => {
  assert.equal(CONSOLE_RING_LINES, 500)
  const ring = createConsoleRing()
  for (let i = 1; i <= 612; i++) ring.push(`line ${i}`)
  const lines = ring.lines()
  assert.equal(lines.length, 500)
  assert.equal(lines[0], "line 113")
  assert.equal(lines.at(-1), "line 612")
  ring.clear()
  assert.deepEqual(ring.lines(), [])
})

test("console and page-error lines, and an empty record", () => {
  assert.equal(consoleLine("error", "bad thing"), "[error] bad thing")
  assert.equal(pageErrorLine("boom"), "[pageerror] boom")
  assert.equal(formatConsoleRecord(["[log] a", "[pageerror] b"]), "[log] a\n[pageerror] b")
  assert.equal(formatConsoleRecord([]), "(no console output)")
})

test("the idle exit defaults to 15 minutes and takes a whole number, 0 included", () => {
  assert.equal(DEFAULT_PW_IDLE_EXIT_MS, 900000)
  assert.equal(pwIdleExitMs(undefined), 900000)
  assert.equal(pwIdleExitMs("60000"), 60000)
  assert.equal(pwIdleExitMs("0"), 0)
  assert.equal(pwIdleExitMs("-5"), 900000)
  assert.equal(pwIdleExitMs("soon"), 900000)
})

test("pw console with an unknown argument exits 2 without a daemon", () => {
  const runtime = mkdtempSync(join(tmpdir(), "pw-cli-"))
  try {
    const r = spawnSync(process.execPath, [PW, "console", "--all"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, PW_SESSION: "ses_cli" },
      encoding: "utf8",
    })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /pw console: unknown argument "--all"/)
  } finally {
    rmSync(runtime, { recursive: true, force: true })
  }
})

// No browser under PLAYWRIGHT_BROWSERS_PATH: `pw start` downloads nothing,
// starts no daemon and exits 1 at once with its one line.
test("pw start with no browser installed exits 1 at once with one line", () => {
  assert.equal(PW_BROWSER_MISSING_LINE, "pw: browser not installed — report this check as NOT RUN")
  const runtime = mkdtempSync(join(tmpdir(), "pw-nobrowser-run-"))
  const browsers = mkdtempSync(join(tmpdir(), "pw-nobrowser-dir-"))
  try {
    const started = Date.now()
    const r = spawnSync(process.execPath, [PW, "start"], {
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: runtime,
        PW_SESSION: "ses_nobrowser",
        PLAYWRIGHT_BROWSERS_PATH: browsers,
      },
      encoding: "utf8",
      timeout: 15000,
    })
    assert.equal(r.status, 1, `stderr: ${r.stderr}`)
    assert.ok(Date.now() - started < 10000, "pw start returned at once")
    assert.equal(r.stderr, `${PW_BROWSER_MISSING_LINE}\n`)
    assert.equal(r.stdout, "")
    assert.deepEqual(readdirSync(browsers), [], "nothing was downloaded")
    const dir = join(runtime, "opencode-agent-intercom")
    assert.equal(existsSync(join(dir, "pw-ses_nobrowser.sock")), false, "no daemon socket")
    assert.equal(existsSync(join(dir, "pw-ses_nobrowser.log")), false, "no daemon spawned")
  } finally {
    rmSync(runtime, { recursive: true, force: true })
    rmSync(browsers, { recursive: true, force: true })
  }
})

// Two sessions, two daemons: the page that throws on load shows its
// `[pageerror]` line in its own session's record and nowhere else.
test("two sessions run two daemons, each with its own page-error record", async (t) => {
  let installed = false
  try {
    ;({ installed } = await chromiumInstalled())
  } catch (err) {
    t.skip(`playwright-core not loadable: ${err.message}`)
    return
  }
  if (!installed) {
    t.skip("the plugin's Chromium is not installed on this host")
    return
  }

  const runtime = mkdtempSync(join(tmpdir(), "pw-daemon-"))
  const run = (session, ...args) =>
    spawnSync(process.execPath, [PW, ...args], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, PW_SESSION: session, PW_IDLE_EXIT_MS: "120000" },
      encoding: "utf8",
      timeout: 60000,
    })
  const throwing = "data:text/html,<p>a</p><script>throw new Error('pw-test-boom')</script>"
  const quiet = "data:text/html,<p>b</p><script>console.log('pw-test-quiet')</script>"
  try {
    for (const session of ["ses_a", "ses_b"]) {
      const started = run(session, "start")
      assert.equal(started.status, 0, `${session} start: ${started.stderr}`)
    }
    assert.equal(run("ses_a", "goto", throwing).status, 0)
    assert.equal(run("ses_b", "goto", quiet).status, 0)

    const a = run("ses_a", "console")
    const b = run("ses_b", "console")
    assert.equal(a.status, 0, a.stderr)
    assert.equal(b.status, 0, b.stderr)
    assert.match(a.stdout, /\[pageerror\] .*pw-test-boom/)
    assert.doesNotMatch(b.stdout, /pw-test-boom/)
    assert.match(b.stdout, /\[log\] pw-test-quiet/)

    const cleared = run("ses_a", "console", "--clear")
    assert.match(cleared.stdout, /pw-test-boom/)
    assert.match(run("ses_a", "console").stdout, /\(no console output\)/)
  } finally {
    run("ses_a", "stop")
    run("ses_b", "stop")
    rmSync(runtime, { recursive: true, force: true })
  }
})
