// The endless-mode gates in src/registry.js: the latch (schedule / mark /
// claim / release / cancel), the spawn-freeze predicate, the quiesce predicate,
// the post-abandon cooldown and the cross-cycle progress record.
//
// Mirrors test/handoff-idle-gating.test.js's coverage of the plain handoff:
// imports ONLY registry.js / state.js + node builtins — no hooks.js, no
// client.js, no settings file.
//
// Run: node --test --test-timeout=2000 test/endless-latch.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  resetState,
  pendingEndless,
  endlessInProgress,
  pendingSpawns,
  pendingDeliveries,
  pendingHandoffs,
  aborted,
  endlessProgress,
} from "../src/state.js"
import {
  recordPrimaryContext,
  scheduleEndlessIfNeeded,
  markEndlessPending,
  hasEndlessPending,
  claimPendingEndless,
  releaseEndless,
  cancelPendingEndless,
  cancelPendingHandoff,
  markHandoffPending,
  claimPendingHandoff,
  hasHandoffPending,
  isHandoffInProgress,
  isEndlessInProgress,
  isEndlessFrozen,
  setEndlessCooldown,
  endlessCooldownActive,
  isQuiesced,
  recordEndlessCycle,
  resetEndlessProgress,
  reservePendingDelivery,
  releasePendingDelivery,
  upsertSession,
  forgetPrimary,
  beginHandoffDrain,
  ENDLESS_COOLDOWN_MS,
} from "../src/registry.js"

test.beforeEach(() => resetState())

const SID = "ses-endless-1"
const THRESHOLD = 250_000

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

test("scheduleEndlessIfNeeded: sets the latch once per crossing, not again while set", () => {
  recordPrimaryContext(SID, THRESHOLD)
  assert.equal(scheduleEndlessIfNeeded(SID, THRESHOLD), true, "the crossing arms the latch")
  assert.equal(hasEndlessPending(SID), true)
  assert.equal(
    scheduleEndlessIfNeeded(SID, THRESHOLD),
    false,
    "an over-threshold turn while the latch is set does not re-arm it",
  )
  assert.equal(pendingEndless.size, 1)
})

test("scheduleEndlessIfNeeded: below the threshold, and with the threshold disabled", () => {
  recordPrimaryContext(SID, THRESHOLD - 1)
  assert.equal(scheduleEndlessIfNeeded(SID, THRESHOLD), false)
  recordPrimaryContext(SID, THRESHOLD)
  assert.equal(scheduleEndlessIfNeeded(SID, 0), false, "a zero threshold arms nothing")
  assert.equal(hasEndlessPending(SID), false)
})

test("the latch is not set while a cycle is in progress", () => {
  recordPrimaryContext(SID, THRESHOLD)
  assert.equal(scheduleEndlessIfNeeded(SID, THRESHOLD), true)
  assert.equal(claimPendingEndless(SID), true)
  assert.equal(isEndlessInProgress(SID), true)
  assert.equal(markEndlessPending(SID), false)
  assert.equal(scheduleEndlessIfNeeded(SID, THRESHOLD), false)
})

test("claimPendingEndless: true exactly once, so a duplicate idle event cannot start a second cycle", () => {
  markEndlessPending(SID)
  assert.equal(claimPendingEndless(SID), true)
  assert.equal(claimPendingEndless(SID), false)
  assert.equal(pendingEndless.has(SID), false, "the claim consumes the latch")
  assert.equal(endlessInProgress.has(SID), true)
})

test("claimPendingEndless: false without a latch and for a falsy id", () => {
  assert.equal(claimPendingEndless(SID), false)
  assert.equal(claimPendingEndless(undefined), false)
  assert.equal(markEndlessPending(""), false)
})

test("releaseEndless clears the in-progress latch without restoring the pending one", () => {
  markEndlessPending(SID)
  claimPendingEndless(SID)
  releaseEndless(SID)
  assert.equal(isEndlessInProgress(SID), false)
  assert.equal(
    hasEndlessPending(SID),
    false,
    "the retry goes through a fresh schedule, so a failing cycle cannot hot-loop on idle",
  )
})

test("forgetPrimary drops the retired primary's latch, freeze and cooldown", () => {
  markEndlessPending(SID)
  claimPendingEndless(SID)
  setEndlessCooldown(SID)
  forgetPrimary(SID)
  assert.equal(isEndlessFrozen(SID), false)
  assert.equal(endlessCooldownActive(SID), false)
})

test("cancelPendingEndless drops an unclaimed latch but never an executing cycle", () => {
  markEndlessPending(SID)
  assert.equal(cancelPendingEndless(SID), true)
  assert.equal(isEndlessFrozen(SID), false)

  markEndlessPending(SID)
  claimPendingEndless(SID)
  assert.equal(cancelPendingEndless(SID), false, "a cycle past the save must not be half-cancelled")
  assert.equal(isEndlessInProgress(SID), true)
})

test("cancelPendingHandoff drops an unclaimed plain-handoff latch but never an executing one", () => {
  markHandoffPending(SID)
  assert.equal(cancelPendingHandoff(SID), true)
  assert.equal(hasHandoffPending(SID), false)
  assert.equal(cancelPendingHandoff(SID), false, "nothing left to cancel")
  assert.equal(cancelPendingHandoff(undefined), false)

  markHandoffPending(SID)
  claimPendingHandoff(SID)
  assert.equal(cancelPendingHandoff(SID), false, "a handoff past its claim cannot be undone")
  assert.equal(isHandoffInProgress(SID), true)
})

test("the two latches cannot both stand: cancelling the plain one leaves only the endless cycle", () => {
  // The sequence the sidebar toggle makes possible: over maxPrimaryContext
  // with the mode off, then over endlessContext with it on.
  markHandoffPending(SID)
  markEndlessPending(SID)
  assert.equal(pendingHandoffs.size, 1)
  cancelPendingHandoff(SID)
  assert.equal(hasHandoffPending(SID), false, "only one executor may fire on this primary")
  assert.equal(hasEndlessPending(SID), true)
})

// ---------------------------------------------------------------------------
// The spawn freeze predicate
// ---------------------------------------------------------------------------

test("isEndlessFrozen: true from the mark, through the claim, until the release", () => {
  assert.equal(isEndlessFrozen(SID), false)
  markEndlessPending(SID)
  assert.equal(isEndlessFrozen(SID), true, "frozen from the latch, before the cycle starts")
  claimPendingEndless(SID)
  assert.equal(isEndlessFrozen(SID), true, "still frozen while the cycle runs")
  releaseEndless(SID)
  assert.equal(isEndlessFrozen(SID), false, "the release lifts the freeze")
})

// ---------------------------------------------------------------------------
// Quiesce
// ---------------------------------------------------------------------------

test("quiesce: zero entries and zero pending spawns is quiesced", async () => {
  assert.equal(await isQuiesced(SID), true)
})

test("quiesce: one registry entry is not quiesced", async () => {
  upsertSession("ses-sub-1", { agent: "coder", parentID: SID })
  assert.equal(await isQuiesced(SID), false)
})

test("quiesce: zero entries with pendingSpawns.count === 1 is NOT quiesced", async () => {
  pendingSpawns.count = 1
  assert.equal(
    await isQuiesced(SID),
    false,
    "the reservation window is exactly what a naive registry scan reports as zero",
  )
})

test("quiesce: zero entries with a delivery in flight is NOT quiesced", async () => {
  reservePendingDelivery()
  assert.equal(
    await isQuiesced(SID),
    false,
    "the wake path removes the entry before it posts the notice — that window is not quiesce",
  )
  releasePendingDelivery()
  assert.equal(await isQuiesced(SID), true, "the delivery is over, the primary is quiesce")
})

test("the delivery counter never goes negative and resetState clears it", async () => {
  releasePendingDelivery()
  assert.equal(pendingDeliveries.count, 0)
  reservePendingDelivery()
  reservePendingDelivery()
  assert.equal(pendingDeliveries.count, 2, "the counter nests: the wake path reserves around the teardown's own")
  resetState()
  assert.equal(pendingDeliveries.count, 0)
})

test("quiesce: an entry that is dispatched but still in the registry is not quiesced", async () => {
  const entry = upsertSession("ses-sub-2", { agent: "coder", parentID: SID })
  entry.dispatched = true
  assert.equal(await isQuiesced(SID), false)
})

test("quiesce: an aborted entry is quiesced (it holds no slot)", async () => {
  upsertSession("ses-sub-3", { agent: "coder", parentID: SID })
  aborted.add("ses-sub-3")
  assert.equal(await isQuiesced(SID), true)
})

test("quiesce: an open handoff drain for this primary is not quiesced", async () => {
  beginHandoffDrain(SID)
  assert.equal(await isQuiesced(SID), false)
})

// ---------------------------------------------------------------------------
// The cooldown after an abandoned cycle
// ---------------------------------------------------------------------------

test("the cooldown suppresses the next schedule and lifts after it", () => {
  recordPrimaryContext(SID, THRESHOLD)
  setEndlessCooldown(SID)
  assert.equal(endlessCooldownActive(SID), true)
  assert.equal(
    scheduleEndlessIfNeeded(SID, THRESHOLD),
    false,
    "a primary already over the threshold must not retry on its very next turn",
  )
  // An expired cooldown is dropped on read and the next crossing schedules again.
  setEndlessCooldown(SID, -1)
  assert.equal(endlessCooldownActive(SID), false)
  assert.equal(scheduleEndlessIfNeeded(SID, THRESHOLD), true)
})

test("ENDLESS_COOLDOWN_MS is the five minutes the bound names", () => {
  assert.equal(ENDLESS_COOLDOWN_MS, 300_000)
})

// ---------------------------------------------------------------------------
// The cross-cycle progress record
// ---------------------------------------------------------------------------

test("recordEndlessCycle: the first cycle has nothing to compare against", () => {
  assert.deepEqual(recordEndlessCycle(5), { stalledCycles: 0, previousOpenTasks: null })
})

test("recordEndlessCycle: a count that does not fall raises the streak, a falling one resets it", () => {
  recordEndlessCycle(5)
  assert.equal(recordEndlessCycle(5).stalledCycles, 1)
  assert.equal(recordEndlessCycle(6).stalledCycles, 2, "a rising count is no progress either")
  assert.equal(recordEndlessCycle(4).stalledCycles, 0)
  assert.equal(endlessProgress.lastOpenTasks, 4)
})

test("resetEndlessProgress clears the streak, so re-arming the mode starts from scratch", () => {
  recordEndlessCycle(5)
  assert.equal(recordEndlessCycle(5).stalledCycles, 1)
  resetEndlessProgress()
  assert.equal(endlessProgress.lastOpenTasks, null)
  assert.equal(endlessProgress.stalledCycles, 0)
  assert.deepEqual(
    recordEndlessCycle(5),
    { stalledCycles: 0, previousOpenTasks: null },
    "the cycle after a re-arm has nothing to compare against, as the first one had",
  )
})

test("recordEndlessCycle: the progress record survives forgetPrimary (each cycle replaces the primary)", () => {
  recordEndlessCycle(7)
  forgetPrimary(SID)
  assert.equal(endlessProgress.lastOpenTasks, 7)
  assert.equal(recordEndlessCycle(7).stalledCycles, 1)
})
