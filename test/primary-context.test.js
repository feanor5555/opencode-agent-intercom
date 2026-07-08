// Unit tests for the primary context-token cache (Slice 3, measurement only).
//
// Verifies the three pure helpers in registry.js:
//   - recordPrimaryContext writes the map
//   - primaryContextTokens reads it back
//   - shouldRefreshPrimary flips true<->false across the TTL boundary
//
// Tests import ONLY state.js and registry.js — never hooks.js or client.js,
// because importing those starts long-lived plugin handles that keep
// `node --test` from exiting.
//
// Run: node --test test/primary-context.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { primaryCtx } from "../src/state.js"
import {
  recordPrimaryContext,
  primaryContextTokens,
  shouldRefreshPrimary,
} from "../src/registry.js"

test("recordPrimaryContext writes the map; primaryContextTokens reads it back", () => {
  primaryCtx.clear()
  assert.equal(primaryContextTokens("s-1"), undefined, "no entry yet")

  recordPrimaryContext("s-1", 12345)
  assert.equal(primaryContextTokens("s-1"), 12345, "cached tokens round-trip")

  // undefined is still a valid measurement (e.g. no completed assistant step
  // yet) — it must be cached, not coalesced into "missing".
  recordPrimaryContext("s-2", undefined)
  assert.equal(
    Object.prototype.hasOwnProperty.call(primaryCtx.get("s-2") ?? {}, "tokens"),
    true,
    "undefined tokens are still recorded as an entry",
  )
  assert.equal(primaryContextTokens("s-2"), undefined)
})

test("shouldRefreshPrimary is true when absent and false when fresh", () => {
  primaryCtx.clear()
  assert.equal(shouldRefreshPrimary("missing"), true, "absent entry must refresh")

  recordPrimaryContext("s-fresh", 100)
  // Default TTL is 3000ms; an entry written a moment ago is fresh.
  assert.equal(shouldRefreshPrimary("s-fresh"), false, "fresh entry must NOT refresh")
})

test("shouldRefreshPrimary flips true again once the entry is older than the TTL", () => {
  primaryCtx.clear()
  const sessionID = "s-stale"
  recordPrimaryContext(sessionID, 999)

  // Default 3000ms TTL — backdate to 1ms in the past: still fresh.
  primaryCtx.get(sessionID).lastFetchAt = Date.now() - 1
  assert.equal(
    shouldRefreshPrimary(sessionID),
    false,
    "1ms-old entry is within the default 3000ms TTL",
  )

  // Backdate to >3000ms in the past: stale.
  primaryCtx.get(sessionID).lastFetchAt = Date.now() - 3001
  assert.equal(
    shouldRefreshPrimary(sessionID),
    true,
    "entry older than the default TTL must refresh",
  )

  // Custom TTL: a 50ms window. 100ms-old entry is stale under it, even though
  // it would still be fresh under the default 3000ms.
  primaryCtx.get(sessionID).lastFetchAt = Date.now() - 100
  assert.equal(shouldRefreshPrimary(sessionID, 50), true, "custom TTL is respected")
  assert.equal(shouldRefreshPrimary(sessionID, 5000), false, "larger custom TTL keeps it fresh")
})

test("recordPrimaryContext updates lastFetchAt on every call", async () => {
  primaryCtx.clear()
  const sessionID = "s-bumped"
  recordPrimaryContext(sessionID, 1)
  const t1 = primaryCtx.get(sessionID).lastFetchAt
  // Yield so Date.now() can move forward — but the spec only requires
  // monotonicity at ms resolution, so a tiny await is enough.
  await new Promise((r) => setImmediate(r))
  recordPrimaryContext(sessionID, 2)
  const t2 = primaryCtx.get(sessionID).lastFetchAt
  assert.equal(primaryCtx.get(sessionID).tokens, 2, "tokens overwritten by latest call")
  assert.ok(t2 >= t1, "lastFetchAt does not go backwards")
})
