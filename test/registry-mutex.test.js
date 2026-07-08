// Unit tests for the shared async mutex (registryMutex) and the
// removeEntry/forgetPrimary serialization wrapper in registry.js.
//
// Slice 1a: prove that runExclusive serializes concurrent callers, and that
// mutations made under the lock are visible atomically to subsequent holders.
//
// Run: node --test test/registry-mutex.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, primarySessions, aborted, registryMutex } from "../src/state.js"
import { removeEntry } from "../src/registry.js"

// Seed an entry the same way the registry does internally, without depending
// on any other plugin wiring (the event hook / upsertSession pathway is not
// in scope for this slice).
function seed(sessionID, handle, agent = "subagent") {
  const entry = { handle, sessionID, agent, parentID: undefined, taskId: undefined, status: "busy" }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

test("registryMutex serializes concurrent runExclusive callers (FIFO)", async () => {
  const order = []
  const n = 8
  const tasks = []
  for (let i = 0; i < n; i++) {
    tasks.push(
      registryMutex.runExclusive(async () => {
        order.push(`start:${i}`)
        // Yield to the event loop. If the lock weren't FIFO, overlapping tasks
        // would all interleave here and start markers would not be in order.
        await new Promise((r) => setImmediate(r))
        order.push(`end:${i}`)
        return i
      }),
    )
  }
  const results = await Promise.all(tasks)
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7], "each task resolves with its own value")
  for (let i = 0; i < n; i++) {
    assert.deepEqual(
      [order[2 * i], order[2 * i + 1]],
      [`start:${i}`, `end:${i}`],
      `task #${i} must complete entirely before task #${i + 1 ?? "—"} starts`,
    )
  }
})

test("registryMutex.runExclusive accepts a sync function and resolves to its return value", async () => {
  const v = await registryMutex.runExclusive(() => 42)
  assert.equal(v, 42)
})

test("registryMutex.runExclusive propagates rejections without poisoning the lock", async () => {
  // First caller rejects; subsequent callers must still get to run.
  const p1 = registryMutex.runExclusive(async () => {
    throw new Error("boom")
  })
  const p2 = registryMutex.runExclusive(() => "after")
  await assert.rejects(p1, /boom/)
  assert.equal(await p2, "after")
})

test("removeEntry mutates shared maps and is safe under concurrent calls", async () => {
  // Reset to a clean slate (state.js's resetState also clears registryMutex's
  // tail by virtue of being module-scope shared — the tail itself never
  // carries user data, just Promise bookkeeping, so no reset is required).
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()

  const sessionID = "s-concurrent"
  seed(sessionID, "researcher#1")

  // Two callers race to remove the same entry. Both are routed through
  // runExclusive (one currently runs as the lock holder, the other waits).
  // The first must see the entry and return true; the second must observe an
  // empty bySession and return false — proving the second call ran *after*
  // the first finished, never interleaved.
  const [first, second] = await Promise.all([removeEntry(sessionID), removeEntry(sessionID)])

  assert.equal(first, true, "first removeEntry sees the entry")
  assert.equal(second, false, "second removeEntry sees an already-cleared entry")
  assert.equal(registry.has("researcher#1"), false, "entry deleted from registry")
  assert.equal(bySession.has(sessionID), false, "sessionID removed from bySession")
  // No crash, no leftover state — done.
})

test("removeEntry works for an unknown sessionID and returns false", async () => {
  registry.clear()
  bySession.clear()
  const ok = await removeEntry("does-not-exist")
  assert.equal(ok, false)
})
