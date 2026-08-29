// The five places a nested spawn would break the wake machinery, and the fix
// each one now carries (concept: role-delegation-and-web-access, step S4).
//
// The machinery was built on the premise that a subagent is a leaf: it has no
// children, so it can be torn down the moment it stops talking, its session
// can be DELETEd (opencode cascades that delete recursively), its silence is
// proof that it hangs, the concurrency cap can be process-wide, and every
// primary-keyed decision reaches every caller. A subagent that waits on a child
// falsifies all five, three of them destructively.
//
// Nothing registers a waiter in production yet — the spawn path is a later
// step — so these tests register waiters directly and drive the real paths:
// session.idle, teardownSubagent, sweepWatchdog, the spawn gate, the abort
// tool.
//
// Run: node --test test/nesting-fixes.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, primarySessions } from "../src/state.js"
import {
  entryForSession,
  upsertSession,
  removeEntry,
  trackPrimary,
  isPrimary,
  rootPrimaryFor,
  spawnCapDecision,
  countActiveSubagents,
  isEndlessFrozen,
  markEndlessPending,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { teardownSubagent, endLiveChildrenOf } from "../src/teardown.js"
import {
  sweepWatchdog,
  isWaitingOnWatchdoggedChild,
  _stopWatchdogForTests,
} from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import {
  registerChildWaiter,
  settleChildWaiter,
  hasLiveChildren,
} from "../src/childwait.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-nesting-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// Room for a parent and a child in the same test. The cap is global and its
// default is 1, which is precisely what break 4 is about — the tests that pin
// the cap itself set their own value.
function withMaxSubagents(n) {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: n }))
  resetSettings()
}

beforeEach(() => {
  // Disarm the interval before each test: the sweeps here are driven by hand,
  // and a background tick landing on a deliberately back-dated entry would
  // reap it out from under the assertions. plugin(ctx) re-arms it with the
  // fresh client, so `watchdogClient` (which the timeout path posts through)
  // is always set.
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// Records the order of the calls the destructive fixes are about: which
// session was deleted when, which was aborted, and which session a wake notice
// was posted into.
function makeCtx({ messages = [] } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const aborts = []
  const notices = []
  // One ordered log across both destructive calls: the fixes here are about
  // WHEN a delete happens relative to an abort, which two separate arrays
  // cannot express.
  const calls = []
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
        // A prompt into a session we did not create is a wake notice; a prompt
        // into a freshly created one is the spawn itself.
        if (!created.includes(id)) notices.push(id)
        return { data: undefined }
      },
      abort: async (opts) => {
        aborts.push(opts?.path?.id)
        calls.push(`abort:${opts?.path?.id}`)
        return { data: true }
      },
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        calls.push(`delete:${opts?.path?.id}`)
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
    aborts,
    notices,
    calls,
  }
}

function assistantReply(text, tokens = 4321) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

function settledOrPending(promise) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("pending"), 5))])
}

// What a nested spawn leaves behind: the child blocks its caller (the waiter)
// and its registry entry names that caller as its parent. Both spawns in these
// tests come from the orchestrator, so the parentID is rewritten here rather
// than through a spawn path that does not admit a subagent caller yet.
function nest(childSessionID, parentSessionID, opts) {
  const entry = entryForSession(childSessionID)
  if (entry) entry.parentID = parentSessionID
  return registerChildWaiter(childSessionID, parentSessionID, opts)
}

// ---- break 1: an idle parent that is only waiting is not torn down ---------

test("a subagent with a live child survives session.idle — no notice, no removal, no delete", async () => {
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("premature") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const parentID = created[0]

  const childResult = registerChildWaiter("ses_child", parentID, { timeoutMs: 0 })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: parentID } } })

  const entry = entryForSession(parentID)
  assert.ok(entry, "the waiting subagent must keep its registry entry")
  assert.equal(entry.dispatched, undefined, "the wake latch must not be claimed while it waits")
  assert.notEqual(entry.status, "idle", "a session blocked in a tool call has not gone idle")
  assert.deepEqual(deleted, [], "its session must not be deleted while a child is live")
  assert.deepEqual(notices, [], "no premature result may reach the orchestrator")
  assert.equal(await settledOrPending(childResult), "pending", "the waiter stays open")
  assert.equal(countActiveSubagents(), 1, "it still holds its slot")
})

test("the same subagent is torn down normally on the idle AFTER its child settles", async () => {
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("THE REAL RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const parentID = created[0]

  const childResult = registerChildWaiter("ses_child", parentID, { timeoutMs: 0 })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: parentID } } })
  assert.ok(entryForSession(parentID), "held on the first idle")

  // The child finishes: the parent's tool call returns, it finishes its turn,
  // and opencode emits a second idle for it.
  settleChildWaiter("ses_child", { status: "completed", result: "child answer" })
  await childResult
  assert.equal(hasLiveChildren(parentID), false)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: parentID } } })
  assert.equal(entryForSession(parentID), undefined, "now it is a finished one-shot subagent")
  assert.deepEqual(deleted, [parentID])
  assert.deepEqual(notices, [PRIMARY], "the orchestrator is woken exactly once, with the real result")
})

test("the idle hold is scoped to the waiting session — a sibling still completes", async () => {
  withMaxSubagents(5)
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("done") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "b" }, toolCtx)
  const [waitingID, siblingID] = created

  registerChildWaiter("ses_child", waitingID, { timeoutMs: 0 })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: siblingID } } })

  assert.deepEqual(deleted, [siblingID], "only the sibling is torn down")
  assert.ok(entryForSession(waitingID), "the waiting one is untouched")
})

// ---- break 2: the DELETE cascade never reaches a live child ----------------

test("teardownSubagent ends a live child BEFORE deleting the parent session", async () => {
  withMaxSubagents(5)
  const { ctx, created, deleted, calls } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created
  const childResult = nest(childID, parentID, { timeoutMs: 0 })

  await teardownSubagent(
    ctx.client,
    { sessionID: parentID, handle: "planner#1", parentID: PRIMARY, agent: "planner" },
    { label: "test" },
  )

  assert.deepEqual(
    deleted,
    [childID, parentID],
    "the child's session must be gone before the parent's DELETE can cascade onto it",
  )
  assert.deepEqual(
    calls,
    [`abort:${childID}`, `delete:${childID}`, `delete:${parentID}`],
    "the child is stopped cooperatively, then deleted, and only then is the parent deleted",
  )
  assert.equal(entryForSession(childID), undefined, "the child's slot is freed with it")
  assert.equal((await childResult).status, "ended", "and the waiter it held is settled, not leaked")
  assert.equal(hasLiveChildren(parentID), false)
  assert.equal(countActiveSubagents(), 0, "neither generation keeps a slot")
})

test("a live child is ended even when it has no registry entry of its own", async () => {
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  const parentID = created[0]
  const ghost = registerChildWaiter("ses_ghost_child", parentID, { timeoutMs: 0 })

  await teardownSubagent(
    ctx.client,
    { sessionID: parentID, handle: "planner#1", parentID: PRIMARY },
    { label: "test" },
  )

  assert.deepEqual(deleted, ["ses_ghost_child", parentID])
  assert.equal((await ghost).status, "ended")
})

test("endLiveChildrenOf recurses to the grandchild and never spins on a cycle", async () => {
  const { ctx, deleted } = makeCtx()
  const child = registerChildWaiter("ses_c", "ses_p", { timeoutMs: 0 })
  const grandchild = registerChildWaiter("ses_g", "ses_c", { timeoutMs: 0 })
  // The cycle the depth bound forbids and a reparent race could still produce.
  const cycle = registerChildWaiter("ses_p", "ses_g", { timeoutMs: 0 })

  const ended = await endLiveChildrenOf(ctx.client, "ses_p", { label: "test" })

  assert.deepEqual(ended, ["ses_c"], "one generation is ended per call; the rest by recursion")
  assert.deepEqual(deleted, ["ses_g", "ses_c"], "deepest first, and the cycle back to ses_p is cut")
  assert.equal((await child).status, "ended")
  assert.equal((await grandchild).status, "ended")
  assert.equal(
    await settledOrPending(cycle),
    "pending",
    "ses_p is nobody's torn-down session here: the guard cut the walk, it did not end the root",
  )
  settleChildWaiter("ses_p", { status: "ended" })
  await cycle
})

test("a leaf subagent's teardown is unchanged — no extra abort, one delete", async () => {
  const { ctx, created, deleted, aborts, notices } = makeCtx({ messages: assistantReply("done") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

  assert.deepEqual(deleted, [sessionID])
  assert.deepEqual(aborts, [])
  assert.deepEqual(notices, [PRIMARY])
})

// ---- break 3: the watchdog does not reap a session that is merely waiting --

test("the watchdog does not reap a silent parent whose child is still tracked", async () => {
  withMaxSubagents(5)
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created
  nest(childID, parentID, { timeoutMs: 0 })

  const parent = entryForSession(parentID)
  // Silent for well over the 90 s window: every event of the run belongs to
  // the child's session.
  parent.lastActivityAt = Date.now() - 600_000
  entryForSession(childID).lastActivityAt = Date.now()

  assert.equal(isWaitingOnWatchdoggedChild(parentID), true)
  await sweepWatchdog()

  assert.ok(entryForSession(parentID), "waiting on a live child is activity, not silence")
  assert.equal(parent.timedOut, false, "and it was not latched as timed out")
  assert.deepEqual(deleted, [], "and nothing was deleted, so no cascade could reach the child")
  assert.ok(
    Date.now() - parent.lastActivityAt < 5000,
    "the parent's window restarts, so it is not reaped the instant its child ends",
  )
})

test("the exemption is lifted the moment the child stops being tracked", async () => {
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  const parentID = created[0]
  // A waiter whose child has no registry entry: nothing watchdogs that child,
  // so an exemption keyed on it could never be lifted.
  registerChildWaiter("ses_untracked_child", parentID, { timeoutMs: 0 })
  entryForSession(parentID).lastActivityAt = Date.now() - 600_000

  assert.equal(isWaitingOnWatchdoggedChild(parentID), false)
  await sweepWatchdog()

  assert.equal(entryForSession(parentID), undefined, "the parent is reaped normally")
  assert.deepEqual(deleted, ["ses_untracked_child", parentID], "child-first even on the reap")
})

test("the watchdog still reaps the CHILD, and the parent follows once it is gone", async () => {
  withMaxSubagents(5)
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created
  const childResult = nest(childID, parentID, { timeoutMs: 0 })

  entryForSession(parentID).lastActivityAt = Date.now() - 600_000
  entryForSession(childID).lastActivityAt = Date.now() - 600_000

  await sweepWatchdog()

  assert.equal(entryForSession(childID), undefined, "the hung child is reaped by its own silence")
  assert.equal((await childResult).status, "timeout", "which frees the session blocked on it")
  assert.ok(entryForSession(parentID), "the parent survives the sweep that reaped its child")

  // With the child gone the exemption is over: the parent is reaped like any
  // other silent subagent on the next window.
  entryForSession(parentID).lastActivityAt = Date.now() - 600_000
  await sweepWatchdog()
  assert.equal(entryForSession(parentID), undefined)
})

// ---- break 4: the cap gates a primary, counts everyone -------------------

test("spawnCapDecision refuses a primary at the cap and admits a nested caller", () => {
  upsertSession("ses_sub_caller", { agent: "planner", prompt: "p", parentID: PRIMARY })

  const fromPrimary = spawnCapDecision(PRIMARY, 1)
  assert.equal(fromPrimary.nested, false)
  assert.equal(fromPrimary.active, 1)
  assert.equal(fromPrimary.refused, true, "the orchestrator waits for its slot")

  const fromSubagent = spawnCapDecision("ses_sub_caller", 1)
  assert.equal(fromSubagent.nested, true)
  assert.equal(fromSubagent.active, 1)
  assert.equal(
    fromSubagent.refused,
    false,
    "the caller IS the subagent occupying the slot — gating it would deadlock it against itself",
  )
})

test("a nested spawn is still counted: the cap counter sees both generations", () => {
  upsertSession("ses_parent", { agent: "planner", prompt: "p", parentID: PRIMARY })
  assert.equal(countActiveSubagents(), 1)
  upsertSession("ses_child", { agent: "researcher", prompt: "c", parentID: "ses_parent" })
  assert.equal(
    countActiveSubagents(),
    2,
    "the orchestrator's slot figure, quiesce and the endless cycle all read this number",
  )
  assert.equal(spawnCapDecision("ses_parent", 1).active, 2)
})

test("maxSubagents = 0 refuses nobody, nested or not", () => {
  upsertSession("ses_sub_caller", { agent: "planner", prompt: "p", parentID: PRIMARY })
  assert.equal(spawnCapDecision(PRIMARY, 0).refused, false)
  assert.equal(spawnCapDecision("ses_sub_caller", 0).refused, false)
})

test("the spawn tool still refuses a primary that has reached the cap", async () => {
  withMaxSubagents(1)
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "a" }, toolCtx)
  const res = await hooks.tool.spawn.execute({ agent: "planner", prompt: "b" }, toolCtx)

  assert.match(res.output, /Subagent limit reached \(1\/1 running globally/)
  assert.equal(created.length, 1, "no second session is created")
})

// ---- break 5: primary-keyed decisions reach a nested caller ---------------

test("rootPrimaryFor walks the spawn chain up to the primary", () => {
  assert.equal(rootPrimaryFor(PRIMARY), PRIMARY, "a primary is its own root")
  upsertSession("ses_child", { agent: "planner", prompt: "p", parentID: PRIMARY })
  upsertSession("ses_grandchild", { agent: "researcher", prompt: "r", parentID: "ses_child" })

  assert.equal(rootPrimaryFor("ses_child"), PRIMARY)
  assert.equal(rootPrimaryFor("ses_grandchild"), PRIMARY)
  assert.equal(rootPrimaryFor(undefined), undefined)
  assert.equal(rootPrimaryFor("ses_unknown"), "ses_unknown", "an untracked session is a root")
})

test("rootPrimaryFor terminates on a parentID cycle", () => {
  const a = upsertSession("ses_a", { agent: "planner", prompt: "a", parentID: "ses_b" })
  const b = upsertSession("ses_b", { agent: "planner", prompt: "b", parentID: "ses_a" })
  assert.equal(a.parentID, "ses_b")
  assert.equal(b.parentID, "ses_a")
  assert.ok(["ses_a", "ses_b"].includes(rootPrimaryFor("ses_a")), "returns rather than spinning")
})

test("the endless spawn freeze reaches a subagent through its root primary", () => {
  upsertSession("ses_child", { agent: "planner", prompt: "p", parentID: PRIMARY })
  upsertSession("ses_grandchild", { agent: "researcher", prompt: "r", parentID: "ses_child" })
  markEndlessPending(PRIMARY)

  assert.equal(isEndlessFrozen(PRIMARY), true)
  assert.equal(isEndlessFrozen("ses_child"), false, "the latch sets hold primary ids only")
  assert.equal(
    isEndlessFrozen(rootPrimaryFor("ses_child")),
    true,
    "which is why the gate asks about the root, not the caller",
  )
  assert.equal(isEndlessFrozen(rootPrimaryFor("ses_grandchild")), true)
})

test("the spawn tool throws the freeze refusal for a frozen primary, unchanged", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  assert.match(res.output ?? "", /No new subagent will start/)
  assert.equal(created.length, 0)
})

test("a session that has a registry entry is never tracked as a primary", () => {
  upsertSession("ses_sub", { agent: "planner", prompt: "p", parentID: PRIMARY })
  trackPrimary("ses_sub")
  assert.equal(isPrimary("ses_sub"), false, "a subagent that spawns must not become a primary")
  assert.equal(primarySessions.has("ses_sub"), false)

  trackPrimary(PRIMARY)
  assert.equal(isPrimary(PRIMARY), true, "a real primary is tracked as before")
})

test("removing an entry clears any primary-set leak the session left behind", async () => {
  primarySessions.add("ses_sub")
  upsertSession("ses_sub", { agent: "planner", prompt: "p", parentID: PRIMARY })
  assert.equal(isPrimary("ses_sub"), true, "tracked before the entry existed")

  await removeEntry("ses_sub")
  assert.equal(isPrimary("ses_sub"), false, "and gone with the entry, not for the life of the process")
})

// ---- the abort tool: same ordering as every other ending path -------------

test("abort ends the subagent's live children before deleting its session", async () => {
  withMaxSubagents(5)
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created

  // A grandparent blocked on the subagent being aborted, and the subagent's own
  // live child.
  const parentResult = registerChildWaiter(parentID, "ses_grandparent", { timeoutMs: 0 })
  const childResult = nest(childID, parentID, { timeoutMs: 0 })

  const res = await hooks.tool.abort.execute({ subagent: spawned.metadata.handle }, toolCtx)

  assert.match(res.output, /Abort signalled/)
  assert.deepEqual(deleted, [childID, parentID], "child-first, so the DELETE cascades over nothing live")
  assert.equal((await parentResult).status, "aborted", "the blocked grandparent is freed")
  assert.equal((await childResult).status, "ended", "and the child's waiter is settled, not leaked")
  assert.equal(entryForSession(childID), undefined)
  assert.equal(countActiveSubagents(), 0)
})

test("abort frees the session blocked on the subagent before the children are torn down", async () => {
  withMaxSubagents(5)
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created

  // Hold the child's delete open: the grandparent must not wait behind it.
  let releaseDelete
  const deleteGate = new Promise((r) => { releaseDelete = r })
  ctx.client.session.delete = async (opts) => {
    if (opts?.path?.id === childID) await deleteGate
    return { data: true }
  }

  const parentResult = registerChildWaiter(parentID, "ses_grandparent", { timeoutMs: 0 })
  nest(childID, parentID, { timeoutMs: 0 })
  const aborting = hooks.tool.abort.execute({ subagent: spawned.metadata.handle }, toolCtx)

  const outcome = await settledOrPending(parentResult)
  assert.notEqual(outcome, "pending", "the blocked session is freed while the teardown is still running")
  assert.equal(outcome.status, "aborted")

  releaseDelete()
  await aborting
})
