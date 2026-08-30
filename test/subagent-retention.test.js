// Retention: a finished subagent kept alive as a re-promptable session instead
// of having its opencode session deleted at idle.
//
// The whole feature hangs on one setting. `maxRetainedSubagents` defaults to 0,
// and at 0 the idle path is what it has always been: deliver the result, remove
// the entry, delete the session. Above 0 a top-level subagent that ended
// cleanly keeps both, on `lifecycle: "retained"`, until its window runs out or
// capacity evicts it.
//
// What is pinned here:
//   - the two settings and their defaults, over file > env > default, and the
//     1 ms floor under the window;
//   - retention off (the default) leaves the idle path's observable behaviour
//     exactly as it was;
//   - retention on holds the session, keeps the handle, and holds no
//     concurrency slot;
//   - the exclusions: a `Blocked:` report, a nested child and a session whose
//     context no later reuse could admit are never retained;
//   - capacity evicts the OLDEST retained entry, silently;
//   - the watchdog: a retained entry is exempt from `maxSubagentAgeMs` and is
//     reaped by `retainedSubagentTtlMs` instead — including with
//     `maxSubagentAgeMs = 0`, which switches the inactivity timer off and must
//     NOT switch off the reap.
//
// Run: node --test test/subagent-retention.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  countActiveSubagents,
  countRetainedSubagents,
  isActiveEntry,
  entryLifecycle,
  retentionDecision,
  retentionContextDecision,
  isRetainedExpired,
  upsertSession,
  trackPrimary,
  LIFECYCLE_RETAINED,
  LIFECYCLE_CLOSING,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings, getSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-retention-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

const ENV_KEYS = [
  "OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS",
  "OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS",
  "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS",
]

// Writes the settings file and drops the settings cache, so the very next
// getSettings() in the code under test reads exactly these values.
function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

beforeEach(() => {
  // The sweeps here are driven by hand; a background tick landing on a
  // deliberately back-dated entry would reap it out from under the assertions.
  // plugin(ctx) re-arms the timer with the fresh client, so the teardown path
  // the reap posts through always has one.
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  for (const key of ENV_KEYS) delete process.env[key]
  resetSettings()
})

// A fake opencode client that records what was created, deleted and prompted.
// `promptAsync` into a session this client did not create is a notice to the
// parent; into one it did create, it is the spawn itself.
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
        if (!created.includes(id)) notices.push(id)
        return { data: undefined }
      },
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
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, deleted, notices }
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

// ---- the settings and their defaults ---------------------------------------

test("with neither file nor env, retention is off and the window is one hour", () => {
  const s = getSettings()
  assert.equal(s.maxRetainedSubagents, 0, "the feature ships off")
  assert.equal(s.retainedSubagentTtlMs, 3600000, "60 minutes")
})

test("both retention settings resolve file > env > default", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS = "2"
  process.env.OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS = "60000"
  resetSettings()
  let s = getSettings()
  assert.equal(s.maxRetainedSubagents, 2, "env over the built-in default")
  assert.equal(s.retainedSubagentTtlMs, 60000)

  withSettings({ maxRetainedSubagents: 5, retainedSubagentTtlMs: 120000 })
  s = getSettings()
  assert.equal(s.maxRetainedSubagents, 5, "the file over the env var")
  assert.equal(s.retainedSubagentTtlMs, 120000)
})

test("both reject a non-integer or negative value and fall back", () => {
  for (const bad of [-1, 1.5, "3", null, true]) {
    withSettings({ maxRetainedSubagents: bad, retainedSubagentTtlMs: bad })
    const s = getSettings()
    assert.equal(s.maxRetainedSubagents, 0, `${bad} must not reach maxRetainedSubagents`)
    assert.equal(s.retainedSubagentTtlMs, 3600000, `${bad} must not reach retainedSubagentTtlMs`)
  }
})

test("0 switches retention off, and the window has a floor of 1 ms", () => {
  withSettings({ maxRetainedSubagents: 0, retainedSubagentTtlMs: 0 })
  const s = getSettings()
  assert.equal(s.maxRetainedSubagents, 0, "0 is a value in its own right: the feature is off")
  assert.equal(
    s.retainedSubagentTtlMs,
    1,
    "a 0 window would be a session nothing ever reaps, so it is clamped, not honoured",
  )
})

// ---- the decision itself ----------------------------------------------------

test("retentionDecision: off at capacity 0, on for a top-level entry, never for a nested one", () => {
  trackPrimary(PRIMARY)
  upsertSession("ses_top", { agent: "planner", prompt: "p", parentID: PRIMARY })
  const top = entryForSession("ses_top")

  assert.deepEqual(retentionDecision(top, 0), { retain: false, reason: "retention-off" })
  assert.deepEqual(retentionDecision(top, 3), { retain: true, reason: "retained" })

  upsertSession("ses_nested", { agent: "researcher", prompt: "p", parentID: "ses_top" })
  const nested = entryForSession("ses_nested")
  assert.deepEqual(
    retentionDecision(nested, 3),
    { retain: false, reason: "nested" },
    "a child whose parent is itself a tracked subagent is never retained",
  )

  const orphan = { ...top, parentID: undefined }
  assert.equal(retentionDecision(orphan, 3).retain, false, "no parent, nobody to follow up")
  assert.equal(retentionDecision(undefined, 3).retain, false)
})

// Condition 5 of the retention decision, the phase-2 half: the context term.
// It is the reason a session is not held that every reuse attempt would refuse
// — the entry would take a retained slot and offer the orchestrator a handle
// the gate turns down at every try.
test("retentionContextDecision: a figure above 0, at or below the ceiling, under the budget", () => {
  const under = { ceiling: 70000, budget: 100000 }

  // 1. a figure at all, and above zero. fetchSnapshot returns {} on any
  // failure, and a ceiling evaluated against a missing number is no ceiling.
  for (const bad of [undefined, null, NaN, "40000", 0, -1]) {
    assert.deepEqual(
      retentionContextDecision(bad, under),
      { retain: false, reason: "no-context" },
      `${String(bad)} is not a context figure`,
    )
  }

  // 2. the ceiling, inclusive.
  assert.deepEqual(retentionContextDecision(1, under), { retain: true, reason: "retained" })
  assert.deepEqual(retentionContextDecision(70000, under), { retain: true, reason: "retained" })
  assert.deepEqual(retentionContextDecision(70001, under), {
    retain: false,
    reason: "over-reuse-ceiling",
  })

  // A ceiling of 0 needs no branch of its own: no real session's context is at
  // or below it, so the type is never retained and never reused.
  assert.deepEqual(retentionContextDecision(1, { ceiling: 0, budget: 100000 }), {
    retain: false,
    reason: "over-reuse-ceiling",
  })
})

test("retentionContextDecision: the budget term, and what it does where it is disabled", () => {
  // A budget below the ceiling is the tighter of the two, and it is exclusive:
  // a session AT its budget is re-prompted straight into the STOP block.
  const tight = { ceiling: 70000, budget: 50000 }
  assert.deepEqual(retentionContextDecision(49999, tight), { retain: true, reason: "retained" })
  assert.deepEqual(retentionContextDecision(50000, tight), { retain: false, reason: "over-budget" })
  assert.deepEqual(retentionContextDecision(60000, tight), { retain: false, reason: "over-budget" })

  // A ceiling above the budget is inert rather than rejected: the budget term
  // refuses what the ceiling lets through.
  const wide = { ceiling: 150000, budget: 100000 }
  assert.deepEqual(retentionContextDecision(99999, wide), { retain: true, reason: "retained" })
  assert.deepEqual(retentionContextDecision(120000, wide), { retain: false, reason: "over-budget" })

  // Where the budget is disabled with 0, the ceiling is the only rule — which
  // is the configuration in which a ceiling above it means something.
  const noBudget = { ceiling: 150000, budget: 0 }
  assert.deepEqual(retentionContextDecision(120000, noBudget), { retain: true, reason: "retained" })
  assert.deepEqual(retentionContextDecision(150001, noBudget), {
    retain: false,
    reason: "over-reuse-ceiling",
  })
})

test("isRetainedExpired reads only retained entries, and an unstamped one is expired", () => {
  trackPrimary(PRIMARY)
  upsertSession("ses_x", { agent: "planner", prompt: "p", parentID: PRIMARY })
  const entry = entryForSession("ses_x")
  const now = 1_000_000

  assert.equal(isRetainedExpired(entry, 1000, now), false, "a running entry never expires here")

  entry.lifecycle = LIFECYCLE_RETAINED
  entry.retainedAt = now - 500
  assert.equal(isRetainedExpired(entry, 1000, now), false, "still inside the window")
  entry.retainedAt = now - 1001
  assert.equal(isRetainedExpired(entry, 1000, now), true, "past it")

  delete entry.retainedAt
  assert.equal(isRetainedExpired(entry, 1000, now), true, "a half-written state is reaped")

  entry.lifecycle = LIFECYCLE_CLOSING
  assert.equal(isRetainedExpired(entry, 1000, now), false, "a teardown is already in flight")
})

// ---- retention off: today's behaviour, unchanged ----------------------------

test("at the default capacity of 0 the idle path deletes the session, as it always has", async () => {
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY], "the orchestrator is woken")
  assert.deepEqual(deleted, [sessionID], "and the session is gone")
  assert.equal(entryForSession(sessionID), undefined, "and so is the entry")
  assert.equal(countRetainedSubagents(), 0)
})

// ---- retention on -----------------------------------------------------------

test("with capacity the session survives idle, keeps its handle, and holds no slot", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  const handle = entryForSession(sessionID).handle

  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY], "the delivery half of the idle path is untouched")
  assert.deepEqual(deleted, [], "and nothing was deleted")

  const entry = entryForSession(sessionID)
  assert.ok(entry, "the entry stays so the handle keeps addressing the session")
  assert.equal(entry.handle, handle)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED)
  assert.ok(entry.retainedAt > 0, "and the window is stamped from now")
  assert.equal(entry.dispatched, false, "the wake latch belongs to the run, and the run is over")
  assert.equal(isActiveEntry(entry), false, "a retained entry holds no concurrency slot")
  assert.equal(countActiveSubagents(), 0)
  assert.equal(countRetainedSubagents(), 1)
})

test("a second idle on a retained session does not wake the parent again", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)
  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY], "exactly one wake for the one run")
  assert.deepEqual(deleted, [])
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
})

test("a Blocked: report is delivered and then deleted, never retained", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({
    messages: assistantReply("Blocked: the briefing does not say which of the two files to take."),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY], "the report still reaches the orchestrator")
  assert.deepEqual(deleted, [sessionID], "a blocked task continues through a fresh spawn")
  assert.equal(entryForSession(sessionID), undefined)
  assert.equal(countRetainedSubagents(), 0)
})

// The same condition through the whole idle path. A healthy run that ended
// above the ceiling is under its budget, was never STOP-injected and returned a
// good result — and is still not held.
test("a run that ended above the reuse ceiling is delivered and then deleted", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({
    messages: assistantReply("THE RESULT", 85000),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY], "the result still reaches the orchestrator")
  assert.deepEqual(deleted, [sessionID], "no reuse could ever admit it, so it is not held")
  assert.equal(entryForSession(sessionID), undefined)
  assert.equal(countRetainedSubagents(), 0)
})

test("a per-type reuse ceiling of 0 means this type is never retained", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 5, reuseContext: { planner: 0 } })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("THE RESULT", 1000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "y" }, toolCtx)
  const [plannerID, researcherID] = created

  await idle(hooks, plannerID)
  assert.deepEqual(deleted, [plannerID], "0 is never-reuse, not no-limit")
  assert.equal(countRetainedSubagents(), 0)

  // The map is per type: the sibling keeps the inherited ceiling and is held.
  await idle(hooks, researcherID)
  assert.deepEqual(deleted, [plannerID], "the sibling's session is untouched")
  assert.equal(countRetainedSubagents(), 1)
})

// Where a type's budget is set below its reuse ceiling, the budget is the
// binding term — a session between the two would be re-prompted into an
// immediate STOP, so it is not held either.
test("a context budget below the reuse ceiling binds instead of the ceiling", async () => {
  withSettings({ maxRetainedSubagents: 3, agentContext: { planner: 30000 } })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("THE RESULT", 40000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(deleted, [sessionID], "under the 70000 ceiling, over its own budget")
  assert.equal(countRetainedSubagents(), 0)
})

test("a budget disabled with 0 leaves the reuse ceiling as the only term", async () => {
  withSettings({
    maxRetainedSubagents: 3,
    agentContext: { planner: 0 },
    reuseContext: { planner: 150000 },
  })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("THE RESULT", 120000) })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(deleted, [], "no budget to bind, and the ceiling the user raised admits it")
  assert.equal(countRetainedSubagents(), 1)
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
})

// A snapshot that came back without a figure refuses the retention: the entry
// is removed and the session deleted on the path it always used.
test("a snapshot without a context figure is not retained", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({
    messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "THE RESULT" }] }],
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(notices, [PRIMARY])
  assert.deepEqual(deleted, [sessionID], "a ceiling evaluated on a guess is not a ceiling")
  assert.equal(entryForSession(sessionID), undefined)
  assert.equal(countRetainedSubagents(), 0)
})

test("a nested child is deleted at idle even with capacity to spare", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 5 })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("child result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [parentID, childID] = created
  // What a nested spawn leaves behind: the child's entry names the calling
  // SUBAGENT as its parent.
  entryForSession(childID).parentID = parentID

  await idle(hooks, childID)

  assert.deepEqual(deleted, [childID], "its rows would be wiped by its parent's own delete")
  assert.equal(entryForSession(childID), undefined)
  assert.equal(countRetainedSubagents(), 0)
})

test("capacity evicts the OLDEST retained subagent, silently", async () => {
  withSettings({ maxRetainedSubagents: 1, maxSubagents: 5 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [firstID, secondID] = created

  await idle(hooks, firstID)
  assert.equal(countRetainedSubagents(), 1)
  // Back-date the first retention so the ordering is unambiguous.
  entryForSession(firstID).retainedAt = Date.now() - 60_000

  await idle(hooks, secondID)

  assert.deepEqual(deleted, [firstID], "the newest retention wins the last slot")
  assert.equal(entryForSession(firstID), undefined)
  assert.equal(entryLifecycle(entryForSession(secondID)), LIFECYCLE_RETAINED)
  assert.equal(countRetainedSubagents(), 1)
  assert.deepEqual(
    notices,
    [PRIMARY, PRIMARY],
    "one wake per run and not one more: an eviction is silent",
  )
})

// ---- the watchdog -----------------------------------------------------------

test("a retained entry is exempt from maxSubagentAgeMs and is not timed out", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)

  // Silent for far longer than the 90 s inactivity window: a retained session
  // emits no events at all, so its lastActivityAt stands still by construction.
  const entry = entryForSession(sessionID)
  entry.lastActivityAt = Date.now() - 600_000
  entry.status = "busy" // the idle-status race guard must not be what saves it

  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "the inactivity window does not apply to a retained entry")
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
  assert.equal(entry.timedOut, false, "and it was never latched as hung")
  assert.deepEqual(deleted, [])
  assert.deepEqual(notices, [PRIMARY], "no false hang report about a subagent that finished")
})

test("the retention window is what ends it: past the TTL the sweep reaps it, silently", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 60_000 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)

  entryForSession(sessionID).retainedAt = Date.now() - 59_000
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "inside the window it stays")

  entryForSession(sessionID).retainedAt = Date.now() - 61_000
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "past it the entry is gone")
  assert.deepEqual(deleted, [sessionID], "and so is the opencode session")
  assert.deepEqual(notices, [PRIMARY], "the parent is not woken a second time to be told")
  assert.equal(countRetainedSubagents(), 0)
})

test("a running subagent is still timed out by the same sweep that spares a retained one", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 5 })
  const { ctx, created, deleted, notices } = makeCtx({ messages: assistantReply("result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [retainedID, hungID] = created
  await idle(hooks, retainedID)

  entryForSession(retainedID).lastActivityAt = Date.now() - 600_000
  entryForSession(hungID).lastActivityAt = Date.now() - 600_000

  await sweepWatchdog()

  assert.equal(entryForSession(hungID), undefined, "the hung run is reaped by its silence")
  assert.deepEqual(deleted, [hungID])
  assert.ok(entryForSession(retainedID), "and the retained one is untouched by that clock")
  assert.deepEqual(notices, [PRIMARY, PRIMARY], "one completion wake, one timeout notice")
})

test("maxSubagentAgeMs = 0 disables the inactivity timer alone — the reap still runs", async () => {
  withSettings({
    maxSubagentAgeMs: 0,
    maxRetainedSubagents: 3,
    retainedSubagentTtlMs: 60_000,
    maxSubagents: 5,
  })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("result") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "b" }, toolCtx)
  const [retainedID, silentID] = created
  await idle(hooks, retainedID)

  entryForSession(retainedID).retainedAt = Date.now() - 61_000
  entryForSession(silentID).lastActivityAt = Date.now() - 600_000

  await sweepWatchdog()

  assert.ok(
    entryForSession(silentID),
    "the watchdog is off: a silent running subagent is not killed on a timer",
  )
  assert.equal(
    entryForSession(retainedID),
    undefined,
    "but the retention window still has an owner — otherwise the leak is unbounded",
  )
  assert.deepEqual(deleted, [retainedID])
})
