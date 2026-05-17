// Integration tests for TODO.md auto-tracking.
//
// Drives the plugin end-to-end against a real tmp directory + real TODO.md
// file, exercising: spawn extracting task-id, duplicate rejection, missing-
// optional T-prefix extraction, wake-hook auto-ticking on DONE/BLOCKED markers,
// marker mismatch, no-marker, aborted-session, todos_open + todo_done tools,
// subagent denial of todo_done. Plus a few todofile parser unit tests.
//
// Run: node --test test/todo.test.js

import test, { beforeEach, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
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
  markDone,
  markBlocked,
  readTodoFile,
  todoFilePath,
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

## Milestone 1

- [ ] T1. add export endpoint
    accept: GET /export returns 200 with JSON
- [ ] T2. write tests for export
    accept: at least one passing integration test
- [x] T3. scaffold project
    accept: package.json exists

## Review-Findings

- [ ] R1. drop unused dependency
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
// the DONE/BLOCKED marker.
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

// Helper: deliver a session.idle event and let any async work in the handler
// resolve. The handler awaits client.session.messages + postNotice; one tick
// is enough since the mock client resolves immediately.
async function fireIdle(hooks, sessionID) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
}

// ---------- todofile parser (small unit tests) -------------------------------

test("parseTasks: extracts id, status, text and accept-line", () => {
  const tasks = parseTasks(TODO_SEED)
  assert.equal(tasks.length, 4)
  assert.deepEqual(tasks.map((t) => t.id), ["T1", "T2", "T3", "R1"])
  assert.equal(tasks[0].status, "open")
  assert.equal(tasks[0].accept, "GET /export returns 200 with JSON")
  assert.equal(tasks[2].status, "done")
})

test("parseTasks: extracts blocked reason from suffix", () => {
  const content =
    "- [!] T9. wait for vendor (blocked: SDK not released)\n" +
    "    accept: SDK v2 published\n"
  const [t] = parseTasks(content)
  assert.equal(t.status, "blocked")
  assert.equal(t.blockedReason, "SDK not released")
  assert.equal(t.text, "wait for vendor")
})

test("listOpen: filters out done tasks, returns accept criterion", () => {
  const open = listOpen(projectDir)
  assert.deepEqual(open.map((t) => t.id), ["T1", "T2", "R1"])
  assert.ok(open[0].accept.startsWith("GET /export"))
})

test("listOpen: throws on missing TODO.md (greenfield hard-error)", () => {
  removeTodo()
  assert.throws(
    () => listOpen(projectDir),
    (err) =>
      err instanceof TodoFileMissingError &&
      err.kind === "missing" &&
      /TODO\.md not found/.test(err.message),
  )
})

test("listOpen: detects case-variant todo.md and throws wrong-case", () => {
  removeTodo()
  writeFileSync(join(projectDir, "todo.md"), "- [ ] T1. legacy lowercase task\n")
  try {
    assert.throws(
      () => listOpen(projectDir),
      (err) =>
        err instanceof TodoFileMissingError &&
        err.kind === "wrong-case" &&
        err.actualName === "todo.md",
    )
  } finally {
    rmSync(join(projectDir, "todo.md"), { force: true })
  }
})

test("markDone: flips [ ] → [x], idempotent, throws on unknown id", () => {
  const res = markDone(projectDir, "T1")
  assert.equal(res.changed, true)
  assert.match(readTodoFile(projectDir), /- \[x\] T1\. add export endpoint/)
  const again = markDone(projectDir, "T1")
  assert.equal(again.changed, false)
  assert.equal(again.alreadyDone, true)
  assert.throws(() => markDone(projectDir, "T99"), /T99 not found/)
})

test("markBlocked: flips to [!], appends reason, idempotent on identical reason", () => {
  const res = markBlocked(projectDir, "T2", "missing fixture")
  assert.equal(res.changed, true)
  const content = readTodoFile(projectDir)
  assert.match(content, /- \[!\] T2\. write tests for export \(blocked: missing fixture\)/)
  // re-blocking with same reason -> no-op
  const again = markBlocked(projectDir, "T2", "missing fixture")
  assert.equal(again.changed, false)
  // re-blocking with new reason -> swaps the suffix, doesn't append a second one
  markBlocked(projectDir, "T2", "auth credentials gone")
  const c2 = readTodoFile(projectDir)
  assert.equal((c2.match(/blocked:/g) ?? []).length, 1)
  assert.match(c2, /\(blocked: auth credentials gone\)/)
})

test("markDone after markBlocked strips the (blocked: …) suffix", () => {
  markBlocked(projectDir, "T1", "stub")
  markDone(projectDir, "T1")
  const content = readTodoFile(projectDir)
  assert.match(content, /- \[x\] T1\. add export endpoint$/m)
  assert.doesNotMatch(content, /T1.*blocked/)
})

// ---------- spawn: task-id extraction ---------------------------------------

test("spawn extracts the T-id from the prompt's first line", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint per TODO.md" },
    primaryCtx,
  )
  // The entry's taskId is set; verify indirectly through list (which surfaces handle/agent) +
  // duplicate-rejection (the strongest signal).
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

test("spawn accepts R-prefix for review-findings", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "R1: drop the lodash dependency" },
    primaryCtx,
  )
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.equal(created.length, 1)
})

// ---------- wake-hook auto-tick ---------------------------------------------

test("wake-hook auto-ticks T1 when subagent replies with `DONE: T1`", async () => {
  const { ctx, created, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: T1\nimplemented the endpoint, all tests pass.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /- \[x\] T1\. add export endpoint/)
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.ok(wake, "the orchestrator must be woken")
  assert.match(wake.text, /T1 marked done/)
})

test("wake-hook handles `BLOCKED: T2 — <reason>` and rewrites the suffix", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T2: write tests for the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "BLOCKED: T2 — fixture data not generated yet\nrest of the report …")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /- \[!\] T2\. write tests for export \(blocked: fixture data not generated yet\)/)
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /T2 marked blocked \(fixture data not generated yet\)/)
})

test("wake-hook ignores a marker whose id does NOT match the spawn id", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  // Hallucinated id — must NOT tick T3 (already done) AND must not tick T1.
  setReply(subID, "DONE: T3\nI confused myself about which task this was.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /- \[ \] T1\. add export endpoint/, "T1 must remain open")
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /subagent reported `T3` but was spawned for `T1`/)
  assert.match(wake.text, /Marker IGNORED/)
})

test("wake-hook reports no-marker when subagent replies without DONE/BLOCKED line", async () => {
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
  assert.match(content, /- \[ \] T1\. add export endpoint/, "T1 must remain open")
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /reply did NOT start with `DONE: <id>` or `BLOCKED: <id>`/)
  assert.match(wake.text, /NOT auto-ticked/)
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

  // User aborts before the subagent finishes.
  await hooks.tool.abort.execute({ subagent: spawned.metadata.handle }, primaryCtx)
  const noticesBefore = notices.length
  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /- \[ \] T1\. add export endpoint/, "T1 must NOT be ticked after abort")
  // The wake-hook for aborted sessions returns early — no completion notice.
  assert.equal(notices.length, noticesBefore, "no completion notice for aborted session")
})

test("wake-hook auto-ticks R-findings the same way as T-tasks", async () => {
  const { ctx, notices, setReply } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "R1: remove the lodash dependency from package.json" },
    primaryCtx,
  )
  const subID = spawned.metadata.sessionID
  setReply(subID, "DONE: R1\nremoved lodash, npm install passes.")

  await fireIdle(hooks, subID)

  const content = readTodoFile(projectDir)
  assert.match(content, /- \[x\] R1\. drop unused dependency/)
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.match(wake.text, /R1 marked done/)
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

  // No TODO.md, no task-id on the spawn — completion notice has no TODO-line at all.
  const wake = notices.find((n) => n.sessionID === primaryCtx.sessionID)
  assert.doesNotMatch(wake.text, /TODO\.md:/)
  assert.doesNotMatch(wake.text, /NOT auto-ticked/)
})

// ---------- tool exposure + guards ------------------------------------------

test("todos_open tool returns open tasks with their accept-criterion", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todos_open.execute({}, primaryCtx)
  assert.match(res.output, /OPEN T1\. add export endpoint/)
  assert.match(res.output, /accept: GET \/export returns 200 with JSON/)
  assert.match(res.output, /OPEN R1\. drop unused dependency/)
  assert.doesNotMatch(res.output, /T3/, "done tasks must be filtered out")
})

test("todos_open errors clearly when TODO.md does not exist", async () => {
  removeTodo()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todos_open.execute({}, primaryCtx)
  assert.match(res.output, /TODO\.md not found/)
  assert.match(res.output, /Tasks\/TODOs live ONLY in TODO\.md/)
  assert.match(res.output, /never AGENTS\.md/)
  assert.match(res.output, /Do NOT spawn a subagent/)
})

test("todos_open surfaces case-variant todo.md with rename/migrate options", async () => {
  removeTodo()
  writeFileSync(join(projectDir, "todo.md"), "- [ ] T1. legacy lowercase task\n")
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)
    const res = await hooks.tool.todos_open.execute({}, primaryCtx)
    assert.match(res.output, /case-variant "todo\.md"/)
    assert.match(res.output, /rename "todo\.md" to TODO\.md/)
    assert.match(res.output, /create a fresh empty TODO\.md/)
    assert.match(res.output, /migrate existing tasks/)
    assert.match(res.output, /Do NOT spawn a subagent/)
    assert.match(res.output, /tasks live ONLY in TODO\.md/)
  } finally {
    rmSync(join(projectDir, "todo.md"), { force: true })
  }
})

test("todo_done tool flips T2 and is idempotent", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const a = await hooks.tool.todo_done.execute({ id: "T2" }, primaryCtx)
  assert.match(a.output, /T2 marked done/)
  const b = await hooks.tool.todo_done.execute({ id: "T2" }, primaryCtx)
  assert.match(b.output, /T2 was already \[x\]/)
})

test("todo_done rejects malformed ids", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todo_done.execute({ id: "task-5" }, primaryCtx)
  assert.match(res.output, /id must look like T5 or R2/)
})

test("todo_done errors when id is not present in TODO.md", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.todo_done.execute({ id: "T42" }, primaryCtx)
  assert.match(res.output, /T42 not found/)
})

test("PRIMARY_TOOLS now include todos_open/todo_done/todo_block", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  // The orchestrator may call all three without being denied as "non-orchestration".
  for (const t of ["todos_open", "todo_done", "todo_block"]) {
    await hooks["tool.execute.before"]({ tool: t, sessionID: "ses_primary", callID: `p-${t}` })
  }
})

test("subagents are DENIED from calling todo_done/todo_block", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "T1: implement the export endpoint" },
    primaryCtx,
  )
  const subID = created[0]
  // subagent calling todo_done -> denied
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "todo_done", sessionID: subID, callID: "s1" }),
    /orchestrator-only/,
  )
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "todo_block", sessionID: subID, callID: "s2" }),
    /orchestrator-only/,
  )
  // but todos_open IS allowed for subagents (read-only)
  await hooks["tool.execute.before"]({ tool: "todos_open", sessionID: subID, callID: "s3" })
})

// ---------- sanity: the file path is the project root -----------------------

test("todoFilePath resolves to <directory>/TODO.md", () => {
  assert.equal(todoFilePath(projectDir), join(projectDir, "TODO.md"))
  assert.ok(existsSync(todoFilePath(projectDir)))
})
