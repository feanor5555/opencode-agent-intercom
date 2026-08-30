// The bootstrap sweep against the reload leak.
//
// A retained subagent session outlives its run by design. opencode has no
// session TTL and no garbage collection, and the plugin gets no shutdown hook,
// so a plugin reload inside a retention window leaves that opencode session
// behind with nothing in the world that would ever delete it. The sweep runs
// once at plugin load and deletes what can only be such a leftover.
//
// What is pinned here:
//   - it deletes a leaked subagent session of this plugin's own;
//   - it deletes NOTHING it cannot positively attribute. Every criterion is a
//     positive statement about the session — the plugin's title marker, a
//     parentID, no children of its own, unknown to this process, idle for
//     longer than twice the retention window — and each one is pinned by a
//     session that fails it alone and survives;
//   - it never touches a primary, the handoff's successor orchestrator
//     included: that session is a child and carries no marker;
//   - at the shipped default it makes no call at all, and the session titles it
//     identifies by are not written either.
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
} from "../src/settings.js"
import {
  sweepOrphanedSubagentSessions,
  SUBAGENT_SESSION_TITLE_MARKER,
  ORPHAN_SWEEP_TTL_FACTOR,
} from "../src/teardown.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }
const TTL = 3600000
const OLD_ENOUGH = ORPHAN_SWEEP_TTL_FACTOR * TTL + 60000

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

test("retention off: no list call, no delete, at the sweep and at plugin load", async () => {
  const { client, deleted, listCalls } = makeClient({ sessions: [session("ses_leaked")] })
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { now }), [])
  await plugin(ctxFor(client))
  assert.deepEqual(listCalls, [], "the shipped default costs not one call")
  assert.deepEqual(deleted, [])
})

test("retention only switched on live, without a restart: still no sweep", async () => {
  // The tool map was resolved without `reuse`, so this process retains nothing
  // and has nothing of its own to clean up either.
  withSettings({ maxRetainedSubagents: 0 })
  const { client, listCalls } = makeClient({ sessions: [session("ses_leaked")] })
  await plugin(ctxFor(client))
  // a live edit: the file moves, the load-time latch does not
  writeFileSync(settingsFile, JSON.stringify({ maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL }))
  dropSettingsCacheKeepingLatch()
  assert.deepEqual(await sweepOrphanedSubagentSessions(client, { now }), [])
  assert.deepEqual(listCalls, [])
})

// ---- the marker the sweep identifies by --------------------------------------

test("retention off: the spawned session's title is byte-identical to what it was", async () => {
  const created = []
  const { client } = makeClient()
  client.session.create = async (opts) => {
    created.push(opts?.body)
    return { data: { id: "ses_sub1" } }
  }
  const hooks = await plugin(ctxFor(client))
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "do the thing" }, toolCtx)
  assert.equal(created[0].title, "planner: do the thing")
})

test("retention offered: the spawned session's title carries the marker", async () => {
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
