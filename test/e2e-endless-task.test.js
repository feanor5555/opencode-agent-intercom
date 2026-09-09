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

// ---------------------------------------------------------------------------
// What the driver reads out of the plugin's debug log. That log is
// process-global — every opencode instance on the machine appends to the file
// the driver slices — and handle numbers are handed back and reused, so a
// criterion matched on a bare handle or counted without a session is satisfied
// by a line that belongs to another subagent or another primary. These tests
// drive the readers over a fabricated slice, without a server.
// ---------------------------------------------------------------------------

// A slice file plus the driver's slice readers, run against it.
function runSliceReader({ lines, body, vars = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-endless-slice-"))
  const slice = join(dir, "slice.log")
  writeFileSync(slice, lines.join("\n") + "\n")
  const assignments = Object.entries(vars)
    .map(([name, value]) => `${name}=${shellQuote(String(value))}`)
    .join("\n")
  const script = `SLICE_FILE=${shellQuote(slice)}
${assignments}
refresh_slice() { :; }
${driverFunction("slice_match_from")}
${driverFunction("slice_count_from")}
slice_match_after() { slice_match_from "$SLICE_FROM_LINE" "$1"; }
slice_count_after() { slice_count_from "$SLICE_FROM_LINE" "$1"; }
${body}
`
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" })
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`)
  rmSync(dir, { recursive: true, force: true })
  return result.stdout
}

// The successor's own work-off subagent finishes and gives its handle number
// back (`releaseHandle`, src/registry.js), so the subagent the driver spawns
// next carries the very same handle string under the very same parent — with
// its completion line already standing in the cycle's window.
const REUSED_HANDLE_SLICE = [
  'A spawned {"handle":"coder#4","sessionID":"ses_workoff","agent":"coder","taskId":"T104"}',
  'B notified primary of completion {"handle":"coder#4","parentID":"ses_primary","taskOutcome":{"kind":"no-marker"}}',
  'C deleted opencode session {"handle":"coder#4","sessionID":"ses_workoff"}',
  'D spawned {"handle":"coder#4","sessionID":"ses_driver","agent":"coder"}',
  'E notified primary of completion {"handle":"coder#4","parentID":"ses_elsewhere","taskOutcome":{"kind":"no-marker"}}',
  'F notified primary of completion {"handle":"coder#4","parentID":"ses_primary","taskOutcome":{"kind":"done","id":"T101"}}',
]

test("the in-flight gate reads past its own spawn line, so a reused handle is not mistaken for it", () => {
  const out = runSliceReader({
    lines: REUSED_HANDLE_SLICE,
    vars: {
      SLICE_FROM_LINE: 0,
      SPAWN_SLICE_LINE: 4,
      SPAWN_HANDLE: "coder#4",
      SID: "ses_primary",
    },
    body: `${driverFunction("subagent_completion_line")}\nsubagent_completion_line`,
  })
  // Line 2 carries the same handle and the same parent inside the same window;
  // only line 6 belongs to the subagent spawned on line 4.
  assert.match(out, /^6:/, `expected the completion after the spawn line, got: ${out}`)
  assert.match(out, /"kind":"done","id":"T101"/)
})

test("the in-flight gate ignores another opencode instance's subagent of the same handle", () => {
  const out = runSliceReader({
    lines: REUSED_HANDLE_SLICE.slice(0, 5),
    vars: {
      SLICE_FROM_LINE: 0,
      SPAWN_SLICE_LINE: 4,
      SPAWN_HANDLE: "coder#4",
      SID: "ses_primary",
    },
    body: `${driverFunction("subagent_completion_line")}\nsubagent_completion_line`,
  })
  // Line 5 is a completion for coder#4 under a parent this run never created:
  // the driver's subagent is still in flight, so the gate reports nothing.
  assert.equal(out, "", `expected no completion line, got: ${out}`)
})

test("the permit criterion counts the admissions of its own primary and no other's", () => {
  const lines = [
    'A spawn admitted: endless wind-down permit consumed {"sessionID":"ses_primary","agent":"planner"}',
    'B endless: scheduled {"sessionID":"ses_primary","ctx":5703,"threshold":5117}',
    'C spawn admitted: endless wind-down permit consumed {"sessionID":"ses_foreign","agent":"planner"}',
    'D spawn admitted: endless wind-down permit consumed {"sessionID":"ses_primary","agent":"planner"}',
  ]
  const body = `${driverFunction("permit_admission_lines")}
permit_admission_lines | grep -c .
permit_admission_lines`
  const out = runSliceReader({
    lines,
    vars: { SLICE_FROM_LINE: 1, SID: "ses_primary" },
    body,
  })
  // Line 1 is this primary's, but before the window; line 3 is a second
  // primary's own permit — counted, they read as a double consumption that
  // never happened. Only line 4 belongs to this cycle.
  assert.match(out, /^1\n/, `expected exactly one admission, got: ${out}`)
  assert.match(out, /\n4:D spawn admitted/)
})

test("the replacement criterion accepts only this primary's cycle completion", () => {
  const lines = [
    'A endless: cycle 1/2 complete, new session ses_foreign, open tasks 4→3 completed=1 {"sessionID":"ses_foreign"}',
    'B endless: cycle 1/2 complete, new session ses_primary, open tasks 4→3 completed=1 {"sessionID":"ses_primary"}',
  ]
  const pattern = String.raw`endless: cycle [0-9]+/[^ ]+ complete, new session ses_[A-Za-z0-9]+.*"sessionID":"$SID"`
  const out = runSliceReader({
    lines,
    vars: { SLICE_FROM_LINE: 0, SID: "ses_primary" },
    body: `slice_match_after ${shellQuote(pattern.replace("$SID", "ses_primary"))}`,
  })
  assert.match(out, /^2:/, `expected this primary's completion, got: ${out}`)
  assert.match(out, /new session ses_primary/)

  const replacement = DRIVER_SOURCE
    .split("\n")
    .find((line) => line.includes('if wait_for_pattern "endless: cycle complete"'))
  assert.ok(replacement, "the replacement wait is missing")
  assert.ok(
    replacement.includes(String.raw`\"sessionID\":\"$SID\"`),
    "the replacement wait does not scope completion to the primary session",
  )
})

test("a foreign primary writing the driven todo file is reported, an own one is not", () => {
  const lines = [
    'A endless: wind-down confirmed 4 open task(s) [T101,T102,T103,T104] file=TODO.md {"sessionID":"ses_primary"}',
    'B notified primary of completion {"handle":"coder#1","parentID":"ses_successor","taskOutcome":{"kind":"done","id":"T101"}}',
    'C endless: wind-down confirmed 4 open task(s) [T101,T102,T103,T104] file=TODO.md {"sessionID":"ses_foreign"}',
    'D notified primary of completion {"handle":"coder#2","parentID":"ses_foreign","taskOutcome":{"kind":"done","id":"T999"}}',
    'E notified primary of completion {"handle":"coder#3","parentID":"ses_foreign","taskOutcome":{"kind":"done","id":"T102"}}',
  ]
  const out = runSliceReader({
    lines,
    vars: { SESSION_IDS: "ses_primary ses_successor" },
    body: `${driverFunction("foreign_todo_writer_lines")}
foreign_todo_writer_lines 1 "T101,T102,T103,T104"`,
  })
  const found = out.trim().split("\n").filter(Boolean).map((line) => line.slice(0, 1))
  // 1 is before the window, 2 is this run's own removal, 4 names an id no cycle
  // of this run confirmed; 3 and 5 are another primary editing these very ids.
  assert.deepEqual(found, ["3", "5"], `unexpected foreign lines: ${out}`)
})

// ---------------------------------------------------------------------------
// The suite driver's own share of the same contamination: its server outlives
// the drivers that used it, and the endless driver arms endless mode through
// the global settings file every instance on the machine reads.
// ---------------------------------------------------------------------------

test("run-all.sh stops its server before the endless driver, not only in the trap", () => {
  const source = readFileSync(resolve(import.meta.dirname, "e2e/run-all.sh"), "utf8")
  const multi = source.lastIndexOf('"$HERE/multi-task.sh"')
  const endless = source.lastIndexOf('"$HERE/endless-task.sh"')
  assert.ok(multi > 0 && endless > multi, "run-all.sh does not sequence multi-task before endless-task")
  const stop = source.indexOf("e2e_server_stop", multi)
  assert.ok(
    stop > multi && stop < endless,
    "no e2e_server_stop between the last driver that uses the suite server and endless-task.sh — a session left alive there runs a wind-down cycle of its own on the todo file the endless driver asserts on",
  )
})
