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
import { lastUserGoal, LAST_USER_GOAL_MAX } from "../src/handoff.js"
import { intercomTextPart } from "../src/pluginmsg.js"

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

test("lastUserGoal: caps content longer than LAST_USER_GOAL_MAX and appends …", () => {
  const long = "a".repeat(LAST_USER_GOAL_MAX + 300)
  const messages = [{ role: "user", content: long }]
  const out = lastUserGoal(messages)
  // Capped at LAST_USER_GOAL_MAX chars, with the ellipsis replacing the last char.
  assert.equal(out.length, LAST_USER_GOAL_MAX, `output length must be exactly ${LAST_USER_GOAL_MAX}`)
  assert.ok(out.endsWith("…"), "capped output must end with the ellipsis")
  // Everything before the ellipsis is the original text, truncated.
  assert.equal(out.slice(0, LAST_USER_GOAL_MAX - 1), "a".repeat(LAST_USER_GOAL_MAX - 1))
})

test("lastUserGoal: the cap is 1500 (raised from 500)", () => {
  // The cap is a CEILING, not a target — see the next two tests. Pinning the
  // value here keeps an accidental revert to the old 500 from going unnoticed.
  assert.equal(LAST_USER_GOAL_MAX, 1500)
})

test("lastUserGoal: content between the old cap (500) and the new one passes through unchanged", () => {
  // Regression guard against the old 500-char cap: an 800-char goal used to
  // be truncated; now it must survive verbatim, with NO ellipsis.
  const goal = "b".repeat(800)
  const messages = [{ role: "user", content: goal }]
  const out = lastUserGoal(messages)
  assert.equal(out, goal, "800-char goal must pass through unchanged")
  assert.ok(!out.endsWith("…"), "un-truncated goal must not carry an ellipsis")
})

test("lastUserGoal: content of exactly LAST_USER_GOAL_MAX chars is NOT truncated", () => {
  const goal = "c".repeat(LAST_USER_GOAL_MAX)
  const messages = [{ role: "user", content: goal }]
  const out = lastUserGoal(messages)
  assert.equal(out, goal, "exact-cap goal must pass through unchanged")
  assert.ok(!out.endsWith("…"), "exact-cap goal must not carry an ellipsis")
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

// ---------------------------------------------------------------------------
// lastUserGoal — opencode session.messages shape ({info: {role}, parts})
//
// In production this is the ONLY shape the function sees: the
// system.transform hook input carries NO `messages` field (SDK:
// TransformSystemInput = { sessionID?, model }), so hooks.js fetches the old
// primary's history via `client.session.messages`, which returns
// Array<{info, parts}> entries. Live-verified bug: with the old
// `input.messages` wiring the goal was empty in EVERY real handoff.
// ---------------------------------------------------------------------------

test("lastUserGoal: reads the last user message from opencode session-shaped entries", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "first goal" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "ack" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: "the real goal" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "final answer" }] },
  ]
  assert.equal(lastUserGoal(messages), "the real goal")
})

test("lastUserGoal: concatenates multiple text parts of a session-shaped user message", () => {
  const messages = [
    {
      info: { role: "user" },
      parts: [
        { type: "text", text: "part one, " },
        { type: "text", text: "part two" },
      ],
    },
  ]
  assert.equal(lastUserGoal(messages), "part one, part two")
})

test("lastUserGoal: skips non-text parts (file/tool) even when they carry a text field", () => {
  const messages = [
    {
      info: { role: "user" },
      parts: [
        { type: "file", text: "should-not-appear" },
        { type: "text", text: "only the prose" },
        { type: "tool", text: "also-not" },
      ],
    },
  ]
  assert.equal(lastUserGoal(messages), "only the prose")
})

test("lastUserGoal: session-shaped user message with no text parts falls through to the previous user message", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "earlier goal" }] },
    { info: { role: "user" }, parts: [{ type: "file", filename: "shot.png" }] },
  ]
  assert.equal(lastUserGoal(messages), "earlier goal")
})

test("lastUserGoal: cap semantics apply to session-shaped messages too (ceiling, ellipsis only on real truncation)", () => {
  const long = "d".repeat(LAST_USER_GOAL_MAX + 100)
  const capped = lastUserGoal([
    { info: { role: "user" }, parts: [{ type: "text", text: long }] },
  ])
  assert.equal(capped.length, LAST_USER_GOAL_MAX)
  assert.ok(capped.endsWith("…"))

  const exact = "e".repeat(LAST_USER_GOAL_MAX)
  const out = lastUserGoal([
    { info: { role: "user" }, parts: [{ type: "text", text: exact }] },
  ])
  assert.equal(out, exact, "exact-cap session-shaped goal passes through unchanged")
})

test("lastUserGoal: mixed arrays (chat-completion + session shape) still find the newest user text", () => {
  const messages = [
    { role: "user", content: "old chat-completion style goal" },
    { info: { role: "user" }, parts: [{ type: "text", text: "newest session-style goal" }] },
  ]
  assert.equal(lastUserGoal(messages), "newest session-style goal")
})

// ---------------------------------------------------------------------------
// lastUserGoal — plugin-generated messages are NOT the user's goal
//
// Every notice the plugin posts (subagent completion / error / timeout /
// denial-loop, buffered drain flushes), the handoff kickoff and the
// DOC_SUMMARY prompt travel as user-role messages via promptAsync.
// Live-verified failure (live-test 3, kickoff #1): the goal scan picked a
// subagent wake notice as `Letztes Ziel:`. Detection: the part-metadata
// marker client.js sets centrally (intercomTextPart), plus a text-prefix
// backstop for pre-marker / TUI-version-skew messages.
// ---------------------------------------------------------------------------

// Builds a session-shaped plugin message the way production does: the part
// comes from intercomTextPart (client.js sends exactly this shape).
function pluginMessage(text) {
  return { info: { role: "user" }, parts: [intercomTextPart(text)] }
}

function userMessage(text) {
  return { info: { role: "user" }, parts: [{ type: "text", text }] }
}

const NOTICE_TEXT =
  '🔔 agent-intercom: your subagent "explore#2" (explore) has finished and been destroyed.\n' +
  "Its result:\nAll commands executed."

test("lastUserGoal: (a) a marked wake notice as the LAST message is skipped — the real user message before it wins", () => {
  const messages = [
    userMessage("investigate the wake mechanics"),
    { info: { role: "assistant" }, parts: [{ type: "text", text: "delegating…" }] },
    pluginMessage(NOTICE_TEXT),
  ]
  assert.equal(lastUserGoal(messages), "investigate the wake mechanics")
})

test("lastUserGoal: (b) several marked notices in a row are ALL skipped", () => {
  const messages = [
    userMessage("the actual goal"),
    pluginMessage(NOTICE_TEXT),
    pluginMessage('🔔 agent-intercom: subagent "coder#1" (coder, session ses_x) timed out after 94s of inactivity (limit 90s) — slot freed.'),
    pluginMessage('⚠️ agent-intercom: subagent "coder#1" (coder) is OVER its context budget'),
    pluginMessage('🔔 agent-intercom: subagent "coder#1" (coder, session ses_x) failed: APIError. Slot freed.'),
  ]
  assert.equal(lastUserGoal(messages), "the actual goal")
})

test("lastUserGoal: (c) ONLY plugin messages in the history — returns '' without crashing", () => {
  const messages = [
    pluginMessage("## Stand / Aktueller Zustand\n\nLetztes Ziel: …"),
    pluginMessage(NOTICE_TEXT),
    { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
  ]
  assert.equal(lastUserGoal(messages), "")
})

test("lastUserGoal: (d) the kickoff of an EARLIER handoff is not adopted as the goal by the next one", () => {
  // Second-handoff scenario (three back-to-back handoffs are live-observed):
  // the new session's history starts with the previous handoff's kickoff —
  // a plugin message sent through promptSession, hence marked.
  const kickoff =
    "## Stand / Aktueller Zustand\n\nLetztes Ziel: ship the feature\n\n" +
    "## Zu beachtende Punkte\n\n- Diese Subagents liefern jetzt an diese Session:\n\n" +
    "## Geplante Schritte\n\n- step A\n\n## PROJECT.md — index"
  const messages = [
    pluginMessage(kickoff),
    { info: { role: "assistant" }, parts: [{ type: "text", text: "understood, taking over" }] },
    userMessage("continue with T5"),
    pluginMessage(NOTICE_TEXT),
  ]
  assert.equal(lastUserGoal(messages), "continue with T5")
})

test("lastUserGoal: (d2) history of kickoff + notices only (no real user turn yet) — ''", () => {
  const kickoff = "## Stand / Aktueller Zustand\n\nLetztes Ziel: earlier goal"
  const messages = [
    pluginMessage(kickoff),
    { info: { role: "assistant" }, parts: [{ type: "text", text: "taking over" }] },
    pluginMessage(NOTICE_TEXT),
  ]
  assert.equal(lastUserGoal(messages), "")
})

test("lastUserGoal: (e) cap semantics unchanged with plugin messages present — ceiling, ellipsis only on real truncation", () => {
  const long = "f".repeat(LAST_USER_GOAL_MAX + 50)
  const capped = lastUserGoal([
    { info: { role: "user" }, parts: [{ type: "text", text: long }] },
    pluginMessage(NOTICE_TEXT),
  ])
  assert.equal(capped.length, LAST_USER_GOAL_MAX)
  assert.ok(capped.endsWith("…"))

  const exact = "g".repeat(LAST_USER_GOAL_MAX)
  const out = lastUserGoal([
    userMessage(exact),
    pluginMessage(NOTICE_TEXT),
  ])
  assert.equal(out, exact, "exact-cap goal passes through unchanged despite trailing notice")
  assert.ok(!out.endsWith("…"))
})

test("lastUserGoal: BACKSTOP — unmarked messages with the plugin's verbatim leading strings are skipped (pre-marker history, older TUI)", () => {
  const messages = [
    userMessage("real goal before the legacy notices"),
    // No metadata on any of these — as posted by a pre-marker plugin build
    // or the published TUI package.
    userMessage('🔔 agent-intercom: an error occurred with your subagent "coder#1" (coder) — it was terminated and did not finish.'),
    userMessage('⚠️ agent-intercom: subagent "coder#1" (coder) is OVER its context budget'),
    userMessage("## Stand / Aktueller Zustand\n\nLetztes Ziel: old kickoff"),
    userMessage("You are about to be replaced by a fresh orchestrator session. Before that, emit ONE final plain-text reply…"),
  ]
  assert.equal(lastUserGoal(messages), "real goal before the legacy notices")
})

test("lastUserGoal: BACKSTOP matches only LEADING strings — a user merely QUOTING a notice is still the goal", () => {
  const quoting = 'why did I get "🔔 agent-intercom: your subagent …" twice?'
  assert.equal(lastUserGoal([userMessage(quoting)]), quoting)
})
