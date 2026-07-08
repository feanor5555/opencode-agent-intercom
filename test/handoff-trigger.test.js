// Unit tests for two PURE helpers in the handoff slice 6b-ii-a:
//   - shouldTriggerPrimaryHandoff (src/registry.js)
//   - lastUserGoal (src/handoff.js)
//
// Both helpers are intentionally side-effect free so we can test them
// without any opencode runtime, plugin wiring, or mutex. The test imports
// ONLY node builtins + these two source modules — no hooks.js, no
// client.js, no project.js, no state.js.
//
// Run: node --test --test-timeout=2000 test/handoff-trigger.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { recordPrimaryContext, shouldTriggerPrimaryHandoff } from "../src/registry.js"
import { lastUserGoal } from "../src/handoff.js"

// ---------------------------------------------------------------------------
// shouldTriggerPrimaryHandoff
//
// Each test uses a unique sessionID so cache writes don't bleed between
// tests. No global cache reset is required (and would be impossible without
// importing state.js, which the slice's import rules forbid).
// ---------------------------------------------------------------------------

test("shouldTriggerPrimaryHandoff: returns false when maxPrimaryContext is 0 (disabled)", () => {
  recordPrimaryContext("s-1", 999_999)
  assert.equal(shouldTriggerPrimaryHandoff("s-1", 0), false)
})

test("shouldTriggerPrimaryHandoff: returns false when maxPrimaryContext is negative", () => {
  recordPrimaryContext("s-2", 999_999)
  assert.equal(shouldTriggerPrimaryHandoff("s-2", -1), false)
})

test("shouldTriggerPrimaryHandoff: returns false when no tokens cached for session", () => {
  // No recordPrimaryContext call for "s-3".
  assert.equal(shouldTriggerPrimaryHandoff("s-3", 80_000), false)
})

test("shouldTriggerPrimaryHandoff: returns false when cached tokens is undefined", () => {
  // Explicitly record undefined — recordPrimaryContext allows this.
  recordPrimaryContext("s-4", undefined)
  assert.equal(shouldTriggerPrimaryHandoff("s-4", 80_000), false)
})

test("shouldTriggerPrimaryHandoff: returns true when tokens exceed threshold", () => {
  recordPrimaryContext("s-5", 100_000)
  assert.equal(shouldTriggerPrimaryHandoff("s-5", 80_000), true)
})

test("shouldTriggerPrimaryHandoff: returns false when tokens below threshold", () => {
  recordPrimaryContext("s-6", 50_000)
  assert.equal(shouldTriggerPrimaryHandoff("s-6", 80_000), false)
})

test("shouldTriggerPrimaryHandoff: boundary — tokens === threshold triggers handoff", () => {
  recordPrimaryContext("s-7", 80_000)
  assert.equal(shouldTriggerPrimaryHandoff("s-7", 80_000), true)
})

test("shouldTriggerPrimaryHandoff: disabled overrides high token count", () => {
  recordPrimaryContext("s-8", 1_000_000)
  // maxPrimaryContext=0 means "handoff disabled by user setting" — must win
  // over the most extreme token usage.
  assert.equal(shouldTriggerPrimaryHandoff("s-8", 0), false)
})

// ---------------------------------------------------------------------------
// lastUserGoal
// ---------------------------------------------------------------------------

test("lastUserGoal: returns the text of the last user message when content is a string", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second goal" },
  ]
  assert.equal(lastUserGoal(messages), "second goal")
})

test("lastUserGoal: concatenates text parts when content is an array of parts", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
    },
  ]
  assert.equal(lastUserGoal(messages), "Hello world")
})

test("lastUserGoal: concatenates string parts mixed with text-object parts", () => {
  const messages = [
    {
      role: "user",
      content: [
        "Plain string part, ",
        { type: "text", text: "then an object part." },
      ],
    },
  ]
  assert.equal(lastUserGoal(messages), "Plain string part, then an object part.")
})

test("lastUserGoal: returns '' when there is no user message in the array", () => {
  const messages = [
    { role: "assistant", content: "only assistant" },
    { role: "system", content: "boot" },
  ]
  assert.equal(lastUserGoal(messages), "")
})

test("lastUserGoal: returns '' for an empty array", () => {
  assert.equal(lastUserGoal([]), "")
})

test("lastUserGoal: returns '' for non-array input", () => {
  assert.equal(lastUserGoal(undefined), "")
  assert.equal(lastUserGoal(null), "")
  assert.equal(lastUserGoal("not an array"), "")
})

test("lastUserGoal: ignores assistant messages — scans past them to find the user", () => {
  const messages = [
    { role: "user", content: "the real goal" },
    { role: "assistant", content: "ack" },
    { role: "assistant", content: "more ack" },
  ]
  assert.equal(lastUserGoal(messages), "the real goal")
})

test("lastUserGoal: trims trailing whitespace only (preserves leading)", () => {
  const messages = [
    { role: "user", content: "  leading kept\n\n" },
  ]
  assert.equal(lastUserGoal(messages), "  leading kept")
})

test("lastUserGoal: caps long content at ~500 chars and appends …", () => {
  const long = "a".repeat(800)
  const messages = [{ role: "user", content: long }]
  const out = lastUserGoal(messages)
  // Capped at 500 chars, with the ellipsis replacing the last char.
  assert.equal(out.length, 500, "output length must be exactly 500")
  assert.ok(out.endsWith("…"), "capped output must end with the ellipsis")
  // First 499 chars are all 'a' (the truncation drops the final 'a' for the ellipsis).
  assert.equal(out.slice(0, 499), "a".repeat(499))
})

test("lastUserGoal: tolerates malformed entries (skip them, find the real one)", () => {
  const messages = [
    null,
    "not an object",
    42,
    { role: "user" /* no content — should fall through to next user */ },
    { role: "user", content: null }, // no text — should also fall through
    { role: "assistant", content: "noise" },
    { role: "user", content: "real one" },
  ]
  assert.equal(lastUserGoal(messages), "real one")
})
