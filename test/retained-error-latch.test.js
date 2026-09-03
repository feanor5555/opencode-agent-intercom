// A held subagent's session is still alive, so events keep arriving for it long
// after its run ended — and `session.error` is one of them. The entry's two
// teardown marks, `errored` and `timedOut`, are one-way latches that every
// delivery path reads as "another path already owns this entry": the wake
// critical section drops the notice at its `|| e.errored` test and the watchdog
// skips the entry for good.
//
// What is pinned here:
//   - `session.error` landing on a retained (or closing) entry is not a live
//     run's failure: nothing is latched, nothing is torn down, no notice is
//     posted, and the entry stays held and reusable;
//   - a reuse that follows such an error still delivers its answer — the case
//     the suite missed, and the one the defect showed as a subagent that was
//     asked, answered, and never came back;
//   - the revive and the restore clear both latches, so a mark set while the
//     entry was held or left over from an earlier run cannot swallow run 2;
//   - a throw between the watchdog's mark and the teardown that mark stands in
//     for releases the mark again, so the next sweep finishes the job instead of
//     leaving a live opencode session nothing will ever delete.
//
// Run: node --test test/retained-error-latch.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  entryLifecycle,
  countActiveSubagents,
  countRetainedSubagents,
  reviveRetainedEntryLocked,
  restoreRetainedEntryLocked,
  LIFECYCLE_RETAINED,
  LIFECYCLE_RUNNING,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-retained-error-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

beforeEach(() => {
  // The sweeps below are driven by hand; a background tick landing on a
  // deliberately back-dated entry would take it out from under the assertions.
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// The same fake client the reuse suite drives: `messages` is a mutable holder so
// a test can change what the session reports between the runs, and a prompt to a
// session that was never created is a notice to the primary.
function makeCtx({ messages = [] } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
  const prompts = []
  const state = { messages }
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
        const text = (opts?.body?.parts ?? []).map((p) => p.text ?? "").join("")
        prompts.push({ id, text })
        if (!created.includes(id)) notices.push(text)
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: state.messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    deleted,
    notices,
    prompts,
    state,
  }
}

function assistantReply(text, tokens = 20000) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

const idle = (hooks, sessionID) =>
  hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

const sessionError = (hooks, sessionID, error) =>
  hooks.event({ event: { type: "session.error", properties: { sessionID, error } } })

const PROVIDER_ERROR = { name: "UnknownError", data: { message: "provider blew up" } }

// Spawns one planner, ends its run, and leaves it held.
async function retainOne(hooks, created) {
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  await idle(hooks, sessionID)
  const entry = entryForSession(sessionID)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED, "the fixture must actually retain")
  return { sessionID, handle: entry.handle }
}

// ---- session.error on an entry with no live run ------------------------------

test("session.error on a held subagent is not a live run's failure: nothing latched, nothing torn down", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("FIRST", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)
  assert.equal(notices.length, 1, "the completion notice of run 1")

  await sessionError(hooks, sessionID, PROVIDER_ERROR)

  const entry = entryForSession(sessionID)
  assert.ok(entry, "the held entry survives an error on its own session")
  assert.equal(entry.handle, handle)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED, "and it is still held")
  assert.notEqual(entry.errored, true, "the one-way latch must not be set on a run that is over")
  assert.notEqual(entry.timedOut, true)
  assert.equal(notices.length, 1, "no second wake: the orchestrator already has this reply")
  assert.deepEqual(deleted, [], "and the session it may still be asked is not deleted")
  assert.equal(countRetainedSubagents(), 1)
})

test("a reuse after such an error still delivers its answer", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, notices, state } = makeCtx({ messages: assistantReply("FIRST", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)

  await sessionError(hooks, sessionID, PROVIDER_ERROR)

  const res = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)
  assert.match(res.output, /Follow-up sent to "planner#1"/, "the reuse is admitted")
  const revived = entryForSession(sessionID)
  assert.equal(entryLifecycle(revived), LIFECYCLE_RUNNING)
  assert.notEqual(revived.errored, true, "run 2 starts on a clean entry")
  assert.notEqual(revived.timedOut, true)

  state.messages = assistantReply("THE ANSWER", 31000)
  await idle(hooks, sessionID)

  assert.equal(notices.length, 2, "the answer of run 2 reaches the orchestrator")
  assert.match(notices[1], /follow-up run 2 of that session has finished/)
  assert.match(notices[1], /THE ANSWER/)
  assert.equal(countActiveSubagents(), 0, "and the slot it took is free again")
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
})

test("session.error on a running subagent still tears it down and wakes the parent", async () => {
  // The guard narrows the error path to entries that have a live run — this is
  // that run, and it must behave exactly as it always has.
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("PARTIAL", 20000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await sessionError(hooks, sessionID, PROVIDER_ERROR)

  assert.equal(notices.length, 1, "the parent is woken with the failure")
  assert.match(notices[0], /provider blew up/)
  assert.deepEqual(deleted, [sessionID], "a failed run is never held")
  assert.equal(entryForSession(sessionID), undefined)
})

// ---- the latches do not survive a revival ------------------------------------

test("reviveRetainedEntryLocked clears both teardown latches", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created } = makeCtx({ messages: assistantReply("FIRST", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID } = await retainOne(hooks, created)

  const held = entryForSession(sessionID)
  held.errored = true
  held.timedOut = true

  const revived = reviveRetainedEntryLocked(sessionID, { ctxTokens: 20000, packageTokens: 100 })
  assert.ok(revived, "a held entry is revivable")
  assert.equal(revived.entry.errored, false, "run 2's wake is not swallowed by run 1's latch")
  assert.equal(revived.entry.timedOut, false, "and the watchdog owns run 2 again")
  assert.equal(entryLifecycle(revived.entry), LIFECYCLE_RUNNING)

  // The failed-prompt path puts the entry back, and it stays reusable.
  revived.entry.errored = true
  revived.entry.timedOut = true
  assert.equal(restoreRetainedEntryLocked(sessionID, revived.previous), true)
  const restored = entryForSession(sessionID)
  assert.equal(restored.errored, false)
  assert.equal(restored.timedOut, false)
  assert.equal(entryLifecycle(restored), LIFECYCLE_RETAINED)
})

// ---- the sweep's marks are released when the teardown they stand for throws ----

// The mark is set inside the sweep and everything after it runs inside
// timeoutSubagent / reapRetainedSubagent, so a field only those read is the
// seam where a failure between the mark and the teardown can be produced.
function poison(entry, field) {
  Object.defineProperty(entry, field, {
    configurable: true,
    get() {
      throw new Error(`boom reading ${field}`)
    },
  })
}

function heal(entry, field, value) {
  Object.defineProperty(entry, field, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

test("a throw after the timeout latch releases it, and the next sweep tears the entry down", async () => {
  withSettings({ maxSubagents: 4, maxSubagentAgeMs: 90000 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("PARTIAL", 20000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  const entry = entryForSession(sessionID)
  entry.lastActivityAt = Date.now() - 600_000

  poison(entry, "parentID")
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), entry, "the entry is still the registered one")
  assert.equal(entry.timedOut, false, "a latch with no teardown behind it is released")
  assert.deepEqual(deleted, [], "and its session is still there to be dealt with")
  assert.equal(notices.length, 0)

  heal(entry, "parentID", PRIMARY)
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the retry finishes the job")
  assert.deepEqual(deleted, [sessionID])
  assert.equal(notices.length, 1, "and the parent is woken about the hang")
})

test("a throw during a retention reap puts the entry back to held for the next sweep", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 1000 })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("FIRST", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID } = await retainOne(hooks, created)
  const entry = entryForSession(sessionID)
  entry.retainedAt = Date.now() - 600_000
  const agent = entry.agent

  poison(entry, "agent")
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), entry, "the entry is still the registered one")
  assert.equal(
    entryLifecycle(entry),
    LIFECYCLE_RETAINED,
    "a closing mark with no teardown behind it is undone",
  )
  assert.deepEqual(deleted, [], "nothing was deleted, so nothing may be forgotten")

  heal(entry, "agent", agent)
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the expired window is served at the retry")
  assert.deepEqual(deleted, [sessionID])
})

// ---- a sweep that throws on one entry still walks the rest --------------------

test("one entry throwing does not stop the sweep of the others", async () => {
  withSettings({ maxSubagents: 4, maxSubagentAgeMs: 90000 })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("PARTIAL", 20000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "y" }, toolCtx)
  const [first, second] = created
  for (const id of created) entryForSession(id).lastActivityAt = Date.now() - 600_000

  poison(entryForSession(first), "parentID")
  await sweepWatchdog()

  assert.deepEqual(deleted, [second], "the healthy entry is reaped on the same tick")
  assert.ok(entryForSession(first), "and the failing one is left for the next")
})
