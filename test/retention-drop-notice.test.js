// The parent is woken when a HELD subagent's session is deleted from outside
// the plugin, and is NOT woken by the drops it asked for.
//
// A retention is a promise made in the completion notice: this handle stays
// reachable for the window, come back to it with `reuse`. When the session
// behind it is deleted by somebody else — the sidebar's `x` on a held row, a
// user deleting the session in opencode — that promise is void, and nothing
// else tells the orchestrator so. Without the notice it finds out at the
// refusal of a `reuse` it has already spent a turn framing.
//
// What is pinned here:
//   - the drop posts a notice to the parent, naming the handle, the agent type
//     and the session, and pointing at `spawn`;
//   - the capacity eviction on the idle path stays silent — the parent's own
//     `maxRetainedSubagents` asked for that drop;
//   - a running subagent's `session.deleted` wakes nobody: the watchdog owns
//     that ending;
//   - the cascade case, a parent deleted with its children, wakes nobody: the
//     session the notice would go to is gone too — and it holds in the order
//     opencode really publishes a cascade in, the child's `session.deleted`
//     first and the parent's own LAST.
//
// Run: node --test test/retention-drop-notice.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { deletedSessions, resetState } from "../src/state.js"
import {
  entryForSession,
  countRetainedSubagents,
  entryLifecycle,
  LIFECYCLE_RUNNING,
} from "../src/registry.js"
import {
  resetTurnNotices,
  _setRetentionDropNoticeGraceForTests,
  RETENTION_DROP_NOTICE_GRACE_MS,
} from "../src/hooks.js"
import { retentionLostNotice } from "../src/notices.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-drop-notice-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => {
  _setRetentionDropNoticeGraceForTests()
  _stopWatchdogForTests()
  rmSync(fixtureDir, { recursive: true, force: true })
})

function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

// The drop notice defers past a macrotask before it decides whether the parent
// went too (see the cascade tests at the foot of this file). The shipped grace
// is a few hundred ms; every case here would otherwise pay it, so the seam
// shortens it to a span still comfortably longer than the ticks these tests
// interleave.
const TEST_GRACE_MS = 60

beforeEach(() => {
  _setRetentionDropNoticeGraceForTests(TEST_GRACE_MS)
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

test("resetState clears deleted-session cascade memory", () => {
  deletedSessions.set(PRIMARY, Date.now())
  resetState()
  assert.equal(deletedSessions.has(PRIMARY), false)
})

// Every prompt into a session this fake did NOT create is a notice to a
// primary, and its text is what these tests read.
function makeCtx({ messages = [] } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
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
        if (!created.includes(id)) {
          notices.push({ sessionID: id, text: opts?.body?.parts?.[0]?.text ?? "" })
        }
        return { data: undefined }
      },
      update: async () => ({ data: true }),
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
    notices,
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

function idle(hooks, sessionID) {
  return hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
}

function sessionDeleted(hooks, sessionID) {
  return hooks.event({
    event: { type: "session.deleted", properties: { sessionID, info: { id: sessionID } } },
  })
}

// The notice this feature adds, told apart from the completion wake that came
// before it by the word no other notice carries.
function lostNotices(notices) {
  return notices.filter((n) => /is GONE/.test(n.text))
}

// ---- the notice text --------------------------------------------------------

test("the notice names the handle, the type, the session and the way forward", () => {
  const text = retentionLostNotice({
    handle: "researcher#2",
    agent: "researcher",
    sessionID: "ses_sub2",
  })

  assert.match(text, /^🔔 agent-intercom: /, "the vocabulary every wake notice starts with")
  assert.match(text, /researcher#2/)
  assert.match(text, /\(researcher, session ses_sub2\)/)
  assert.match(text, /deleted from outside the plugin/, "and why it is gone")
  assert.match(text, /reuse\("researcher#2", …\) will not reach it/)
  assert.match(text, /spawn\(\)/, "the only thing left to do")
  assert.ok(!/slot/i.test(text), "a held subagent occupies no slot, so none was freed")
})

// ---- the drop that warrants it ----------------------------------------------

test("a held subagent's session deleted from outside wakes the parent", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  const handle = entryForSession(sessionID).handle
  assert.equal(countRetainedSubagents(), 1, "held to begin with")

  await sessionDeleted(hooks, sessionID)

  const lost = lostNotices(notices)
  assert.equal(lost.length, 1, "exactly one notice for the drop")
  assert.equal(lost[0].sessionID, PRIMARY, "addressed to the primary that holds the handle")
  assert.ok(lost[0].text.includes(handle), "the handle the orchestrator was told to come back to")
  assert.match(lost[0].text, /planner/, "the type it was")
  assert.ok(lost[0].text.includes(sessionID), "and the session it addressed")
  assert.equal(entryForSession(sessionID), undefined, "and the entry is gone with it")
})

test("a parent that cannot be reached costs the drop nothing", async () => {
  // No retry budget: this test is about what the failure leaves behind, and
  // postNotice's backoff would only make it slow.
  withSettings({ maxRetainedSubagents: 3, postNoticeRetries: 0 })
  const { ctx, created } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  // Every attempt fails, retries included: the notice is best-effort and the
  // registry must be straight either way.
  ctx.client.session.promptAsync = async () => {
    throw new Error("session not found")
  }

  await sessionDeleted(hooks, sessionID)

  assert.equal(entryForSession(sessionID), undefined, "the entry still went")
  assert.equal(countRetainedSubagents(), 0)
})

// ---- the drops that stay quiet ----------------------------------------------

test("the capacity eviction on the idle path stays silent", async () => {
  withSettings({ maxRetainedSubagents: 1 })
  const { ctx, created, notices, deleted } = makeCtx({
    messages: assistantReply("THE RESULT"),
  })
  const hooks = await plugin(ctx)
  // One at a time: the shipped concurrency cap is one running subagent, and a
  // held one does not occupy that slot.
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "one" }, toolCtx)
  await idle(hooks, created[0])
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "two" }, toolCtx)
  await idle(hooks, created[1])

  assert.equal(countRetainedSubagents(), 1, "the newest retention won the one place")
  assert.ok(deleted.includes(created[0]), "and the older one was really torn down")
  assert.deepEqual(
    lostNotices(notices),
    [],
    "the parent's own maxRetainedSubagents asked for this drop; it is not woken for it",
  )
})

test("a running subagent's session.deleted wakes nobody", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RUNNING)

  await sessionDeleted(hooks, sessionID)

  assert.deepEqual(lostNotices(notices), [], "the parent is waiting for a result; the watchdog owns that")
  assert.ok(entryForSession(sessionID), "and the entry is untouched")
})

test("the already-seen parent deletion fast path is pinned with a hand-fed order", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)

  // Pin the already-seen fast path with a hand-fed parent-first order, not the real cascade order.
  await sessionDeleted(hooks, PRIMARY)
  await sessionDeleted(hooks, sessionID)

  assert.equal(entryForSession(sessionID), undefined, "the held entry still goes")
  assert.deepEqual(
    lostNotices(notices),
    [],
    "there is no session left to post the notice into",
  )
})

// ---- the cascade in the order opencode really publishes it ------------------
//
// opencode's `Session.remove` recurses over the children BEFORE it publishes
// its own `Deleted`, so a cascade arrives depth-first post-order: every
// descendant first, the deleted session's own event last. The test above feeds
// the parent's event first, which is the one order that never occurs on a real
// server; these feed the real one.
//
// The plugin's handler is started synchronously inside opencode's publish and
// its promise is voided, so when a held child's event is handled the parent's
// event has not been published yet and no amount of awaiting inside the handler
// can make it appear. The decision therefore has to be deferred past a
// macrotask boundary and taken on a second reading.

// Lets the event loop turn: pending microtasks drain and one macrotask passes.
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("the real cascade order — child first, parent last — still wakes nobody", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  assert.equal(countRetainedSubagents(), 1, "held to begin with")

  // The held child's event comes first and is NOT awaited — that is how
  // opencode calls it, and the cascade continues while the handler is still in
  // flight.
  const child = sessionDeleted(hooks, sessionID)

  // A macrotask passes before the parent's own event. Every microtask the
  // handler could have awaited has drained by now, so a guard that only
  // deferred within the microtask queue has already made its decision here.
  await tick(5)
  assert.equal(
    entryForSession(sessionID),
    undefined,
    "the entry left the registry before the wait — `list` and `reuse` are straight throughout it",
  )
  assert.equal(countRetainedSubagents(), 0)

  // Now the parent's own event, last, as the server publishes it.
  await sessionDeleted(hooks, PRIMARY)
  await child

  assert.deepEqual(
    lostNotices(notices),
    [],
    "the parent went too; there is no session left to post the notice into",
  )
})

test("a grandchild whose whole branch is already gone is decided at once", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)

  // The parent's event has already been seen — the far side of a cascade, where
  // the branch above this row was published first. No waiting is warranted.
  await sessionDeleted(hooks, PRIMARY)
  const started = Date.now()
  await sessionDeleted(hooks, sessionID)

  assert.ok(
    Date.now() - started < TEST_GRACE_MS,
    "a decision already settled is not slept on",
  )
  assert.deepEqual(lostNotices(notices), [])
})

test("a lone delete still wakes the parent once the grace has passed", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)

  const child = sessionDeleted(hooks, sessionID)
  // Nothing else is deleted: no cascade, the parent is alive, and the notice
  // must arrive — deferred, not dropped.
  await tick(5)
  assert.deepEqual(lostNotices(notices), [], "not yet: the guard is still waiting out the grace")
  await child

  const lost = lostNotices(notices)
  assert.equal(lost.length, 1, "and then it goes")
  assert.equal(lost[0].sessionID, PRIMARY)
})

test("the shipped grace clears the measured cascade by an order of magnitude", () => {
  // The measured span of a real cascade is ~3 ms per session, 28 ms for a
  // parent with eight children. The default must sit well clear of that, and
  // stay small enough that a notice into a live primary is not noticeably late.
  assert.ok(
    RETENTION_DROP_NOTICE_GRACE_MS >= 200 && RETENTION_DROP_NOTICE_GRACE_MS <= 1000,
    `a few hundred ms, got ${RETENTION_DROP_NOTICE_GRACE_MS}`,
  )
  // The seam restores exactly that value, so a suite that shortens it cannot
  // leave a different one behind for the next.
  _setRetentionDropNoticeGraceForTests(1)
  _setRetentionDropNoticeGraceForTests()
  _setRetentionDropNoticeGraceForTests(TEST_GRACE_MS)
})
