// Unit tests for the state behind the sidebar's subagent rows
// (tui/src/subagent-store.ts): when a finished row is dropped, when it is held
// as `retained`, and when a held row goes again.
//
// Two states are pinned here, and the first one matters as much as the second:
//
//   - retention off (maxRetainedSubagents = 0, the shipped default) — the panel
//     behaves exactly as it did before retention existed: a finished subagent
//     disappears the moment its run ends and nothing is ever held;
//   - retention on — a finished subagent stays as a `retained` row with the
//     window it has left, and that row is removed again as soon as the state
//     the plugin publishes says the retention is over: its opencode session is
//     no longer listed among its primary's children.
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

function row(over = {}) {
  return {
    sessionID: "ses_child",
    parentID: "ses_primary",
    agent: "researcher",
    handle: "researcher#1",
    title: "Searching for latest Spring API",
    status: "idle",
    wasBusy: true,
    createdAt: NOW - 30000,
    updatedAt: NOW,
    ctxTokens: 12000,
    lastTokenFetch: NOW,
    ...over,
  }
}

// ---------------------------------------------------------------- retention off

test("retention off: the feature is not enabled at the shipped default", () => {
  assert.equal(retentionEnabled(RETENTION_OFF), false)
  assert.equal(retentionEnabled(RETENTION_ON), true)
})

test("retention off: a finished subagent is dropped, exactly as before", () => {
  const held = holdFinishedRow(
    row(),
    { aborted: false, settings: RETENTION_OFF },
    NOW,
  )
  assert.equal(held, undefined)
})

test("retention off: no row is ever held, so no row is ever reaped", () => {
  const rows = [row(), row({ sessionID: "ses_other", status: "busy" })]
  // Neither row is listed by the poll — with nothing held, the new pass still
  // takes nothing away: dropping a live row stays the poll's own business.
  assert.deepEqual(
    reapRetained(rows, { seen: new Set(), settings: RETENTION_OFF }, NOW),
    [],
  )
})

test("retention off: a row that is not held is never reaped, listed or not", () => {
  const rows = [row({ status: "busy" }), row({ sessionID: "ses_b", status: "idle" })]
  assert.deepEqual(
    reapRetained(rows, { seen: new Set(), settings: RETENTION_ON }, NOW),
    [],
  )
})

// ----------------------------------------------------------------- retention on

test("retention on: a finished subagent is held with its window stamped", () => {
  const held = holdFinishedRow(
    row(),
    { aborted: false, settings: RETENTION_ON },
    NOW,
  )
  assert.ok(held)
  assert.equal(held.status, "retained")
  assert.equal(isRetained(held), true)
  assert.equal(held.retainedAt, NOW)
  // Everything the row already carried survives the transition.
  assert.equal(held.handle, "researcher#1")
  assert.equal(held.agent, "researcher")
  assert.equal(held.wasBusy, true)
  assert.equal(held.ctxTokens, 12000)
})

test("retention on: holding a held row again does not restart its window", () => {
  const held = holdFinishedRow(
    row(),
    { aborted: false, settings: RETENTION_ON },
    NOW,
  )
  const again = holdFinishedRow(
    held,
    { aborted: false, settings: RETENTION_ON },
    NOW + 120000,
  )
  assert.ok(again)
  assert.equal(again.retainedAt, NOW)
})

test("retention on: an aborted subagent is never held", () => {
  const held = holdFinishedRow(
    row(),
    { aborted: true, settings: RETENTION_ON },
    NOW,
  )
  assert.equal(held, undefined)
})

test("retention on: a row the panel never saw is not held", () => {
  const held = holdFinishedRow(
    undefined,
    { aborted: false, settings: RETENTION_ON },
    NOW,
  )
  assert.equal(held, undefined)
})

// ------------------------------------------------- the held row goes again

test("a held row whose session is still listed stays", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  assert.deepEqual(
    reapRetained(
      [held],
      { seen: new Set(["ses_child"]), settings: RETENTION_ON },
      NOW + 60000,
    ),
    [],
  )
})

test("a held row whose session is gone is reaped — whatever ended the retention", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  // The TTL reap, a capacity eviction, the drop at a handoff or an endless
  // freeze, an abort: each of them has the plugin delete the session, and the
  // session's absence from the poll is the one signal the panel acts on.
  assert.deepEqual(
    reapRetained(
      [held],
      { seen: new Set(["ses_someone_else"]), settings: RETENTION_ON },
      NOW + 60000,
    ),
    ["ses_child"],
  )
})

test("a held row is reaped once its window is past the grace, session or not", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  const seen = new Set(["ses_child"])
  const justInside = NOW + TTL_MS + RETENTION_EXPIRY_GRACE_MS
  assert.equal(retentionExpired(held, TTL_MS, justInside), false)
  assert.deepEqual(
    reapRetained([held], { seen, settings: RETENTION_ON }, justInside),
    [],
  )
  const past = justInside + 1
  assert.equal(retentionExpired(held, TTL_MS, past), true)
  assert.deepEqual(reapRetained([held], { seen, settings: RETENTION_ON }, past), [
    "ses_child",
  ])
})

test("retentionExpired says nothing about a row that is not held", () => {
  assert.equal(
    retentionExpired(row({ status: "idle" }), TTL_MS, NOW + TTL_MS * 10),
    false,
  )
})

test("several held rows are reaped in one pass", () => {
  const a = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  const b = holdFinishedRow(
    row({ sessionID: "ses_b", handle: "coder#1" }),
    { aborted: false, settings: RETENTION_ON },
    NOW,
  )
  const live = row({ sessionID: "ses_live", status: "busy" })
  assert.deepEqual(
    reapRetained(
      [a, b, live],
      { seen: new Set(["ses_live"]), settings: RETENTION_ON },
      NOW + 1000,
    ),
    ["ses_child", "ses_b"],
  )
})

// ------------------------------------------------------------- what it shows

test("the window left is the figure the plugin shows the orchestrator", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  for (const elapsed of [0, 59000, 60000, 1800000, TTL_MS - 1, TTL_MS]) {
    const now = NOW + elapsed
    assert.equal(
      retainedMinutesLeft(held, TTL_MS, now),
      pluginMinutesLeft({ retainedAt: NOW }, TTL_MS, now),
      `minutes left disagree at +${elapsed}ms`,
    )
  }
})

test("the window left never goes negative", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  const past = NOW + TTL_MS + 600000
  assert.equal(retainedMsLeft(held, TTL_MS, past), 0)
  assert.equal(retainedMinutesLeft(held, TTL_MS, past), 0)
})

test("a held row's note names the state and the minutes left", () => {
  const held = holdFinishedRow(row(), { aborted: false, settings: RETENTION_ON }, NOW)
  assert.equal(retainedRowNote(held, TTL_MS, NOW + 780000), "retained · 47m left")
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
