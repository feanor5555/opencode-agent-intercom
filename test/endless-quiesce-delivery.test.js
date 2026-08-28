// The quiesce predicate against a REAL wake: a subagent's result must count as
// in flight until it has actually been delivered to the primary, not only
// until its registry entry is gone.
//
// The wake path removes the entry inside the registry mutex and does its
// network work afterwards (fetch the snapshot, auto-tick the task, post the
// completion notice, tear the session down). Between those two moments
// countActiveSubagents() is already 0, so an endless cycle polling isQuiesced
// at a 500 ms cadence would fire its open-points prompt into a primary whose
// last subagent result is still on its way to it — and that result would land
// in a session that is about to be archived, never reaching the saved open
// points. `pendingDeliveries` is what closes that window.
//
// Drives the real plugin factory with a mock client, the way
// test/endless-spawn-freeze.test.js does; the notice post is held open on a
// gate so the assertion can be taken exactly inside the window.
//
// Run: node --test --test-timeout=5000 test/endless-quiesce-delivery.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { countActiveSubagents, isQuiesced } from "../src/registry.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-delivery-"))
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

// A client whose prompt into the PRIMARY session (i.e. the wake notice) blocks
// until the returned gate is opened. Prompts into a subagent session — the
// spawn's own task prompt — pass straight through.
function makeGatedCtx() {
  let openGate
  const gate = new Promise((resolve) => {
    openGate = resolve
  })
  let noticeStarted
  const noticeInFlight = new Promise((resolve) => {
    noticeStarted = resolve
  })
  const created = []
  let counter = 0
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async ({ path }) => {
        if (path?.id === PRIMARY) {
          noticeStarted()
          await gate
        }
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
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    noticeInFlight,
    openGate,
  }
}

test("the primary is NOT quiesced while the last subagent's result is still being delivered", async () => {
  const { ctx, created, noticeInFlight, openGate } = makeGatedCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.equal(countActiveSubagents(), 1)
  assert.equal(await isQuiesced(PRIMARY), false, "a running subagent is not quiesce")

  // The subagent finishes. The handler is not awaited yet: it is holding the
  // notice open inside the gated promptAsync.
  const idle = hooks.event({
    event: { type: "session.idle", properties: { sessionID: created[0] } },
  })
  await noticeInFlight

  assert.equal(
    countActiveSubagents(),
    0,
    "the registry entry is already gone — this is exactly the window the count alone misses",
  )
  assert.equal(
    await isQuiesced(PRIMARY),
    false,
    "the result is still on its way to the primary, so the cycle must not start",
  )

  openGate()
  await idle
  assert.equal(await isQuiesced(PRIMARY), true, "delivered and torn down: now it is quiesce")
})

test("a delivery that fails still ends the in-flight window", async () => {
  const { ctx, created, noticeInFlight, openGate } = makeGatedCtx()
  // Make the notice reject once the gate opens: the wake path logs and falls
  // through to the teardown, and the reservation must not leak — a leaked one
  // would keep isQuiesced false for the life of the process.
  const original = ctx.client.session.promptAsync
  ctx.client.session.promptAsync = async (args) => {
    await original(args)
    if (args?.path?.id === PRIMARY) throw new Error("promptAsync exploded")
    return { data: undefined }
  }
  writeFileSync(settingsFile, JSON.stringify({ postNoticeRetries: 0 }))
  resetSettings()

  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  const idle = hooks.event({
    event: { type: "session.idle", properties: { sessionID: created[0] } },
  })
  await noticeInFlight
  openGate()
  await idle

  assert.equal(await isQuiesced(PRIMARY), true)
})
