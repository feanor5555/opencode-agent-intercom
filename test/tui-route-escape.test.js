// The route escape that runs when a subagent row is retired
// (tui/src/subagent-store.ts: routeEscapeTarget, wired in tui/src/tui.tsx:
// retireRow).
//
// The rule the whole file turns on: a row that goes takes the view with it.
// The plugin deletes a subagent's session at every ending it controls, and the
// TUI answers a route naming a session the server no longer has with its start
// page — the orchestrator chat gone from under the user. Three paths retire a
// row and any of them can be the one that gets there first (`session.deleted`,
// the poll's reap, dropping a held row from the panel); the ones that follow
// find no row and do nothing. So the escape belongs to the retiring itself, at
// the one funnel every path goes through, not to whichever call site happens
// to win.
//
// Run: node --test test/tui-route-escape.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { routeEscapeTarget } from "../tui/src/subagent-store.ts"

const CHILD = "ses_child"
const PARENT = "ses_parent"
const ROOT = "ses_orchestrator"

// A chain child -> parent -> orchestrator, with `gone` naming the rows that
// have already been retired. The orchestrator holds no row and is never gone.
function chain(gone = []) {
  const parents = new Map([
    [CHILD, PARENT],
    [PARENT, ROOT],
  ])
  return {
    isGone: (id) => gone.includes(id),
    parentOfGone: (id) => parents.get(id),
  }
}

function query(over = {}) {
  return {
    routeName: "session",
    routeSessionID: CHILD,
    sessionID: CHILD,
    parentID: PARENT,
    ...chain(),
    ...over,
  }
}

// ------------------------------------------------- when the view stays put

test("a view somewhere else is left alone", () => {
  assert.equal(routeEscapeTarget(query({ routeSessionID: "ses_other" })), undefined)
})

test("a route that names no session is left alone", () => {
  assert.equal(routeEscapeTarget(query({ routeName: "home", routeSessionID: undefined })), undefined)
  assert.equal(routeEscapeTarget(query({ routeName: "plugin" })), undefined)
})

test("a row with no parent has nowhere to escape to", () => {
  assert.equal(routeEscapeTarget(query({ parentID: undefined })), undefined)
  assert.equal(routeEscapeTarget(query({ parentID: "" })), undefined)
})

// ------------------------------------------------- when it moves

test("the view inside a retiring row moves to its parent", () => {
  assert.equal(routeEscapeTarget(query()), PARENT)
})

test("a parent already retired is skipped — the view lands on the orchestrator", () => {
  // The poll's reap retires a whole chain in one pass and the order inside that
  // pass is not fixed. When the parent went first, escaping to it would strand
  // the route on a second session the server no longer has.
  assert.equal(routeEscapeTarget(query({ ...chain([PARENT]) })), ROOT)
})

test("the escape is repeated as each ancestor goes in turn", () => {
  // The other order: the child goes first and the view follows it to the
  // parent, then the parent goes and the same rule moves the view on.
  assert.equal(routeEscapeTarget(query()), PARENT)
  assert.equal(
    routeEscapeTarget(
      query({ routeSessionID: PARENT, sessionID: PARENT, parentID: ROOT, ...chain([CHILD]) }),
    ),
    ROOT,
  )
})

// ------------------------------------------------- when the chain leads nowhere

test("a chain whose gone parent has no remembered parent yields no jump", () => {
  assert.equal(
    routeEscapeTarget(
      query({ isGone: (id) => id === PARENT, parentOfGone: () => undefined }),
    ),
    undefined,
  )
})

test("a parent chain that loops terminates without a jump", () => {
  assert.equal(
    routeEscapeTarget(
      query({ isGone: () => true, parentOfGone: (id) => (id === PARENT ? CHILD : PARENT) }),
    ),
    undefined,
  )
})

// ------------------------------------------------- how the panel is wired

// The panel is @opentui/solid JSX with no render seam a unit test can drive, so
// what a test can hold is the source itself — the same way
// test/tui-sidebar-rows.test.js pins the rest of the panel's wiring.
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

function bodyOf(marker) {
  const start = only(marker)
  const end = source.indexOf("\n  };", start)
  assert.notEqual(end, -1, `no end found for: ${marker}`)
  return source.slice(start, end)
}

test("retireRow is what escapes the route, off the row it is retiring", () => {
  const body = bodyOf("const retireRow = (")
  assert.match(body, /routeEscapeTarget\(\{/)
  assert.match(body, /const route = api\.route\.current;/)
  assert.match(body, /routeName: route\.name/)
  assert.match(body, /route\.name === "session"/)
  assert.match(body, /route\.params\?\.sessionID as string \| undefined/)
  assert.match(body, /parentID: entry\?\.parentID/)
  assert.match(body, /isGone: \(id\) => finished\.has\(id\)/)
  assert.match(body, /parentOfGone,/)
  assert.match(body, /api\.route\.navigate\("session", \{ sessionID: escapeTo \}\)/)
})

test("every path that retires a row goes through retireRow", () => {
  // The poll's reap, the deletion event and dropping a held row. Each one can
  // be the path that owns an ending, so each one has to reach the escape.
  for (const [name, marker] of [
    ["the poll's reap", "const refresh = async (): Promise<void> => {"],
    ["session.deleted", "const onSessionDeleted = (event: unknown): void => {"],
    ["dropping a held row", "const dropRetained = async (id: string): Promise<void> => {"],
  ]) {
    assert.match(bodyOf(marker), /retireRow\(/, `${name} must retire through retireRow`)
  }
})

test("no retiring call site carries a route escape of its own", () => {
  // A duplicated escape is an escape the other paths bypass, which is the
  // defect this file exists for.
  for (const marker of [
    "const refresh = async (): Promise<void> => {",
    "const onSessionDeleted = (event: unknown): void => {",
    "const dropRetained = async (id: string): Promise<void> => {",
  ]) {
    assert.equal(
      bodyOf(marker).includes("api.route.navigate("),
      false,
      `${marker} must leave the route to retireRow`,
    )
  }
})

test("the only other route jumps are opening a row and the idle pre-escape", () => {
  const jumps = source.match(/api\.route\.navigate\(/g) ?? []
  assert.equal(
    jumps.length,
    3,
    "exactly three: openSubagent, onSessionIdle's pre-escape, retireRow's escape",
  )
  assert.match(bodyOf("const openSubagent = (id: string): void => {"), /api\.route\.navigate\(/)
  // session.idle is not an ending, so it retires nothing; it moves the view off
  // a subagent that has stopped running before the session is torn down.
  const idle = bodyOf("const onSessionIdle = (event: unknown): void => {")
  assert.match(idle, /api\.route\.navigate\("session", \{ sessionID: entry\.parentID \}\)/)
  assert.equal(idle.includes("retireRow"), false)
})
