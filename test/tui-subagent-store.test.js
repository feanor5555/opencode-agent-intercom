// Unit tests for the state behind the sidebar's subagent rows
// (tui/src/subagent-store.ts): when a finished row is dropped, when it is held
// as `retained`, and when a held row goes again.
//
// The one rule the whole file turns on: a row is held because the PLUGIN says
// so, never because the panel worked it out. When a row EXISTS at all is a
// different rule and is pinned in test/tui-sidebar-rows.test.js. The plugin publishes the state on
// the subagent session's title — `[retained:<epoch ms the window ends>]` after
// its own marker — and `decideRow` combines it with the local abort mark and
// the server's live status. So:
//
//   - retention off (maxRetainedSubagents = 0, the shipped default) — no
//     session is ever stamped, so no row is ever held and every row ends the
//     ordinary way, with its session;
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
  assembleSubagentEntry,
  decideRow,
  isRetained,
  reapRows,
  retainedMinutesLeft,
  retainedMsLeft,
  readSessionChildren,
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
    status: "waiting",
    wasBusy: true,
    createdAt: NOW - 30000,
    updatedAt: NOW,
    ctxTokens: 12000,
    lastTokenFetch: NOW,
    knownAtPass: SPAWN_PASS,
    ...over,
  }
}

// What the poll observes about one listed child session.
function seenAs(over = {}) {
  return { sessionID: "ses_child", aborted: false, title: HELD_TITLE, serverStatus: undefined, ...over }
}

// A row already held on the published window, as a poll would have left it.
function heldRow(over = {}) {
  const decision = decideRow(seenAs())
  assert.equal(decision.kind, "hold", "fixture: the stamped title must hold")
  return {
    ...assembleSubagentEntry(
      row(),
      { id: "ses_child", parentID: "ses_primary", title: HELD_TITLE },
      "ses_primary",
      decision,
      "researcher#1",
    ),
    ...over,
  }
}

// The two poll sets, for the reap: everything below holds rows whose parent is
// the one session the pass asked about.
const POLLED = new Set(["ses_primary"])
// The pass the rows below were learned of at, and a pass that started after
// them — the one whose listing may answer for them. A pass that was already
// under way when a row was learned of never had the chance to list it, so
// every reap states which pass's result it is (test/tui-sidebar-rows.test.js
// pins that guard).
const SPAWN_PASS = 2
const LATER_PASS = SPAWN_PASS + 1

// -------------------------------------------------------- poll result and row

test("session.children responses preserve the difference between missing and failed", () => {
  assert.deepEqual(readSessionChildren({ data: [] }), {
    kind: "ok",
    children: [],
  })
  assert.deepEqual(
    readSessionChildren({ error: { name: "NotFoundError" }, response: { status: 404 } }),
    { kind: "missing" },
  )
  assert.deepEqual(
    readSessionChildren({ error: { name: "ServerError" }, response: { status: 503 } }),
    { kind: "error" },
  )
  assert.deepEqual(readSessionChildren({ data: undefined, error: undefined }), {
    kind: "error",
  })
})

test("row assembly applies the decision and keeps existing row state", () => {
  const base = row({
    status: "retained",
    retainedUntil: UNTIL,
    ctxTokens: 12000,
  })
  const child = {
    id: "ses_child",
    parentID: "ses_nested",
    agent: "coder",
    title: "updated title",
    time: { created: NOW - 1000, updated: NOW + 1000 },
  }
  const running = assembleSubagentEntry(
    base,
    child,
    "ses_primary",
    { kind: "row", status: "busy" },
    "coder#2",
  )
  assert.deepEqual(running, {
    ...base,
    sessionID: "ses_child",
    parentID: "ses_nested",
    agent: "coder",
    handle: "coder#2",
    title: "updated title",
    status: "busy",
    retainedUntil: undefined,
    wasBusy: true,
    createdAt: NOW - 1000,
    updatedAt: NOW + 1000,
  })
  const held = assembleSubagentEntry(
    running,
    { ...child, title: HELD_TITLE },
    "ses_primary",
    { kind: "hold", retainedUntil: UNTIL },
    "coder#2",
  )
  assert.equal(held.status, "retained")
  assert.equal(held.retainedUntil, UNTIL)
  assert.equal(held.ctxTokens, 12000)
})

// ---------------------------------------------------------------- retention off

test("retention off: the feature is not enabled at the shipped default", () => {
  assert.equal(retentionEnabled(RETENTION_OFF), false)
  assert.equal(retentionEnabled(RETENTION_ON), true)
})

test("retention off: an unstamped subagent is a row, never a hold", () => {
  // Nothing retains, so nothing stamps a title, so nothing is held — and the
  // row stays, because the session is still listed. What ends it is the
  // session going away, not this decision.
  assert.deepEqual(decideRow(seenAs({ title: PLAIN_TITLE })), {
    kind: "row",
    status: "waiting",
  })
})

test("retention off: rows the poll still lists are left alone", () => {
  const rows = [row({ status: "waiting" }), row({ sessionID: "ses_other", status: "busy" })]
  const seen = new Set(["ses_child", "ses_other"])
  assert.deepEqual(reapRows(rows, { seen, polled: POLLED, completedPass: LATER_PASS }, NOW), [])
})

// ------------------------------------------- the refusals the panel is told of

test("a refused retention is never held, whatever the settings file says", () => {
  // Every plugin-side refusal looks the same from here, and that is the point:
  // over the reuse ceiling, a `Blocked:` reply, a nested child, an error
  // ending, or a process that latched retention off at load. Without a stamp
  // the row is never painted as held — it stays an ordinary row until the
  // plugin deletes the session.
  for (const title of [PLAIN_TITLE, "researcher: plain", "", undefined]) {
    assert.equal(
      decideRow(seenAs({ title })).kind,
      "row",
      `an unstamped title must not hold: ${JSON.stringify(title)}`,
    )
  }
})

test("a stamp on a title that is not this plugin's is not a retention", () => {
  // The marker is what attributes a session to this plugin. Without it the
  // text is a user's own title that happens to read like a stamp.
  assert.equal(
    decideRow(seenAs({ title: `[retained:${UNTIL}] hand-typed` })).kind,
    "row",
  )
})

// ----------------------------------------------------------------- retention on

test("retention on: a subagent the plugin published is held on its window", () => {
  const decision = decideRow(seenAs())
  assert.deepEqual(decision, { kind: "hold", retainedUntil: UNTIL })
  // The row the panel builds from it keeps everything it already carried.
  const held = heldRow()
  assert.equal(held.status, "retained")
  assert.equal(isRetained(held), true)
  assert.equal(held.retainedUntil, UNTIL, "the plugin's window, not one measured here")
  assert.equal(held.handle, "researcher#1")
  assert.equal(held.agent, "researcher")
  assert.equal(held.wasBusy, true)
  assert.equal(held.ctxTokens, 12000)
})

test("retention on: deciding a held row again does not move its window", () => {
  // The window is read off the title on every pass, so a poll that revisits a
  // held row names the same moment rather than starting a window of its own.
  assert.deepEqual(decideRow(seenAs()), decideRow(seenAs()))
  assert.equal(heldRow().retainedUntil, UNTIL)
})

test("retention on: a live run outranks a stale retention stamp", () => {
  assert.deepEqual(decideRow(seenAs({ serverStatus: "busy" })), {
    kind: "row",
    status: "busy",
  })
  assert.deepEqual(decideRow(seenAs({ serverStatus: "retry" })), {
    kind: "row",
    status: "retry",
  })
  assert.deepEqual(decideRow(seenAs({ serverStatus: undefined })), {
    kind: "hold",
    retainedUntil: UNTIL,
  })
})

test("retention on: an aborted subagent is never held", () => {
  assert.deepEqual(decideRow(seenAs({ aborted: true })), {
    kind: "row",
    status: "aborted",
  })
})

// ------------------------------------------------- the held row goes again

test("a held row whose session is still listed stays", () => {
  assert.deepEqual(
    reapRows(
      [heldRow()],
      { seen: new Set(["ses_child"]), polled: POLLED, completedPass: LATER_PASS },
      NOW + 60000,
    ),
    [],
  )
})

test("a held row whose session is gone is reaped — whatever ended the retention", () => {
  // The TTL reap, a capacity eviction, the drop at a handoff or an endless
  // freeze, an abort, a drop from this very panel: each of them has the plugin
  // delete the session, and the session's absence from the poll is the one
  // signal the panel acts on.
  assert.deepEqual(
    reapRows(
      [heldRow()],
      {
        seen: new Set(["ses_someone_else"]),
        polled: POLLED,
        completedPass: LATER_PASS,
      },
      NOW + 60000,
    ),
    ["ses_child"],
  )
})

test("a held row is reaped once its published window is past the grace", () => {
  const held = heldRow()
  const seen = new Set(["ses_child"])
  const justInside = UNTIL + RETENTION_EXPIRY_GRACE_MS
  assert.equal(retentionExpired(held, justInside), false)
  assert.deepEqual(reapRows([held], { seen, polled: POLLED, completedPass: LATER_PASS }, justInside), [])
  const past = justInside + 1
  assert.equal(retentionExpired(held, past), true)
  assert.deepEqual(reapRows([held], { seen, polled: POLLED, completedPass: LATER_PASS }, past), ["ses_child"])
})

test("the expired hold is reaped on the very pass that learned of it", () => {
  // The pass count guards an ABSENCE and nothing else. This row is listed, so
  // no question of reach arises: the pass sees the session standing with its
  // published window long past the grace, and that is enough on its own.
  const held = heldRow({ knownAtPass: LATER_PASS })
  const past = UNTIL + RETENTION_EXPIRY_GRACE_MS + 1
  assert.deepEqual(
    reapRows(
      [held],
      {
        seen: new Set(["ses_child"]),
        polled: POLLED,
        completedPass: LATER_PASS,
      },
      past,
    ),
    ["ses_child"],
  )
})

test("retentionExpired says nothing about a row that is not held", () => {
  assert.equal(retentionExpired(row({ status: "waiting" }), NOW + TTL_MS * 10), false)
})

test("several rows the pass no longer lists are reaped at once", () => {
  const a = heldRow()
  const b = heldRow({ sessionID: "ses_b", handle: "coder#1" })
  const live = row({ sessionID: "ses_live", status: "busy" })
  assert.deepEqual(
    reapRows(
      [a, b, live],
      { seen: new Set(["ses_live"]), polled: POLLED, completedPass: LATER_PASS },
      NOW + 1000,
    ),
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
    waiting: statusMarker("waiting"),
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
  assert.ok(statusRank("busy") < statusRank("waiting"))
  assert.ok(statusRank("retry") < statusRank("retained"))
  assert.ok(statusRank("waiting") < statusRank("retained"))
  assert.ok(statusRank("aborted") < statusRank("retained"))
})

test("the cross on a held row asks to drop, not to abort", () => {
  assert.notEqual(DROP_CONFIRM_TEXT, ABORT_CONFIRM_TEXT)
  assert.match(DROP_CONFIRM_TEXT, /^drop\? /)
  // Both name the same two ways to confirm, so the arming reads the same.
  assert.match(DROP_CONFIRM_TEXT, /✕ or x again$/)
  assert.match(ABORT_CONFIRM_TEXT, /✕ or x again$/)
})
