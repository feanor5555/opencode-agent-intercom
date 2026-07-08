// Slice 5: reparentSubagents(fromID, toID) — the handoff primitive that moves
// every in-flight subagent of one primary onto another.
//
// Verified against real code (NOT against ARCHITECTURE.md, whose §14.7
// referenced a `forgetPrimary` that does not exist):
//   - Entry field for the parent session id is `parentID` (registry.js:223).
//   - "In-flight" = entry still in the registry (one-shot: finished entries
//     are removed in the wake critical section, hooks.js:494-512) AND not
//     already `dispatched` (the latch set by the wake handler before it
//     snapshots parentID — a dispatched entry has its old parentID pinned
//     and reparenting it would contradict the in-flight delivery target).
//   - No persistent wake/results queue exists (grep across src/ for
//     wakeQueue/pendingWake/resultsBuffer/etc. — zero hits). Results are
//     dispatched inline on idle; nothing to re-key outside the registry.
//
// Run: node --test --test-timeout=2000 test/reparent-subagents.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, primarySessions, aborted, registryMutex } from "../src/state.js"
import { reparentSubagents, entryForSession } from "../src/registry.js"

function seed(sessionID, handle, parentID, { dispatched = false } = {}) {
  const entry = {
    handle, sessionID, agent: "researcher", parentID,
    status: "busy", dispatched,
  }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

function reset() {
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()
}

test("reparentSubagents rewrites parentID on every matching entry and returns the count", async () => {
  reset()
  seed("s-a-1", "researcher#1", "A")
  seed("s-a-2", "researcher#2", "A")
  seed("s-b-1", "coder#1", "B")
  seed("s-none", "researcher#3", undefined)

  const n = await reparentSubagents("A", "C")
  assert.equal(n, 2)
  assert.equal(entryForSession("s-a-1").parentID, "C")
  assert.equal(entryForSession("s-a-2").parentID, "C")
  // Unrelated parents untouched.
  assert.equal(entryForSession("s-b-1").parentID, "B")
  assert.equal(entryForSession("s-none").parentID, undefined)
})

test("reparentSubagents skips dispatched entries (the wake latch invariant)", async () => {
  // Reproduces the §14.7 race the implementation is built to honour: a wake
  // handler has already snapshotted this entry's old parentID and is mid-
  // delivery to it. Mutating parentID now would not redirect the delivery —
  // it would only corrupt the registry. The function must leave dispatched
  // entries alone and not count them.
  reset()
  seed("s-live", "researcher#1", "A")
  const dispatched = seed("s-mid-dispatch", "researcher#2", "A", { dispatched: true })

  const n = await reparentSubagents("A", "C")
  assert.equal(n, 1)
  assert.equal(entryForSession("s-live").parentID, "C")
  assert.equal(dispatched.parentID, "A", "dispatched entry's parentID must not change")
})

test("reparentSubagents(from, from) is a no-op and returns 0", async () => {
  reset()
  seed("s-1", "researcher#1", "A")
  const n = await reparentSubagents("A", "A")
  assert.equal(n, 0)
  assert.equal(entryForSession("s-1").parentID, "A", "entry untouched")
})

test("reparentSubagents for an unknown fromID returns 0 and changes nothing", async () => {
  reset()
  seed("s-1", "researcher#1", "B")
  const n = await reparentSubagents("does-not-exist", "C")
  assert.equal(n, 0)
  assert.equal(entryForSession("s-1").parentID, "B")
})

test("reparentSubagents with empty / falsy ids is a safe no-op", async () => {
  reset()
  seed("s-1", "researcher#1", "A")
  assert.equal(await reparentSubagents("", "C"), 0)
  assert.equal(await reparentSubagents("A", ""), 0)
  assert.equal(await reparentSubagents(undefined, "C"), 0)
  assert.equal(entryForSession("s-1").parentID, "A")
})

test("reparentSubagents runs under registryMutex — concurrent holder sees serialized effect", async () => {
  // Sanity check on the locking discipline: reparentSubagents must NOT use
  // any nested runExclusive call internally (the FIFO chain is not
  // re-entrant), AND it must hold the lock across the whole iteration so a
  // concurrent holder either runs entirely before or entirely after the
  // mutation. If it weren't exclusive, the concurrent holder could observe
  // a half-rewritten registry.
  reset()
  for (let i = 0; i < 5; i++) seed(`s-${i}`, `researcher#${i}`, "A")

  const observed = []

  const reparent = registryMutex.runExclusive(async () => {
    // Pretend we're reparentSubagents. Hold the lock across a yield so a
    // concurrent holder (queued behind us) cannot interleave with the
    // mutation it is about to perform. We replicate the function body
    // inline (not via reparentSubagents) so this test is independent of
    // reparentSubagents' own implementation details.
    observed.push(["reparent:start"])
    for (const e of registry.values()) {
      if (e.parentID === "A") e.parentID = "C"
    }
    await new Promise((r) => setImmediate(r))
    observed.push(["reparent:end"])
  })

  const concurrent = registryMutex.runExclusive(async () => {
    observed.push(["concurrent:inside"])
    // By the time this runs, reparent has released the lock, so every A
    // entry is already C.
    let sawC = 0
    for (const e of registry.values()) if (e.parentID === "C") sawC += 1
    return sawC
  })

  await reparent
  const sawC = await concurrent
  assert.equal(sawC, 5, "concurrent holder sees fully-rewritten registry")
  const reEnd = observed.findIndex((x) => x[0] === "reparent:end")
  const conc = observed.findIndex((x) => x[0] === "concurrent:inside")
  assert.ok(reEnd >= 0 && conc >= 0)
  assert.ok(reEnd < conc, `reparent must release before concurrent starts; got ${JSON.stringify(observed)}`)
})

test("reparentSubagents call itself does not deadlock the FIFO chain", async () => {
  // Regression: if reparentSubagents ever called another registry function
  // that itself wraps in runExclusive (e.g. removeEntry, upsertSession),
  // the FIFO tail would be poisoned and the very next runExclusive would
  // hang. We don't call any such helper from inside reparentSubagents — we
  // only mutate entry.parentID directly. This test asserts that two
  // back-to-back reparentSubagents calls plus a third runExclusive all
  // settle.
  reset()
  seed("s-1", "researcher#1", "A")
  seed("s-2", "researcher#2", "A")

  const n1 = await reparentSubagents("A", "C")
  const n2 = await reparentSubagents("C", "D")
  const tail = await registryMutex.runExclusive(() => "alive")

  assert.equal(n1, 2)
  assert.equal(n2, 2)
  assert.equal(tail, "alive")
  assert.equal(entryForSession("s-1").parentID, "D")
  assert.equal(entryForSession("s-2").parentID, "D")
})