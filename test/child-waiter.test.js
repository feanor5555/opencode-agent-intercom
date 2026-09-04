// Tests for the child-waiter mechanism (src/childwait.js): the state that makes
// "this session has live children" expressible, and the guarantee every ending
// path has to keep — a child's run cannot end without settling the session
// blocked on it.
//
// The spawn path registers waiters in production via registerChildWaiter in src/tools.js.
// These tests therefore register waiters directly and drive the real ending
// paths (session.idle, session.error, the abort tool, the inactivity watchdog,
// teardownSubagent itself) against them.
//
// Run: node --test test/child-waiter.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, pendingChildResults } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { resetTurnNotices, timeoutSubagent } from "../src/hooks.js"
import { teardownSubagent } from "../src/teardown.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings, getSettings } from "../src/settings.js"
import {
  registerChildWaiter,
  settleChildWaiter,
  hasChildWaiter,
  hasLiveChildren,
  liveChildSessionIDs,
  waitingParentOf,
  childWaiterTimeoutMs,
  CHILD_WAITER_TIMEOUT_FACTOR,
} from "../src/childwait.js"

const PARENT = "ses_parent"
const CHILD = "ses_child"

// A deterministic fixture project for the plugin-driven tests, mirroring the
// one in plugin.test.js (the project-context snapshot reads it).
const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-waiter-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// Minimal mock ctx: enough for spawn + the event hooks. `messages` is what
// `session.messages` returns, i.e. what fetchSnapshot reads the child's result
// and ctxTokens out of.
function makeCtx({ messages = [] } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    deleted,
  }
}

const toolCtx = { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" }

// An assistant reply the way opencode returns it from session.messages.
function assistantReply(text, tokens = 4321) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

// Resolves to "pending" if `promise` has not settled by the time the
// microtask/timer queue drains once — used to assert a waiter is still open.
function settledOrPending(promise) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("pending"), 5))])
}

// ---- the mechanism itself --------------------------------------------------

test("a registered waiter makes its parent's live children visible", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })

  assert.equal(hasChildWaiter(CHILD), true)
  assert.equal(hasLiveChildren(PARENT), true)
  assert.deepEqual(liveChildSessionIDs(PARENT), [CHILD])
  assert.equal(waitingParentOf(CHILD), PARENT)
  assert.equal(await settledOrPending(promise), "pending", "waiter must stay open until settled")

  // No other session is affected by it.
  assert.equal(hasLiveChildren("ses_someone_else"), false)
  assert.deepEqual(liveChildSessionIDs("ses_someone_else"), [])
  assert.equal(hasChildWaiter("ses_other_child"), false)
  assert.equal(waitingParentOf("ses_other_child"), undefined)

  settleChildWaiter(CHILD, { status: "completed" })
  await promise
})

test("a parent with no waiter has no live children", () => {
  assert.equal(hasLiveChildren(PARENT), false)
  assert.equal(hasLiveChildren(undefined), false)
  assert.deepEqual(liveChildSessionIDs(PARENT), [])
  assert.equal(hasChildWaiter(undefined), false)
})

test("one parent can hold several waiters; each child is listed once", async () => {
  const a = registerChildWaiter("ses_a", PARENT, { timeoutMs: 0 })
  const b = registerChildWaiter("ses_b", PARENT, { timeoutMs: 0 })
  const c = registerChildWaiter("ses_c", "ses_other_parent", { timeoutMs: 0 })

  assert.deepEqual(liveChildSessionIDs(PARENT).sort(), ["ses_a", "ses_b"])
  assert.deepEqual(liveChildSessionIDs("ses_other_parent"), ["ses_c"])

  // Settling one leaves the other open.
  settleChildWaiter("ses_a", { status: "completed" })
  await a
  assert.deepEqual(liveChildSessionIDs(PARENT), ["ses_b"])
  assert.equal(hasLiveChildren(PARENT), true)

  settleChildWaiter("ses_b", { status: "completed" })
  settleChildWaiter("ses_c", { status: "completed" })
  await Promise.all([b, c])
  assert.equal(hasLiveChildren(PARENT), false)
})

test("settling resolves with the outcome, both session ids and the wait duration", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  const settled = settleChildWaiter(CHILD, {
    status: "completed",
    handle: "researcher#1",
    agent: "researcher",
    result: "the answer",
    ctxTokens: 4321,
  })

  assert.equal(settled, true, "the settling call reports that it was the one that settled")
  const outcome = await promise
  assert.equal(outcome.status, "completed")
  assert.equal(outcome.result, "the answer")
  assert.equal(outcome.ctxTokens, 4321)
  assert.equal(outcome.handle, "researcher#1")
  assert.equal(outcome.agent, "researcher")
  assert.equal(outcome.childSessionID, CHILD)
  assert.equal(outcome.parentSessionID, PARENT)
  assert.equal(typeof outcome.waitedMs, "number")

  // The record is gone: the parent is no longer waiting on anything.
  assert.equal(hasChildWaiter(CHILD), false)
  assert.equal(hasLiveChildren(PARENT), false)
  assert.equal(pendingChildResults.size, 0)
})

test("a settle without a status settles as `ended`", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  settleChildWaiter(CHILD)
  assert.equal((await promise).status, "ended")
})

test("only the first settle counts; later ones are no-ops", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  assert.equal(settleChildWaiter(CHILD, { status: "completed", result: "first" }), true)
  assert.equal(settleChildWaiter(CHILD, { status: "error", detail: "second" }), false)
  assert.equal(settleChildWaiter(CHILD, { status: "timeout" }), false)
  const outcome = await promise
  assert.equal(outcome.status, "completed")
  assert.equal(outcome.result, "first")
})

test("settling an unwaited child is a harmless no-op", () => {
  assert.equal(settleChildWaiter("ses_nobody_waits", { status: "completed" }), false)
  assert.equal(settleChildWaiter(undefined, { status: "completed" }), false)
  assert.equal(pendingChildResults.size, 0)
})

test("a double registration for the same child session throws", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  assert.throws(
    () => registerChildWaiter(CHILD, "ses_another_parent", { timeoutMs: 0 }),
    /already registered/,
  )
  // The first waiter is untouched by the rejected second registration.
  assert.equal(waitingParentOf(CHILD), PARENT)
  settleChildWaiter(CHILD, { status: "completed" })
  await promise
})

test("registration requires both session ids", () => {
  assert.throws(() => registerChildWaiter("", PARENT), /childSessionID is required/)
  assert.throws(() => registerChildWaiter(CHILD, ""), /parentSessionID is required/)
  assert.equal(pendingChildResults.size, 0)
})

// ---- the ceiling -----------------------------------------------------------

test("the waiter ceiling is a multiple of the inactivity window, and 0 disables it", () => {
  assert.equal(childWaiterTimeoutMs(90000), 90000 * CHILD_WAITER_TIMEOUT_FACTOR)
  assert.ok(
    childWaiterTimeoutMs(90000) > 90000,
    "the ceiling must outlast the watchdog it backs up, or it would fire first",
  )
  // maxSubagentAgeMs = 0 switches the watchdog off; the ceiling goes with it.
  assert.equal(childWaiterTimeoutMs(0), 0)
  assert.equal(childWaiterTimeoutMs(-1), 0)
  assert.equal(childWaiterTimeoutMs(Number.NaN), 0)
  // Called with no argument it reads the live setting, so the two knobs cannot
  // drift apart.
  assert.equal(childWaiterTimeoutMs(), getSettings().maxSubagentAgeMs * CHILD_WAITER_TIMEOUT_FACTOR)
  writeFileSync(settingsFile, JSON.stringify({ maxSubagentAgeMs: 0 }))
  resetSettings()
  assert.equal(childWaiterTimeoutMs(), 0, "switching off the watchdog switches off the ceiling")
})

test("the ceiling frees the parent as `expired` and drops the waiter", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 5 })
  const outcome = await promise
  assert.equal(outcome.status, "expired")
  assert.match(outcome.detail, /may still be running/)
  assert.equal(hasLiveChildren(PARENT), false, "an expired waiter is no longer a live child")

  // The child is NOT dead — its own ending path runs later and finds no
  // waiter, which must not throw or resurrect one.
  assert.equal(settleChildWaiter(CHILD, { status: "completed", result: "late" }), false)
  assert.equal(pendingChildResults.size, 0)
})

test("a waiter that settles in time never expires", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 60000 })
  settleChildWaiter(CHILD, { status: "completed", result: "in time" })
  const outcome = await promise
  assert.equal(outcome.status, "completed")
  // The ceiling's timer was cleared with the settle: nothing is left to fire.
  assert.equal(pendingChildResults.size, 0)
})

test("resetState settles leftover waiters instead of leaving them hanging", async () => {
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 60000 })
  resetState()
  const outcome = await promise
  assert.equal(outcome.status, "abandoned")
  assert.equal(pendingChildResults.size, 0)
  assert.equal(hasLiveChildren(PARENT), false)
})

// ---- every ending path settles the waiter ----------------------------------

test("teardownSubagent settles the waiter with the caller's outcome", async () => {
  const { ctx } = makeCtx()
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  await teardownSubagent(
    ctx.client,
    { sessionID: CHILD, handle: "researcher#1", parentID: PARENT, agent: "researcher" },
    { outcome: { status: "error", detail: "provider blew up" }, label: "test" },
  )
  const outcome = await promise
  assert.equal(outcome.status, "error")
  assert.equal(outcome.detail, "provider blew up")
  assert.equal(outcome.handle, "researcher#1")
  assert.equal(outcome.agent, "researcher")
})

test("teardownSubagent without an outcome still settles the waiter, as `ended`", async () => {
  const { ctx } = makeCtx()
  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  await teardownSubagent(
    ctx.client,
    { sessionID: CHILD, handle: "coder#1", parentID: PARENT },
    { label: "test" },
  )
  assert.equal((await promise).status, "ended")
})

test("teardownSubagent frees the waiting session BEFORE it deletes the child session", async () => {
  // The waiting session is blocked inside a tool call; holding it there for the
  // duration of the teardown's network I/O is exactly what the mechanism must
  // not do. Gate session.delete open and check the waiter has already resolved.
  const { ctx } = makeCtx()
  let releaseDelete
  const deleteGate = new Promise((r) => { releaseDelete = r })
  ctx.client.session.delete = async () => {
    await deleteGate
    return { data: true }
  }

  const promise = registerChildWaiter(CHILD, PARENT, { timeoutMs: 0 })
  const teardown = teardownSubagent(
    ctx.client,
    { sessionID: CHILD, handle: "researcher#1", parentID: PARENT },
    { outcome: { status: "completed", result: "done" }, label: "test" },
  )

  const outcome = await settledOrPending(promise)
  assert.notEqual(outcome, "pending", "the waiter must resolve while the delete is still open")
  assert.equal(outcome.status, "completed")

  releaseDelete()
  await teardown
})

test("a subagent going idle settles its waiter with the reply and the token figure", async () => {
  const { ctx, created } = makeCtx({ messages: assistantReply("RESEARCH RESULT", 4321) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })

  const outcome = await promise
  assert.equal(outcome.status, "completed")
  assert.equal(outcome.result, "RESEARCH RESULT")
  assert.equal(outcome.ctxTokens, 4321, "the nested run's own cost rides along with the result")
  assert.equal(outcome.agent, "researcher")
  assert.equal(hasLiveChildren(PARENT), false)
})

test("a subagent whose LLM call fails settles its waiter as `error`", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: childID,
        error: { name: "ProviderAuthError", data: { message: "no key" } },
      },
    },
  })

  const outcome = await promise
  assert.equal(outcome.status, "error")
  assert.match(outcome.detail, /no key/)
})

test("a subagent aborted by the user settles its waiter as `aborted`", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: childID,
        error: { name: "MessageAbortedError", data: { message: "stopped" } },
      },
    },
  })

  assert.equal((await promise).status, "aborted")
})

test("the inactivity watchdog settles the waiter of the child it reaps", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const childID = created[0]
  const entry = entryForSession(childID)

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await timeoutSubagent(entry, 90000, 91000)

  const outcome = await promise
  assert.equal(outcome.status, "timeout")
  assert.match(outcome.detail, /91000 ms/)
  assert.match(outcome.detail, /90000 ms/)
  assert.equal(hasLiveChildren(PARENT), false)
})

// The reap reads the session one last time before its teardown deletes it. A
// blocked parent never sees the wake notice that text also rides in — it is
// inside a tool call, not waiting to be woken — so the outcome is the only
// channel it has, and the text has to be on it.
test("the inactivity watchdog hands the rescued text to the waiter as `result`", async () => {
  const { ctx, created } = makeCtx({
    messages: assistantReply("Done: mapped the call sites; the migration is not written."),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await timeoutSubagent(entryForSession(childID), 90000, 91000)

  const outcome = await promise
  assert.equal(outcome.status, "timeout")
  assert.equal(outcome.result, "Done: mapped the call sites; the migration is not written.")
})

// The rescue is best-effort: a session with no usable assistant text leaves
// `result` empty rather than absent, and the renderings fall back on it being
// falsy, not on the key being missing.
test("a timed-out child with nothing to rescue settles with an empty `result`", async () => {
  const { ctx, created } = makeCtx({ messages: [] })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await timeoutSubagent(entryForSession(childID), 90000, 91000)

  const outcome = await promise
  assert.equal(outcome.status, "timeout")
  assert.equal(outcome.result, "")
})

test("the abort tool settles the waiter of the subagent it stops", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const childID = created[0]

  const promise = registerChildWaiter(childID, PARENT, { timeoutMs: 0 })
  await hooks.tool.abort.execute({ subagent: spawned.metadata.handle }, toolCtx)

  const outcome = await promise
  assert.equal(outcome.status, "aborted")
  assert.match(outcome.detail, /aborted by its parent/)
})

// ---- the mechanism is unreachable from a role ------------------------------

test("a normal subagent run registers no waiter — the mechanism is inert today", async () => {
  const { ctx, created } = makeCtx({ messages: assistantReply("done") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  assert.equal(pendingChildResults.size, 0, "spawn must not register a waiter yet")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  assert.equal(pendingChildResults.size, 0)
  assert.equal(hasLiveChildren(toolCtx.sessionID), false)
})
