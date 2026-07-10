// The re-parent window of the orchestrator handoff: a subagent may finish at
// any point between handoff start and the moment the new session has received
// its kickoff. Its result must land at the NEW session — never at the dying
// old one, never nowhere. This suite drives the REAL registry drain/router
// helpers (beginHandoffDrain / bindHandoffDrainTarget / flushHandoffDrain /
// abortHandoffDrain / routeParentNotice / resolveDeliveryTarget) plus the
// REAL performPrimaryHandoff + reparentSubagents + inFlightSubagentsFor,
// with only the I/O edges faked (deliveries recorded into a timeline).
//
// Imports ONLY registry.js / state.js / handoff.js + node builtins — no
// hooks.js, no client.js (slice discipline).
//
// Run: node --test --test-timeout=2000 test/handoff-reparent.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { resetState, handoffDrains, handoffRedirects } from "../src/state.js"
import {
  upsertSession,
  entryForSession,
  removeEntry,
  inFlightSubagentsFor,
  reparentSubagents,
  forgetPrimary,
  beginHandoffDrain,
  bindHandoffDrainTarget,
  flushHandoffDrain,
  abortHandoffDrain,
  resolveDeliveryTarget,
  routeParentNotice,
  hasHandoffDrain,
} from "../src/registry.js"
import { performPrimaryHandoff } from "../src/handoff.js"

test.beforeEach(() => resetState())

const OLD = "old-primary"
const NEW = "new-primary"

// Mirrors hooks.js postParentNotice without a client: route, and record a
// non-buffered delivery into the timeline as ["notice", target, text].
function deliverOrBuffer(timeline, parentID, notice) {
  const routed = routeParentNotice(parentID, notice)
  if (!routed.buffered) timeline.push(["notice", routed.target, notice])
  return routed
}

// Full deps for the REAL performPrimaryHandoff with the REAL registry wired
// in (drain, reparent, in-flight snapshot, forgetPrimary). Deliveries —
// kickoff, flushed buffer, aborted buffer — are recorded into `timeline` so
// tests can assert both target and ORDER.
function makeRealDeps(timeline, overrides = {}) {
  return {
    primarySessionID: OLD,
    directory: "/tmp/work",
    orchestratorAgentName: "orchestrator",
    beginDrain: () => beginHandoffDrain(OLD),
    bindDrainTarget: (newID) => bindHandoffDrainTarget(OLD, newID),
    // Same shape as hooks.js buildPrimaryHandoffDeps: flush closes the drain
    // and delivers to the NEW session; abort delivers back to the OLD one.
    flushDrain: async () => {
      const flushed = flushHandoffDrain(OLD)
      if (!flushed) return 0
      for (const n of flushed.notices) timeline.push(["notice", flushed.newID, n])
      return flushed.notices.length
    },
    abortDrain: async () => {
      const drained = abortHandoffDrain(OLD)
      if (!drained) return 0
      for (const n of drained.notices) timeline.push(["notice", OLD, n])
      return drained.notices.length
    },
    getInFlightSubagents: inFlightSubagentsFor,
    getPlannedSteps: () => [],
    getLastUserGoal: () => "the goal",
    formatPrimarySummary: (s) => [s.stand, ...s.notes].join("\n"),
    writePrimarySummary: () => {},
    createSession: async () => NEW,
    promptAsync: async (sessionID, message) => {
      timeline.push(["kickoff", sessionID, message])
    },
    promptOldPrimaryForDocSummaries: async () =>
      "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a",
    reparent: reparentSubagents,
    deleteSession: async (sessionID) => {
      timeline.push(["delete", sessionID])
    },
    archiveSession: async (sessionID) => {
      timeline.push(["archive", sessionID])
    },
    forgetPrimary,
    ...overrides,
  }
}

// Simulates the wake path for a finished subagent, mirroring onSessionIdle's
// discipline: snapshot parentID, remove the entry, then route the delivery.
async function simulateSubagentFinish(timeline, sessionID, notice) {
  const entry = entryForSession(sessionID)
  const parentID = entry?.parentID
  await removeEntry(sessionID)
  return deliverOrBuffer(timeline, parentID, notice)
}

// ---- router / drain unit behavior -------------------------------------------

test("no drain, no redirect: routeParentNotice targets the parent directly", () => {
  const routed = routeParentNotice(OLD, "n1")
  assert.deepEqual(routed, { buffered: false, target: OLD })
})

test("open drain buffers a notice for the old primary", () => {
  const drain = beginHandoffDrain(OLD)
  const routed = routeParentNotice(OLD, "n1")
  assert.equal(routed.buffered, true)
  assert.deepEqual(drain.notices, ["n1"])
})

test("beginHandoffDrain is idempotent — a second begin returns the same drain", () => {
  const a = beginHandoffDrain(OLD)
  routeParentNotice(OLD, "n1")
  const b = beginHandoffDrain(OLD)
  assert.equal(a, b, "same drain object")
  assert.deepEqual(b.notices, ["n1"], "buffer survives a repeated begin")
})

test("bound drain also buffers notices addressed to the NEW session (pre-flush)", () => {
  const drain = beginHandoffDrain(OLD)
  bindHandoffDrainTarget(OLD, NEW)
  const routed = routeParentNotice(NEW, "early-result")
  assert.equal(routed.buffered, true, "a reparented entry's wake must not beat the kickoff")
  assert.deepEqual(drain.notices, ["early-result"])
})

test("flush installs the redirect and clears both drain keys — stragglers go straight to the new session", () => {
  beginHandoffDrain(OLD)
  bindHandoffDrainTarget(OLD, NEW)
  routeParentNotice(OLD, "n1")

  const flushed = flushHandoffDrain(OLD)
  assert.deepEqual(flushed, { newID: NEW, notices: ["n1"] })
  assert.equal(hasHandoffDrain(OLD), false)
  assert.equal(hasHandoffDrain(NEW), false)

  // Late delivery whose wake snapshot still carries the deleted old id.
  const straggler = routeParentNotice(OLD, "late")
  assert.deepEqual(straggler, { buffered: false, target: NEW })
  // Deliveries to the new session itself are direct.
  assert.deepEqual(routeParentNotice(NEW, "x"), { buffered: false, target: NEW })
})

test("flush without a bound target returns null and leaves the drain intact", () => {
  beginHandoffDrain(OLD)
  assert.equal(flushHandoffDrain(OLD), null)
  assert.equal(hasHandoffDrain(OLD), true)
})

test("abort clears the drain WITHOUT a redirect — the old primary stays the target", () => {
  beginHandoffDrain(OLD)
  bindHandoffDrainTarget(OLD, NEW)
  routeParentNotice(OLD, "n1")

  const drained = abortHandoffDrain(OLD)
  assert.deepEqual(drained, { notices: ["n1"] })
  assert.equal(handoffDrains.size, 0, "no drain key survives (no leak)")
  assert.equal(handoffRedirects.size, 0, "failed handoff installs no redirect")
  assert.deepEqual(routeParentNotice(OLD, "n2"), { buffered: false, target: OLD })
})

test("resolveDeliveryTarget follows redirect chains across multiple handoffs", () => {
  handoffRedirects.set("p1", "p2")
  handoffRedirects.set("p2", "p3")
  assert.equal(resolveDeliveryTarget("p1"), "p3")
  assert.equal(resolveDeliveryTarget("p2"), "p3")
  assert.equal(resolveDeliveryTarget("p3"), "p3")
})

test("resolveDeliveryTarget survives a (should-be-impossible) redirect cycle", () => {
  handoffRedirects.set("a", "b")
  handoffRedirects.set("b", "a")
  // Must terminate; the exact node is irrelevant as long as it doesn't hang.
  const out = resolveDeliveryTarget("a")
  assert.ok(out === "a" || out === "b")
})

test("a redirected target with an OPEN drain buffers (handoff of the successor in progress)", () => {
  // First handoff completed: p1 → p2. Second handoff of p2 running: drain open.
  handoffRedirects.set("p1", "p2")
  const drain = beginHandoffDrain("p2")
  const routed = routeParentNotice("p1", "n1")
  assert.equal(routed.buffered, true, "straggler for p1 lands in p2's drain")
  assert.deepEqual(drain.notices, ["n1"])
})

// ---- (b) finish DURING the handoff window → delivered to the NEW session ----

test("(b) subagent finishing during the doc-summary wait: result is buffered and delivered to the NEW session after the kickoff", async () => {
  upsertSession("sub-1", { agent: "explore", parentID: OLD, prompt: "T5: accept criteria" })
  const timeline = []
  const deps = makeRealDeps(timeline, {
    promptOldPrimaryForDocSummaries: async () => {
      // explore#1 finishes WHILE the old primary produces its summaries —
      // exactly the live-verified failure window.
      const routed = await simulateSubagentFinish(timeline, "sub-1", "explore#1 result")
      assert.equal(routed.buffered, true, "mid-handoff finish must be buffered")
      return "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a"
    },
  })

  const result = await performPrimaryHandoff(deps)
  assert.equal(result.newSessionID, NEW)

  // Delivered to the NEW session — not the old one, not dropped.
  const notices = timeline.filter((e) => e[0] === "notice")
  assert.deepEqual(notices, [["notice", NEW, "explore#1 result"]])
  assert.ok(!timeline.some((e) => e[0] === "notice" && e[1] === OLD), "nothing delivered to the old session")

  // Order: the kickoff reaches the new session BEFORE the buffered result.
  const iKickoff = timeline.findIndex((e) => e[0] === "kickoff")
  const iNotice = timeline.findIndex((e) => e[0] === "notice")
  assert.ok(iKickoff >= 0 && iNotice > iKickoff, "kickoff first, buffered result after")

  // (a) tie-in: the kickoff must NOT announce the finished subagent as
  // re-parented — the announcement reflects the post-reparent registry.
  const kickoffMsg = timeline[iKickoff][2]
  assert.ok(!kickoffMsg.includes("explore#1"), "finished subagent not announced")
  assert.equal(handoffDrains.size, 0, "drain fully closed")
})

// ---- (c) finish BEFORE the new session exists → buffered, delivered later ---

test("(c) subagent finishing before the new session exists: buffered and re-delivered once the new session is ready", async () => {
  upsertSession("sub-1", { agent: "coder", parentID: OLD, prompt: "T1: fix" })
  const timeline = []
  const deps = makeRealDeps(timeline, {
    createSession: async () => {
      // Finish lands while the new session is still being created — there is
      // no valid delivery target anywhere at this moment.
      const routed = await simulateSubagentFinish(timeline, "sub-1", "coder#1 result")
      assert.equal(routed.buffered, true)
      return NEW
    },
  })

  await performPrimaryHandoff(deps)

  const notices = timeline.filter((e) => e[0] === "notice")
  assert.deepEqual(notices, [["notice", NEW, "coder#1 result"]])
  const iKickoff = timeline.findIndex((e) => e[0] === "kickoff")
  assert.ok(timeline.findIndex((e) => e[0] === "notice") > iKickoff)
})

// ---- during / after the kickoff ---------------------------------------------

test("finish WHILE the kickoff is being sent: buffered via the new-session drain key, delivered after the kickoff", async () => {
  upsertSession("sub-1", { agent: "reviewer", parentID: OLD, prompt: "R1: review" })
  const timeline = []
  const deps = makeRealDeps(timeline, {
    promptAsync: async (sessionID, message) => {
      timeline.push(["kickoff", sessionID, message])
      // The entry was reparented to NEW before the kickoff — its wake now
      // targets the NEW session, which must still be shielded until flush.
      assert.equal(entryForSession("sub-1").parentID, NEW, "entry reparented before kickoff")
      const routed = await simulateSubagentFinish(timeline, "sub-1", "reviewer#1 result")
      assert.equal(routed.buffered, true, "kickoff-window finish is buffered, not raced")
    },
  })

  await performPrimaryHandoff(deps)

  const notices = timeline.filter((e) => e[0] === "notice")
  assert.deepEqual(notices, [["notice", NEW, "reviewer#1 result"]])
})

test("finish AFTER the handoff completed: reparented entry wakes the new session directly; a stale old-id snapshot is redirected", async () => {
  upsertSession("sub-1", { agent: "coder", parentID: OLD, prompt: "T2: build" })
  const timeline = []
  const deps = makeRealDeps(timeline)

  await performPrimaryHandoff(deps)

  // The still-running subagent survived the handoff, reparented to NEW.
  assert.equal(entryForSession("sub-1").parentID, NEW)
  const routed = await simulateSubagentFinish(timeline, "sub-1", "late result")
  assert.deepEqual(routed, { buffered: false, target: NEW })

  // A hypothetical straggler that snapshotted the OLD id pre-handoff is
  // redirected to the new session instead of hitting the deleted row.
  assert.deepEqual(routeParentNotice(OLD, "stale-snapshot result"), { buffered: false, target: NEW })
})

// ---- (d) multiple concurrent finishes ----------------------------------------

test("(d) several subagents finishing in different phases of the window: ALL results reach the new session, in arrival order", async () => {
  upsertSession("sub-1", { agent: "coder", parentID: OLD, prompt: "T1" })
  upsertSession("sub-2", { agent: "explore", parentID: OLD, prompt: "T2" })
  upsertSession("sub-3", { agent: "reviewer", parentID: OLD, prompt: "R1" })
  const timeline = []
  const deps = makeRealDeps(timeline, {
    createSession: async () => {
      await simulateSubagentFinish(timeline, "sub-1", "result-1") // before new session exists
      return NEW
    },
    promptOldPrimaryForDocSummaries: async () => {
      await simulateSubagentFinish(timeline, "sub-2", "result-2") // during the doc wait
      return "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a"
    },
    promptAsync: async (sessionID, message) => {
      timeline.push(["kickoff", sessionID, message])
      await simulateSubagentFinish(timeline, "sub-3", "result-3") // during the kickoff send
    },
  })

  const result = await performPrimaryHandoff(deps)
  // sub-1 and sub-2 finished BEFORE the reparent step (buffered, gone from
  // the registry); sub-3 was still running at reparent time and finishes
  // during the kickoff send — so exactly one entry was reparented.
  assert.equal(result.reparented, 1)

  const notices = timeline.filter((e) => e[0] === "notice")
  assert.deepEqual(notices, [
    ["notice", NEW, "result-1"],
    ["notice", NEW, "result-2"],
    ["notice", NEW, "result-3"],
  ], "all results reach the NEW session, FIFO")

  const iKickoff = timeline.findIndex((e) => e[0] === "kickoff")
  for (const [i, e] of timeline.entries()) {
    if (e[0] === "notice") assert.ok(i > iKickoff, "every buffered result lands after the kickoff")
  }
  assert.equal(handoffDrains.size, 0)
})

// ---- (e) failed handoff: buffer must not leak ---------------------------------

test("(e) kickoff failure: buffered results are handed back to the still-existing OLD session; no drain, no redirect, reparent reverted", async () => {
  upsertSession("sub-1", { agent: "explore", parentID: OLD, prompt: "T5" }) // finishes mid-window
  upsertSession("sub-2", { agent: "coder", parentID: OLD, prompt: "T6" })   // still running
  const timeline = []
  const deps = makeRealDeps(timeline, {
    promptOldPrimaryForDocSummaries: async () => {
      await simulateSubagentFinish(timeline, "sub-1", "explore result")
      return "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a"
    },
    promptAsync: async () => {
      throw new Error("kickoff transport down")
    },
  })

  await assert.rejects(() => performPrimaryHandoff(deps), /kickoff transport down/)

  // The buffered result went BACK to the old session (it survives a failed
  // handoff and remains the live orchestrator) — not lost, not leaked.
  const notices = timeline.filter((e) => e[0] === "notice")
  assert.deepEqual(notices, [["notice", OLD, "explore result"]])

  assert.equal(handoffDrains.size, 0, "no drain leaks")
  assert.equal(handoffRedirects.size, 0, "no redirect from a failed handoff")

  // The still-running subagent was reparent-REVERTED to the old primary, and
  // the orphaned new session was deleted.
  assert.equal(entryForSession("sub-2").parentID, OLD, "reparent reverted on failure")
  assert.ok(timeline.some((e) => e[0] === "delete" && e[1] === NEW), "orphan new session deleted")
  assert.ok(!timeline.some((e) => e[0] === "delete" && e[1] === OLD), "old session NOT deleted on failure")

  // Post-failure deliveries go to the old session as if no handoff happened.
  assert.deepEqual(routeParentNotice(OLD, "next"), { buffered: false, target: OLD })
})

test("(e) createSession failure with an empty buffer: abort is a clean no-op, no drain leaks", async () => {
  const timeline = []
  const deps = makeRealDeps(timeline, {
    createSession: async () => {
      throw new Error("session API 500")
    },
  })

  await assert.rejects(() => performPrimaryHandoff(deps), /session API 500/)
  assert.equal(handoffDrains.size, 0)
  assert.equal(handoffRedirects.size, 0)
  assert.equal(timeline.filter((e) => e[0] === "notice").length, 0)
})
