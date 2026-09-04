// The one eviction rule the plugin's short-lived per-session memories share:
// `trimByAgeAndSize` in src/state.js, and the two stores bounded through it —
// the deleted-session cascade memory (hooks.js) and the quiescence marks
// (teardown.js).
//
// Run: node --test --test-timeout=5000 test/bounded-session-memory.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { trimByAgeAndSize, quiescedSessions, resetState } from "../src/state.js"
import { QUIESCE_MARK_MEMORY, QUIESCE_MARK_TTL_MS, signalSessionIdle } from "../src/teardown.js"

test.beforeEach(() => {
  resetState()
})

test("trimByAgeAndSize drops the oldest records until the store is within its cap", () => {
  const store = new Map()
  const now = 1_000_000
  for (let n = 0; n < 10; n++) store.set(`ses_${n}`, now - (10 - n))

  trimByAgeAndSize(store, now, { max: 4 })

  assert.equal(store.size, 4)
  assert.deepEqual([...store.keys()], ["ses_6", "ses_7", "ses_8", "ses_9"])
})

test("trimByAgeAndSize bounds by size alone where no ttl is given", () => {
  const store = new Map()
  const now = 1_000_000
  // Every record is ancient. Without a ttl that is not a reason to drop one:
  // the deleted-session memory only has to outlive a delete cascade and keeps
  // its whole cap however old the ids in it are.
  store.set("ses_a", 0)
  store.set("ses_b", 0)

  trimByAgeAndSize(store, now, { max: 2 })

  assert.equal(store.size, 2, "size alone bounds it, so nothing goes")
})

test("trimByAgeAndSize drops what is past its ttl even inside the cap", () => {
  const store = new Map()
  const now = 1_000_000
  store.set("ses_stale", now - 5_000)
  store.set("ses_fresh", now - 10)

  trimByAgeAndSize(store, now, { max: 100, ttlMs: 1_000 })

  assert.deepEqual([...store.keys()], ["ses_fresh"])
})

test("trimByAgeAndSize stops at the first record inside both bounds", () => {
  // The walk starts at the oldest and every record after the stopping point is
  // younger still, so a store already within both bounds is not walked to its
  // end — and an empty one is not walked at all.
  const store = new Map()
  const now = 1_000_000
  store.set("ses_a", now - 10)
  store.set("ses_b", now - 5)

  trimByAgeAndSize(store, now, { max: 2, ttlMs: 1_000 })
  assert.equal(store.size, 2)

  const empty = new Map()
  trimByAgeAndSize(empty, now, { max: 0, ttlMs: 0 })
  assert.equal(empty.size, 0)
})

test("the quiescence marks stay within the cap as endings come in", () => {
  for (let n = 0; n < QUIESCE_MARK_MEMORY + 20; n++) signalSessionIdle(`ses_q${n}`)

  assert.equal(quiescedSessions.size, QUIESCE_MARK_MEMORY)
  assert.equal(quiescedSessions.has("ses_q0"), false, "the oldest mark is the one that went")
  assert.equal(
    quiescedSessions.has(`ses_q${QUIESCE_MARK_MEMORY + 19}`),
    true,
    "the newest mark is kept",
  )
})

test("a quiescence mark past its ttl is dropped by the next write", () => {
  quiescedSessions.set("ses_stale", Date.now() - QUIESCE_MARK_TTL_MS - 1_000)
  signalSessionIdle("ses_fresh")

  assert.equal(quiescedSessions.has("ses_stale"), false)
  assert.equal(quiescedSessions.has("ses_fresh"), true)
})
