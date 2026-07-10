// Slice 1b: regression test for the wake-dispatch critical section.
//
// This test exercises the EXACT critical-section shape used by
// `onSessionIdle` in src/hooks.js — `runExclusive { read parentID +
// removeEntryLocked + return snapshot }`, then deliver outside the lock —
// by importing the real `registryMutex` and `removeEntryLocked` and
// reproducing that pattern here.
//
// Why hang-proof: no real network I/O, no timers longer than setImmediate,
// no nested `runExclusive` calls. `removeEntryLocked` is a sync helper
// exported from registry.js for callers already inside `runExclusive` —
// the production code (and this test) uses it instead of awaiting
// `removeEntry`, because `removeEntry` is itself a `runExclusive` and the
// FIFO mutex is NOT re-entrant (nesting would deadlock the chain).
//
// Run: node --test --test-timeout=2000 test/wake-critical-section.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { registry, bySession, primarySessions, aborted, registryMutex } from "../src/state.js"
import { removeEntryLocked, entryForSession } from "../src/registry.js"

// Reproduce the wake critical-section pattern from src/hooks.js:onSessionIdle.
// MUST mirror the shape in hooks.js:485-512 — see the file-level comment.
// Sync arrow fn, no await inside runExclusive (so the FIFO tail settles).
function wakeCriticalSection(sessionID) {
  return registryMutex.runExclusive(() => {
    const e = entryForSession(sessionID)
    if (!e || aborted.has(sessionID) || e.timedOut || e.errored || e.dispatched) return null
    e.status = "idle"
    if (!e.parentID) return null
    e.dispatched = true
    // removeEntryLocked is the synchronous body of removeEntry; using it
    // here avoids the nested-runExclusive deadlock while keeping the
    // snapshot+mutation atomic (same lock, same critical section).
    const removed = removeEntryLocked(sessionID)
    return removed ? {
      handle: e.handle,
      parentID: e.parentID,
      agent: e.agent,
    } : null
  })
}

function seed(sessionID, handle, parentID) {
  const entry = {
    handle, sessionID, agent: "researcher", parentID,
    status: "busy", dispatched: false,
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

test("wake critical section serializes snapshot+removeEntryLocked under runExclusive", async () => {
  reset()
  const sessionID = "s-1b-serialize"
  seed(sessionID, "researcher#1", "primary-A")

  const observed = []

  // The wake critical section: mark dispatched, removeEntryLocked, yield.
  const wake = registryMutex.runExclusive(async () => {
    const e = entryForSession(sessionID)
    assert.ok(e)
    assert.equal(e.parentID, "primary-A")
    e.dispatched = true
    const removed = removeEntryLocked(sessionID)
    observed.push(["wake:removed", removed])
    await new Promise((r) => setImmediate(r))
    observed.push(["wake:about-to-release"])
    return { parentID: e.parentID, removed }
  })

  // Concurrent holder. If the wake section were not exclusive, this would
  // start before "wake:about-to-release" and observe a non-undefined entry.
  const concurrent = registryMutex.runExclusive(async () => {
    observed.push(["concurrent:inside"])
    return entryForSession(sessionID)
  })

  const [wakeResult, concurrentEntry] = await Promise.all([wake, concurrent])
  assert.equal(wakeResult.removed, true)
  assert.equal(wakeResult.parentID, "primary-A")
  assert.equal(concurrentEntry, undefined, "concurrent holder saw the entry already removed")

  const releaseIdx = observed.findIndex((x) => x[0] === "wake:about-to-release")
  const concurrentIdx = observed.findIndex((x) => x[0] === "concurrent:inside")
  assert.ok(releaseIdx >= 0 && concurrentIdx >= 0)
  assert.ok(releaseIdx < concurrentIdx,
    `wake must release before concurrent starts; got ${JSON.stringify(observed)}`)
})

test("wake critical section returns null when entry is missing (no leaked Promise snapshot)", async () => {
  // Regression: before slice 1b, the critical section used the bare Promise
  // from `removeEntry(sessionID)` as a truthy value, so even when the entry
  // was gone the snapshot was returned (Promise object is truthy).
  reset()
  // No seed: bySession is empty, so removeEntryLocked returns false.
  const result = await wakeCriticalSection("s-1b-missing")
  assert.equal(result, null, "wake returns null when entry is already gone")
})

test("duplicate wake event on the same sessionID is a no-op", async () => {
  reset()
  const sessionID = "s-1b-dup"
  seed(sessionID, "researcher#2", "primary-B")

  const first = await wakeCriticalSection(sessionID)
  assert.ok(first, "first wake snapshots and dispatches")
  assert.equal(first.parentID, "primary-B")

  // Second idle event for the same session: the missing-entry guard short-circuits.
  const second = await wakeCriticalSection(sessionID)
  assert.equal(second, null)
  assert.equal(registry.has("researcher#2"), false)
  assert.equal(bySession.has(sessionID), false)
})

test("wake critical section returns null when entry is aborted", async () => {
  reset()
  seed("s-1b-aborted", "researcher#3", "primary-C")
  aborted.add("s-1b-aborted")

  const result = await wakeCriticalSection("s-1b-aborted")
  assert.equal(result, null, "aborted entries are not dispatched by wake")
  // Wake must not remove an aborted entry — the abort path owns cleanup.
  assert.equal(registry.has("researcher#3"), true)
})

test("every removeEntry() call in src/ is awaited", async () => {
  // Static guard against future regressions: scan src/ for `removeEntry(`
  // and verify each call is prefixed with `await` (or is the function
  // definition itself). Note: `removeEntryLocked(` is the variant for
  // callers already inside runExclusive — it's sync, so we don't audit
  // it here (its sole caller in src/ is the wake critical section).
  const { readFileSync, readdirSync } = await import("node:fs")
  const path = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src")
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".js"))
  const violations = []

  for (const f of files) {
    const txt = readFileSync(path.join(srcDir, f), "utf8")
    const lines = txt.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      // Skip pure comment lines.
      if (/^\s*(\/\/|\*)/.test(raw)) continue
      // Strip trailing line comments for the regex check.
      const code = raw.replace(/\/\/.*$/, "")
      const idx = code.indexOf("removeEntry(")
      if (idx < 0) continue
      // Look back up to 20 chars from `removeEntry(` to find `await`.
      const before = code.slice(Math.max(0, idx - 20), idx)
      if (/\bawait\s+$/.test(before)) continue
      // Allowed: the function definition `export async function removeEntry`.
      if (/export\s+(async\s+)?function\s+removeEntry\b/.test(code)) continue
      violations.push(`${f}:${i + 1}: ${raw.trim()}`)
    }
  }

  assert.deepEqual(violations, [],
    `Every removeEntry() call must be awaited; un-awaited calls found:\n${violations.join("\n")}`)
})