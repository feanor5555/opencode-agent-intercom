// What counts as a sign of life towards the inactivity watchdog.
//
// Three things count, and the sweep needs all three: any event on the session,
// the start of any tool call, and opencode's own `session.status === "busy"`.
//
// The first two are stamps on `entry.lastActivityAt`; the tool-call stamp also
// says the call is IN FLIGHT, and that — like opencode's own `busy` — moves the
// entry onto the second window, `maxSubagentToolCallMs`, because opencode
// publishes nothing between the part that announces a tool call and the part
// that reports its result and its own `bash` tool may block far longer than the
// 90 s silence window. Both windows still kill: these tests pin each one at its
// own value and pin which of the two applies.
//
// The event stamp is bumped by the event handler, from the session id it
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
import { sweepWatchdog, watchdogLimit, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { getSettings, setSettingsPath, resetSettings } from "../src/settings.js"

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

// `silentFor` is how long the entry has been quiet when the sweep meets it.
// The default is past every ceiling the sweep knows, so an entry left at it is
// reaped unless something in the test made it look alive.
async function spawnedEntry(silentFor = 700_000) {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  const entry = entryForSession(sessionID)
  entry.lastActivityAt = Date.now() - silentFor
  return { hooks, entry, sessionID, created }
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

// ---- a tool call is a sign of life -------------------------------------------
//
// opencode publishes nothing between the part that announces a tool call and
// the part that reports its result. Its own `bash` tool blocks for up to
// 120 000 ms by default and 600 000 ms on request, all of it above the 90 s
// window, so the start of the call is the last thing the plugin sees of a
// subagent that is about to spend two minutes working.

test("the start of a tool call is activity and survives the sweep", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })

  assert.ok(Date.now() - entry.lastActivityAt < 5000, "the tool call must bump lastActivityAt")
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "a subagent that just started a tool call must not be reaped")
  assert.notEqual(entry.timedOut, true)
})

test("a DENIED tool call is activity too — the subagent is still producing", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  // `task` is denied to every subagent. The deny throws, and the stamp must
  // already have been made: a subagent locked down to a text-only handover
  // must not be reaped while it writes that handover.
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "task", sessionID, callID: "c1" }),
    /cannot spawn other agents/,
  )

  assert.ok(Date.now() - entry.lastActivityAt < 5000, "a denied call must bump lastActivityAt too")
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "a denied tool call must not cost the subagent its slot")
})

test("a tool call on a session this plugin does not track changes nothing", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()
  const silentSince = entry.lastActivityAt

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: PRIMARY, callID: "c1" }),
    /orchestrator session/,
  )

  assert.equal(entry.lastActivityAt, silentSince, "another session's tool call is not our activity")
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "the dead-man's switch must still fire")
})

// ---- the two windows --------------------------------------------------------

const TOOL_CALL_MS = 200_000

// A tool-call window small enough to cross inside a test, and distinct from the
// 90 s silence window so that which of the two fired is visible in the result.
function tightToolCallWindow() {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 4, maxSubagentToolCallMs: TOOL_CALL_MS }))
  resetSettings()
}

test("the default tool-call window clears opencode's own bash ceiling", () => {
  // opencode permits a command timeout of at most 600 000 ms; a default at or
  // under that would reap a command opencode itself would have run to the end.
  assert.ok(getSettings().maxSubagentToolCallMs > 600_000)
})

test("maxSubagentToolCallMs is read from the settings file and the env", () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagentToolCallMs: 300_000 }))
  resetSettings()
  assert.equal(getSettings().maxSubagentToolCallMs, 300_000)

  writeFileSync(settingsFile, JSON.stringify({ maxSubagentToolCallMs: "soon" }))
  resetSettings()
  assert.equal(getSettings().maxSubagentToolCallMs, 660_000, "a non-integer is dropped")

  rmSync(settingsFile, { force: true })
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_TOOL_CALL_MS = "123000"
  resetSettings()
  try {
    assert.equal(getSettings().maxSubagentToolCallMs, 123_000)
  } finally {
    delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_TOOL_CALL_MS
    resetSettings()
  }
})

test("a subagent inside a tool call outlives maxSubagentAgeMs", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  // The call itself is now the last thing seen of it, and it has been running
  // for longer than the 90 s silence window.
  const startedAt = Date.now() - 150_000
  entry.lastActivityAt = startedAt
  entry.toolCallAt = startedAt

  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "a running tool call must not be cut off at the silence window")
  assert.notEqual(entry.timedOut, true)
})

test("a subagent inside a tool call IS killed past maxSubagentToolCallMs", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  const startedAt = Date.now() - (TOOL_CALL_MS + 10_000)
  entry.lastActivityAt = startedAt
  entry.toolCallAt = startedAt

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "a call in flight is not a licence to run forever")
})

test("watchdogLimit: which window applies, and which setting it comes from", () => {
  const settings = { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: TOOL_CALL_MS }
  const inFlight = { status: "retry", lastActivityAt: 500, toolCallAt: 500, toolCallTool: "bash" }
  assert.deepEqual(watchdogLimit(inFlight, settings), {
    ms: TOOL_CALL_MS,
    setting: "maxSubagentToolCallMs",
    kind: "tool-call",
    tool: "bash",
  })
  // An event after the call started means the call is over: back to silence.
  assert.deepEqual(watchdogLimit({ ...inFlight, lastActivityAt: 900 }, settings), {
    ms: 90_000,
    setting: "maxSubagentAgeMs",
    kind: "silence",
  })
  assert.deepEqual(watchdogLimit({ status: "busy", lastActivityAt: 900 }, settings), {
    ms: TOOL_CALL_MS,
    setting: "maxSubagentToolCallMs",
    kind: "busy",
  })
  assert.equal(watchdogLimit({ status: "idle", lastActivityAt: 900 }, settings).kind, "silence")
})

test("a subagent opencode still calls busy is measured against the tool-call window", async () => {
  tightToolCallWindow()
  const { entry, sessionID } = await spawnedEntry(120_000)
  assert.equal(entry.status, "busy", "a spawned entry starts out busy")

  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "opencode's own busy verdict must widen the window")
  assert.notEqual(entry.timedOut, true)
})

test("the wider window is not a bump — the entry stays as silent as it was", async () => {
  tightToolCallWindow()
  const { entry, sessionID } = await spawnedEntry(120_000)
  const silentSince = entry.lastActivityAt

  await sweepWatchdog()

  assert.equal(entry.lastActivityAt, silentSince, "a working entry must not have its clock restarted")
  assert.ok(entryForSession(sessionID))
})

test("a stale busy that was never refreshed still hits the tool-call window", async () => {
  tightToolCallWindow()
  const { sessionID } = await spawnedEntry(TOOL_CALL_MS + 10_000)

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "a busy entry must not be exempt forever")
})

test("maxSubagentToolCallMs = 0 lifts the ceiling for a working subagent alone", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagentToolCallMs: 0 }))
  resetSettings()
  const { entry, sessionID } = await spawnedEntry()

  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "0 means no ceiling while it works")

  // The same entry, no longer working: the silence window applies again.
  entry.status = "retry"
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "the silence watchdog is untouched by that 0")
})

test("a subagent that is NOT working is reaped at the ordinary window", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry(120_000)

  // opencode's retry status: the session is not processing, and no tool call of
  // its own is in flight, so nothing here says the silence is work.
  await hooks.event({
    event: { type: "session.status", properties: { sessionID, status: { type: "retry" } } },
  })
  entry.lastActivityAt = Date.now() - 120_000 // the status event itself was activity

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the silence window still kills")
})
