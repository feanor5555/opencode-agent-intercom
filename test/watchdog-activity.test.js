// What counts as a sign of life towards the inactivity watchdog.
//
// Two things count: any event on the session, and the start or the end of any
// tool call. Both are stamps on `entry.lastActivityAt`.
//
// A tool call says one thing more — that the subagent is WORKING — and it says
// it for exactly as long as the call is IN FLIGHT: it goes into
// `entry.toolCalls` on `tool.execute.before` and comes out on
// `tool.execute.after`. Only that moves the entry onto the second window,
// `maxSubagentToolCallMs`, because opencode publishes nothing between the part
// that announces a tool call and the part that reports its result and its own
// `bash` tool may block far longer than the 90 s silence window. `entry.status`
// does NOT move it: the plugin seeds that field itself on every spawn, so a
// branch on it would put every subagent on the wide window. Both windows still
// kill: these tests pin each one at its own value and pin which of the two
// applies.
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

// Moves the START of a call already in flight into the past, which is the only
// clock the working window is measured against.
function callStartedMsAgo(entry, callID, ms) {
  const call = entry.toolCalls.get(callID)
  assert.ok(call, `no call ${callID} in flight`)
  call.startedAt = Date.now() - ms
  return call
}

// An entry as watchdogLimit reads it, without a plugin run behind it.
function inFlightEntry(startedAt = 500, tool = "bash") {
  return { status: "busy", lastActivityAt: 500, toolCalls: new Map([["c1", { tool, startedAt }]]) }
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

test("watchdogLimit: which window applies, from when, and which setting it comes from", () => {
  const settings = { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: TOOL_CALL_MS }
  assert.deepEqual(watchdogLimit(inFlightEntry(), settings), {
    ms: TOOL_CALL_MS,
    setting: "maxSubagentToolCallMs",
    kind: "tool-call",
    tool: "bash",
    since: 500,
  })
  // Nothing in flight: the silence window, and no `since` — the sweep then
  // measures from the entry's own last sign of life.
  assert.deepEqual(watchdogLimit({ status: "busy", lastActivityAt: 900 }, settings), {
    ms: 90_000,
    setting: "maxSubagentAgeMs",
    kind: "silence",
  })
  // An entry that never had the map at all reads as nothing in flight.
  assert.equal(watchdogLimit({ lastActivityAt: 900 }, settings).kind, "silence")
  assert.equal(watchdogLimit({ toolCalls: new Map() }, settings).kind, "silence")
})

test("watchdogLimit measures the working window from the OLDEST call in flight", () => {
  const settings = { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: TOOL_CALL_MS }
  const entry = inFlightEntry(1000, "bash")
  entry.toolCalls.set("c2", { tool: "read", startedAt: 500 })
  const limit = watchdogLimit(entry, settings)
  assert.equal(limit.since, 500, "a newer call must not push the ceiling out")
  assert.equal(limit.tool, "read", "and the tool named is the one that has been running longest")
})

// `entry.status` is written by this plugin — `createEntry` seeds "busy" on every
// spawn — so a window that branched on it would be the window every subagent
// gets, and the silence window would govern nothing.
test("a freshly spawned entry with no tool call in flight is measured against maxSubagentAgeMs", async () => {
  tightToolCallWindow()
  const { entry, sessionID } = await spawnedEntry(120_000)
  assert.equal(entry.status, "busy", "a spawned entry starts out busy")
  assert.equal(entry.toolCalls.size, 0, "and with nothing in flight")

  assert.equal(watchdogLimit(entry, getSettings()).setting, "maxSubagentAgeMs")
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the seeded busy must not widen the window")
})

test("opencode's own busy verdict does not widen the window either", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry(120_000)

  await hooks.event({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  })
  assert.equal(entry.status, "busy")
  entry.lastActivityAt = Date.now() - 120_000 // the status event itself was activity

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "busy is the whole of a turn, hang included")
})

test("a subagent that is NOT working is reaped at the ordinary window", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry(120_000)

  await hooks.event({
    event: { type: "session.status", properties: { sessionID, status: { type: "retry" } } },
  })
  entry.lastActivityAt = Date.now() - 120_000

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the silence window still kills")
})

test("a subagent inside a tool call outlives maxSubagentAgeMs", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  // The call has been running for longer than the 90 s silence window.
  callStartedMsAgo(entry, "c1", 150_000)
  entry.lastActivityAt = Date.now() - 150_000

  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "a running tool call must not be cut off at the silence window")
  assert.notEqual(entry.timedOut, true)
})

test("a subagent inside a tool call IS killed past maxSubagentToolCallMs", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  callStartedMsAgo(entry, "c1", TOOL_CALL_MS + 10_000)

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "a call in flight is not a licence to run forever")
})

// The defect this replaced: "in flight" used to be `toolCallAt >=
// lastActivityAt`, and ANY event for the session moved lastActivityAt past the
// stamp — a part update, a republished session.status. The call was still
// running; the entry silently fell back to the silence window and was reaped
// mid-command at the next stretch of quiet.
test("an event during a tool call does not end the call", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  callStartedMsAgo(entry, "c1", 150_000)
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: { part: { id: "prt_1", sessionID, messageID: "msg_1", type: "tool" } },
    },
  })
  // The event landed 120 s ago; the call it landed during is still running.
  entry.lastActivityAt = Date.now() - 120_000

  assert.equal(watchdogLimit(entry, getSettings()).kind, "tool-call")
  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "an event during a call must not put the entry back on the silence window")
})

// The other side of the same property: the wide window is a ceiling on the
// call, not a lease the traffic during the call keeps renewing.
test("the working window is not renewed by the events that arrive during the call", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  callStartedMsAgo(entry, "c1", TOOL_CALL_MS + 10_000)
  await hooks.event({
    event: {
      type: "message.part.updated",
      properties: { part: { id: "prt_1", sessionID, messageID: "msg_1", type: "tool" } },
    },
  })
  assert.ok(Date.now() - entry.lastActivityAt < 5000, "the event did bump the sign-of-life stamp")

  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the ceiling is counted from the call's start")
})

test("tool.execute.after ends the call and the entry goes back on the silence window", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  callStartedMsAgo(entry, "c1", 150_000)
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID: "c1", args: {} },
    { title: "bash", output: "done", metadata: {} },
  )

  assert.equal(entry.toolCalls.size, 0, "the call must come out of the map")
  assert.ok(Date.now() - entry.lastActivityAt < 5000, "and its return is itself a sign of life")
  assert.equal(watchdogLimit(entry, getSettings()).setting, "maxSubagentAgeMs")

  entry.lastActivityAt = Date.now() - 120_000
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "a subagent no longer working keeps no wide window")
})

test("parallel tool calls each hold their own slot", async () => {
  tightToolCallWindow()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "read", sessionID, callID: "c1" })
  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c2" })
  assert.equal(entry.toolCalls.size, 2)

  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID: "c2", args: {} },
    { title: "bash", output: "done", metadata: {} },
  )
  assert.equal(watchdogLimit(entry, getSettings()).kind, "tool-call", "one call ending is not all of them")
  assert.equal(watchdogLimit(entry, getSettings()).tool, "read")

  await hooks["tool.execute.after"](
    { tool: "read", sessionID, callID: "c1", args: {} },
    { title: "read", output: "…", metadata: {} },
  )
  assert.equal(entry.toolCalls.size, 0)
  assert.equal(watchdogLimit(entry, getSettings()).kind, "silence")
})

test("an `after` for a call nobody announced, or a second one, changes nothing", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID: "never-started", args: {} },
    { title: "bash", output: "", metadata: {} },
  )
  assert.equal(entry.toolCalls.size, 0)
  assert.ok(Date.now() - entry.lastActivityAt < 5000, "it is still a sign of life")

  // And on a session this plugin does not track it must not throw.
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID: PRIMARY, callID: "c1", args: {} },
    { title: "bash", output: "", metadata: {} },
  )
})

// A denied call throws out of the before-hook, so opencode never runs it and
// never sends an `after` for it. Left in the map it would be an in-flight call
// that nothing can ever end — with `maxSubagentToolCallMs` at 0, a subagent no
// clock reaches at all.
test("a denied tool call leaves nothing in flight", async () => {
  const { hooks, entry, sessionID } = await spawnedEntry()

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "task", sessionID, callID: "c1" }),
    /cannot spawn other agents/,
  )

  assert.equal(entry.toolCalls.size, 0, "a denied call is not a call in flight")
  assert.equal(watchdogLimit(entry, getSettings()).setting, "maxSubagentAgeMs")

  entry.lastActivityAt = Date.now() - 120_000
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "so the silence window still reaches it")
})

test("maxSubagentToolCallMs = 0 lifts the ceiling for a working subagent alone", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagentToolCallMs: 0 }))
  resetSettings()
  const { hooks, entry, sessionID } = await spawnedEntry()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  callStartedMsAgo(entry, "c1", 700_000)
  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "0 means no ceiling while it works")

  // The same entry once that call has returned: the silence window applies
  // again, untouched by the 0.
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID: "c1", args: {} },
    { title: "bash", output: "done", metadata: {} },
  )
  entry.lastActivityAt = Date.now() - 120_000
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "the silence watchdog is untouched by that 0")
})

// A settings object with no tool-call window at all is read the way
// childWaiterTimeoutMs reads it: no window wider than the silence one. The
// alternative is `undefined` as the limit, which reaps a working entry on the
// first tick and reports NaN seconds to the parent.
test("a settings object without maxSubagentToolCallMs falls back to the silence window", () => {
  const partial = { maxSubagentAgeMs: 90_000 }
  assert.equal(watchdogLimit(inFlightEntry(), partial).ms, 90_000)
  assert.equal(watchdogLimit({ lastActivityAt: 900 }, partial).ms, 90_000)
  for (const bad of [{ maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: null }, partial]) {
    assert.ok(Number.isFinite(watchdogLimit(inFlightEntry(), bad).ms), "never NaN or undefined")
  }
  // An explicit 0 is a statement and is kept: no ceiling while it works.
  assert.equal(watchdogLimit(inFlightEntry(), { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: 0 }).ms, 0)
})
