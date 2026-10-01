// The orchestrator keeps working through an endless cycle until the cycle
// claims its wind-down (src/tools.js, src/registry.js): after the latch and
// through the quiesce wait, `spawn` and `abort` run as usual; a subagent it
// starts then is one more the quiesce waits for; the wind-down is claimed only
// once none of the primary's subagents runs and the primary is idle; and from
// that claim on `spawn` and `reuse` stay open: a result that comes in after the
// claim is buffered by the delivery drain the claim opens.
// Drives the real plugin factory with a mock client, the way
// test/plugin.test.js does.
//
// Run: node --test --test-timeout=5000 test/endless-spawn-after-latch.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, endlessWindingDown } from "../src/state.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  claimEndlessWindDown,
  noteEndlessPrimaryIdle,
  isEndlessWindingDown,
  hasHandoffDrain,
  beginHandoffDrain,
  bindHandoffDrainTarget,
  flushHandoffDrain,
  closeEndlessWindDownDrain,
  isEndlessPrimaryBusy,
  countActiveSubagents,
  countActiveSubagentsFor,
  entryForSession,
  upsertSession,
} from "../src/registry.js"
import { releaseEndlessCycle } from "../src/handoffwiring.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-after-latch-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx() {
  let counter = 0
  const created = []
  const noticesTo = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async ({ path }) => {
        if (path?.id === PRIMARY) noticesTo.push(path.id)
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, noticesTo }
}

const idle = (sessionID) => ({ event: { type: "session.idle", properties: { sessionID } } })

// ---------------------------------------------------------------------------
// Before the wind-down claim: ordinary work
// ---------------------------------------------------------------------------

test("with the latch set, spawn is accepted and takes its slot", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.doesNotMatch(res.output, /^spawn failed: /)
  assert.doesNotMatch(res.output, /Endless mode/)
  assert.deepEqual(created, ["ses_sub1"])
  assert.equal(countActiveSubagents(), 1)
})

test("during the quiesce wait of a claimed cycle, spawn is accepted", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.doesNotMatch(res.output, /^spawn failed: /)
  assert.deepEqual(created, ["ses_sub1"])
  assert.equal(isEndlessWindingDown(PRIMARY), false)
})

test("with the latch set, abort of a running subagent is accepted", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  const handle = entryForSession(created[0]).handle
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)

  const res = await hooks.tool.abort.execute({ subagent: handle }, toolCtx)

  assert.doesNotMatch(res.output ?? "", /^abort failed: |Endless mode|unknown/i)
  assert.equal(countActiveSubagentsFor(PRIMARY), 0, "the aborted subagent no longer holds the quiesce")
})

// ---------------------------------------------------------------------------
// The quiesce covers every subagent of the primary, and the primary's turn
// ---------------------------------------------------------------------------

test("a subagent spawned after the latch holds the wind-down claim until it is done and the primary is idle", async () => {
  const { ctx, created, noticesTo } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  // The orchestrator delegates in the turn that crossed the ceiling.
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  // The cycle takes the latch (as the primary's idle would) and waits.
  claimPendingEndless(PRIMARY)
  await hooks.event(idle(PRIMARY))
  assert.equal(isEndlessPrimaryBusy(PRIMARY), false, "the primary's turn has ended")

  assert.equal(await claimEndlessWindDown(PRIMARY), false, "its subagent still runs")
  assert.equal(isEndlessWindingDown(PRIMARY), false)

  // The subagent finishes: its result is posted into the primary, which starts
  // a turn there — the primary is busy until that turn's own idle.
  await hooks.event(idle(created[0]))
  assert.deepEqual(noticesTo, [PRIMARY], "the result was delivered to the primary")
  assert.equal(countActiveSubagentsFor(PRIMARY), 0)
  assert.equal(isEndlessPrimaryBusy(PRIMARY), true, "the wake starts a turn")
  assert.equal(await claimEndlessWindDown(PRIMARY), false, "the primary is inside the wake turn")

  // In that turn the orchestrator delegates again.
  const again = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do y" }, toolCtx)
  assert.doesNotMatch(again.output, /^spawn failed: /)
  await hooks.event(idle(PRIMARY))
  assert.equal(await claimEndlessWindDown(PRIMARY), false, "the second subagent holds it now")

  await hooks.event(idle(created[1]))
  assert.equal(await claimEndlessWindDown(PRIMARY), false, "the wake turn for the second result")
  await hooks.event(idle(PRIMARY))

  assert.equal(await claimEndlessWindDown(PRIMARY), true, "no subagent running and the primary idle")
  assert.equal(isEndlessWindingDown(PRIMARY), true)
})

test("a session.status busy event marks the primary busy, an idle status clears it", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  await hooks.event(idle(PRIMARY))

  await hooks.event({
    event: { type: "session.status", properties: { sessionID: PRIMARY, status: { type: "busy" } } },
  })
  assert.equal(await claimEndlessWindDown(PRIMARY), false, "a user message started a turn")
  await hooks.event({
    event: { type: "session.status", properties: { sessionID: PRIMARY, status: { type: "idle" } } },
  })
  assert.equal(await claimEndlessWindDown(PRIMARY), true)
})

// ---------------------------------------------------------------------------
// From the wind-down claim: spawn and reuse stay open, and a result that comes
// in is buffered for the primary that ends up running
// ---------------------------------------------------------------------------

async function windingDown() {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  // The primary's own idle, then the claim the cycle takes.
  noteEndlessPrimaryIdle(PRIMARY)
  assert.equal(await claimEndlessWindDown(PRIMARY), true)
}

test("after the wind-down claim, a spawn is accepted and takes its slot", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.doesNotMatch(res.output, /^spawn failed: /)
  assert.doesNotMatch(res.output, /Endless mode|handing this session over|no further subagent/)
  assert.deepEqual(created, ["ses_sub1"])
  assert.equal(countActiveSubagentsFor(PRIMARY), 1)
})

test("after the wind-down claim, a nested caller's spawn is not refused for endless mode", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  upsertSession("ses_planner", { agent: "planner", parentID: PRIMARY })
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  endlessWindingDown.add(PRIMARY)

  const call = hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "do x" },
    { sessionID: "ses_planner", agent: "planner", messageID: "m2" },
  )
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(created, ["ses_sub1"], "the nested spawn started a child")
  await hooks.event(idle("ses_sub1"))
  const res = await call
  assert.doesNotMatch(res.output, /endless mode is handing|^spawn failed:/i)
})

test("after the wind-down claim, reuse is not refused for endless mode", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()

  const res = await hooks.tool.reuse.execute({ subagent: "researcher#1", prompt: "follow up" }, toolCtx)

  assert.doesNotMatch(res.output ?? "", /handing this session over|no follow-up will run/)
})

test("the claim opens the delivery drain: a subagent started after it ends into the buffer, not the session", async () => {
  const { ctx, created, noticesTo } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()
  assert.equal(hasHandoffDrain(PRIMARY), true, "the claim opened the drain")

  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  await hooks.event(idle(created[0]))

  assert.deepEqual(noticesTo, [], "nothing was posted into the session being replaced")
  assert.equal(countActiveSubagentsFor(PRIMARY), 0)
  assert.equal(bufferedCount(), 1, "the result is held in the drain")
})

function bufferedCount() {
  // Closes the drain and counts what it held; nothing is delivered.
  const drained = closeEndlessWindDownDrain(PRIMARY)
  return drained ? drained.notices.length : 0
}

test("a handoff that completes delivers the buffered result to the successor", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  await hooks.event(idle(created[0]))

  // The handoff's own begin finds the drain standing, then binds the successor.
  beginHandoffDrain(PRIMARY)
  bindHandoffDrainTarget(PRIMARY, "ses_successor")
  const flushed = flushHandoffDrain(PRIMARY)

  assert.equal(flushed.newID, "ses_successor")
  assert.equal(flushed.notices.length, 1, "the result reaches the successor")
})

test("a cycle that ends without a handoff hands the buffered result back to the primary", async () => {
  const { ctx, created, noticesTo } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  await hooks.event(idle(created[0]))
  assert.deepEqual(noticesTo, [])

  const delivered = await releaseEndlessCycle(ctx.client, PRIMARY)

  assert.equal(delivered, 1)
  assert.deepEqual(noticesTo, [PRIMARY], "the primary, which stays live, receives the result")
  assert.equal(isEndlessWindingDown(PRIMARY), false)
  assert.equal(hasHandoffDrain(PRIMARY), false, "no drain is left behind")
})

test("the release of a cycle that holds no claim touches no drain", async () => {
  const { ctx } = makeCtx()
  await plugin(ctx)
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  beginHandoffDrain(PRIMARY) // a drain that is not this cycle's claim

  assert.equal(await releaseEndlessCycle(ctx.client, PRIMARY), 0)
  assert.equal(hasHandoffDrain(PRIMARY), true)
})

test("the release lifts the claim and spawn proceeds", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await windingDown()
  releaseEndless(PRIMARY)

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.doesNotMatch(res.output, /Endless mode/)
  assert.deepEqual(created, ["ses_sub1"])
})
