// Integration tests for TODO.md auto-tracking.
//
// Drives the plugin end-to-end against a real tmp directory + real TODO.md
// file, exercising: spawn extracting task-id, duplicate rejection, missing-
// optional T-prefix extraction, wake-hook auto-removing on DONE marker,
// marker mismatch, no-marker, aborted-session, todos_open + todo_done +
// todo_add + todo_edit tools, subagent gating. Plus todofile parser unit
// tests and the todo-file lookup: accepted name variants, several matches,
// creation when none exists, a non-regular file, an unreadable directory.
//
// Run: node --test test/todo.test.js

import test, { beforeEach, before } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  parseTasks,
  listOpen,
  removeTask,
  addTask,
  editTask,
  nextFreeId,
  readTodoFile,
  todoFilePath,
  findTodoFile,
  CANONICAL_TODO_NAME,
  TodoFileMissingError,
} from "../src/todofile.js"

// ---------- Fixture project --------------------------------------------------

const projectDir = mkdtempSync(join(tmpdir(), "intercom-todo-test-"))
writeFileSync(
  join(projectDir, "package.json"),
  JSON.stringify({ name: "todo-fixture", description: "todo test fixture" }),
)
const settingsFile = join(projectDir, "agent-intercom.json")
before(() => setSettingsPath(settingsFile))

const TODO_SEED = `# TODO

- T1: add export endpoint
  accept: GET /export returns 200 with JSON
- T2: write tests for export
  accept: at least one passing integration test
- T3: drop unused dependency
  accept: package.json no longer lists "lodash"
`

function writeTodo(content = TODO_SEED) {
  writeFileSync(join(projectDir, "TODO.md"), content)
}

function removeTodo() {
  rmSync(join(projectDir, "TODO.md"), { force: true })
}

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
  writeTodo()
})

// ---------- Mock opencode client --------------------------------------------

// Mock client that records spawn/abort/delete calls and lets a test plant a
// subagent's `messages` payload — `fetchSnapshot` reads from there to assemble
// `snapshot.result` (the final assistant text), which the wake-hook scans for
// the DONE marker.
function makeCtx() {
  let counter = 0
  const created = []
  const prompted = []
  const aborted = []
  const deleted = []
  const notices = []
  const messagesBySession = new Map()

  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        const id = opts?.path?.id
        const text = (opts?.body?.parts ?? []).map((p) => p?.text ?? "").join("")
        prompted.push(id)
        notices.push({ sessionID: id, text })
        return { data: undefined }
      },
      abort: async (opts) => {
        aborted.push(opts?.path?.id)
        return { data: true }
      },
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: projectDir } }),
      messages: async (opts) => {
        const id = opts?.path?.id
        return { data: messagesBySession.get(id) ?? [] }
      },
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return {
    ctx: { client, directory: projectDir, worktree: projectDir, project: {} },
    created,
    prompted,
    aborted,
    deleted,
    notices,
    setReply(sessionID, text) {
      messagesBySession.set(sessionID, [
        {
          info: { role: "assistant", id: "m1", tokens: { input: 100, output: 50 } },
          parts: [{ type: "text", text }],
        },
      ])
    },
  }
}

const primaryCtx = { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" }

async function fireIdle(hooks, sessionID) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
}

// ---------- todofile parser (small unit tests) -------------------------------

test("parseTasks: extracts id, title, and accept-line", () => {
  const tasks = parseTasks(TODO_SEED)
  assert.equal(tasks.length, 3)
  assert.deepEqual(tasks.map((t) => t.id), ["T1", "T2", "T3"])
  assert.equal(tasks[0].text, "add export endpoint")
  assert.equal(tasks[0].accept, "GET /export returns 200 with JSON")
})

test("listOpen: returns all tasks in file order (= feasibility order)", () => {
  const tasks = listOpen(projectDir)
  assert.deepEqual(tasks.map((t) => t.id), ["T1", "T2", "T3"])
  assert.ok(tasks[0].accept.startsWith("GET /export"))
})

test("listOpen: throws on missing TODO.md (greenfield hard-error)", () => {
  removeTodo()
  assert.throws(
    () => listOpen(projectDir),
    (err) =>
      err instanceof TodoFileMissingError &&
      err.kind === "missing" &&
      /no todo file in/.test(err.message),
  )
})

// ---------- todo-file lookup: naming, uniqueness, non-regular files ---------

// Every test below works in its own tmp directory: the shared `projectDir`
// fixture is rewritten by beforeEach and must not gain stray name variants.
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-todo-lookup-"))
  try {
    return fn(dir)
  } finally {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
}

const NAME_VARIANTS = [
  "TODO.md",
  "todo.md",
  "Todo.md",
  "toDo.md",
  "todos.md",
  "TODOS.md",
  "Todos.md",
  "todo.MD",
]

test("lookup: every case variant of todo.md / todos.md is the todo file", () => {
  for (const name of NAME_VARIANTS) {
    withTempDir((dir) => {
      writeFileSync(join(dir, name), "- T7: variant task\n  accept: read from the variant\n")
      assert.equal(findTodoFile(dir).name, name, `${name} must resolve`)
      const tasks = listOpen(dir)
      assert.deepEqual(tasks.map((t) => t.id), ["T7"], `${name} must be read`)
      assert.equal(tasks[0].accept, "read from the variant")
      assert.equal(nextFreeId(dir), "T8", `${name} must feed nextFreeId`)
    })
  }
})

test("lookup: files that only look like a todo file are ignored", () => {
  withTempDir((dir) => {
    for (const name of ["todo.markdown", "todo.txt", "mytodo.md", "todoes.md", "todo", "TODO.md.bak"]) {
      writeFileSync(join(dir, name), "- T1: not a todo file\n")
    }
    assert.throws(
      () => findTodoFile(dir),
      (err) => err instanceof TodoFileMissingError && err.kind === "missing",
    )
  })
})

test("writes go back to the variant that was found, not to TODO.md", () => {
  withTempDir((dir) => {
    const variant = join(dir, "todos.md")
    writeFileSync(variant, "- T1: first\n  accept: stays\n")
    assert.equal(addTask(dir, { title: "second", accept: "appended" }).id, "T2")
    assert.equal(editTask(dir, "T1", { title: "first, edited" }).changed, true)
    assert.equal(removeTask(dir, "T2").changed, true)
    assert.ok(!existsSync(join(dir, CANONICAL_TODO_NAME)), "no TODO.md may be created alongside")
    const content = readFileSync(variant, "utf8")
    assert.match(content, /- T1: first, edited/)
    assert.doesNotMatch(content, /T2/)
  })
})

test("lookup: several matching files are a typed error, never a pick", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "todos.md"), "- T1: from todos.md\n")
    writeFileSync(join(dir, "Todo.md"), "- T5: from Todo.md\n")
    const isMultiple = (err) =>
      err instanceof TodoFileMissingError &&
      err.kind === "multiple" &&
      // sorted, so the report never depends on the directory listing order
      err.names.join(",") === "Todo.md,todos.md" &&
      /exactly one/.test(err.message)
    assert.throws(() => findTodoFile(dir), isMultiple)
    assert.throws(() => listOpen(dir), isMultiple)
    assert.throws(() => nextFreeId(dir), isMultiple)
    assert.throws(() => addTask(dir, { title: "x" }), isMultiple)
    assert.throws(() => removeTask(dir, "T1"), isMultiple)
    // neither file was touched and no third one was created
    assert.equal(readFileSync(join(dir, "todos.md"), "utf8"), "- T1: from todos.md\n")
    assert.equal(readFileSync(join(dir, "Todo.md"), "utf8"), "- T5: from Todo.md\n")
    assert.ok(!existsSync(join(dir, CANONICAL_TODO_NAME)))
  })
})

// Pins the precedence the statSync fast path establishes: a regular canonical
// TODO.md is the todo file without listing the directory at all, so it wins
// over a differently-cased sibling instead of raising "multiple".
test("lookup: canonical TODO.md takes precedence over a differently-cased sibling", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, CANONICAL_TODO_NAME), "- T1: canonical\n")
    writeFileSync(join(dir, "todos.md"), "- T9: sibling\n")
    assert.equal(findTodoFile(dir).name, CANONICAL_TODO_NAME)
    assert.deepEqual(listOpen(dir).map((t) => t.id), ["T1"])
  })
})

test("addTask: creates TODO.md when the directory has no todo file", () => {
  withTempDir((dir) => {
    assert.equal(nextFreeId(dir), "T1")
    assert.equal(addTask(dir, { title: "first task", accept: "it exists" }).id, "T1")
    assert.equal(findTodoFile(dir).name, CANONICAL_TODO_NAME)
    assert.equal(
      readFileSync(join(dir, CANONICAL_TODO_NAME), "utf8"),
      "- T1: first task\n  accept: it exists\n",
    )
    // second call reuses the file it just created rather than making another
    assert.equal(addTask(dir, { title: "second task" }).id, "T2")
    assert.deepEqual(listOpen(dir).map((t) => t.id), ["T1", "T2"])
  })
})

test("addTask: a missing directory is not silently created over", () => {
  withTempDir((dir) => {
    const gone = join(dir, "does-not-exist")
    assert.throws(
      () => addTask(gone, { title: "x" }),
      (err) => err?.code === "ENOENT",
    )
  })
})

const isNotAFile = (err) => err instanceof TodoFileMissingError && err.kind === "not-a-file"

test("lookup: a symlink named like a todo file is neither read nor written through", () => {
  withTempDir((dir) => {
    const target = join(dir, "elsewhere.md")
    writeFileSync(target, "- T1: not the todo file\n")
    symlinkSync(target, join(dir, "todo.md"))
    assert.throws(() => listOpen(dir), isNotAFile)
    assert.throws(() => readTodoFile(dir), isNotAFile)
    assert.throws(() => nextFreeId(dir), isNotAFile)
    assert.throws(() => addTask(dir, { title: "x" }), isNotAFile)
    assert.throws(() => removeTask(dir, "T1"), isNotAFile)
    assert.equal(readFileSync(target, "utf8"), "- T1: not the todo file\n", "target untouched")
  })
})

test("lookup: a dangling symlink named TODO.md is the typed error, not ENOENT", () => {
  withTempDir((dir) => {
    symlinkSync(join(dir, "nowhere.md"), join(dir, CANONICAL_TODO_NAME))
    assert.throws(() => readTodoFile(dir), isNotAFile)
    assert.throws(() => addTask(dir, { title: "x" }), isNotAFile)
    assert.ok(!existsSync(join(dir, "nowhere.md")), "the write must not create the link target")
  })
})

test("lookup: a directory named TODO.md is the typed error, not EISDIR", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, CANONICAL_TODO_NAME))
    assert.throws(() => readTodoFile(dir), isNotAFile)
    assert.throws(() => addTask(dir, { title: "x" }), isNotAFile)
  })
})

test("lookup: an unreadable directory fails visibly instead of reporting no todo file", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses directory permissions")
    return
  }
  withTempDir((dir) => {
    writeFileSync(join(dir, "todo.md"), "- T1: existing task\n")
    chmodSync(dir, 0o111) // traversable, not listable
    const isDenied = (err) => !(err instanceof TodoFileMissingError) && err?.code === "EACCES"
    assert.throws(() => findTodoFile(dir), isDenied)
    assert.throws(() => listOpen(dir), isDenied)
    // the fatal one: T1 must not be handed out a second time
    assert.throws(() => nextFreeId(dir), isDenied)
    assert.throws(() => addTask(dir, { title: "x" }), isDenied)
  })
})


test("nextFreeId: max+1, T1 when empty / file absent", () => {
  assert.equal(nextFreeId(projectDir), "T4")
  writeTodo("# TODO\n")
  assert.equal(nextFreeId(projectDir), "T1")
  removeTodo()
  assert.equal(nextFreeId(projectDir), "T1")
})

test("removeTask: deletes header + accept line, throws on unknown id", () => {
  removeTask(projectDir, "T1")
  const content = readTodoFile(projectDir)
  assert.doesNotMatch(content, /T1:/, "T1 header gone")
  assert.doesNotMatch(content, /GET \/export returns 200/, "T1 accept gone")
  assert.match(content, /T2:/, "T2 untouched")
  assert.throws(() => removeTask(projectDir, "T99"), /T99 not found/)
})

test("addTask: appends with next free id, preserves order", () => {
  const res = addTask(projectDir, { title: "wire pagination", accept: "?page=N works" })
  assert.equal(res.id, "T4")
  const tasks = listOpen(projectDir)
  assert.deepEqual(tasks.map((t) => t.id), ["T1", "T2", "T3", "T4"])
  assert.equal(tasks[3].text, "wire pagination")
  assert.equal(tasks[3].accept, "?page=N works")
})

test("addTask: works on a non-existent TODO.md (creates it empty first)", () => {
  removeTodo()
  const res = addTask(projectDir, { title: "first task", accept: "first criterion" })
  assert.equal(res.id, "T1")
  const tasks = listOpen(projectDir)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].text, "first task")
})

test("addTask: rejects empty title", () => {
  assert.throws(() => addTask(projectDir, { title: "   " }), /title is required/)
})

test("editTask: updates title and / or accept, preserves id", () => {
  editTask(projectDir, "T2", { title: "write integration tests" })
  let tasks = listOpen(projectDir)
  assert.equal(tasks.find((t) => t.id === "T2").text, "write integration tests")
  editTask(projectDir, "T2", { accept: "happy + error paths covered" })
  tasks = listOpen(projectDir)
  assert.equal(tasks.find((t) => t.id === "T2").accept, "happy + error paths covered")
})

test('editTask: accept: "" drops the accept line', () => {
  editTask(projectDir, "T1", { accept: "" })
  const tasks = listOpen(projectDir)
  assert.equal(tasks.find((t) => t.id === "T1").accept, undefined)
})

test("editTask: throws on unknown id", () => {
  assert.throws(() => editTask(projectDir, "T99", { title: "x" }), /T99 not found/)
})

// ---------- spawn: task-id extraction ---------------------------------------

test("spawn extracts the T-id from the prompt's first line", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint per TODO.md" },
    primaryCtx,
  )
  const dup = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: still T1, second try" },
    primaryCtx,
  )
  assert.match(dup.output, /task T1 already has a subagent running/)
  assert.equal(created.length, 1, "the duplicate must NOT have created another session")
})

test("spawn accepts prefix-less prompts even when TODO.md exists (non-task spawns)", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "summarize what src/foo.js exports" },
    primaryCtx,
  )
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.equal(created.length, 1)
})

test("spawn accepts prefix-less prompts in greenfield (no TODO.md)", async () => {
  removeTodo()
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: "draft initial milestones for this fresh project" },
    primaryCtx,
  )
  assert.match(res.output, /Spawned subagent "planner#1"/)
  assert.equal(created.length, 1)
})

// ---------- wake-hook auto-remove -------------------------------------------

test("wake-hook auto-removes T1 when subagent replies with `DONE: T1`", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T1\nimplemented the endpoint, all tests pass.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.doesNotMatch(content, /T1:/, "T1 must be removed from TODO.md")
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.ok(wake, "the orchestrator must be woken")
  assert.match(wake.text, /T1 removed/)
})

test("wake-hook reports no-todo when the directory has no todo file at all", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T1\nimplemented the endpoint.")
  removeTodo()

  await fireIdle(hooks, subID)

  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /TODO\.md not present/)
})

// An unresolvable todo file is NOT greenfield: the marker must be reported as
// a failed auto-remove, never swallowed as "no todo file" — the task is still
// standing in a file we merely could not resolve.
test("wake-hook reports an error when several todo files exist", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T1\nimplemented the endpoint.")
  removeTodo()
  writeFileSync(join(projectDir, "todos.md"), TODO_SEED)
  writeFileSync(join(projectDir, "Todo.md"), TODO_SEED)
  try {
    await fireIdle(hooks, subID)
    const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
    assert.match(wake.text, /auto-remove failed/)
    assert.match(wake.text, /several todo files/)
    assert.doesNotMatch(wake.text, /not present/)
    assert.equal(readFileSync(join(projectDir, "todos.md"), "utf8"), TODO_SEED, "nothing removed")
  } finally {
    rmSync(join(projectDir, "todos.md"), { force: true })
    rmSync(join(projectDir, "Todo.md"), { force: true })
  }
})

test("wake-hook ignores a marker whose id does NOT match the spawn id", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T3\nI confused myself about which task this was.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /T1:/, "T1 must remain in TODO.md")
  assert.match(content, /T3:/, "T3 must remain in TODO.md")
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /subagent reported `T3` but was spawned for `T1`/)
  assert.match(wake.text, /Marker IGNORED/)
})

test("wake-hook reports no-marker when subagent replies without DONE line", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "all done!\nimplementation complete, tests pass.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /T1:/, "T1 must remain in TODO.md")
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /reply did NOT start with `DONE: <id>`/)
  assert.match(wake.text, /NOT auto-removed/)
})

test("wake-hook skips marker processing for an aborted subagent", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T1\nthought I was done, but the user just aborted me.")

  await hooks.tool.abort.execute({ subagent: spawned.metadata.handle }, primaryCtx)
  const noticesBefore = notices.length
  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /T1:/, "T1 must NOT be removed after abort")
  assert.equal(notices.length, noticesBefore, "no completion notice for aborted session")
})

test("wake-hook tolerates marker for a spawn without task-id (greenfield)", async () => {
  removeTodo()
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: "draft initial milestones for this fresh project" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "all milestones drafted, see MILESTONES.md.")

  await fireIdle(hooks, subID)

  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.doesNotMatch(wake.text, /TODO\.md:/)
  assert.doesNotMatch(wake.text, /NOT auto-removed/)
})

// ---------- tool exposure + guards ------------------------------------------

test("todos_open tool returns open tasks with their accept-criterion", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todos_open.execute({}, primaryCtx)
  assert.match(res.output, /T1: add export endpoint/)
  assert.match(res.output, /accept: GET \/export returns 200 with JSON/)
  assert.match(res.output, /T3: drop unused dependency/)
})

test("todos_open errors clearly when TODO.md does not exist", async () => {
  removeTodo()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todos_open.execute({}, primaryCtx)
  assert.match(res.output, /No todo file at/)
  assert.match(res.output, /Tasks\/TODOs live ONLY in the todo file/)
})

test("todos_open reports several todo files instead of picking one", async () => {
  removeTodo()
  writeFileSync(join(projectDir, "todos.md"), "- T1: from todos.md\n")
  writeFileSync(join(projectDir, "Todo.md"), "- T2: from Todo.md\n")
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)
    const res = await hooks.tool.todos_open.execute({}, primaryCtx)
    assert.match(res.output, /Several todo files exist/)
    assert.match(res.output, /Todo\.md, todos\.md/)
  } finally {
    rmSync(join(projectDir, "todos.md"), { force: true })
    rmSync(join(projectDir, "Todo.md"), { force: true })
  }
})

test("todos_open reports a todo-file name that is not a regular file", async () => {
  removeTodo()
  mkdirSync(join(projectDir, "TODO.md"))
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)
    const res = await hooks.tool.todos_open.execute({}, primaryCtx)
    assert.match(res.output, /is not a regular file/)
  } finally {
    rmSync(join(projectDir, "TODO.md"), { recursive: true, force: true })
  }
})

test("todo_done tool removes a task; second call errors (task gone)", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const a = await hooks.tool.todo_done.execute({ id: "T2" }, primaryCtx)
  assert.match(a.output, /T2 removed/)
  const b = await hooks.tool.todo_done.execute({ id: "T2" }, primaryCtx)
  assert.match(b.output, /T2 not found/)
})

test("todo_done rejects malformed ids", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todo_done.execute({ id: "task-5" }, primaryCtx)
  assert.match(res.output, /id must look like T5/)
})

test("todo_add tool appends a new task with the next free id", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todo_add.execute(
    { title: "wire pagination", accept: "?page=N works" },
    primaryCtx,
  )
  assert.match(res.output, /Added T4: wire pagination/)
  const tasks = listOpen(projectDir)
  assert.equal(tasks.length, 4)
  assert.equal(tasks[3].id, "T4")
})

test("todo_edit tool changes title or accept in place", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const a = await hooks.tool.todo_edit.execute(
    { id: "T1", title: "build /export endpoint" },
    primaryCtx,
  )
  assert.match(a.output, /T1 updated/)
  const tasks = listOpen(projectDir)
  assert.equal(tasks.find((t) => t.id === "T1").text, "build /export endpoint")
})

test("orchestrator is DENIED from calling any TODO tool (subagent-only now)", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  for (const t of ["todos_open", "todo_done", "todo_add", "todo_edit", "glob", "grep"]) {
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: t, sessionID: "ses_primary", callID: `p-${t}` }),
      /orchestrator session/,
      `${t} should be denied for the orchestrator`,
    )
  }
})

test("planner/coder/debugger/reviewer/documenter/designer can use TODO tools; researcher/gitter are DENIED (even reads)", async () => {
  // Raise the concurrent-subagent cap so we can spawn one of each agent in
  // the same test run without hitting the default cap of 1.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 10 }))
  resetSettings()
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  // researcher + gitter: ALL four TODO tools (including todos_open) denied.
  for (const agent of ["researcher", "gitter"]) {
    const before = created.length
    await hooks.tool.spawn.execute({ agent, prompt: `task for ${agent}` }, primaryCtx)
    assert.equal(created.length, before + 1)
    const id = created[created.length - 1]
    for (const t of ["todos_open", "todo_done", "todo_add", "todo_edit"]) {
      await assert.rejects(
        () => hooks["tool.execute.before"]({ tool: t, sessionID: id, callID: `${agent}-${t}` }),
        /restricted to planner \/ coder \/ debugger \/ reviewer \/ documenter \/ designer/,
      )
    }
  }

  // The six TODO-owning agents: all four tools allowed.
  for (const agent of ["planner", "coder", "debugger", "reviewer", "documenter", "designer"]) {
    const before = created.length
    await hooks.tool.spawn.execute(
      { agent, prompt: `do something specific to ${agent}` },
      primaryCtx,
    )
    assert.equal(created.length, before + 1, `${agent} must spawn (cap raised)`)
    const id = created[created.length - 1]
    for (const t of ["todos_open", "todo_done", "todo_add", "todo_edit"]) {
      await hooks["tool.execute.before"]({ tool: t, sessionID: id, callID: `${agent}-${t}` })
    }
  }
})

// ---------- sanity: the file path is the project root -----------------------

test("todoFilePath resolves to <directory>/TODO.md", () => {
  assert.equal(todoFilePath(projectDir), join(projectDir, "TODO.md"))
  assert.ok(existsSync(todoFilePath(projectDir)))
})
