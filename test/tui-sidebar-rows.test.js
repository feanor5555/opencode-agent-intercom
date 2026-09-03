// When a sidebar row exists, and when it goes
// (tui/src/subagent-store.ts, wired in tui/src/tui.tsx).
//
// The rule this file pins, and the whole of it: a row lives while its session
// is listed among its parent's children and carries no retention stamp. The
// plugin deletes a subagent's opencode session at every ending it controls
// (teardownSubagent, src/teardown.js), so "still listed" IS "the plugin has not
// finished with it", and that is a statement the plugin makes rather than one
// the panel infers.
//
// What the opencode session status may NOT do is end a row. `idle` there means
// only "no run fiber in this session right now", and opencode spells it as
// absence from GET /session/status — the same absence a subagent shows between
// its session being created and its run being forked, while it is blocked
// inside a nested spawn of its own, and while a retained session is being
// re-prompted. Every one of those is a subagent at work, so `busy`/`retry`
// decide what a row SHOWS and nothing else.
//
// The nested case is the one that carried the defect and is pinned here end to
// end: a subagent that spawns a subagent is a parent AND a subagent, it stays
// on the list while opencode reports it idle, its child gets a row of its own,
// and both go when their sessions are deleted.
//
// Run: node --test test/tui-sidebar-rows.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { retentionStampedTitle } from "../src/teardown.js"
import { decideRow, reapRows } from "../tui/src/subagent-store.ts"

const NOW = 1_700_000_000_000
const UNTIL = NOW + 3600000

const ORCHESTRATOR = "ses_primary"
const PLANNER = "ses_planner"
const NESTED = "ses_nested"

const PLAIN_TITLE = retentionStampedTitle("planning the run", 0)
const HELD_TITLE = retentionStampedTitle("planning the run", UNTIL)

// What the poll observes about one listed child session.
function seenAs(over = {}) {
  return {
    sessionID: PLANNER,
    aborted: false,
    title: PLAIN_TITLE,
    serverStatus: undefined,
    ...over,
  }
}

function row(over = {}) {
  return {
    sessionID: PLANNER,
    parentID: ORCHESTRATOR,
    agent: "planner",
    handle: "planner#1",
    title: PLAIN_TITLE,
    status: "waiting",
    wasBusy: true,
    createdAt: NOW - 30000,
    updatedAt: NOW,
    lastTokenFetch: NOW,
    ...over,
  }
}

// ------------------------------------------------------------ decideRow

test("a decision is a row or a hold, and never a retirement", () => {
  // The two outcomes are the whole vocabulary: no observation of a status, of
  // a title or of an abort ever ends a row. Only the session going away does.
  for (const aborted of [false, true]) {
    for (const title of [undefined, "", "plain", PLAIN_TITLE, HELD_TITLE]) {
      for (const serverStatus of [undefined, "idle", "busy", "retry", "?"]) {
        const decision = decideRow(seenAs({ aborted, title, serverStatus }))
        assert.ok(
          decision.kind === "row" || decision.kind === "hold",
          `unexpected outcome ${decision.kind} for ${JSON.stringify({ aborted, title, serverStatus })}`,
        )
      }
    }
  }
})

test("busy and retry pick a status, not a lifetime", () => {
  assert.deepEqual(decideRow(seenAs({ serverStatus: "busy" })), {
    kind: "row",
    status: "busy",
  })
  assert.deepEqual(decideRow(seenAs({ serverStatus: "retry" })), {
    kind: "row",
    status: "retry",
  })
})

test("no run fiber in a listed, unstamped session is a waiting row", () => {
  // opencode says idle by leaving the session out of GET /session/status, so
  // `undefined` is the ordinary reading — and an explicit "idle" must land the
  // same way.
  for (const serverStatus of [undefined, "idle"]) {
    assert.deepEqual(decideRow(seenAs({ serverStatus })), {
      kind: "row",
      status: "waiting",
    })
  }
})

test("an abort outranks everything, live status outranks a stale stamp", () => {
  // 1. abort, 2. busy/retry, 3. retention stamp, 4. waiting.
  assert.deepEqual(
    decideRow(seenAs({ aborted: true, title: HELD_TITLE, serverStatus: "busy" })),
    { kind: "row", status: "aborted" },
  )
  assert.deepEqual(
    decideRow(seenAs({ title: HELD_TITLE, serverStatus: "busy" })),
    { kind: "row", status: "busy" },
  )
  assert.deepEqual(
    decideRow(seenAs({ title: HELD_TITLE, serverStatus: "retry" })),
    { kind: "row", status: "retry" },
  )
  assert.deepEqual(decideRow(seenAs({ title: HELD_TITLE })), {
    kind: "hold",
    retainedUntil: UNTIL,
  })
})

// --------------------------------------------------------- the nested case

test("a subagent blocked in a nested spawn keeps its row", () => {
  // The planner spawned a subagent of its own and is waiting on it. opencode
  // reports no run fiber in the planner's session; the plugin's own server half
  // treats exactly this as "not finished" (src/hooks.js, "idle held: subagent
  // is waiting on a live child"). The panel has to agree.
  const decision = decideRow(
    seenAs({ sessionID: PLANNER, title: PLAIN_TITLE, serverStatus: undefined }),
  )
  assert.deepEqual(decision, { kind: "row", status: "waiting" })
})

test("the parent stays listed pass after pass while it waits", () => {
  // A single non-busy observation is not final, and repeating it changes
  // nothing: the reap only acts on the session being gone.
  const parent = row({ status: "waiting" })
  const seen = new Set([PLANNER])
  const polled = new Set([ORCHESTRATOR])
  for (const pass of [0, 1, 2, 3]) {
    assert.deepEqual(
      reapRows([parent], { seen, polled }, NOW + pass * 5000),
      [],
      `the parent was reaped on pass ${pass}`,
    )
  }
})

test("the nested child gets a row of its own, under its own parent", () => {
  // The child is listed under the planner, not under the orchestrator, so it
  // is a row of the panel rendered for the planner's session.
  const child = row({
    sessionID: NESTED,
    parentID: PLANNER,
    agent: "researcher",
    handle: "researcher#1",
    status: "busy",
  })
  const parent = row({ status: "waiting" })
  assert.notEqual(child.sessionID, parent.sessionID)
  assert.equal(child.parentID, parent.sessionID)
  assert.deepEqual(
    reapRows(
      [parent, child],
      { seen: new Set([PLANNER, NESTED]), polled: new Set([ORCHESTRATOR, PLANNER]) },
      NOW,
    ),
    [],
  )
})

test("a child of a session the pass never asked about is not reaped", () => {
  // The panel is rendered for the orchestrator, so it lists the orchestrator's
  // children and nobody else's. The nested child is out of that reach: the
  // pass did not disprove it, so its row stands until a pass that does ask.
  const child = row({ sessionID: NESTED, parentID: PLANNER, status: "busy" })
  assert.deepEqual(
    reapRows(
      [child],
      { seen: new Set([PLANNER]), polled: new Set([ORCHESTRATOR]) },
      NOW,
    ),
    [],
  )
})

test("the deleted sessions go, parent and child together", () => {
  // Both sessions were asked about and neither is listed any more — which is
  // what the plugin's teardown leaves behind for both of them.
  const parent = row({ status: "waiting" })
  const child = row({ sessionID: NESTED, parentID: PLANNER, status: "busy" })
  assert.deepEqual(
    reapRows(
      [parent, child],
      { seen: new Set(), polled: new Set([ORCHESTRATOR, PLANNER]) },
      NOW,
    ),
    [PLANNER, NESTED],
  )
})

test("a busy row is reaped exactly like any other once its session is gone", () => {
  // The status has no say in the end of a row either: a session opencode still
  // called busy on the last pass and no longer lists is gone.
  assert.deepEqual(
    reapRows(
      [row({ status: "busy" })],
      { seen: new Set(), polled: new Set([ORCHESTRATOR]) },
      NOW,
    ),
    [PLANNER],
  )
})

// ------------------------------------------------- how the panel is wired

// The panel is @opentui/solid JSX with no render seam a unit test can drive, so
// what a test can hold is the source itself — the same way
// test/tui-sidebar-sections.test.js pins where each row sits.
const source = readFileSync(
  fileURLToPath(new URL("../tui/src/tui.tsx", import.meta.url)),
  "utf8",
)

function only(marker) {
  const first = source.indexOf(marker)
  assert.notEqual(first, -1, `marker not in tui.tsx: ${marker}`)
  assert.equal(
    source.indexOf(marker, first + 1),
    -1,
    `marker occurs more than once in tui.tsx: ${marker}`,
  )
  return first
}

test("the panel subscribes to session.deleted and retires the row on it", () => {
  only('api.event.on("session.deleted", onSessionDeleted)')
  const handler = only("const onSessionDeleted = (event: unknown): void => {")
  const body = source.slice(handler, source.indexOf("\n  };", handler))
  assert.match(body, /retireRow\(next, sessionID\)/)
  assert.match(body, /setSubagents\(next\)/)
})

test("session.idle no longer takes a row away", () => {
  const handler = only("const onSessionIdle = (event: unknown): void => {")
  const body = source.slice(handler, source.indexOf("\n  };", handler))
  for (const forbidden of ["retireRow", "setSubagents", "finished.set", "setCompletedCount"]) {
    assert.equal(
      body.includes(forbidden),
      false,
      `onSessionIdle must not ${forbidden}: the idle event is not the end of a subagent`,
    )
  }
  // What it keeps is the route jump, and that jump is held back for a session
  // the last completed pass still listed with no retention stamp on it.
  assert.match(body, /api\.route\.navigate\("session", \{ sessionID: entry\.parentID \}\)/)
  assert.match(body, /const stillWorking = listed\.has\(sessionID\) && !isRetained\(entry\)/)
  assert.match(body, /if \(\s*!stillWorking/)
})

test("a failed children request cannot become an empty completed poll", () => {
  const read = only("const childRead = readSessionChildren(childRes);")
  const end = source.indexOf("for (const child of childRead.children)", read)
  assert.notEqual(end, -1, "the children outcome must be checked before iteration")
  const body = source.slice(read, end)
  assert.match(body, /if \(childRead\.kind === "missing"\)/)
  assert.match(body, /polledIDs\.delete\(parentID\)/)
  assert.match(body, /if \(childRead\.kind === "error"\)/)
  assert.match(body, /throw new Error\("session\.children failed"\)/)
  assert.equal(body.includes("childRes?.data ?? []"), false)
})

test("a failed abort clears the local aborted mark", () => {
  const handler = only("const abortSubagent = async (id: string): Promise<void> => {")
  const start = source.indexOf("    aborted.add(id);", handler)
  const failed = source.indexOf("      aborted.delete(id);", handler)
  const end = source.indexOf("    scheduleRefresh();", failed)
  assert.ok(start > handler, "abort must mark the entry before requesting it")
  assert.ok(failed > start, "a failed request must clear the mark it set")
  assert.ok(end > failed, "the clear must happen before refresh is scheduled")
  const abortCall = source.indexOf("api.client.session.abort(", handler)
  const callEnd = source.indexOf("      );", abortCall)
  assert.match(
    source.slice(abortCall, callEnd),
    /throwOnError: true/,
    "HTTP abort failures must reject so the mark is cleared",
  )
})

test("a row is filed away as gone in one place only", () => {
  // Every end of a row goes through retireRow, so none of them can drift from
  // the others — and the poll no longer files a row on a status it observed.
  only("finished.set(sessionID, rows.get(sessionID))")
})

test("the polled set is seeded from the panel's own session alone", () => {
  assert.equal(
    source.includes("trackPrimary"),
    false,
    "the old parenthood-based tracking is gone",
  )
  only("trackPolled(sessionID)")
  assert.equal(
    source.includes("trackPolled(info.parentID)"),
    false,
    "being somebody's parent must not make a session an orchestrator",
  )
  only("const polledIDs = new Set<string>()")
  only("for (const parentID of polledIDs) {")
})

test("deleted sessions leave the polled set", () => {
  const handler = only("const onSessionDeleted = (event: unknown): void => {")
  const end = source.indexOf("    const current = sessionID ? subagents() : undefined;", handler)
  assert.notEqual(end, -1)
  const body = source.slice(handler, end)
  assert.match(body, /polledIDs\.delete\(sessionID\)/)
})

test("the row is assembled through the store helper", () => {
  const call = only("assembleSubagentEntry(base, child, parentID, decision, handle)")
  assert.match(
    source.slice(call - 80, call + 100),
    /next\.set\(\s*child\.id,\s*assembleSubagentEntry\(/s,
  )
})

test("orchestrator and subagent are decided by one test, taken in both places", () => {
  only(
    "const isPrimarySession = (sessionID: string): boolean =>\n    polledIDs.has(sessionID) && !subagentIDs.has(sessionID);",
  )
  // The poll's skip and the row list take the same test, so a session cannot be
  // shown in one and skipped in the other.
  only("if (isPrimarySession(child.id)) continue;")
  only("isPrimary={isPrimarySession}")
  only("!props.isPrimary(entry.sessionID),")
  // A session listed as somebody's child is a subagent from that moment on,
  // which is the rule the server half applies (src/registry.js).
  only("subagentIDs.add(child.id);")
  only("subagentIDs.add(info.id);")
})

test("the reap is what ends a row on a completed pass, and it is widened", () => {
  const call = only("reapRows(")
  assert.match(
    source.slice(call, call + 200),
    /\{ seen, polled: polledIDs \}/,
    "the reap is given both the children it saw and the parents it asked",
  )
})
