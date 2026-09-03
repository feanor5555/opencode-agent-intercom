// The bootstrap sweep against the leftover subagent session.
//
// A plugin process that stops mid-run leaves its subagents' opencode sessions
// behind — a reload inside a retention window, an instance that died with
// subagents still running. opencode has no session TTL and no garbage
// collection, and the plugin gets no shutdown hook, so nothing in the world
// would ever delete them. The sweep runs once at plugin load and deletes what
// can only be such a leftover.
//
// What is pinned here:
//   - it deletes a leaked subagent session of this plugin's own;
//   - it deletes NOTHING it cannot positively attribute. Every criterion is a
//     positive statement about the session — the plugin's title marker, a
//     parentID, no children of its own, unknown to this process, idle for
//     longer than the age bound — and each one is pinned by a session that
//     fails it alone and survives;
//   - it never touches a primary, the handoff's successor orchestrator
//     included: that session is a child and carries no marker;
//   - the age bound is twice the retention window, never less than
//     ORPHAN_SWEEP_MIN_AGE_MS or the watchdog-derived margin, so a short
//     retention window cannot pull it down onto a subagent that is merely
//     running;
//   - it runs at the shipped default too, on titles that carry the marker at
//     the shipped default.
//
// Run: node --test test/bootstrap-sweep.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { trackPrimary, upsertSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  setSettingsPath,
  resetSettings,
  dropSettingsCacheKeepingLatch,
  DEFAULT_RETAINED_SUBAGENT_TTL_MS,
} from "../src/settings.js"
import {
  sweepOrphanedSubagentSessions,
  SUBAGENT_SESSION_TITLE_MARKER,
  ORPHAN_SWEEP_TTL_FACTOR,
  ORPHAN_SWEEP_MIN_AGE_MS,
  ORPHAN_SWEEP_WATCHDOG_FACTOR,
} from "../src/teardown.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }
const TTL = 3600000
const OLD_ENOUGH = ORPHAN_SWEEP_TTL_FACTOR * TTL + 60000
// Past the bound the sweep computes with no settings file in place.
const DEFAULT_OLD_ENOUGH =
  Math.max(ORPHAN_SWEEP_TTL_FACTOR * DEFAULT_RETAINED_SUBAGENT_TTL_MS, ORPHAN_SWEEP_MIN_AGE_MS) +
  60000

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-sweep-"))
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
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

const now = Date.now()

// One session record as `session.list` returns it. The defaults are a leaked
// subagent session: this plugin's marker, a parent, long idle.
function session(id, over = {}) {
  return {
    id,
    parentID: "ses_old_primary",
    title: `${SUBAGENT_SESSION_TITLE_MARKER}planner: do x`,
    time: { created: now - OLD_ENOUGH, updated: now - OLD_ENOUGH },
    ...over,
  }
}

function makeClient({ sessions = [], failList = false } = {}) {
  const deleted = []
  const listCalls = []
  const client = {
    session: {
      list: async (opts) => {
        listCalls.push(opts)
        if (failList) throw new Error("connection reset")
        return { data: sessions }
      },
      create: async () => ({ data: { id: "ses_child" } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { client, deleted, listCalls }
}

const ctxFor = (client) => ({ client, directory: fixtureDir, worktree: fixtureDir, project: {} })
const nextImmediate = () => new Promise((resolve) => setImmediate(resolve))

// ---- what it deletes ---------------------------------------------------------

test("a leaked subagent session is deleted", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const { client, deleted } = makeClient({ sessions: [session("ses_leaked")] })
  const swept = await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now })
  assert.deepEqual(swept, ["ses_leaked"])
  assert.deepEqual(deleted, ["ses_leaked"])
})

test("the sweep runs at plugin load, scoped to this project's directory", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const { client, deleted, listCalls } = makeClient({ sessions: [session("ses_leaked")] })
  await plugin(ctxFor(client))
  await nextImmediate()
  assert.deepEqual(deleted, ["ses_leaked"])
  assert.deepEqual(listCalls, [{ query: { directory: fixtureDir } }])
})

test("the plugin factory does not wait for a bootstrap sweep failure", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  let rejectList
  const listGate = new Promise((_, reject) => {
    rejectList = reject
  })
  const { client } = makeClient()
  client.session.list = () => listGate
  const factory = plugin(ctxFor(client))
  let factorySettled = false
  factory.then(() => {
    factorySettled = true
  })

  try {
    await nextImmediate()
    await Promise.resolve()
    assert.equal(factorySettled, true, "plugin factory waited for session.list")
  } finally {
    rejectList(new Error("connection reset"))
    await factory
  }
})

// ---- what it never touches ---------------------------------------------------

test("every session it cannot positively attribute is left standing", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const sessions = [
    // no marker: opencode's own `task` child, a user's session, or one this
    // plugin created before the marker existed
    session("ses_unmarked", { title: "planner: do x" }),
    // no parent: a root session is never a subagent of ours
    session("ses_root", { parentID: undefined }),
    // marked, but something calls it its parent — deleting it would cascade
    // over a session this sweep never judged
    session("ses_has_child"),
    session("ses_the_child", { parentID: "ses_has_child", title: "whatever" }),
    // not old enough, and exactly at the boundary
    session("ses_young", { time: { created: now, updated: now - 60000 } }),
    session("ses_boundary", {
      time: { created: now, updated: now - ORPHAN_SWEEP_TTL_FACTOR * TTL },
    }),
    // no readable idle time: the age can be established for it, or it stays
    session("ses_no_time", { time: undefined }),
    session("ses_bad_time", { time: { updated: "yesterday" } }),
    // the handoff's successor orchestrator: a child session, and a primary
    session("ses_handoff", { title: "orchestrator#2 (handoff from ses_old_primary)" }),
    // a marked leftover, so the sweep is doing something at all
    session("ses_leaked"),
  ]
  const { client, deleted } = makeClient({ sessions })
  const swept = await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now })
  assert.deepEqual(swept, ["ses_leaked"])
  assert.deepEqual(deleted, ["ses_leaked"])
})

test("a session this process itself knows about is never swept", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  trackPrimary(PRIMARY)
  upsertSession("ses_mine", { agent: "planner", prompt: "x", parentID: PRIMARY })
  const sessions = [
    // a registry entry of this process — however old its last event looks
    session("ses_mine"),
    // a primary this process is orchestrating, marked title and all
    session(PRIMARY),
  ]
  const { client, deleted } = makeClient({ sessions })
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { now }), [])
  assert.deepEqual(deleted, [])
})

test("a failed list sweeps nothing and does not throw", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const { client, deleted } = makeClient({ sessions: [session("ses_leaked")], failList: true })
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { now }), [])
  assert.deepEqual(deleted, [])
})

// ---- the default -------------------------------------------------------------

test("the shipped default sweeps too: a leftover is listed and deleted", async () => {
  // No settings file at all, so maxRetainedSubagents is 0. The leftovers this
  // clears are not held sessions but the ones a process that stopped mid-run
  // left behind, and those exist at every setting.
  const { client, deleted, listCalls } = makeClient({
    sessions: [session("ses_leaked", { time: { created: now, updated: now - DEFAULT_OLD_ENOUGH } })],
  })
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now }), [
    "ses_leaked",
  ])
  assert.deepEqual(deleted, ["ses_leaked"])
  assert.deepEqual(listCalls, [{ query: { directory: fixtureDir } }])
})

test("the shipped default sweeps at plugin load", async () => {
  const { client, deleted, listCalls } = makeClient({
    sessions: [session("ses_leaked", { time: { created: now, updated: now - DEFAULT_OLD_ENOUGH } })],
  })
  await plugin(ctxFor(client))
  await nextImmediate()
  assert.deepEqual(listCalls, [{ query: { directory: fixtureDir } }])
  assert.deepEqual(deleted, ["ses_leaked"])
})

test("retention only switched on live, without a restart: the sweep runs either way", async () => {
  // The tool map was resolved without `reuse`, so this process retains nothing.
  // The sweep no longer reads that latch at all — what it clears was never a
  // retention phenomenon.
  withSettings({ maxRetainedSubagents: 0 })
  const { client, deleted } = makeClient({ sessions: [session("ses_leaked")] })
  // a live edit: the file moves, the load-time latch does not
  writeFileSync(settingsFile, JSON.stringify({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL }))
  dropSettingsCacheKeepingLatch()
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now }), [
    "ses_leaked",
  ])
  assert.deepEqual(deleted, ["ses_leaked"])
})

// ---- the age bound and its floor ---------------------------------------------

test("a retention window too short to bound anything cannot pull the age bound down", async () => {
  // Twice a one-second window is two seconds. With a one-minute watchdog the
  // independent floor remains the stronger bound, so a session idle for five
  // minutes may still be a running one — the floor keeps the sweep off it.
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 1000, maxSubagentAgeMs: 60000 })
  const sessions = [
    session("ses_recent", { time: { created: now, updated: now - 300000 } }),
    session("ses_at_floor", { time: { created: now, updated: now - ORPHAN_SWEEP_MIN_AGE_MS } }),
    session("ses_past_floor", {
      time: { created: now, updated: now - ORPHAN_SWEEP_MIN_AGE_MS - 1000 },
    }),
  ]
  const { client, deleted } = makeClient({ sessions })
  const swept = await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now })
  assert.deepEqual(swept, ["ses_past_floor"], "the floor holds, and the bound is exclusive")
  assert.deepEqual(deleted, ["ses_past_floor"])
})

test("the sweep bound follows a longer configured watchdog window", async () => {
  const watchdogAge = 120000
  const bound = Math.max(
    ORPHAN_SWEEP_TTL_FACTOR * 1000,
    ORPHAN_SWEEP_MIN_AGE_MS,
    ORPHAN_SWEEP_WATCHDOG_FACTOR * watchdogAge,
  )
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 1000, maxSubagentAgeMs: watchdogAge })
  const sessions = [
    session("ses_at_watchdog_bound", {
      time: { created: now, updated: now - bound },
    }),
    session("ses_past_watchdog_bound", {
      time: { created: now, updated: now - bound - 1 },
    }),
  ]
  const { client, deleted } = makeClient({ sessions })
  assert.deepEqual(
    await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now }),
    ["ses_past_watchdog_bound"],
  )
  assert.deepEqual(deleted, ["ses_past_watchdog_bound"])
})

test("a disabled watchdog leaves foreign sessions standing", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 1000, maxSubagentAgeMs: 0 })
  const { client, deleted, listCalls } = makeClient({ sessions: [session("ses_live_foreign")] })
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now }), [])
  assert.deepEqual(listCalls, [], "no finite age can make a live session safe to delete")
  assert.deepEqual(deleted, [])
})

test("a retention window longer than the floor sets the bound itself", async () => {
  // 2 × TTL is well past ORPHAN_SWEEP_MIN_AGE_MS, so the floor is inert and the
  // window governs: a session older than the floor but younger than 2 × TTL
  // survives.
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const sessions = [
    session("ses_past_floor_only", {
      time: { created: now, updated: now - ORPHAN_SWEEP_MIN_AGE_MS - 1000 },
    }),
    session("ses_past_window"),
  ]
  const { client, deleted } = makeClient({ sessions })
  assert.deepEqual(
    await sweepOrphanedSubagentSessions(client, { directory: fixtureDir, now }),
    ["ses_past_window"],
  )
  assert.deepEqual(deleted, ["ses_past_window"])
})

// ---- the marker the sweep identifies by --------------------------------------

test("the spawned session's title carries the marker at the shipped default", async () => {
  const created = []
  const { client } = makeClient()
  client.session.create = async (opts) => {
    created.push(opts?.body)
    return { data: { id: "ses_sub1" } }
  }
  const hooks = await plugin(ctxFor(client))
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "do the thing" }, toolCtx)
  assert.equal(created[0].title, `${SUBAGENT_SESSION_TITLE_MARKER}planner: do the thing`)
  assert.equal(created[0].parentID, PRIMARY, "still a child of its orchestrator")
})

test("retention offered: the spawned session's title carries the same marker", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL })
  const created = []
  const { client } = makeClient()
  client.session.create = async (opts) => {
    created.push(opts?.body)
    return { data: { id: "ses_sub1" } }
  }
  const hooks = await plugin(ctxFor(client))
  await hooks.tool.spawn.execute(
    { agent: "planner", prompt: "do the thing", description: "the thing" },
    toolCtx,
  )
  assert.equal(created[0].title, `${SUBAGENT_SESSION_TITLE_MARKER}the thing`)
  assert.equal(created[0].parentID, PRIMARY, "still a child of its orchestrator")
})

test("a session spawned by this process is swept by the next one", async () => {
  // The end-to-end property the marker exists for, at the shipped default: the
  // title spawn writes is exactly what the sweep of a LATER process attributes
  // by. The registry entry is dropped first — a fresh process has none.
  const created = []
  const { client } = makeClient()
  client.session.create = async (opts) => {
    created.push(opts?.body)
    return { data: { id: "ses_sub1" } }
  }
  const hooks = await plugin(ctxFor(client))
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "do the thing" }, toolCtx)
  const leftover = {
    id: "ses_sub1",
    parentID: created[0].parentID,
    title: created[0].title,
    time: { created: now, updated: now - DEFAULT_OLD_ENOUGH },
  }

  resetState()
  const { client: next, deleted } = makeClient({ sessions: [leftover] })
  assert.deepEqual(await sweepOrphanedSubagentSessions(next, { directory: fixtureDir, now }), [
    "ses_sub1",
  ])
  assert.deepEqual(deleted, ["ses_sub1"])
})
