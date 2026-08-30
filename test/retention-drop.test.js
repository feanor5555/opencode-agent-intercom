// Retained subagents do not outlive the primary they belong to: the drop at
// the start of a primary handoff and at the endless cycle's freeze.
//
// A retained session is a finished subagent held alive for a follow-up
// question, and its only value is the context of the primary that asked. When
// that primary is replaced, the new orchestrator has never seen that history —
// a fresh spawn is a better offer than a warm session it cannot read — and an
// entry left behind would keep a handle pointing at an archived session.
//
// What is pinned here:
//   - dropRetainedSubagents tears the session DOWN rather than forgetting it:
//     the opencode session is deleted, the entry goes, and a running subagent
//     beside it is untouched;
//   - `keep` leaves that many of the newest retentions standing (the capacity
//     eviction) and defaults to dropping all of them;
//   - performPrimaryHandoff runs the drop first, right after the drain opens
//     and before it gathers anything, and survives a drop that throws;
//   - runEndlessCycle runs it after the claim and before the quiesce wait, on
//     the abandon path too, and NOT on the cycle-ceiling path, which replaces
//     no primary and lifts the freeze again.
//
// Imports no hooks.js and no plugin factory, so nothing here arms a watchdog
// timer that would keep `node --test` from exiting.
//
// Run: node --test --test-timeout=2000 test/retention-drop.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, resetState } from "../src/state.js"
import { entryForSession, countRetainedSubagents, LIFECYCLE_RETAINED } from "../src/registry.js"
import { dropRetainedSubagents } from "../src/teardown.js"
import { performPrimaryHandoff } from "../src/handoff.js"
import { runEndlessCycle } from "../src/endless.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  setEndlessCooldown,
} from "../src/registry.js"

test.beforeEach(() => resetState())

// Seeds one entry directly, the convention of test/handoff-deps.test.js: this
// file is about what the drop does to the registry, not about how an entry
// gets there.
function seedRetained(sessionID, handle, retainedAt) {
  const entry = {
    handle,
    sessionID,
    agent: "researcher",
    parentID: "ses-primary",
    status: "idle",
    lifecycle: LIFECYCLE_RETAINED,
    retainedAt,
    dispatched: false,
  }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

function seedRunning(sessionID, handle) {
  const entry = {
    handle,
    sessionID,
    agent: "coder",
    parentID: "ses-primary",
    status: "busy",
    lifecycle: "running",
  }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

// Records the session ids opencode was asked to delete.
function fakeClient() {
  const deleted = []
  return {
    deleted,
    client: {
      session: {
        delete: async (opts) => {
          deleted.push(opts?.path?.id)
          return { data: true }
        },
        abort: async () => ({ data: true }),
        promptAsync: async () => ({ data: undefined }),
      },
      tui: { showToast: async () => ({ data: true }) },
    },
  }
}

// ---- the drop itself --------------------------------------------------------

test("the drop deletes every retained session and leaves a running one alone", async () => {
  seedRetained("ses-a", "researcher#1", 1000)
  seedRetained("ses-b", "researcher#2", 2000)
  seedRunning("ses-c", "coder#1")
  const { client, deleted } = fakeClient()

  const dropped = await dropRetainedSubagents(client)

  assert.deepEqual(deleted.sort(), ["ses-a", "ses-b"], "the sessions are torn down, not forgotten")
  assert.deepEqual(dropped.map((d) => d.handle).sort(), ["researcher#1", "researcher#2"])
  assert.equal(entryForSession("ses-a"), undefined)
  assert.equal(entryForSession("ses-b"), undefined)
  assert.equal(countRetainedSubagents(), 0)
  assert.ok(entryForSession("ses-c"), "a running subagent is none of the drop's business")
})

test("keep leaves that many of the newest retentions standing", async () => {
  seedRetained("ses-old", "researcher#1", 1000)
  seedRetained("ses-new", "researcher#2", 2000)
  const { client, deleted } = fakeClient()

  await dropRetainedSubagents(client, { keep: 1 })

  assert.deepEqual(deleted, ["ses-old"], "oldest retainedAt first")
  assert.equal(countRetainedSubagents(), 1)
  assert.ok(entryForSession("ses-new"))
})

test("a process that retains nothing sees no teardown at all", async () => {
  seedRunning("ses-c", "coder#1")
  const { client, deleted } = fakeClient()

  const dropped = await dropRetainedSubagents(client)

  assert.deepEqual(dropped, [])
  assert.deepEqual(deleted, [], "the default of maxRetainedSubagents = 0 changes nothing here")
})

// ---- the handoff ------------------------------------------------------------

// The pure sequence against a recording fake, the discipline of
// test/handoff.test.js: what is asserted is the ORDER, because the drop has to
// happen before reparent and the in-flight list can meet a retained entry.
function handoffDeps(overrides = {}) {
  const log = []
  const call = (name) => log.push(name)
  return {
    _log: log,
    primarySessionID: "primary-1",
    directory: "/tmp/work",
    orchestratorAgentName: "orchestrator",
    beginDrain: () => call("beginDrain"),
    bindDrainTarget: () => call("bindDrainTarget"),
    flushDrain: async () => call("flushDrain"),
    abortDrain: async () => call("abortDrain"),
    dropRetainedSubagents: async () => call("dropRetainedSubagents"),
    getInFlightSubagents: () => {
      call("getInFlightSubagents")
      return []
    },
    getPlannedSteps: () => {
      call("getPlannedSteps")
      return []
    },
    getLastUserGoal: () => {
      call("getLastUserGoal")
      return "a goal"
    },
    formatPrimarySummary: () => {
      call("formatPrimarySummary")
      return "summary"
    },
    writePrimarySummary: () => call("writePrimarySummary"),
    createSession: async () => {
      call("createSession")
      return "orch2"
    },
    promptAsync: async () => call("promptAsync"),
    promptOldPrimaryForDocSummaries: async () => {
      call("promptOldPrimaryForDocSummaries")
      return "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a"
    },
    reparent: async () => {
      call("reparent")
      return 0
    },
    deleteSession: async () => call("deleteSession"),
    archiveSession: async () => call("archiveSession"),
    forgetPrimary: () => call("forgetPrimary"),
    ...overrides,
  }
}

test("the handoff drops the retained subagents before it gathers anything", async () => {
  const deps = handoffDeps()
  await performPrimaryHandoff(deps)

  assert.deepEqual(
    deps._log.slice(0, 3),
    ["beginDrain", "dropRetainedSubagents", "getPlannedSteps"],
    "step 0b: after the drain opens, before the gather",
  )
  const idx = (name) => deps._log.indexOf(name)
  assert.ok(idx("dropRetainedSubagents") < idx("reparent"))
  assert.ok(idx("dropRetainedSubagents") < idx("getInFlightSubagents"))
})

test("a drop that throws does not cost the primary its handoff", async () => {
  const deps = handoffDeps({
    dropRetainedSubagents: async () => {
      throw new Error("delete failed")
    },
  })
  const result = await performPrimaryHandoff(deps)

  assert.equal(result.newSessionID, "orch2")
  assert.ok(deps._log.includes("forgetPrimary"), "the sequence ran to its end")
})

// A handoff wired without the dep — every harness that retains nothing — runs
// exactly as it did before retention existed.
test("the handoff sequence is unchanged where no drop is wired", async () => {
  const deps = handoffDeps({ dropRetainedSubagents: undefined })
  await performPrimaryHandoff(deps)
  assert.deepEqual(deps._log.slice(0, 2), ["beginDrain", "getPlannedSteps"])
})

// ---- the endless cycle ------------------------------------------------------

const SID = "ses-endless-drop"

function cycleIo(overrides = {}) {
  const log = []
  markEndlessPending(SID)
  return {
    _log: log,
    primarySessionID: SID,
    claim: () => claimPendingEndless(SID),
    release: () => releaseEndless(SID),
    setCooldown: () => setEndlessCooldown(SID),
    dropRetained: async () => log.push("dropRetained"),
    isQuiesced: async () => {
      log.push("isQuiesced")
      return true
    },
    requestOpenPoints: async () => {
      log.push("requestOpenPoints")
      return "## OPEN POINTS\n\n- a point\n  accept: it lands\n"
    },
    addTask: () => ({ id: "T1" }),
    listOpen: () => [{ id: "T1" }],
    todoFileName: () => "TODO.md",
    performHandoff: async () => {
      log.push("performHandoff")
      return { newSessionID: "ses-new" }
    },
    cycleNumber: 1,
    maxCycles: 10,
    switchOff: () => true,
    recordCycle: () => ({ stalledCycles: 0 }),
    toast: () => {},
    quiesceTimeoutMs: 600_000,
    pollMs: 500,
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  }
}

test("the endless cycle drops the retained subagents before the quiesce wait", async () => {
  const io = cycleIo()
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.deepEqual(io._log.slice(0, 2), ["dropRetained", "isQuiesced"])
})

test("an abandoned quiesce wait has already paid the drop", async () => {
  let clock = 0
  const io = cycleIo({
    isQuiesced: async () => false,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    quiesceTimeoutMs: 1000,
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "quiesce")
  assert.deepEqual(io._log.filter((e) => e === "dropRetained"), ["dropRetained"])
})

// The ceiling replaces no primary and lifts the freeze again, so the retained
// sessions it would have dropped are still the current primary's to use.
test("the cycle ceiling leaves the retentions alone", async () => {
  const io = cycleIo({ cycleNumber: 4, maxCycles: 3 })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "ceiling")
  assert.deepEqual(io._log, [])
})

test("a drop that throws does not abandon a cycle that can still save", async () => {
  const io = cycleIo({
    dropRetained: async () => {
      throw new Error("delete failed")
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.ok(io._log.includes("performHandoff"))
})
