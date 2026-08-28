// Unit tests for the shared `opencode serve` lifecycle library used by the
// end-to-end drivers, test/e2e/server-lifecycle.sh.
//
// The library is sourced into a throwaway bash script that exercises one
// function each. Nothing here starts a real opencode: a stub named `opencode`
// is put first on PATH, so the pid trick, the readiness poll and the process
// group kill are driven exactly as they are in a real run, in under a second.
//
// Run: node --test test/

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const LIB = resolve(import.meta.dirname, "e2e/server-lifecycle.sh")

// A stand-in for `opencode serve`. STUB_MODE=serve answers /global/health with
// a version field; STUB_MODE=die exits without ever listening, which is the
// "server died during startup" path. Written in python so the recorded pid is
// one process, and named `opencode` so the /proc/<pid>/cmdline check sees it.
const STUB = `#!/usr/bin/env python3
import os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

if os.environ.get("STUB_MODE") == "die":
    time.sleep(1.5)
    sys.stderr.write("stub refused to start\\n")
    sys.exit(1)

port = int(sys.argv[sys.argv.index("--port") + 1])

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/global/health":
            body = b'{"version":"stub-1.0.0"}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", port), H).serve_forever()
`

// A port nothing listens on. Bound and released in a separate process, so no
// handle is left behind that would keep the test runner's event loop alive.
function freePort() {
  const r = spawnSync(
    "python3",
    ["-c", "import socket\ns=socket.socket()\ns.bind(('127.0.0.1',0))\nprint(s.getsockname()[1])\ns.close()"],
    { encoding: "utf8" },
  )
  assert.equal(r.status, 0, `could not pick a free port: ${r.stderr}`)
  return Number(r.stdout.trim())
}

// Writes `script` into a fresh directory that also holds the opencode stub,
// runs it with bash, and returns { status, stdout, stderr, dir }.
function runShell(script, { env = {}, withStub = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-lifecycle-"))
  const bin = join(dir, "bin")
  spawnSync("mkdir", ["-p", bin])
  if (withStub) {
    const stub = join(bin, "opencode")
    writeFileSync(stub, STUB)
    chmodSync(stub, 0o755)
  }
  const file = join(dir, "drive.sh")
  writeFileSync(file, script)
  const res = spawnSync("bash", [file], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIB, DIR: dir, ...env },
  })
  return { ...res, dir }
}

test("e2e_server_url is the one place the host part is decided", () => {
  const r = runShell(`. "$LIB"\ne2e_server_url 4599\n`, { withStub: false })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "http://127.0.0.1:4599")
})

test("start, readiness and stop drive a server through its whole life", () => {
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
. "$LIB"
e2e_server_start ${port} "$DIR" "$DIR/server.log" "$DIR/pidfile" || exit 11
e2e_server_wait_ready 30 "$DIR/health.json" || exit 12
e2e_server_alive || exit 13
echo "PID=$E2E_SERVER_PID"
echo "PGID=$E2E_SERVER_PGID"
echo "BASE=$E2E_SERVER_BASE"
e2e_server_stop || exit 14
e2e_server_alive && exit 15
curl -fsS -m 3 "http://127.0.0.1:${port}/global/health" >/dev/null 2>&1 && exit 16
echo "AFTER_PID=[$E2E_SERVER_PID]"
exit 0
`,
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)

  // The recorded pid is the server itself, not a wrapper that handed off.
  const pid = /PID=(\d+)/.exec(r.stdout)[1]
  const pgid = /PGID=(\d+)/.exec(r.stdout)[1]
  assert.equal(pid, pgid, "setsid must make the recorded pid its own group leader")
  assert.match(r.stdout, new RegExp(`BASE=http://127\\.0\\.0\\.1:${port}`))

  // The health response is kept where the caller asked for it.
  const health = JSON.parse(readFileSync(join(r.dir, "health.json"), "utf8"))
  assert.equal(health.version, "stub-1.0.0")

  // The pid file holds that same pid, and stop clears the recorded state.
  assert.equal(readFileSync(join(r.dir, "pidfile"), "utf8").trim(), pid)
  assert.match(r.stdout, /AFTER_PID=\[\]/)
  assert.match(r.stdout, /server stopped \(signalled -\d+\)/)

  rmSync(r.dir, { recursive: true, force: true })
})

test("readiness fails loudly, with the server log, when opencode dies at startup", () => {
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
. "$LIB"
e2e_server_start ${port} "$DIR" "$DIR/server.log" "$DIR/pidfile" || exit 11
e2e_server_wait_ready 30 "$DIR/health.json" && exit 12
echo "READY_FAILED"
exit 0
`,
    { env: { STUB_MODE: "die" } },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /READY_FAILED/)
  assert.match(r.stderr, /last 30 lines of/)
  assert.match(r.stderr, /stub refused to start/)
  assert.match(r.stderr, /exited during startup/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("readiness fails on its timeout while the process is still alive", () => {
  // A port the stub never listens on: the health poll runs out of budget.
  const r = runShell(
    `set -uo pipefail
. "$LIB"
E2E_SERVER_PID=$$
E2E_SERVER_PGID=$$
E2E_SERVER_BASE=$(e2e_server_url ${freePort()})
E2E_SERVER_LOG="$DIR/server.log"
: > "$E2E_SERVER_LOG"
e2e_server_wait_ready 2 && exit 12
echo "TIMED_OUT"
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /TIMED_OUT/)
  assert.match(r.stderr, /no HTTP 200 from .* within 2s/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("start refuses a project directory that does not exist", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
e2e_server_start 4599 "$DIR/nope" "$DIR/server.log" "$DIR/pidfile" && exit 12
echo "REFUSED"
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /REFUSED/)
  assert.match(r.stderr, /no such project directory/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("stop is a no-op when no server was started, and safe to call twice", () => {
  const r = runShell(
    `set -euo pipefail
. "$LIB"
e2e_server_stop
e2e_server_stop
echo "NOOP"
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.equal(r.stdout.trim(), "NOOP")
  rmSync(r.dir, { recursive: true, force: true })
})

test("the TUI build fails loudly instead of starting a server on a stale bundle", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
e2e_build_tui "$DIR" && exit 12
echo "BUILD_REFUSED"
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /BUILD_REFUSED/)
  assert.match(r.stderr, /no such directory: .*\/tui/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("E2E_TUI_BUILT=1 skips the build, so a driver started by run-all.sh builds once", () => {
  const r = runShell(
    `set -euo pipefail
. "$LIB"
e2e_build_tui /nonexistent-plugin-root
`,
    { withStub: false, env: { E2E_TUI_BUILT: "1" } },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /already built in this run/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("e2e_plugin_wired accepts both project-scoped forms and refuses neither", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir -p "$DIR/bare" "$DIR/json" "$DIR/dropin/.opencode/plugins" "$DIR/other"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/json/opencode.json"
printf '{"plugin":["/opt/somewhere-else"]}\n' > "$DIR/other/opencode.json"
: > "$DIR/dropin/.opencode/plugins/loader.js"
e2e_plugin_wired /opt/the-plugin "$DIR/json"   && echo "JSON=yes"   || echo "JSON=no"
e2e_plugin_wired /opt/the-plugin "$DIR/dropin" && echo "DROPIN=yes" || echo "DROPIN=no"
e2e_plugin_wired /opt/the-plugin "$DIR/bare"   && echo "BARE=yes"   || echo "BARE=no"
e2e_plugin_wired /opt/the-plugin "$DIR/other"  && echo "OTHER=yes"  || echo "OTHER=no"
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /JSON=yes/)
  assert.match(r.stdout, /DROPIN=yes/)
  assert.match(r.stdout, /BARE=no/)
  assert.match(r.stdout, /OTHER=no/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("the drivers source the library and call it", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-all.sh", "endless-task.sh"]) {
    const path = join(e2e, name)
    assert.ok(existsSync(path), `${path} is missing`)
    const src = readFileSync(path, "utf8")
    assert.match(src, /\. "\$HERE\/server-lifecycle\.sh"/, `${name} does not source the library`)
    for (const fn of [
      "e2e_plugin_wired",
      "e2e_build_tui",
      "e2e_server_start",
      "e2e_server_wait_ready",
      "e2e_server_stop",
    ]) {
      assert.match(src, new RegExp(`\\b${fn}\\b`), `${name} does not call ${fn}`)
    }
    // Nothing that was moved into the library may be left behind inline.
    assert.doesNotMatch(src, /setsid bash -c/, `${name} still starts a server inline`)
    assert.doesNotMatch(src, /kill -TERM/, `${name} still stops a server inline`)
  }
})

test("every e2e shell script parses", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "server-lifecycle.sh",
    "run-all.sh",
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
  ]) {
    const r = spawnSync("bash", ["-n", join(e2e, name)], { encoding: "utf8" })
    assert.equal(r.status, 0, `bash -n ${name}: ${r.stderr}`)
  }
})
