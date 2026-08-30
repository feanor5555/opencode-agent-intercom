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

test("a start with no pid removes its own empty capture directory", () => {
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir "$DIR/captures"
e2e_server_start ${port} "$DIR" "$DIR/captures/00-suite.server.log" "$DIR/missing/00-suite.serverpid" && exit 12
echo "START_REFUSED"
test ! -e "$DIR/captures/00-suite.server.log" || exit 13
test ! -e "$DIR/captures" || exit 14
test ! -e "$DIR/missing/00-suite.serverpid" || exit 15
`,
    { env: { STUB_MODE: "die" } },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /START_REFUSED/)
  assert.match(r.stderr, /wrapper never wrote its pid/)

  rmSync(r.dir, { recursive: true, force: true })
})

test("a failed start keeps pre-existing capture content", () => {
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir "$DIR/captures"
printf 'keep this\n' > "$DIR/captures/keep.txt"
e2e_server_start ${port} "$DIR" "$DIR/captures/00-suite.server.log" "$DIR/missing/00-suite.serverpid" && exit 12
echo "START_REFUSED"
test -s "$DIR/captures/keep.txt" || exit 13
test ! -e "$DIR/captures/00-suite.server.log" || exit 14
`,
    { env: { STUB_MODE: "die" } },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /START_REFUSED/)
  assert.match(r.stderr, /wrapper never wrote its pid/)

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

// The subshell guard. Every case here runs without the stub on PATH: should the
// guard ever stop firing, the wrapper still writes its pid file before its `exec
// opencode` fails, so the missing pid file is what proves nothing was started —
// and no stray server is left behind by a regression in this very test.
for (const [what, call] of [
  ["a pipeline", `e2e_server_start 4599 "$DIR" "$DIR/server.log" "$DIR/pidfile" | cat`],
  ["a command substitution", `OUT=$(e2e_server_start 4599 "$DIR" "$DIR/server.log" "$DIR/pidfile")`],
  ["a background job", `e2e_server_start 4599 "$DIR" "$DIR/server.log" "$DIR/pidfile" & wait $!`],
  ["an explicit subshell", `( e2e_server_start 4599 "$DIR" "$DIR/server.log" "$DIR/pidfile" )`],
]) {
  test(`start refuses to run in ${what} instead of leaking the server`, () => {
    const r = runShell(
      `set -uo pipefail
. "$LIB"
${call} && exit 12
echo "REFUSED"
`,
      { withStub: false },
    )
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
    assert.match(r.stdout, /REFUSED/)
    // What went wrong, and what the caller must do instead.
    assert.match(r.stderr, /e2e_server_start: refusing to start a server/)
    assert.match(r.stderr, /runs in a subshell \(pid \d+\), not in the caller's shell \(pid \d+\)/)
    assert.match(r.stderr, /could not be stopped again and would be left running/)
    assert.match(r.stderr, /Call it directly in your own shell/)
    assert.match(r.stderr, /not through a pipe/)
    // Nothing was started: the wrapper never ran, so it wrote no pid file.
    assert.equal(existsSync(join(r.dir, "pidfile")), false, "a server was started in the subshell")
    rmSync(r.dir, { recursive: true, force: true })
  })
}

test("the guard stays silent for the direct call the drivers make", () => {
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
. "$LIB"
e2e_server_start ${port} "$DIR" "$DIR/server.log" "$DIR/pidfile" || exit 11
e2e_server_wait_ready 30 "$DIR/health.json" || exit 12
e2e_server_stop || exit 13
echo "DIRECT_OK"
`,
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /DIRECT_OK/)
  assert.doesNotMatch(r.stderr, /subshell/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("piping a whole driver is still allowed — its shell keeps the state", () => {
  // `bash run-all.sh 2>&1 | tee log` puts the driver itself in a pipeline, but
  // the driver is its own process: its globals and its trap survive, so the
  // guard must not fire on the call inside it.
  const port = freePort()
  const r = runShell(
    `set -uo pipefail
cat > "$DIR/driver.sh" <<'INNER'
. "$LIB"
trap 'e2e_server_stop' EXIT
e2e_server_start ${port} "$DIR" "$DIR/server.log" "$DIR/pidfile" || exit 11
e2e_server_wait_ready 30 "$DIR/health.json" || exit 12
echo "DRIVER_OK"
INNER
bash "$DIR/driver.sh" | cat
exit "\${PIPESTATUS[0]}"
`,
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /DRIVER_OK/)
  assert.match(r.stdout, /server stopped \(signalled -\d+\)/)
  assert.doesNotMatch(r.stderr, /subshell/)
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

// The plugin is wired either into the project the server runs in or into the
// user's global opencode config, where it is in force in every directory. All
// four forms count, and only a setup with none of them is unwired. Every case
// runs under an XDG_CONFIG_HOME of its own, so the machine's real global config
// decides nothing here.
test("e2e_plugin_wired accepts the two project-scoped and the two global forms, and refuses none", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir -p "$DIR/bare" "$DIR/json" "$DIR/jsonc" "$DIR/dropin/.opencode/plugins" "$DIR/other" \
         "$DIR/cfg-empty/opencode" "$DIR/cfg-json/opencode" "$DIR/cfg-jsonc/opencode" \
         "$DIR/cfg-dropin/opencode/plugin"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/json/opencode.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/jsonc/opencode.jsonc"
printf '{"plugin":["/opt/somewhere-else"]}\n' > "$DIR/other/opencode.json"
: > "$DIR/dropin/.opencode/plugins/loader.js"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/cfg-json/opencode/opencode.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/cfg-jsonc/opencode/opencode.jsonc"
: > "$DIR/cfg-dropin/opencode/plugin/loader.ts"

probe() { # <xdg_config_home> <project_dir> <label>
  XDG_CONFIG_HOME="$1" e2e_plugin_wired /opt/the-plugin "$2" && echo "$3=yes" || echo "$3=no"
}
probe "$DIR/cfg-empty"  "$DIR/json"   PROJECT_JSON
probe "$DIR/cfg-empty"  "$DIR/jsonc"  PROJECT_JSONC
probe "$DIR/cfg-empty"  "$DIR/dropin" PROJECT_DROPIN
probe "$DIR/cfg-json"   "$DIR/bare"   GLOBAL_JSON
probe "$DIR/cfg-jsonc"  "$DIR/bare"   GLOBAL_JSONC
probe "$DIR/cfg-dropin" "$DIR/bare"   GLOBAL_DROPIN
probe "$DIR/cfg-json"   "$DIR/other"  GLOBAL_OVER_OTHER
probe "$DIR/cfg-empty"  "$DIR/bare"   BARE
probe "$DIR/cfg-empty"  "$DIR/other"  OTHER
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  // Wired: either project-scoped form, either global form, and a project whose
  // own config names another plugin while the global config names this one.
  assert.match(r.stdout, /PROJECT_JSON=yes/)
  assert.match(r.stdout, /PROJECT_JSONC=yes/)
  assert.match(r.stdout, /PROJECT_DROPIN=yes/)
  assert.match(r.stdout, /GLOBAL_JSON=yes/)
  assert.match(r.stdout, /GLOBAL_JSONC=yes/)
  assert.match(r.stdout, /GLOBAL_DROPIN=yes/)
  assert.match(r.stdout, /GLOBAL_OVER_OTHER=yes/)
  // Unwired: nothing anywhere, and a plugin path that matches neither config.
  assert.match(r.stdout, /BARE=no/)
  assert.match(r.stdout, /OTHER=no/)
  rmSync(r.dir, { recursive: true, force: true })
})

// The TUI half reads a plugin list of its own: a `plugin` entry in
// opencode.json wires the server alone, so a setup with that entry and no
// tui.json has the spawn tool and no sidebar. e2e_tui_plugin_wired mirrors the
// server check one file name over — global tui.json/tui.jsonc, project
// tui.json/tui.jsonc, project .opencode/tui.json/.jsonc — and every case runs
// under an XDG_CONFIG_HOME of its own.
test("e2e_tui_plugin_wired accepts the global and project tui config forms, and refuses none", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir -p "$DIR/bare" "$DIR/tjson" "$DIR/tjsonc" "$DIR/tdotopencode/.opencode" "$DIR/server-only" \
         "$DIR/cfg-empty/opencode" "$DIR/cfg-tjson/opencode" "$DIR/cfg-tjsonc/opencode" \
         "$DIR/cfg-server-only/opencode"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/tjson/tui.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/tjsonc/tui.jsonc"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/tdotopencode/.opencode/tui.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/server-only/opencode.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/cfg-tjson/opencode/tui.json"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/cfg-tjsonc/opencode/tui.jsonc"
printf '{"plugin":["/opt/the-plugin"]}\n' > "$DIR/cfg-server-only/opencode/opencode.json"
printf '{"plugin":["/opt/somewhere-else"]}\n' > "$DIR/cfg-empty/opencode/tui.json"

probe() { # <xdg_config_home> <project_dir> <label>
  XDG_CONFIG_HOME="$1" e2e_tui_plugin_wired /opt/the-plugin "$2" 2>/dev/null && echo "$3=yes" || echo "$3=no"
}
probe "$DIR/cfg-empty"       "$DIR/tjson"        PROJECT_TUI_JSON
probe "$DIR/cfg-empty"       "$DIR/tjsonc"       PROJECT_TUI_JSONC
probe "$DIR/cfg-empty"       "$DIR/tdotopencode" PROJECT_DOT_OPENCODE
probe "$DIR/cfg-tjson"       "$DIR/bare"         GLOBAL_TUI_JSON
probe "$DIR/cfg-tjsonc"      "$DIR/bare"         GLOBAL_TUI_JSONC
probe "$DIR/cfg-tjson"       "$DIR/server-only"  GLOBAL_OVER_SERVER_ONLY
probe "$DIR/cfg-empty"       "$DIR/bare"         BARE
probe "$DIR/cfg-empty"       "$DIR/server-only"  OTHER_PLUGIN
probe "$DIR/cfg-server-only" "$DIR/server-only"  SERVER_WIRED_TUI_NOT
`,
    { withStub: false },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /PROJECT_TUI_JSON=yes/)
  assert.match(r.stdout, /PROJECT_TUI_JSONC=yes/)
  assert.match(r.stdout, /PROJECT_DOT_OPENCODE=yes/)
  assert.match(r.stdout, /GLOBAL_TUI_JSON=yes/)
  assert.match(r.stdout, /GLOBAL_TUI_JSONC=yes/)
  assert.match(r.stdout, /GLOBAL_OVER_SERVER_ONLY=yes/)
  assert.match(r.stdout, /BARE=no/)
  // A tui.json naming another plugin is no wiring for this one.
  assert.match(r.stdout, /OTHER_PLUGIN=no/)
  // The defect this check exists for: the server wired, the TUI not.
  assert.match(r.stdout, /SERVER_WIRED_TUI_NOT=no/)
  rmSync(r.dir, { recursive: true, force: true })
})

// The failure is never silent: it names the global tui.json it did not find,
// keeps a file that exists without the entry apart from one that is absent,
// and states the remedy.
test("e2e_tui_plugin_wired names the tui config and what is missing when it refuses", () => {
  const r = runShell(
    `set -uo pipefail
. "$LIB"
mkdir -p "$DIR/proj" "$DIR/cfg/opencode"
printf '{"plugin":["/opt/somewhere-else"]}\n' > "$DIR/proj/tui.json"
XDG_CONFIG_HOME="$DIR/cfg" e2e_tui_plugin_wired /opt/the-plugin "$DIR/proj" && echo UNEXPECTED_PASS
echo "STATUS=$?"
`,
    { withStub: false },
  )
  assert.doesNotMatch(r.stdout, /UNEXPECTED_PASS/)
  assert.match(r.stdout, /STATUS=1/)
  assert.match(r.stderr, /no tui\.json or tui\.jsonc names \/opt\/the-plugin/)
  assert.match(r.stderr, new RegExp(`missing: ${r.dir}/cfg/opencode/tui\\.json`))
  assert.match(r.stderr, new RegExp(`exists but has no "plugin" entry naming /opt/the-plugin: ${r.dir}/proj/tui\\.json`))
  assert.match(r.stderr, new RegExp(`Add \\{"plugin": \\["/opt/the-plugin"\\]\\} to ${r.dir}/cfg/opencode/tui\\.json`))
  rmSync(r.dir, { recursive: true, force: true })
})

// Every driver that builds the TUI half must also check that half is wired.
test("every driver checks the TUI wiring next to the server wiring", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-all.sh", "endless-task.sh", "nested-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\be2e_tui_plugin_wired\b/, `${name} does not check the TUI wiring`)
    assert.match(src, /\be2e_plugin_wired\b/, `${name} does not check the server wiring`)
  }
})

// A genuinely unwired setup must be told about all three remedies, the global
// one included — the drivers are the only place that message is printed.
test("every remediation message for an unwired setup names the global config too", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-all.sh", "endless-task.sh", "nested-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    const message = src
      .split("\n")
      .filter((l) => l.includes("$PLUGIN_ROOT") && (l.includes("die ") || l.includes("echo ")))
      .join("\n")
    assert.ok(message, `${name} prints no wiring remedy`)
    assert.match(message, /XDG_CONFIG_HOME:-\$HOME\/\.config\}\/opencode\/opencode\.json/, `${name}: no global remedy`)
    assert.match(message, /opencode\.json/, `${name}: no project opencode.json remedy`)
    assert.match(message, /\.opencode\/plugin\//, `${name}: no drop-in remedy`)
  }
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

test("no driver calls the start through a pipe, a substitution or a background job", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-all.sh", "multi-task.sh", "run-task.sh", "endless-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    for (const line of src.split("\n")) {
      if (!/^\s*[^#]*\be2e_server_start\b/.test(line)) continue
      assert.doesNotMatch(line, /(?<!\|)\|(?!\|)/, `${name} pipes e2e_server_start: ${line}`)
      assert.doesNotMatch(line, /\$\(\s*e2e_server_start/, `${name} substitutes e2e_server_start: ${line}`)
      assert.doesNotMatch(line, /&\s*$/, `${name} backgrounds e2e_server_start: ${line}`)
    }
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
