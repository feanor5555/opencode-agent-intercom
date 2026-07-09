// Idle-gating of the orchestrator handoff. The transform hook fires WHILE the
// triggering turn is already running, so it must only SCHEDULE the handoff
// (pending flag); execution is gated on the primary's `session.idle` event.
// This suite exercises the state-backed gates in src/registry.js
// (scheduleHandoffIfNeeded / markHandoffPending / claimPendingHandoff /
// releaseHandoff / forgetPrimary) and the injectable execution coordinator
// `runScheduledHandoff` in src/handoff.js — the exact functions hooks.js
// wires 1:1 into the transform hook and the idle handler.
//
// Imports ONLY registry.js / state.js / handoff.js + node builtins — no
// hooks.js, no client.js (slice discipline: the wiring stays thin, the logic
// stays injectable).
//
// Run: node --test --test-timeout=2000 test/handoff-idle-gating.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { resetState, pendingHandoffs, handoffInProgress } from "../src/state.js"
import {
  recordPrimaryContext,
  scheduleHandoffIfNeeded,
  markHandoffPending,
  hasHandoffPending,
  claimPendingHandoff,
  releaseHandoff,
  isHandoffInProgress,
  forgetPrimary,
} from "../src/registry.js"
import { runScheduledHandoff, performPrimaryHandoff } from "../src/handoff.js"

test.beforeEach(() => resetState())

const SID = "primary-idle-1"
const MAX = 80_000

// Minimal full deps for driving the REAL performPrimaryHandoff, with
// forgetPrimary wired to the REAL registry helper — exactly what hooks.js
// passes — so the success path's in-progress release is exercised for real.
function makeRealDeps(overrides = {}) {
  return {
    primarySessionID: SID,
    directory: "/tmp/work",
    orchestratorAgentName: "orchestrator",
    getInFlightSubagents: () => [],
    getPlannedSteps: () => [],
    getLastUserGoal: () => "the goal",
    formatPrimarySummary: (s) => `## Stand\n${s.stand}`,
    writePrimarySummary: () => {},
    createSession: async () => "new-primary-1",
    promptAsync: async () => {},
    promptOldPrimaryForDocSummaries: async () =>
      "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a",
    reparent: async () => 0,
    beginDrain: () => {},
    bindDrainTarget: () => {},
    flushDrain: async () => 0,
    abortDrain: async () => 0,
    deleteSession: async () => {},
    forgetPrimary, // the real one — clears pending + in-progress on success
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// (a) Threshold exceeded in the transform hook: schedules ONLY — sets the
//     pending flag, starts nothing (no in-progress latch, nothing executed).
// ---------------------------------------------------------------------------

test("(a) over-threshold schedules a pending handoff and starts NOTHING", () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true, "first over-budget turn schedules")
  assert.equal(hasHandoffPending(SID), true, "pending flag set")
  assert.equal(isHandoffInProgress(SID), false, "no handoff executing")
  assert.equal(handoffInProgress.size, 0, "in-progress set untouched")
})

test("(a) below threshold schedules nothing", () => {
  recordPrimaryContext(SID, MAX - 1)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), false)
  assert.equal(hasHandoffPending(SID), false)
})

test("(a) repeated over-budget turns do not re-schedule (one-shot toast contract)", () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), false, "second turn: already pending")
  assert.equal(pendingHandoffs.size, 1)
})

test("(a) an executing handoff blocks re-scheduling (doc-summary turn race)", () => {
  // While the handoff runs, the OLD primary gets the doc-summary prompt whose
  // transform is still over budget — it must NOT re-arm the pending flag.
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(markHandoffPending(SID), true)
  assert.equal(claimPendingHandoff(SID), true) // handoff now executing
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), false, "in-progress gates scheduling")
  assert.equal(hasHandoffPending(SID), false)
})

// ---------------------------------------------------------------------------
// (b) `session.idle` of a primary with the pending flag executes the handoff.
// ---------------------------------------------------------------------------

test("(b) idle with pending flag claims and executes the handoff (fake perform)", async () => {
  markHandoffPending(SID)
  const calls = []
  const result = await runScheduledHandoff({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => ({ marker: "deps" }),
    perform: async (deps) => {
      calls.push(deps)
      return { newSessionID: "new-1", reparented: 0 }
    },
  })
  assert.equal(calls.length, 1, "perform ran exactly once")
  assert.deepEqual(calls[0], { marker: "deps" }, "perform received the built deps")
  assert.deepEqual(result, { newSessionID: "new-1", reparented: 0 })
  assert.equal(hasHandoffPending(SID), false, "pending flag consumed")
})

test("(b) full sequence: real performPrimaryHandoff runs and forgetPrimary clears the in-progress latch", async () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true)
  const result = await runScheduledHandoff({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => makeRealDeps(),
    perform: performPrimaryHandoff,
  })
  assert.equal(result.newSessionID, "new-primary-1")
  assert.equal(isHandoffInProgress(SID), false, "success path released via forgetPrimary")
  assert.equal(hasHandoffPending(SID), false)
})

// ---------------------------------------------------------------------------
// (c) No pending flag: idle does nothing.
// ---------------------------------------------------------------------------

test("(c) idle without pending flag executes nothing", async () => {
  let getDepsCalls = 0
  let performCalls = 0
  const result = await runScheduledHandoff({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => {
      getDepsCalls++
      return {}
    },
    perform: async () => {
      performCalls++
      return {}
    },
  })
  assert.equal(result, null, "nothing claimed → null")
  assert.equal(getDepsCalls, 0, "deps never built")
  assert.equal(performCalls, 0, "handoff never started")
  assert.equal(isHandoffInProgress(SID), false)
})

test("(c) subagent idles are a no-op: claim on a session that never scheduled is false", () => {
  // Only primary transforms ever mark pending; a tracked subagent going idle
  // hits claimPendingHandoff with an unmarked id.
  assert.equal(claimPendingHandoff("subagent-session-1"), false)
  assert.equal(claimPendingHandoff(undefined), false)
})

// ---------------------------------------------------------------------------
// (d) Duplicate idle events execute the handoff exactly once.
// ---------------------------------------------------------------------------

test("(d) two concurrent idle events run the handoff exactly once", async () => {
  markHandoffPending(SID)
  let performCalls = 0
  let releaseGate
  const gate = new Promise((resolve) => (releaseGate = resolve))
  const run = () =>
    runScheduledHandoff({
      claim: () => claimPendingHandoff(SID),
      release: () => releaseHandoff(SID),
      getDeps: () => ({}),
      perform: async () => {
        performCalls++
        await gate // keep the first handoff in flight while the second idle arrives
        return { newSessionID: "new-1", reparented: 0 }
      },
    })
  const first = run()
  const second = run() // duplicate idle while the first is still executing
  releaseGate()
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(performCalls, 1, "perform ran exactly once")
  assert.deepEqual(r1, { newSessionID: "new-1", reparented: 0 })
  assert.equal(r2, null, "duplicate idle claimed nothing")
})

test("(d) a later idle after a completed handoff does nothing", async () => {
  markHandoffPending(SID)
  let performCalls = 0
  const io = {
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => makeRealDeps(),
    perform: async (deps) => {
      performCalls++
      return performPrimaryHandoff(deps)
    },
  }
  await runScheduledHandoff(io)
  const again = await runScheduledHandoff(io) // e.g. a stray idle event
  assert.equal(performCalls, 1)
  assert.equal(again, null)
})

// ---------------------------------------------------------------------------
// (e) A failing handoff resets the latches cleanly and can be retried via a
//     fresh schedule on a later over-budget turn.
// ---------------------------------------------------------------------------

test("(e) perform failure releases the in-progress latch; pending stays consumed; never throws", async () => {
  markHandoffPending(SID)
  const result = await runScheduledHandoff({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => ({}),
    perform: async () => {
      throw new Error("boom")
    },
  })
  assert.equal(result, null, "failure surfaces as null, not a throw")
  assert.equal(isHandoffInProgress(SID), false, "in-progress latch released")
  assert.equal(hasHandoffPending(SID), false, "pending stays consumed — no hot retry loop on every idle")
})

test("(e) getDeps failure also releases the latch (no leak before perform)", async () => {
  markHandoffPending(SID)
  let performCalls = 0
  const result = await runScheduledHandoff({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: async () => {
      throw new Error("directory lookup failed")
    },
    perform: async () => {
      performCalls++
      return {}
    },
  })
  assert.equal(result, null)
  assert.equal(performCalls, 0)
  assert.equal(isHandoffInProgress(SID), false)
})

test("(e) after a failure, the next over-budget turn re-schedules and the next idle retries", async () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true)
  const io = (perform) => ({
    claim: () => claimPendingHandoff(SID),
    release: () => releaseHandoff(SID),
    getDeps: () => makeRealDeps(),
    perform,
  })
  const failed = await runScheduledHandoff(io(async () => {
    throw new Error("first attempt fails")
  }))
  assert.equal(failed, null)
  // Context is still over budget → the next primary turn's transform re-arms.
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true, "retry re-schedules after release")
  const retried = await runScheduledHandoff(io(performPrimaryHandoff))
  assert.equal(retried.newSessionID, "new-primary-1", "retry executes the handoff")
  assert.equal(isHandoffInProgress(SID), false)
})

// ---------------------------------------------------------------------------
// forgetPrimary hygiene: the success-path release clears BOTH handoff sets.
// ---------------------------------------------------------------------------

test("forgetPrimary clears pending and in-progress handoff flags for the old primary", () => {
  markHandoffPending(SID)
  claimPendingHandoff(SID) // in-progress
  markHandoffPending("other-primary") // unrelated session must survive
  forgetPrimary(SID)
  assert.equal(hasHandoffPending(SID), false)
  assert.equal(isHandoffInProgress(SID), false)
  assert.equal(hasHandoffPending("other-primary"), true, "other sessions untouched")
})
