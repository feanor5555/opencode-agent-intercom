// What counts as a sign of life towards the inactivity watchdog.
//
// The dead-man's switch reads one field, `entry.lastActivityAt`, and that field
// is bumped in exactly one place: the event handler, from the session id it
// resolves off the event payload. The opencode SDK puts that id in four
// different places depending on the event, and the two HIGH-FREQUENCY ones —
// the only events a subagent emits while it streams a single long step — are
// the two that carry it nowhere near the top level:
//
//   message.part.updated → properties.part.sessionID
//   message.updated      → properties.info.sessionID  (properties.info.id is
//                          the MESSAGE id, `msg_…`, and addresses no session)
//
// A resolver that misses those leaves a subagent that is working hard looking
// perfectly silent, and the sweep kills it mid-step. These tests pin the
// resolver against every shape, and drive the whole path — event in, sweep,
// entry still alive — for the two streaming ones.
//
// Run: node --test test/watchdog-activity.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { eventSessionID, resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-activity-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  // The sweeps below are driven by hand; a background tick landing on a
  // deliberately back-dated entry would reap it out from under the
  // assertions. plugin(ctx) re-arms the timer with the fresh client.
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx() {
  let counter = 0
  const created = []
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
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

// ---- the resolver, per event shape -------------------------------------------

test("eventSessionID: the session.* family carries the id at top level", () => {
  assert.equal(eventSessionID({ sessionID: "ses_a" }), "ses_a")
  assert.equal(eventSessionID({ sessionID: "ses_a", status: "busy" }), "ses_a")
})

test("eventSessionID: message.part.updated carries it on the part", () => {
  const props = { part: { id: "prt_1", sessionID: "ses_a", messageID: "msg_1", type: "text" } }
  assert.equal(eventSessionID(props), "ses_a")
})

test("eventSessionID: message.updated carries it on info, NOT as info.id", () => {
  // `info` is a Message here: `id` is the message id and addresses no session.
  const props = { info: { id: "msg_1", sessionID: "ses_a", role: "assistant" } }
  assert.equal(eventSessionID(props), "ses_a")
})

test("eventSessionID: session.created/updated carry it as info.id", () => {
  // `info` is a Session here, so its own id IS the session id.
  assert.equal(eventSessionID({ info: { id: "ses_a", parentID: "ses_p" } }), "ses_a")
})

test("eventSessionID: an event with no id anywhere resolves to nothing", () => {
  assert.equal(eventSessionID({}), undefined)
  assert.equal(eventSessionID(undefined), undefined)
  assert.equal(eventSessionID({ part: {} }), undefined)
})

// ---- the whole path: event in, sweep, still alive ----------------------------

async function spawnedEntry() {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  const entry = entryForSession(sessionID)
  // Older than the 90 s default window: without a bump this entry is reaped by
  // the very next sweep.
  entry.lastActivityAt = Date.now() - 600_000
  return { hooks, entry, sessionID }
}

test("a streaming step (message.part.updated) is activity and survives the sweep", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id: "prt_1", sessionID, messageID: "msg_1", type: "text", text: "still writing" },
        delta: "g",
      },
    },
  })

  assert.ok(Date.now() - entry.lastActivityAt < 5000, "the part event must bump lastActivityAt")
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "a streaming subagent must not be reaped")
  assert.notEqual(entry.timedOut, true)
})

test("message.updated is activity too, resolved off info.sessionID", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks.event({
    event: {
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID, role: "assistant" } },
    },
  })

  assert.ok(Date.now() - entry.lastActivityAt < 5000, "the message event must bump lastActivityAt")
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "a subagent mid-message must not be reaped")
})

test("the sweep still reaps a genuinely silent subagent — events for another session are not its activity", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()
  const silentSince = entry.lastActivityAt

  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: { part: { id: "prt_1", sessionID: "ses_someone_else", type: "text" } },
    },
  })

  assert.equal(entry.lastActivityAt, silentSince, "a foreign session's part is not our activity")
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "the dead-man's switch must still fire")
})
