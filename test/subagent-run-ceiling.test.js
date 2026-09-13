// The RUN ceiling: the third watchdog window, and the only one a subagent
// cannot renew.
//
// The other two are renewable by the very behaviour that makes a run
// unbounded. The working window is counted from the start of the call in
// flight RIGHT NOW, so a subagent making back-to-back short calls restarts it
// at every call; the silence window is counted from the last event, and a
// subagent that is emitting parts is never silent. A subagent polling for a
// file in repeated short `bash` waits clears both forever, holding a
// concurrency slot, its parent's blocked `spawn` call and an endless cycle's
// quiesce open with it.
//
// `maxSubagentRunMs` is counted from `entry.runStartedAt`, which is stamped at
// the spawn and re-stamped only by a reuse — never by anything the subagent
// does. These tests pin the resolution of the setting, which window
// `watchdogLimit` answers with, the reap the sweep then performs where neither
// older window could have fired, and the two cases that hold the reap off.
//
// Run: node --test test/subagent-run-ceiling.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  retainEntryLocked,
  reviveRetainedEntryLocked,
  restoreRetainedEntryLocked,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, watchdogLimit, _stopWatchdogForTests } from "../src/watchdog.js"
import { registerChildWaiter } from "../src/childwait.js"
import { CHILD_WAITER_TIMEOUT_FACTOR } from "../src/childwait.js"
import { ORPHAN_SWEEP_WATCHDOG_FACTOR } from "../src/teardown.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  getSettings,
  setSettingsPath,
  resetSettings,
  runCeilingFor,
  runWrapUpAt,
  workingWindowMs,
  RUN_WRAP_UP,
} from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-run-ceiling-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

const ENV = "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_RUN_MS"

beforeEach(() => {
  // The sweeps below are driven by hand; a background tick landing on a
  // deliberately back-dated entry would reap it out from under the assertions.
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  delete process.env[ENV]
  resetSettings()
})

function withSettings(obj) {
  writeFileSync(settingsFile, JSON.stringify(obj))
  resetSettings()
}

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

// One spawned subagent, with the plugin's hooks to drive its tool calls.
async function spawned(agent = "researcher") {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent, prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  return { hooks, sessionID, entry: entryForSession(sessionID), created }
}

// ---- the setting ------------------------------------------------------------

test("the default run ceiling is the project's own figure for a plausible lifetime", () => {
  // 4 × the working window — the same multiple the child-waiter's rescue
  // ceiling uses, so the child is reaped at about the moment the parent stops
  // believing in it.
  assert.equal(getSettings().maxSubagentRunMs, 2_640_000)
  assert.equal(
    getSettings().maxSubagentRunMs,
    CHILD_WAITER_TIMEOUT_FACTOR * workingWindowMs(getSettings()),
  )
  // And under the orphan sweep's age bound, so no live subagent falls into
  // another instance's kill range.
  const s = getSettings()
  assert.ok(
    s.maxSubagentRunMs <
      ORPHAN_SWEEP_WATCHDOG_FACTOR * Math.max(s.maxSubagentAgeMs, s.maxSubagentToolCallMs),
  )
  // It clears four maximal opencode `bash` calls in a row — ordinary work.
  assert.ok(s.maxSubagentRunMs >= 4 * 600_000)
})

test("runCeilingFor: own entry > flat key > env > default, and 0 is a real value", () => {
  assert.equal(runCeilingFor("coder"), 2_640_000, "the built-in default")

  process.env[ENV] = "300000"
  resetSettings()
  assert.equal(runCeilingFor("coder"), 300_000, "the env var beats the default")

  withSettings({ maxSubagentRunMs: 200_000 })
  assert.equal(runCeilingFor("coder"), 200_000, "the file beats the env var")

  withSettings({ maxSubagentRunMs: 200_000, agentRunMs: { researcher: 900_000 } })
  assert.equal(runCeilingFor("researcher"), 900_000, "the type's own entry beats the flat key")
  assert.equal(runCeilingFor("coder"), 200_000, "a type the map does not name keeps the flat key")

  withSettings({ maxSubagentRunMs: 200_000, agentRunMs: { researcher: 0 } })
  assert.equal(runCeilingFor("researcher"), 0, "0 is an entry, not an absence")
  assert.equal(runCeilingFor("coder"), 200_000)

  withSettings({ maxSubagentRunMs: 0 })
  assert.equal(runCeilingFor("coder"), 0, "the flat 0 switches the ceiling off for every type")
  delete process.env[ENV]
  resetSettings()
})

test("a bad value leaves the resolution below it standing", () => {
  withSettings({ maxSubagentRunMs: "soon" })
  assert.equal(runCeilingFor("coder"), 2_640_000, "a non-integer is dropped")

  withSettings({ maxSubagentRunMs: -1 })
  assert.equal(runCeilingFor("coder"), 2_640_000, "a negative value is dropped")

  withSettings({ maxSubagentRunMs: 200_000, agentRunMs: { coder: "long", "": 5, planner: 60_000 } })
  assert.equal(runCeilingFor("coder"), 200_000, "one garbage entry costs that entry")
  assert.equal(runCeilingFor("planner"), 60_000, "and not the rest of the map")

  withSettings({ maxSubagentRunMs: 200_000, agentRunMs: [1, 2] })
  assert.equal(runCeilingFor("planner"), 200_000, "a map that is not an object leaves none")
})

test("runWrapUpAt is the band's threshold, and 0 where no ceiling stands", () => {
  withSettings({ maxSubagentRunMs: 400_000 })
  assert.equal(RUN_WRAP_UP, 0.75)
  assert.equal(runWrapUpAt("coder"), 300_000)
  withSettings({ maxSubagentRunMs: 0 })
  assert.equal(runWrapUpAt("coder"), 0, "no ceiling and no band are the one condition")
})

// A settings object built by hand — the shape every older watchdog test passes
// — names the two windows it knows and must not acquire a third.
test("a settings object without a run ceiling has none", () => {
  const windows = { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: 660_000 }
  assert.equal(runCeilingFor("coder", windows), 0)
  const entry = { agent: "coder", runStartedAt: 1, toolCalls: new Map(), lastActivityAt: Date.now() }
  assert.equal(watchdogLimit(entry, windows).kind, "silence")
})

// ---- the stamp --------------------------------------------------------------

test("the run clock is stamped at the spawn and is not spawnedAt", async () => {
  const { entry } = await spawned()
  assert.ok(Number.isFinite(entry.runStartedAt))
  assert.equal(entry.runWarnings, 0)
  assert.equal(entry.runStartedAt, entry.spawnedAt, "run 1 starts when the session does")
})

test("a reuse re-seeds the run clock while spawnedAt stands still", async () => {
  const { sessionID, entry } = await spawned()
  const spawnedAt = entry.spawnedAt
  entry.runStartedAt = spawnedAt - 1_000_000
  entry.runWarnings = 4
  retainEntryLocked(sessionID)

  const revived = reviveRetainedEntryLocked(sessionID, { ctxTokens: 1000, packageTokens: 100 })
  assert.ok(revived, "a held entry is revivable")
  assert.equal(revived.entry.spawnedAt, spawnedAt, "the age column keeps telling the truth")
  assert.ok(
    revived.entry.runStartedAt > spawnedAt - 1_000_000,
    "run 2 is not measured against time run 1 spent",
  )
  assert.equal(revived.entry.runWarnings, 0, "and starts unwarned")

  // A reuse whose prompt never reached the session started no run, so the clock
  // goes back exactly as it was held.
  assert.equal(restoreRetainedEntryLocked(sessionID, revived.previous), true)
  const restored = entryForSession(sessionID)
  assert.equal(restored.runStartedAt, spawnedAt - 1_000_000)
  assert.equal(restored.runWarnings, 4)
})

// ---- which window applies ---------------------------------------------------

test("watchdogLimit answers `run` for an entry past its ceiling with nothing in flight", () => {
  withSettings({ maxSubagentRunMs: 200_000 })
  const now = 1_000_000
  const entry = {
    agent: "coder",
    runStartedAt: now - 200_001,
    lastActivityAt: now,
    toolCalls: new Map(),
  }
  assert.deepEqual(watchdogLimit(entry, getSettings(), now), {
    ms: 200_000,
    setting: "maxSubagentRunMs",
    kind: "run",
    since: now - 200_001,
  })
})

test("a call in flight keeps its own window until the run ceiling is past", () => {
  withSettings({ maxSubagentRunMs: 200_000 })
  const now = 1_000_000
  const inside = {
    agent: "coder",
    runStartedAt: now - 100_000,
    lastActivityAt: now,
    toolCalls: new Map([["c1", { tool: "bash", startedAt: now - 10_000 }]]),
  }
  const limit = watchdogLimit(inside, getSettings(), now)
  assert.equal(limit.kind, "tool-call", "an entry inside its ceiling is measured as before")
  assert.equal(limit.since, now - 10_000)

  // The regression: the call is fresh, so the working window would never fire,
  // and the run ceiling is what bounds it.
  inside.runStartedAt = now - 200_001
  assert.equal(watchdogLimit(inside, getSettings(), now).kind, "run")
})

test("no run clock and no ceiling both fall through to the older windows", () => {
  withSettings({ maxSubagentRunMs: 200_000 })
  const now = 1_000_000
  const noStamp = { agent: "coder", lastActivityAt: now, toolCalls: new Map() }
  assert.equal(watchdogLimit(noStamp, getSettings(), now).kind, "silence", "a reap needs a stamp")

  withSettings({ maxSubagentRunMs: 0 })
  const old = { agent: "coder", runStartedAt: 1, lastActivityAt: now, toolCalls: new Map() }
  assert.equal(watchdogLimit(old, getSettings(), now).kind, "silence")
})

// ---- the reap ---------------------------------------------------------------

// The defect, in one test: the subagent polls, so its silence window is renewed
// by every event and its working window by every fresh call, and neither can
// ever fire. Only the run clock bounds it.
test("the sweep reaps a poller whose last activity is NOW and whose call is fresh", async () => {
  withSettings({ maxSubagents: 4, maxSubagentRunMs: 200_000 })
  const { hooks, sessionID, entry } = await spawned()

  await hooks["tool.execute.before"]({ tool: "bash", sessionID, callID: "c1" })
  entry.lastActivityAt = Date.now()
  entry.toolCalls.get("c1").startedAt = Date.now()
  assert.equal(watchdogLimit(entry, getSettings()).kind, "tool-call", "neither older window fires")

  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "inside its ceiling it keeps polling")

  entry.runStartedAt = Date.now() - 200_001
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined, "the run clock is what nothing renews")
})

test("the run ceiling is off while the inactivity watchdog is off", async () => {
  withSettings({ maxSubagents: 4, maxSubagentAgeMs: 0, maxSubagentRunMs: 200_000 })
  const { sessionID, entry } = await spawned()
  entry.runStartedAt = Date.now() - 900_000

  await sweepWatchdog()

  assert.ok(entryForSession(sessionID), "the dead-man's switch off means no clock cuts a run off")
})

test("a compaction in flight holds the reap off until its own window is up", async () => {
  withSettings({
    maxSubagents: 4,
    maxSubagentRunMs: 200_000,
    maxSubagentToolCallMs: 60_000,
  })
  const { sessionID, entry } = await spawned()
  entry.runStartedAt = Date.now() - 200_001
  entry.compactingSince = Date.now() - 10_000

  await sweepWatchdog()
  assert.ok(entryForSession(sessionID), "the relief the plugin itself started is not reaped into")

  // The deferral is bounded by the working window and lapses with it.
  entry.compactingSince = Date.now() - 60_001
  await sweepWatchdog()
  assert.equal(entryForSession(sessionID), undefined)
})

test("a parent blocked on a live watchdogged child keeps its exemption", async () => {
  withSettings({ maxSubagents: 4, maxSubagentRunMs: 200_000 })
  const { hooks, created } = await spawned()
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "y" }, toolCtx)
  const parentID = created[0]
  const childID = created[1]
  const parent = entryForSession(parentID)
  parent.runStartedAt = Date.now() - 200_001
  registerChildWaiter(childID, parentID)

  await sweepWatchdog()

  assert.ok(
    entryForSession(parentID),
    "reaping the waiting parent would cascade a DELETE over a legitimately working child",
  )
  assert.ok(entryForSession(childID), "and the child is inside its own ceiling")
})
