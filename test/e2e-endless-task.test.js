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

// ---------------------------------------------------------------------------
// The seeded fixture and the work-off gates. What the re-title criterion rests
// on is arranged here and nowhere else: a file the plugin's own parser accepts,
// one task that produces the artefact another task's title still calls
// outstanding, and gates that keep every other task un-finishable until the
// driver opens one.
// ---------------------------------------------------------------------------

// One top-level function of the driver, sliced out by name. Every function
// reached this way closes with a `}` in the first column.
function driverFunction(name) {
  const start = DRIVER_SOURCE.indexOf(`\n${name}() {\n`)
  assert.ok(start >= 0, `endless driver has no ${name} function`)
  const end = DRIVER_SOURCE.indexOf("\n}\n", start)
  assert.ok(end > start, `${name} has no closing brace`)
  return DRIVER_SOURCE.slice(start + 1, end + 3)
}

function runSeed() {
  const dir = mkdtempSync(join(tmpdir(), "e2e-endless-seed-"))
  const path = join(dir, "TODO.md")
  const script = `${driverFunction("seed_todo_file")}\nseed_todo_file ${shellQuote(path)}\n`
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return { dir, path, content: readFileSync(path, "utf8") }
}

test("the seeded todo file parses as the plugin parses it, with the watermark above every id", async () => {
  const { dir, content } = runSeed()
  const { parseTasks, splitSections } = await import("../src/todofile.js")
  const split = splitSections(content)
  assert.equal(split.valid, true)
  const tasks = parseTasks(content)
  assert.deepEqual(tasks.map((t) => t.id), ["T101", "T102", "T103", "T104"])
  for (const task of tasks) {
    assert.ok(task.text.trim() !== "", `${task.id} has an empty title`)
    assert.ok(task.accept, `${task.id} carries no accept line`)
    const at = content.split("\n").indexOf(`- ${task.id}: ${task.text}`)
    assert.ok(at > split.beginIdx && at < split.endIdx, `${task.id} stands outside the markers`)
  }
  const watermark = /<!-- intercom: next-id T(\d+) -->/.exec(content)
  assert.ok(watermark, "the seed carries no id watermark")
  const highest = Math.max(...tasks.map((t) => Number(t.id.slice(1))))
  assert.ok(Number(watermark[1]) > highest, "the watermark does not sit above every seeded id")
  rmSync(dir, { recursive: true, force: true })
})

test("the seed pairs the task that produces merged.md with the one whose title still awaits it", async () => {
  const { dir, content } = runSeed()
  const { parseTasks } = await import("../src/todofile.js")
  const byId = new Map(parseTasks(content).map((t) => [t.id, t]))
  // T101 is what makes the staleness: it writes the file T104's title is still
  // waiting for. Without both halves the last cycle has nothing to re-title.
  assert.match(byId.get("T101").text, /merged\.md/)
  assert.match(byId.get("T104").text, /Waiting on T101 to produce .*merged\.md/)
  rmSync(dir, { recursive: true, force: true })
})

test("every seeded task but the first is gated on a flag no subagent may write", async () => {
  const { dir, content } = runSeed()
  const { parseTasks } = await import("../src/todofile.js")
  const tasks = parseTasks(content)
  assert.equal(/\.flag/.test(tasks[0].text), false, "T101 must be finishable without a gate")
  for (const task of tasks.slice(1)) {
    assert.match(task.text, /\.flag/, `${task.id} names no gate in its title`)
    assert.match(task.accept, /written by the run's owner and by nobody else/, `${task.id} does not forbid its subagent to open the gate`)
    assert.match(task.accept, /report blocked/, `${task.id} does not tell its subagent to report blocked`)
  }
  // Exactly one gate per cycle the driver can open, plus the one it never does.
  assert.match(tasks[1].text, /cycle2\.flag/)
  assert.match(tasks[2].text, /cycle3\.flag/)
  assert.match(tasks[3].text, /owner\.flag/)
  rmSync(dir, { recursive: true, force: true })
})

function runGate({ cycle, seeded = 1 }) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-endless-gate-"))
  const report = join(dir, "report.txt")
  mkdir(join(dir, "e2e-endless-fixture"))
  const script = `say() { printf '%s\\n' "$*"; }
PREFIX=11-endless
PROJECT_DIR=${shellQuote(dir)}
FIXTURE_NAME=e2e-endless-fixture
TODO_SEEDED=${seeded}
REPORT_FILE=${shellQuote(report)}
${driverFunction("open_workoff_gate")}
open_workoff_gate ${cycle}
`
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return { dir, result, flag: join(dir, "e2e-endless-fixture", `cycle${cycle}.flag`) }
}

test("the work-off gate opens for a cycle after the first and for no other", () => {
  const first = runGate({ cycle: 1 })
  assert.equal(existsSync(first.flag), false, "cycle 1 needs no gate — T101 is finishable from the start")
  rmSync(first.dir, { recursive: true, force: true })

  const second = runGate({ cycle: 2 })
  assert.equal(existsSync(second.flag), true)
  assert.match(readFileSync(second.flag, "utf8"), /opened by test\/e2e\/endless-task\.sh for cycle 2/)
  assert.match(second.result.stdout, /cycle 2 work-off gate opened/)
  rmSync(second.dir, { recursive: true, force: true })

  const unseeded = runGate({ cycle: 2, seeded: 0 })
  assert.equal(existsSync(unseeded.flag), false, "an unseeded run drives the file that is there and opens no gate of its own")
  rmSync(unseeded.dir, { recursive: true, force: true })
})

test("the staleness precondition reports the cause's removal and the artefact it left", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-endless-stale-"))
  const todo = join(dir, "TODO.md")
  mkdir(join(dir, "e2e-endless-fixture"))
  const run = () => {
    const script = `PROJECT_DIR=${shellQuote(dir)}
FIXTURE_NAME=e2e-endless-fixture
${driverFunction("stale_precondition")}
stale_precondition ${shellQuote(todo)}
`
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }

  writeFileSync(todo, "- T101: write merged.md\n- T104: waiting on T101\n")
  let out = run()
  assert.match(out, /T101 \(the cause\) present/)
  assert.match(out, /merged\.md absent/)
  assert.match(out, /open ids: T101 T104/)

  writeFileSync(todo, "- T104: waiting on T101\n")
  writeFileSync(join(dir, "e2e-endless-fixture", "merged.md"), "alpha\n")
  out = run()
  assert.match(out, /T101 \(the cause\) gone/)
  assert.match(out, /merged\.md present/)
  assert.match(out, /open ids: T104/)
  rmSync(dir, { recursive: true, force: true })
})
