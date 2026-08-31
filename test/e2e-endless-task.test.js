// Shell-level tests for the endless-mode driver's teardown. The driver is a
// complete live harness, so these tests extract only its cleanup function and
// run it with the same globals and shell commands a teardown receives.

import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const DRIVER = resolve(import.meta.dirname, "e2e/endless-task.sh")
const DRIVER_SOURCE = readFileSync(DRIVER, "utf8")
const CLEANUP_START = DRIVER_SOURCE.indexOf("cleanup() {")
const CLEANUP_END = DRIVER_SOURCE.indexOf("\ntrap cleanup EXIT", CLEANUP_START)
assert.ok(CLEANUP_START >= 0, "endless driver has no cleanup function")
assert.ok(CLEANUP_END > CLEANUP_START, "endless driver cleanup has no trap boundary")
const CLEANUP = DRIVER_SOURCE.slice(CLEANUP_START, CLEANUP_END)

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function runCleanup({
  todoBefore = "",
  todoBackupName = "",
  todoExisted = 0,
  todoGuarded = 0,
  settingsExisted = 0,
  settingsWritten = 0,
  failCp = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-endless-cleanup-"))
  const project = join(dir, "project")
  const config = join(dir, "config", "agent-intercom.json")
  const settingsBackup = join(dir, "settings.bak")
  const todoBackup = join(dir, "todo.bak")
  const report = join(dir, "report.txt")
  const slice = join(dir, "slice.log")
  const serverLog = join(dir, "server.log")
  mkdir(project)
  mkdir(join(dir, "config"))

  if (todoExisted) {
    writeFileSync(join(project, todoBackupName), "baseline\n")
    writeFileSync(todoBackup, "baseline\n")
    if (todoBackupName === "ToDoS.md") {
      writeFileSync(join(project, "TODO.md"), "cycle-created\n")
    }
  }
  if (settingsExisted) {
    writeFileSync(config, '{"endlessMode":true,"endlessContext":1}\n')
    writeFileSync(settingsBackup, '{"endlessMode":false}\n')
  }

  const todoNames = `todo_names() {
  find ${shellQuote(project)} -maxdepth 1 -type f -iregex '.*/todos?\\.md' -printf '%f\\n' 2>/dev/null | sort
}`
  const failingCp = failCp ? "cp() { return 1; }" : ""
  const script = `set +e
say() { printf '%s\\n' "$*"; }
e2e_server_alive() { return 1; }
e2e_server_stop() { :; }
refresh_slice() { :; }
${todoNames}
PROJECT_DIR=${shellQuote(project)}
SETTINGS_FILE=${shellQuote(config)}
SETTINGS_BAK=${shellQuote(settingsBackup)}
SETTINGS_EXISTED=${settingsExisted}
SETTINGS_WRITTEN=${settingsWritten}
TODO_BAK=${shellQuote(todoBackup)}
TODO_BAK_NAME=${shellQuote(todoBackupName)}
TODO_BEFORE=${shellQuote(todoBefore)}
TODO_EXISTED=${todoExisted}
TODO_GUARDED=${todoGuarded}
KEEP_SERVER=1
SID=''
NEWSID=''
E2E_SERVER_PID=''
E2E_SERVER_PGID=''
BASE=''
SLICE_FILE=${shellQuote(slice)}
SERVER_LOG=${shellQuote(serverLog)}
REPORT_FILE=${shellQuote(report)}
LOG_TRUNCATED=0
LOG_OFFSET=0
ASSERTED=0
FAILURES=0
${failingCp}
${CLEANUP}
false
cleanup
`
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  return { ...result, dir, project, config }
}

function mkdir(path) {
  // Keep setup in the same process as the test's temporary-file bookkeeping.
  const result = spawnSync("mkdir", ["-p", path], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

test("cleanup removes every non-baseline todo casing before restoring the baseline", () => {
  const r = runCleanup({
    todoBefore: "ToDoS.md",
    todoBackupName: "ToDoS.md",
    todoExisted: 1,
    todoGuarded: 1,
  })
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.equal(existsSync(join(r.project, "TODO.md")), false)
  assert.equal(readFileSync(join(r.project, "ToDoS.md"), "utf8"), "baseline\n")
  rmSync(r.dir, { recursive: true, force: true })
})

test("cleanup turns a failed todo restore into exit code 2", () => {
  const r = runCleanup({
    todoBefore: "todos.md",
    todoBackupName: "todos.md",
    todoExisted: 1,
    todoGuarded: 1,
    failCp: true,
  })
  assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /CLEANUP FAILED: could not restore .*todos\.md/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("cleanup turns a failed settings restore into exit code 2", () => {
  const r = runCleanup({
    settingsExisted: 1,
    settingsWritten: 1,
    failCp: true,
  })
  assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /CLEANUP FAILED: could not restore .*agent-intercom\.json/)
  assert.match(readFileSync(r.config, "utf8"), /"endlessMode":true/)
  rmSync(r.dir, { recursive: true, force: true })
})
