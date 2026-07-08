// Unit tests for the per-agent handle counter in registry.js (T6).
//
// The counter is monotonic w.r.t. LIVE handles, but a freed handle whose
// number is the current max is decremented back so an aborted subagent does
// not inflate the counter for future spawns. The two policies in tension:
//
//   - "Monotonic-safe (no collisions with live handles)" — the counter
//     must never go below the highest in-use number, so a fresh allocation
//     can never collide with one still in flight.
//   - "Don't let aborts inflate the counter" — the typical spawn→abort
//     lifecycle should not bump the counter to #2 if the user only ran one
//     researcher subagent.
//
// These tests pin both behaviors and the boundary between them.
//
// Run: node --test test/handle-counter.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, primarySessions, aborted, counters } from "../src/state.js"
import { nextHandle, removeEntry, removeEntryLocked, upsertSession } from "../src/registry.js"

function reset() {
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()
  counters.clear()
}

// Seed an entry the way createEntry does (without pulling in other wiring).
function seed(sessionID, handle, agent) {
  const entry = { handle, sessionID, agent, parentID: undefined, taskId: undefined, status: "busy" }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

// ===========================================================================
// nextHandle: monotonic allocation across consecutive calls
// ===========================================================================

test("nextHandle allocates 1, 2, 3, ... for a fresh agent", () => {
  reset()
  assert.equal(nextHandle("researcher"), "researcher#1")
  assert.equal(nextHandle("researcher"), "researcher#2")
  assert.equal(nextHandle("researcher"), "researcher#3")
  assert.equal(counters.get("researcher"), 3)
})

test("nextHandle maintains separate counters per agent", () => {
  reset()
  assert.equal(nextHandle("researcher"), "researcher#1")
  assert.equal(nextHandle("coder"), "coder#1")
  assert.equal(nextHandle("researcher"), "researcher#2")
  assert.equal(nextHandle("coder"), "coder#2")
  assert.equal(nextHandle("planner"), "planner#1")
  assert.equal(counters.get("researcher"), 2)
  assert.equal(counters.get("coder"), 2)
  assert.equal(counters.get("planner"), 1)
})

// ===========================================================================
// removeEntry reclaims the handle number — the bug T6 fixes
// ===========================================================================

test("aborted single subagent: next spawn reuses the same handle number (counter not inflated)", async () => {
  // The headline T6 case: spawn researcher#1, abort it, spawn again — the
  // second one must be researcher#1 again, NOT researcher#2. Before the fix
  // the counter was monotonically-only-increasing and the second spawn
  // became researcher#2, which lied about the user's history.
  reset()
  assert.equal(nextHandle("researcher"), "researcher#1")
  seed("s-1", "researcher#1", "researcher")
  assert.equal(await removeEntry("s-1"), true)
  assert.equal(nextHandle("researcher"), "researcher#1", "counter reused the freed number")
  assert.equal(counters.get("researcher"), 1)
})

test("removeEntry after a normal nextHandle sequence returns the counter to its prior value", async () => {
  reset()
  // Three spawns → counter at 3; abort the last one (which is the current
  // max) → counter drops to 2; the next spawn should be #3 again.
  nextHandle("researcher") // #1
  seed("s-1", "researcher#1", "researcher")
  nextHandle("researcher") // #2
  seed("s-2", "researcher#2", "researcher")
  nextHandle("researcher") // #3
  seed("s-3", "researcher#3", "researcher")
  assert.equal(counters.get("researcher"), 3)

  assert.equal(await removeEntry("s-3"), true)
  assert.equal(counters.get("researcher"), 2, "max-handle abort decrements the counter")

  assert.equal(nextHandle("researcher"), "researcher#3", "next spawn refills the freed slot")
  assert.equal(counters.get("researcher"), 3)
})

// ===========================================================================
// Boundary: when NOT to decrement (in-flight higher-numbered handle)
// ===========================================================================

test("aborting a non-max handle leaves the counter alone (so we don't collide with live in-flight handles)", async () => {
  // Live: researcher#1 and researcher#2. Abort #1. Counter must stay at 2
  // (NOT drop to 0, which would skip and force #3). The next spawn should
  // be #3, NOT #1 — researcher#2 is still live, and the "decrement-when-max"
  // policy says: we don't know that #1 is actually free, because something
  // else could re-register a #1 from a stale code path; keeping the counter
  // at 2 (== max live handle) is the safe invariant.
  reset()
  seed("s-1", "researcher#1", "researcher")
  seed("s-2", "researcher#2", "researcher")
  // Seed counter to match the actual live max (the seed() helper above
  // bypasses nextHandle, so we have to set the counter explicitly).
  counters.set("researcher", 2)

  assert.equal(await removeEntry("s-1"), true)
  assert.equal(counters.get("researcher"), 2, "counter did NOT decrement below the live max")

  // Next spawn gets a fresh number; reusing #1 is impossible by design.
  assert.equal(nextHandle("researcher"), "researcher#3")
  assert.equal(counters.get("researcher"), 3)
})

test("aborting a non-max handle then the max one reclaims the slot — sequential cleanup works", async () => {
  // Live: #1 and #2. Abort #1 first (counter stays at 2). Then abort #2
  // (counter drops to 1). Then spawn → researcher#2 (reuses the just-freed
  // max slot). Then spawn → researcher#3.
  reset()
  seed("s-1", "researcher#1", "researcher")
  seed("s-2", "researcher#2", "researcher")
  counters.set("researcher", 2)

  assert.equal(await removeEntry("s-1"), true)
  assert.equal(counters.get("researcher"), 2)
  assert.equal(await removeEntry("s-2"), true)
  assert.equal(counters.get("researcher"), 1, "after aborting the max, counter decrements")

  assert.equal(nextHandle("researcher"), "researcher#2", "next spawn reuses the freed max slot")
  assert.equal(nextHandle("researcher"), "researcher#3")
  assert.equal(counters.get("researcher"), 3)
})

// ===========================================================================
// Same invariants through removeEntryLocked (the wake critical-section path)
// ===========================================================================

test("removeEntryLocked reclaims the handle number the same way removeEntry does", () => {
  // removeEntryLocked is called from the wake critical section in
  // onSessionIdle — it must apply the same counter policy or the onSessionIdle
  // path would still inflate the counter for finished subagents.
  reset()
  nextHandle("researcher") // #1
  seed("s-1", "researcher#1", "researcher")
  assert.equal(counters.get("researcher"), 1)

  assert.equal(removeEntryLocked("s-1"), true)
  assert.equal(counters.get("researcher"), 0, "removeEntryLocked decrements the max-handle counter")
  assert.equal(nextHandle("researcher"), "researcher#1")
})

test("removeEntryLocked does NOT decrement below the live max", () => {
  reset()
  seed("s-1", "researcher#1", "researcher")
  seed("s-2", "researcher#2", "researcher")
  counters.set("researcher", 2)

  assert.equal(removeEntryLocked("s-1"), true)
  assert.equal(counters.get("researcher"), 2)
})

// ===========================================================================
// Edge cases
// ===========================================================================

test("removeEntry on an unknown sessionID is a no-op and does not touch the counter", async () => {
  reset()
  counters.set("researcher", 5)
  assert.equal(await removeEntry("does-not-exist"), false)
  assert.equal(counters.get("researcher"), 5, "unknown sessionID must not change the counter")
})

test("releaseHandle ignores malformed handle numbers (defense in depth)", async () => {
  // The handle format is always `${agent}#${n}`, so this is purely a
  // safety-net assertion: even if something weird ever landed in the
  // registry (corrupted state, manual test harness), the counter must not
  // be driven to NaN or a negative value.
  reset()
  counters.set("researcher", 5)

  // Manually inject a malformed entry: handle has no '#' suffix.
  registry.set("garbage", { handle: "garbage", sessionID: "sg", agent: "researcher" })
  bySession.set("sg", "garbage")

  assert.equal(await removeEntry("sg"), true)
  assert.equal(counters.get("researcher"), 5, "counter unchanged when handle has no number")
})

// ===========================================================================
// End-to-end through the public surface (upsertSession → removeEntry)
// ===========================================================================

test("upsertSession + removeEntry cycle keeps the counter honest across many aborts", async () => {
  // Mimic the real call path used by the event hook / abort tool: each
  // "spawn" is upsertSession (which calls nextHandle under the hood), each
  // "abort" is removeEntry. Run the cycle several times and assert the
  // counter is bounded by the number of currently-live subagents.
  reset()

  async function spawn() {
    // sessionID must be unique; reuse a counter for the test.
    return await upsertSession("s-" + Math.random().toString(36).slice(2), {
      agent: "researcher",
      prompt: "x",
      parentID: "P",
    })
  }

  // Cycle 1: spawn one, abort it.
  let e = await spawn()
  assert.equal(e.handle, "researcher#1")
  assert.equal(await removeEntry(e.sessionID), true)
  assert.equal(counters.get("researcher"), 0, "single spawn+abort drops counter back to 0")

  // Cycle 2: spawn three, abort them in reverse order.
  const a = await spawn()
  const b = await spawn()
  const c = await spawn()
  assert.equal(a.handle, "researcher#1")
  assert.equal(b.handle, "researcher#2")
  assert.equal(c.handle, "researcher#3")
  assert.equal(counters.get("researcher"), 3)
  // Abort in reverse: each one is the max, so each one decrements.
  assert.equal(await removeEntry(c.sessionID), true)
  assert.equal(counters.get("researcher"), 2)
  assert.equal(await removeEntry(b.sessionID), true)
  assert.equal(counters.get("researcher"), 1)
  assert.equal(await removeEntry(a.sessionID), true)
  assert.equal(counters.get("researcher"), 0, "all cleaned up; counter back to 0")

  // Cycle 3: spawn again, assert it gets #1 (NOT #4).
  const d = await spawn()
  assert.equal(d.handle, "researcher#1", "after full cleanup, counter resets to fresh")
  assert.equal(counters.get("researcher"), 1)
})
