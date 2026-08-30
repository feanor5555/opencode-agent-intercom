// Unit tests for the state behind the sidebar's subagent rows
// (tui/src/subagent-store.ts): when a finished row is dropped, when it is held
// as `retained`, and when a held row goes again.
//
// The one rule the whole file turns on: a row is held because the PLUGIN says
// so, never because the panel worked it out. The plugin publishes the state on
// the subagent session's title — `[retained:<epoch ms the window ends>]` after
// its own marker — and `holdFinishedRow` reads that and nothing else. So:
//
//   - retention off (maxRetainedSubagents = 0, the shipped default) — no
//     session is ever stamped, so the panel behaves exactly as it did before
//     retention existed: a finished subagent disappears the moment its run
//     ends;
//   - a retention the plugin REFUSED — over the reuse ceiling, a `Blocked:`
//     reply, a nested child, an error ending, or retention switched on in the
//     settings file after the plugin process latched it off — carries no stamp
//     and is therefore never painted as held, not for one poll and not for a
//     moment;
//   - a retention the plugin granted carries the window it granted, and the
//     row counts down to that published moment rather than to one the panel
//     measured for itself.
//
// The countdown is pinned against the plugin's own retainedMinutesLeft
// (src/format.js), which is the figure `list` and the per-turn snapshot show
// the orchestrator — the sidebar is the third surface of the same state and has
// to name the same number.
//
// Run: node --test test/tui-subagent-store.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { retainedMinutesLeft as pluginMinutesLeft } from "../src/format.js"
import { retentionStampedTitle } from "../src/teardown.js"
import {
  ABORT_CONFIRM_TEXT,
  DROP_CONFIRM_TEXT,
} from "../tui/src/abort-arming.ts"
import {
  RETENTION_EXPIRY_GRACE_MS,
  holdFinishedRow,
  isRetained,
  reapRetained,
  retainedMinutesLeft,
  retainedMsLeft,
  retainedRowNote,
  retentionEnabled,
  retentionExpired,
  statusMarker,
  statusRank,
} from "../tui/src/subagent-store.ts"

const TTL_MS = 3600000
const RETENTION_OFF = { maxRetainedSubagents: 0, retainedSubagentTtlMs: TTL_MS }
const RETENTION_ON = { maxRetainedSubagents: 3, retainedSubagentTtlMs: TTL_MS }

const NOW = 1_700_000_000_000
// The window the plugin publishes for a subagent it retained at NOW.
const UNTIL = NOW + TTL_MS

const WORK_TITLE = "Searching for latest Spring API"
// What a held session's title looks like, composed by the plugin's own
// function — the two halves cannot drift apart on the format.
const HELD_TITLE = retentionStampedTitle(WORK_TITLE, UNTIL)
// What every other subagent session's title looks like: marked as this
// plugin's, and saying nothing about a retention, because there is none.
const PLAIN_TITLE = retentionStampedTitle(WORK_TITLE, 0)

function row(over = {}) {
  return {
    sessionID: "ses_child",
    parentID: "ses_primary",
    agent: "researcher",
    handle: "researcher#1",
    title: HELD_TITLE,
    status: "idle",
    wasBusy: true,
    createdAt: NOW - 30000,
    updatedAt: NOW,
    ctxTokens: 12000,
    lastTokenFetch: NOW,
    ...over,
  }
}

// A row already held on the published window, as a poll would have left it.
function heldRow(over = {}) {
  const held = holdFinishedRow(row(over), { aborted: false, title: HELD_TITLE }, NOW)
  assert.ok(held, "fixture: the stamped title must hold")
  return held
}

// ---------------------------------------------------------------- retention off

test("retention off: the feature is not enabled at the shipped default", () => {
  assert.equal(retentionEnabled(RETENTION_OFF), false)
  assert.equal(retentionEnabled(RETENTION_ON), true)
})

test("retention off: a finished subagent is dropped, exactly as before", () => {
  // Nothing retains, so nothing stamps a title, so nothing is held.
  const held = holdFinishedRow(row({ title: PLAIN_TITLE }), { aborted: false, title: PLAIN_TITLE }, NOW)
  assert.equal(held, undefined)
})

test("retention off: no row is ever held, so no row is ever reaped", () => {
  const rows = [row({ status: "idle" }), row({ sessionID: "ses_other", status: "busy" })]
  assert.deepEqual(reapRetained(rows, { seen: new Set() }, NOW), [])
})

// ------------------------------------------- the refusals the panel is told of

test("a refused retention is never held, whatever the settings file says", () => {
  // Every plugin-side refusal looks the same from here, and that is the point:
  // over the reuse ceiling, a `Blocked:` reply, a nested child, an error
  // ending, or a process that latched retention off at load. The session is
  // being deleted and its title was never stamped — so the row goes at once
  // instead of being claimed as held until a later poll withdraws the claim.
  for (const title of [PLAIN_TITLE, "researcher: plain", "", undefined]) {
    assert.equal(
      holdFinishedRow(row({ title: PLAIN_TITLE }), { aborted: false, title }, NOW),
      undefined,
      `an unstamped title must not hold: ${JSON.stringify(title)}`,
    )
  }
})

test("a stamp on a title that is not this plugin's is not a retention", () => {
  // The marker is what attributes a session to this plugin. Without it the
  // text is a user's own title that happens to read like a stamp.
  assert.equal(
    holdFinishedRow(row(), { aborted: false, title: `[retained:${UNTIL}] hand-typed` }, NOW),
    undefined,
  )
})

// ----------------------------------------------------------------- retention on

test("retention on: a subagent the plugin published is held on its window", () => {
  const held = holdFinishedRow(row(), { aborted: false, title: HELD_TITLE }, NOW)
  assert.ok(held)
  assert.equal(held.status, "retained")
  assert.equal(isRetained(held), true)
  assert.equal(held.retainedUntil, UNTIL, "the plugin's window, not one measured here")
  // Everything the row already carried survives the transition.
  assert.equal(held.handle, "researcher#1")
  assert.equal(held.agent, "researcher")
  assert.equal(held.wasBusy, true)
  assert.equal(held.ctxTokens, 12000)
})

test("retention on: holding a held row again does not move its window", () => {
  const held = heldRow()
  const again = holdFinishedRow(held, { aborted: false, title: HELD_TITLE }, NOW + 120000)
  assert.ok(again)
  assert.equal(again.retainedUntil, UNTIL, "the window is read, never restarted")
})

test("retention on: an aborted subagent is never held", () => {
  assert.equal(holdFinishedRow(row(), { aborted: true, title: HELD_TITLE }, NOW), undefined)
})

test("a row the panel has nothing of is not held on its own", () => {
  // Re-adopting a published retention builds the row first and holds that; the
  // bare undefined stays a refusal, so no caller can conjure a row out of a
  // title alone.
  assert.equal(holdFinishedRow(undefined, { aborted: false, title: HELD_TITLE }, NOW), undefined)
})

// ------------------------------------------------- the held row goes again

test("a held row whose session is still listed stays", () => {
  assert.deepEqual(
    reapRetained([heldRow()], { seen: new Set(["ses_child"]) }, NOW + 60000),
    [],
  )
})

test("a held row whose session is gone is reaped — whatever ended the retention", () => {
  // The TTL reap, a capacity eviction, the drop at a handoff or an endless
  // freeze, an abort, a drop from this very panel: each of them has the plugin
  // delete the session, and the session's absence from the poll is the one
  // signal the panel acts on.
  assert.deepEqual(
    reapRetained([heldRow()], { seen: new Set(["ses_someone_else"]) }, NOW + 60000),
    ["ses_child"],
  )
})

test("a held row is reaped once its published window is past the grace", () => {
  const held = heldRow()
  const seen = new Set(["ses_child"])
  const justInside = UNTIL + RETENTION_EXPIRY_GRACE_MS
  assert.equal(retentionExpired(held, justInside), false)
  assert.deepEqual(reapRetained([held], { seen }, justInside), [])
  const past = justInside + 1
  assert.equal(retentionExpired(held, past), true)
  assert.deepEqual(reapRetained([held], { seen }, past), ["ses_child"])
})

test("retentionExpired says nothing about a row that is not held", () => {
  assert.equal(retentionExpired(row({ status: "idle" }), NOW + TTL_MS * 10), false)
})

test("several held rows are reaped in one pass", () => {
  const a = heldRow()
  const b = heldRow({ sessionID: "ses_b", handle: "coder#1" })
  const live = row({ sessionID: "ses_live", status: "busy" })
  assert.deepEqual(
    reapRetained([a, b, live], { seen: new Set(["ses_live"]) }, NOW + 1000),
    ["ses_child", "ses_b"],
  )
})

// ------------------------------------------------------------- what it shows

test("the window left is the figure the plugin shows the orchestrator", () => {
  const held = heldRow()
  for (const elapsed of [0, 59000, 60000, 1800000, TTL_MS - 1, TTL_MS]) {
    const now = NOW + elapsed
    assert.equal(
      retainedMinutesLeft(held, now),
      pluginMinutesLeft({ retainedAt: NOW }, TTL_MS, now),
      `minutes left disagree at +${elapsed}ms`,
    )
  }
})

test("the window left never goes negative", () => {
  const held = heldRow()
  const past = UNTIL + 600000
  assert.equal(retainedMsLeft(held, past), 0)
  assert.equal(retainedMinutesLeft(held, past), 0)
})

test("a held row's note names the state and the minutes left", () => {
  assert.equal(retainedRowNote(heldRow(), NOW + 780000), "retained · 47m left")
})

test("a held row carries its own marker, distinct from every other status", () => {
  const markers = {
    busy: statusMarker("busy"),
    retry: statusMarker("retry"),
    idle: statusMarker("idle"),
    aborted: statusMarker("aborted"),
    error: statusMarker("error"),
    retained: statusMarker("retained"),
  }
  assert.equal(markers.retained, "◆")
  for (const [status, marker] of Object.entries(markers)) {
    if (status === "retained") continue
    assert.notEqual(marker, markers.retained, `${status} shares the retained marker`)
  }
})

test("held rows sort below running work and below what is still settling", () => {
  assert.ok(statusRank("busy") < statusRank("idle"))
  assert.ok(statusRank("retry") < statusRank("retained"))
  assert.ok(statusRank("idle") < statusRank("retained"))
  assert.ok(statusRank("aborted") < statusRank("retained"))
})

test("the cross on a held row asks to drop, not to abort", () => {
  assert.notEqual(DROP_CONFIRM_TEXT, ABORT_CONFIRM_TEXT)
  assert.match(DROP_CONFIRM_TEXT, /^drop\? /)
  // Both name the same two ways to confirm, so the arming reads the same.
  assert.match(DROP_CONFIRM_TEXT, /✕ or x again$/)
  assert.match(ABORT_CONFIRM_TEXT, /✕ or x again$/)
})
