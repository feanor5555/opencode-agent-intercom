// The three ways an endless latch used to stick, and the quiesce wait it held
// open. The latch IS the spawn freeze (isEndlessFrozen, src/registry.js), so a
// latch nobody clears is an orchestrator that stays alive and can never spawn
// again for the life of the process.
//
//   1. `session.error` on the primary. Every clearing path — claim, cancel,
//      forgetPrimary — used to run on that primary's own `session.idle` only,
//      and a turn at the endless ceiling is exactly where provider errors live.
//   2. A rejection between the latch check and the atomic claim. Two session
//      reads stand there (getSessionDirectory, handoffAgentName), outside
//      runEndlessCycle's abandon discipline and under a detached call.
//   3. The quiesce wait, which counted subagents process-wide: a retired
//      primary waited on the subagents of the successor its own earlier cycle
//      had created, with the freeze held for the whole wait.
//
// Driven through the real plugin factory with a mock client, the way
// test/endless-spawn-freeze.test.js does.
//
// Run: node --test --test-timeout=5000 test/endless-latch-release.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  markEndlessPending,
  hasEndlessPending,
  claimPendingEndless,
  isEndlessInProgress,
  isEndlessFrozen,
  isQuiesced,
  countActiveSubagents,
  countActiveSubagentsFor,
  recordSessionAgent,
} from "../src/registry.js"
import { maybeRunPendingEndless, dropEndlessLatch } from "../src/handoffwiring.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-latch-release-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

const PRIMARY = "ses_primary"
const OTHER_PRIMARY = "ses_primary_successor"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
  writeFileSync(settingsFile, JSON.stringify({ endlessMode: true }))
  resetSettings()
})

// `hostileConfig` decides what `config.get` hands back: with it on, reading
// `.agent` throws. That is the one unguarded step inside handoffAgentName —
// loadConfig and loadServerAgents each swallow their own transport failure
// (src/config.js), but projectAgentNames and knownAgentKinds around them have
// no guard, so the throw travels out of the pre-claim region.
function makeCtx() {
  let counter = 0
  const created = []
  const state = { hostileConfig: false }
  const config = {
    get agent() {
      if (state.hostileConfig) throw new Error("config.agent exploded")
      return {}
    },
  }
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
      delete: async () => ({ data: true }),
      update: async () => ({ data: {} }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: config }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    state,
  }
}

// ---------------------------------------------------------------------------
// 1. The error path releases the latch
// ---------------------------------------------------------------------------

test("session.error on the latched primary drops the latch and spawning works again", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  assert.equal(isEndlessFrozen(PRIMARY), true)

  await hooks.event({ event: { type: "session.error", properties: { sessionID: PRIMARY } } })

  assert.equal(hasEndlessPending(PRIMARY), false, "the latch is gone")
  assert.equal(isEndlessFrozen(PRIMARY), false, "and with it the spawn freeze")

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.doesNotMatch(res.output, /^spawn failed: /)
  assert.equal(created.length, 1, "the orchestrator can start work again")
})

test("session.error does not cut into a cycle that has already claimed the latch", async () => {
  // A claimed cycle owns its own abandon discipline (releaseEndless plus the
  // cooldown, inside runEndlessCycle) and may already have written to the todo
  // file. The error path must not release it from underneath.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)

  await hooks.event({ event: { type: "session.error", properties: { sessionID: PRIMARY } } })

  assert.equal(isEndlessInProgress(PRIMARY), true, "the running cycle is untouched")
  assert.equal(isEndlessFrozen(PRIMARY), true, "so the freeze it owns still holds")
})

test("a subagent's session.error leaves its primary's latch standing", async () => {
  // The latch is keyed by session id and belongs to the primary alone. A
  // subagent error is the wake-with-an-error path and says nothing about the
  // primary's own turn.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  markEndlessPending(PRIMARY)

  await hooks.event({ event: { type: "session.error", properties: { sessionID: created[0] } } })

  assert.equal(hasEndlessPending(PRIMARY), true, "the primary still owes its cycle")
})

test("session.error with no endless latch changes nothing", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  await hooks.event({ event: { type: "session.error", properties: { sessionID: PRIMARY } } })

  assert.equal(hasEndlessPending(PRIMARY), false)
  assert.equal(isEndlessInProgress(PRIMARY), false)
})

// ---------------------------------------------------------------------------
// 2. A rejection before the claim releases the latch
// ---------------------------------------------------------------------------

test("a pre-claim rejection drops the latch instead of freezing spawn for good", async () => {
  const { ctx, created, state } = makeCtx()
  const hooks = await plugin(ctx)
  // Force handoffAgentName past its cheap rung: a name other than the plugin's
  // own role is confirmed against the resolved agent list, which is the read
  // that now throws.
  recordSessionAgent(PRIMARY, "build")
  state.hostileConfig = true
  markEndlessPending(PRIMARY)

  const res = await maybeRunPendingEndless(ctx.client, PRIMARY)

  assert.equal(res, null, "no cycle started")
  assert.equal(hasEndlessPending(PRIMARY), false, "the latch is dropped")
  assert.equal(isEndlessFrozen(PRIMARY), false, "the freeze lifts with it")
  assert.deepEqual(created, [], "the primary is not replaced")

  state.hostileConfig = false
  const spawned = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.doesNotMatch(spawned.output, /^spawn failed: /)
})

test("the idle event's detached call survives the same rejection", async () => {
  // The wiring the bare `void` used to hide: the rejection travels out of the
  // event handler, so the drop has to happen on the way — either in the
  // executor's own guard or in the call site's catch.
  const { ctx, created, state } = makeCtx()
  const hooks = await plugin(ctx)
  recordSessionAgent(PRIMARY, "build")
  state.hostileConfig = true
  markEndlessPending(PRIMARY)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: PRIMARY } } })
  // The endless call is detached from the handler; let its microtasks run.
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(hasEndlessPending(PRIMARY), false, "the freeze does not outlive the failed start")
  assert.deepEqual(created, [], "nothing was created on the way")
})

test("dropEndlessLatch reports what it did and refuses a claimed cycle", async () => {
  assert.equal(dropEndlessLatch(PRIMARY, "no latch"), false)
  markEndlessPending(PRIMARY)
  assert.equal(dropEndlessLatch(PRIMARY, "a reason"), true)
  assert.equal(hasEndlessPending(PRIMARY), false)

  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  assert.equal(dropEndlessLatch(PRIMARY, "a reason"), false, "a claimed cycle is not droppable")
  assert.equal(isEndlessInProgress(PRIMARY), true)
})

// ---------------------------------------------------------------------------
// 3. Quiesce is the primary's own subagents, not the process
// ---------------------------------------------------------------------------

test("a foreign primary's subagent does not hold this primary's quiesce", async () => {
  // The observed failure: an old primary re-armed while the successor its own
  // earlier cycle created was spawning, and waited 72 s on that successor's
  // subagent with the freeze on.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "do x" },
    { ...toolCtx, sessionID: OTHER_PRIMARY },
  )

  assert.equal(created.length, 1)
  assert.equal(countActiveSubagents(), 1, "the process-wide count still sees it — the cap is global")
  assert.equal(countActiveSubagentsFor(OTHER_PRIMARY), 1, "it belongs to the successor")
  assert.equal(countActiveSubagentsFor(PRIMARY), 0)
  assert.equal(
    await isQuiesced(PRIMARY),
    true,
    "the retired primary waits on nothing it owns, so its cycle may run",
  )
  assert.equal(
    await isQuiesced(OTHER_PRIMARY),
    false,
    "the primary that owns the subagent still waits for it",
  )
})

test("the primary's own subagent still holds its quiesce until it is done", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.equal(await isQuiesced(PRIMARY), false, "its own subagent is what it waits for")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })

  assert.equal(countActiveSubagentsFor(PRIMARY), 0)
  assert.equal(await isQuiesced(PRIMARY), true, "delivered and torn down: now it is quiesce")
})
