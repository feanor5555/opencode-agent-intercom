// Which panel a nested subagent's row is drawn in, and what it looks like
// there (tui/src/subagent-store.ts, wired into the `rows` memo of
// tui/src/tui.tsx).
//
// The rule this file pins: the panel of an orchestrator session shows the
// WHOLE subagent tree beneath it, at any depth. The host renders no sidebar
// inside a session that has a parent, so a row drawn only in its own parent's
// panel is a row nobody can look at — which is what a nested subagent used to
// get. Three properties carry that:
//
//   - membership: a row is on the list exactly when its parent chain reaches
//     the panel's own session. Another orchestrator's subagents stay off it.
//   - order: pre-order, a child directly under its own parent.
//   - depth: one indent level per generation.
//
// The header figures are counted off those same rendered rows, so the summary
// line can never name a subagent the list does not show; `done` is kept per
// orchestrator tree, which is what `rootSessionOf` decides.
//
// Run: node --test test/tui-sidebar-tree.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  ROW_INDENT_COLUMNS,
  descendantRows,
  rootSessionOf,
  rowIndent,
  summariseRows,
} from "../tui/src/subagent-store.ts"

const NOW = 1_700_000_000_000

const ORCHESTRATOR = "ses_primary"
const CODER = "ses_coder"
const RESEARCHER = "ses_researcher"
const FETCHER = "ses_fetcher"

// Another orchestrator's tree, in the same store: the user navigated into a
// second session, so the panel polls it and holds its children too.
const OTHER_PRIMARY = "ses_other_primary"
const OTHER_CHILD = "ses_other_child"

function row(over = {}) {
  return {
    sessionID: CODER,
    parentID: ORCHESTRATOR,
    agent: "coder",
    handle: "coder#1",
    title: "writing the patch",
    status: "waiting",
    wasBusy: false,
    createdAt: NOW - 30000,
    updatedAt: NOW,
    lastTokenFetch: NOW,
    ...over,
  }
}

// orchestrator → coder → researcher → fetcher, each one spawned by the one
// before it. Only the deepest is busy; the ones above it are blocked inside
// their own spawn, which opencode reports as no run fiber at all.
function chain() {
  return [
    row({ sessionID: CODER, parentID: ORCHESTRATOR, agent: "coder", handle: "coder#1" }),
    row({
      sessionID: RESEARCHER,
      parentID: CODER,
      agent: "researcher",
      handle: "researcher#1",
      createdAt: NOW - 20000,
    }),
    row({
      sessionID: FETCHER,
      parentID: RESEARCHER,
      agent: "fetcher",
      handle: "fetcher#1",
      status: "busy",
      wasBusy: true,
      createdAt: NOW - 10000,
    }),
  ]
}

const ids = (rows) => rows.map((r) => r.entry.sessionID)
const depths = (rows) => rows.map((r) => r.depth)

// ------------------------------------------------------- the tree is shown

test("a three-deep chain is one panel's list, in chain order", () => {
  // The grandchild used to be filtered out: its parentID is the coder's
  // session, not the panel's. It is the case the whole change exists for.
  const rows = descendantRows(chain().slice(0, 2), ORCHESTRATOR)
  assert.deepEqual(ids(rows), [CODER, RESEARCHER])
  assert.deepEqual(depths(rows), [0, 1])
})

test("a four-deep chain keeps every generation, one indent level each", () => {
  const rows = descendantRows(chain(), ORCHESTRATOR)
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
  assert.deepEqual(depths(rows), [0, 1, 2])
  assert.deepEqual(
    rows.map((r) => rowIndent(r.depth)),
    [0, ROW_INDENT_COLUMNS, ROW_INDENT_COLUMNS * 2],
  )
})

test("depth is unbounded — a fifth generation is a row like any other", () => {
  const deeper = [
    ...chain(),
    row({
      sessionID: "ses_deepest",
      parentID: FETCHER,
      agent: "fetcher",
      handle: "fetcher#2",
      createdAt: NOW - 5000,
    }),
  ]
  const rows = descendantRows(deeper, ORCHESTRATOR)
  assert.deepEqual(depths(rows), [0, 1, 2, 3])
  assert.equal(rowIndent(3), ROW_INDENT_COLUMNS * 3)
})

// ------------------------------------------------------------- the ordering

test("a child follows its own parent rather than sorting away from it", () => {
  // Sorting the flat list by status would put the busy grandchild first and
  // detach it from the parent it was spawned by. Ranking applies among
  // siblings, which is the only place it ever compared like with like.
  const rows = descendantRows(chain(), ORCHESTRATOR)
  const order = ids(rows)
  assert.ok(order.indexOf(CODER) < order.indexOf(RESEARCHER))
  assert.ok(order.indexOf(RESEARCHER) < order.indexOf(FETCHER))
  assert.equal(rows[2].entry.status, "busy")
})

test("siblings keep the list's own order: running first, then spawn order", () => {
  const siblings = [
    row({ sessionID: "ses_a", handle: "coder#1", createdAt: NOW - 30000 }),
    row({
      sessionID: "ses_b",
      handle: "coder#2",
      status: "busy",
      createdAt: NOW - 20000,
    }),
    row({
      sessionID: "ses_c",
      handle: "coder#3",
      status: "retained",
      retainedUntil: NOW + 60000,
      createdAt: NOW - 40000,
    }),
    row({ sessionID: "ses_d", handle: "coder#4", createdAt: NOW - 10000 }),
  ]
  const rows = descendantRows(siblings, ORCHESTRATOR)
  assert.deepEqual(ids(rows), ["ses_b", "ses_a", "ses_d", "ses_c"])
  assert.deepEqual(depths(rows), [0, 0, 0, 0])
})

test("a whole subtree stays under its own parent when siblings are ranked", () => {
  // Two direct children, the second one busy and therefore first; each keeps
  // its own descendant directly beneath it.
  const rows = descendantRows(
    [
      row({ sessionID: "ses_x", handle: "coder#1", createdAt: NOW - 30000 }),
      row({
        sessionID: "ses_x_child",
        parentID: "ses_x",
        handle: "researcher#1",
        createdAt: NOW - 25000,
      }),
      row({
        sessionID: "ses_y",
        handle: "coder#2",
        status: "busy",
        createdAt: NOW - 20000,
      }),
      row({
        sessionID: "ses_y_child",
        parentID: "ses_y",
        handle: "researcher#2",
        createdAt: NOW - 15000,
      }),
    ],
    ORCHESTRATOR,
  )
  assert.deepEqual(ids(rows), ["ses_y", "ses_y_child", "ses_x", "ses_x_child"])
  assert.deepEqual(depths(rows), [0, 1, 0, 1])
})

// ------------------------------------------------------------- who is left out

test("another orchestrator's subagents stay off this panel", () => {
  const rows = descendantRows(
    [...chain(), row({ sessionID: OTHER_CHILD, parentID: OTHER_PRIMARY, handle: "coder#9" })],
    ORCHESTRATOR,
  )
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
})

test("a descendant of the other tree is not adopted through its own chain", () => {
  const rows = descendantRows(
    [
      row({ sessionID: OTHER_CHILD, parentID: OTHER_PRIMARY, handle: "coder#9" }),
      row({
        sessionID: "ses_other_grandchild",
        parentID: OTHER_CHILD,
        handle: "researcher#9",
      }),
    ],
    ORCHESTRATOR,
  )
  assert.deepEqual(rows, [])
})

test("the panel's own session is never a row of its own, at any depth", () => {
  const rows = descendantRows(
    [
      row({ sessionID: ORCHESTRATOR, parentID: ORCHESTRATOR, handle: "coder#0" }),
      ...chain(),
    ],
    ORCHESTRATOR,
  )
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
})

test("an orchestrator session gets no row, and takes no subtree down with it", () => {
  // `isOrchestrator` is the panel's own test (polled and never a subagent). A
  // session it answers for is not a row; its children hang from the nearest
  // ancestor that is still on the list only where the ancestry says so, which
  // for a foreign orchestrator it does not.
  const rows = descendantRows(
    [...chain(), row({ sessionID: OTHER_PRIMARY, parentID: ORCHESTRATOR, handle: "coder#8" })],
    ORCHESTRATOR,
    { isOrchestrator: (id) => id === OTHER_PRIMARY },
  )
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
})

// --------------------------------------------------- holes, cycles, no hangs

test("a descendant whose parent's row is gone keeps its place", () => {
  // The middle subagent was torn down first; the one it spawned is still
  // working and must not vanish with it. The panel remembers the gone row's
  // own parent, which is what carries the ancestry across the hole.
  const [, researcher, fetcher] = chain()
  const rows = descendantRows([fetcher], ORCHESTRATOR, {
    parentOfGone: (id) => (id === RESEARCHER ? CODER : id === CODER ? ORCHESTRATOR : undefined),
  })
  assert.deepEqual(ids(rows), [FETCHER])
  // It hangs from the panel's session now, because nothing between them has a
  // row any more.
  assert.deepEqual(depths(rows), [0])
  // With the middle row still there it sits under it again.
  const withMiddle = descendantRows([researcher, fetcher], ORCHESTRATOR, {
    parentOfGone: (id) => (id === CODER ? ORCHESTRATOR : undefined),
  })
  assert.deepEqual(ids(withMiddle), [RESEARCHER, FETCHER])
  assert.deepEqual(depths(withMiddle), [0, 1])
})

test("an unknown parent is not an invitation to adopt the row", () => {
  // Nothing says where this session came from, so nothing says it is ours.
  const rows = descendantRows([row({ sessionID: "ses_loose", parentID: "ses_nowhere" })], ORCHESTRATOR)
  assert.deepEqual(rows, [])
})

test("a parent cycle neither hangs nor drops a row that is really ours", () => {
  const rows = descendantRows(
    [
      row({ sessionID: "ses_p", parentID: "ses_q", handle: "coder#1" }),
      row({ sessionID: "ses_q", parentID: "ses_p", handle: "coder#2" }),
      ...chain(),
    ],
    ORCHESTRATOR,
  )
  // The two that only point at each other reach no orchestrator and stay off.
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
})

test("a row that is its own parent does not loop", () => {
  const rows = descendantRows(
    [row({ sessionID: "ses_self", parentID: "ses_self", handle: "coder#1" }), ...chain()],
    ORCHESTRATOR,
  )
  assert.deepEqual(ids(rows), [CODER, RESEARCHER, FETCHER])
})

test("a cycle in the gone-parent chain terminates", () => {
  const rows = descendantRows([row({ sessionID: "ses_loose", parentID: "ses_g1" })], ORCHESTRATOR, {
    parentOfGone: (id) => (id === "ses_g1" ? "ses_g2" : "ses_g1"),
  })
  assert.deepEqual(rows, [])
})

// ------------------------------------------------------------ header figures

test("the header figures are counted off the rows that are rendered", () => {
  const rows = descendantRows(
    [
      ...chain(),
      row({
        sessionID: "ses_held",
        parentID: CODER,
        handle: "coder#2",
        status: "retained",
        retainedUntil: NOW + 60000,
      }),
      row({ sessionID: "ses_retry", parentID: FETCHER, handle: "fetcher#2", status: "retry" }),
      row({ sessionID: OTHER_CHILD, parentID: OTHER_PRIMARY, handle: "coder#9" }),
    ],
    ORCHESTRATOR,
  )
  const counts = summariseRows(rows)
  assert.equal(counts.total, rows.length)
  assert.equal(counts.total, 5, "the other tree's row is neither shown nor counted")
  assert.equal(
    counts.running,
    rows.filter((r) => r.entry.status === "busy" || r.entry.status === "retry").length,
  )
  assert.equal(counts.running, 2, "the nested busy and retry rows count as running")
  assert.equal(counts.retained, 1)
})

test("the counted rows are the rendered rows even when everything is nested", () => {
  const rows = descendantRows(chain(), ORCHESTRATOR)
  const counts = summariseRows(rows)
  assert.equal(counts.total, 3)
  assert.equal(counts.running, 1)
  assert.equal(counts.retained, 0)
})

// ------------------------------------------------- which tree a run is booked to

test("a finished run is booked to the orchestrator at the top of its chain", () => {
  const [coder, researcher, fetcher] = chain()
  const live = new Map([
    [CODER, coder],
    [RESEARCHER, researcher],
    [FETCHER, fetcher],
  ])
  const lookup = (id) => live.get(id)
  assert.equal(rootSessionOf(coder, lookup), ORCHESTRATOR)
  assert.equal(rootSessionOf(researcher, lookup), ORCHESTRATOR)
  assert.equal(rootSessionOf(fetcher, lookup), ORCHESTRATOR)
  assert.equal(
    rootSessionOf(row({ sessionID: OTHER_CHILD, parentID: OTHER_PRIMARY }), lookup),
    OTHER_PRIMARY,
  )
})

test("the chain still resolves when the rows above it have already gone", () => {
  // The deepest subagent outlives the two above it; the panel keeps their
  // records, so its run is still booked to the right orchestrator.
  const [coder, researcher, fetcher] = chain()
  const gone = new Map([
    [CODER, coder],
    [RESEARCHER, researcher],
  ])
  assert.equal(rootSessionOf(fetcher, (id) => gone.get(id)), ORCHESTRATOR)
})

test("rootSessionOf terminates on a cycle", () => {
  const looped = new Map([
    ["ses_p", row({ sessionID: "ses_p", parentID: "ses_q" })],
    ["ses_q", row({ sessionID: "ses_q", parentID: "ses_p" })],
  ])
  const root = rootSessionOf(looped.get("ses_p"), (id) => looped.get(id))
  assert.equal(typeof root, "string")
})

// ------------------------------------------------------------- the wiring

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

test("the panel's row list is the tree walk, rooted at its own session", () => {
  only("descendantRows([...props.subagents().values()], props.sessionID, {")
  only("parentOfGone: props.parentOfGone,")
  only("const parentOfGone = (sessionID: string): string | undefined =>")
})

test("every rendered row carries its depth, and the depth is the indent", () => {
  only("{(row) => <Row entry={row.entry} depth={row.depth} />}")
  only("const indent = createMemo(() => rowIndent(rowProps.depth));")
  only("paddingLeft={indent()}")
  // The label is composed against what is left after the indent, so a deep row
  // is cut to its own budget rather than by the box.
  only("return panel === undefined ? undefined : panel - indent();")
})

test("the header figures come from the rendered rows and the panel's own tree", () => {
  only("const summary = summariseRows(rows());")
  only('completedCount={() => completedFor(sessionID ?? "")}')
  only("rootSessionOf(entry, (sessionID) => rows.get(sessionID) ?? finished.get(sessionID))")
})

test("selection, opening and abort all run off the flattened tree", () => {
  // One flat list of ids in render order: j/k, ⏎ and x reach a nested row
  // exactly as they reach a direct child.
  only("const rowIDs = createMemo(() => rows().map((row) => row.entry.sessionID));")
})
