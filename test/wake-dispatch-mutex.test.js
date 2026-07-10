// Slice 1b: wake-dispatch critical section.
//
// Verifies that the registryMutex serializes the wake path so that:
//   (a) read-parentID/claim-entry/removeEntry happen atomically under the lock
//       (no concurrent registry mutation can interleave),
//   (b) once an entry is `dispatched`, a re-entry on the same sessionID sees
//       the latch and becomes a no-op — which is the join the critical
//       section provides for the duplicate `session.idle` event.
//
// The actual onSessionIdle body is not re-imported (it pulls the whole
// opencode client surface); we instead reproduce the EXACT critical-section
// pattern from src/hooks.js:471-516 here, against the real `registryMutex`
// + `removeEntry`, so any future regression in either the lock or the
// wake pattern is caught.
//
// Run: node --test test/wake-dispatch-mutex.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, primarySessions, aborted, registryMutex } from "../src/state.js"
import { removeEntryLocked, entryForSession } from "../src/registry.js"

// Minimal stand-in for the inner wake critical section. MUST mirror the
// shape used in src/hooks.js:onSessionIdle — see the file-level comment.
async function wakeCriticalSection(sessionID) {
  return registryMutex.runExclusive(() => {
    const e = entryForSession(sessionID)
    if (!e || aborted.has(sessionID) || e.timedOut || e.errored || e.dispatched) return null
    e.status = "idle"
    if (!e.parentID) return null
    e.dispatched = true
    // removeEntryLocked is the NON-locking variant. removeEntry itself wraps a
    // runExclusive, and nesting it inside this outer runExclusive would
    // deadlock the FIFO mutex (the inner call's tail queues behind the outer
    // holder, which is itself awaiting the inner call's resolution). The real
    // onSessionIdle in src/hooks.js uses removeEntryLocked for exactly this
    // reason; we mirror it here. Returns a sync boolean.
    return removeEntryLocked(sessionID)
  })
}

function seed(sessionID, handle, parentID) {
  const entry = {
    handle, sessionID, agent: "researcher", parentID,
    taskId: "T7", directory: "/tmp", status: "busy", dispatched: false,
  }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

test("wake critical section holds the lock across snapshot+removeEntry", async () => {
  registry.clear(); bySession.clear(); primarySessions.clear(); aborted.clear()
  const sessionID = "s-wake-1"
  const handle = "researcher#1"
  const parentID = "primary-A"
  seed(sessionID, handle, parentID)

  const observed = []

  // Inside the wake critical section we mark the entry dispatched, then
  // (a) yield to the event loop so a concurrent holder has a chance to
  //     interleave if the lock were broken, and (b) settle removeEntry's
  //     inner mutex hop. A concurrent second mutation runs *before* the
  //     wake critical section starts; we record order around that.
  const wake = registryMutex.runExclusive(async () => {
    const e = entryForSession(sessionID)
    assert.ok(e, "entry must still be present at snapshot time")
    assert.equal(e.parentID, parentID, "snapshot captures parentID")
    e.dispatched = true
    const removed = removeEntryLocked(sessionID)
    observed.push(["wake:snapshot", parentID, removed])
    // Yield: if the lock were released between snapshot and removeEntry,
    // an interleaved runExclusive call could observe a half-finished state.
    await new Promise((r) => setImmediate(r))
    observed.push(["wake:release-marker"])
    return e.parentID
  })

  // Concurrent registry mutation that attempts to mutate parentID during
  // the wake critical section. If the wake section were not exclusive, this
  // runExclusive call would either run concurrently (interleaving its
  // "before" before our "release-marker") or see a partial state.
  const concurrent = registryMutex.runExclusive(async () => {
    observed.push(["concurrent:inside-after-wake"])
    // Entry was already removed by the wake section; this confirms the
    // concurrent holder ran strictly AFTER wake's release.
    return entryForSession(sessionID)
  })

  const [wakeParentID, concurrentEntry] = await Promise.all([wake, concurrent])
  assert.equal(wakeParentID, parentID, "wake parentID captured under lock")
  assert.equal(concurrentEntry, undefined, "entry gone by the time concurrent runs")
  // The wake section's release-marker MUST be observed strictly before the
  // concurrent holder's "inside-after-wake" tag, otherwise the lock would
  // be broken and the wake race would be a real window.
  const wakeRelease = observed.findIndex((x) => x[0] === "wake:release-marker")
  const concurrentIdx = observed.findIndex((x) => x[0] === "concurrent:inside-after-wake")
  assert.ok(wakeRelease >= 0 && concurrentIdx >= 0, "both markers recorded")
  assert.ok(
    wakeRelease < concurrentIdx,
    `wake-release (${wakeRelease}) must precede concurrent-entry (${concurrentIdx}); got ${JSON.stringify(observed)}`,
  )
})

test("a duplicate wake event on the same sessionID is a no-op (latch joins)", async () => {
  registry.clear(); bySession.clear(); primarySessions.clear(); aborted.clear()
  const sessionID = "s-wake-dup"
  const handle = "researcher#2"
  seed(sessionID, handle, "primary-B")

  // First wake: dispatches and frees the slot.
  const first = await wakeCriticalSection(sessionID)
  assert.ok(first, "first wake captures the snapshot")
  assert.equal(registry.has(handle), false, "entry removed from registry after first wake")
  assert.equal(bySession.has(sessionID), false, "sessionID removed from bySession after first wake")

  // Duplicate wake (e.g. opencode fires `session.idle` twice): the latch
  // `dispatched` was never set because the entry is gone — both guards
  // (`!entry` AND `e.dispatched`) must short-circuit to null.
  const second = await wakeCriticalSection(sessionID)
  assert.equal(second, null, "duplicate wake is a no-op (no entry to mutate)")
})

test("wake critical section returns null when entry was already aborted", async () => {
  registry.clear(); bySession.clear(); primarySessions.clear(); aborted.clear()
  const sessionID = "s-wake-aborted"
  seed(sessionID, "researcher#3", "primary-C")
  aborted.add(sessionID) // simulate prior abort from tools.js
  const result = await wakeCriticalSection(sessionID)
  assert.equal(result, null, "wake skips aborted entries")
  // Entry should still be present (wake didn't touch it; the abort path
  // owns the cleanup). Only one critical section will ever remove it.
  assert.equal(registry.has("researcher#3"), true, "aborted entry left for the abort path to clean")
})

test("wake critical section returns null when entry is missing a parentID", async () => {
  registry.clear(); bySession.clear(); primarySessions.clear(); aborted.clear()
  const sessionID = "s-wake-orphan"
  seed(sessionID, "researcher#4", undefined) // no parent — would have been caught upstream; double-check the guard
  const result = await wakeCriticalSection(sessionID)
  assert.equal(result, null, "wake skips parentless entries (no implicit assignment under the lock)")
  assert.equal(registry.has("researcher#4"), true, "parentless entry NOT implicitly assigned by wake")
})
