// The route escape that runs when a subagent session ends
// (tui/src/subagent-store.ts: routeEscapeTarget, wired in tui/src/tui.tsx:
// escapeRoute, called from retireRow and from the deletion handler).
//
// The rule the whole file turns on: a session that ends takes the view with it.
// The plugin deletes a subagent's session at every ending it controls, and the
// TUI answers a route naming a session the server no longer has with its start
// page — the orchestrator chat gone from under the user.
//
// Two things that has to survive:
//
//   * whichever path owns the ending. Three paths retire a row
//     (`session.deleted`, the poll's reap, dropping a held row from the panel)
//     and the ones that follow find no row; and a deletion can arrive for a
//     session that has no row at all, which is the case a reap that ran before
//     the view moved into the session leaves behind. Every one of them reaches
//     the same escape, and so does `session.idle`, which moves the view off a
//     subagent that has stopped running before its session is torn down.
//   * the target. It must be a session the SERVER still holds. "This panel
//     retired no row for it" is a different question: `finished` is pruned on
//     every pass that relists a session, so a relisted-then-deleted ancestor
//     reads as row-less and jumping to it lands on the same start page one
//     link further up. Nor is the age of the poll snapshot an answer: a session
//     spawned since the last completed pass appears in no listing and is not
//     gone, so `isSessionLive` counts the passes and reads a listing only for
//     what that pass could have seen.
//
// Run: node --test test/tui-route-escape.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { isSessionLive, routeEscapeTarget } from "../tui/src/subagent-store.ts"

const CHILD = "ses_child"
const PARENT = "ses_parent"
const ROOT = "ses_orchestrator"

// A chain child -> parent -> orchestrator. `alive` names the sessions the
// server still holds; every other session in the chain is one the walk has to
// pass over. The orchestrator is supplied separately, as the panel supplies it.
function chain(alive = [PARENT, ROOT]) {
  const parents = new Map([
    [CHILD, PARENT],
    [PARENT, ROOT],
  ])
  return {
    isAlive: (id) => alive.includes(id),
    parentOfGone: (id) => parents.get(id),
  }
}

function query(over = {}) {
  return {
    routeName: "session",
    routeSessionID: CHILD,
    sessionID: CHILD,
    parentID: PARENT,
    orchestratorID: ROOT,
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

// ------------------------------------------------- when it moves

test("the view inside an ending session moves to its parent", () => {
  assert.equal(routeEscapeTarget(query()), PARENT)
})

test("a parent the server no longer has is skipped — the view lands on the orchestrator", () => {
  // The poll's reap retires a whole chain in one pass and the order inside that
  // pass is not fixed. When the parent went first, escaping to it would strand
  // the route on a second session the server no longer has.
  assert.equal(routeEscapeTarget(query({ ...chain([ROOT]) })), ROOT)
})

test("the escape is repeated as each ancestor goes in turn", () => {
  // The other order: the child goes first and the view follows it to the
  // parent, then the parent goes and the same rule moves the view on.
  assert.equal(routeEscapeTarget(query()), PARENT)
  assert.equal(
    routeEscapeTarget(
      query({
        routeSessionID: PARENT,
        sessionID: PARENT,
        parentID: ROOT,
        ...chain([ROOT]),
      }),
    ),
    ROOT,
  )
})

// -------------------------------- the target has to be one the server has

test("an ancestor with no row of its own is not jumped to unverified", () => {
  // The hole this test exists for: liveness used to be read off "this panel
  // retired no row for it". `finished` is pruned on every pass that relists a
  // session, so an ancestor that was relisted and then deleted — with no row
  // present to record the deletion — read as alive and was jumped to.
  assert.equal(
    routeEscapeTarget(query({ ...chain([]), orchestratorID: undefined })),
    undefined,
    "no session in the chain is known alive and there is no orchestrator to fall back to",
  )
  assert.equal(
    routeEscapeTarget(query({ ...chain([]) })),
    undefined,
    "the orchestrator itself has to pass the same test",
  )
})

test("a chain with no live ancestor falls back to the orchestrator", () => {
  assert.equal(routeEscapeTarget(query({ ...chain([ROOT]), parentID: PARENT })), ROOT)
})

test("the orchestrator catches a chain that leads nowhere", () => {
  // The gone parent remembers no parent of its own, so the walk runs out. The
  // view still has somewhere to be.
  assert.equal(
    routeEscapeTarget(
      query({ isAlive: (id) => id === ROOT, parentOfGone: () => undefined }),
    ),
    ROOT,
  )
  assert.equal(
    routeEscapeTarget(
      query({
        isAlive: (id) => id === ROOT,
        parentOfGone: () => undefined,
        orchestratorID: undefined,
      }),
    ),
    undefined,
  )
})

test("a session with no parent at all still escapes to the orchestrator", () => {
  assert.equal(routeEscapeTarget(query({ parentID: undefined })), ROOT)
  assert.equal(routeEscapeTarget(query({ parentID: "" })), ROOT)
  assert.equal(
    routeEscapeTarget(query({ parentID: undefined, orchestratorID: undefined })),
    undefined,
  )
})

test("a parent chain that loops terminates on the orchestrator", () => {
  assert.equal(
    routeEscapeTarget(
      query({
        isAlive: (id) => id === ROOT,
        parentOfGone: (id) => (id === PARENT ? CHILD : PARENT),
      }),
    ),
    ROOT,
  )
})

test("a loop with no orchestrator terminates without a jump", () => {
  assert.equal(
    routeEscapeTarget(
      query({
        isAlive: () => false,
        parentOfGone: (id) => (id === PARENT ? CHILD : PARENT),
        orchestratorID: undefined,
      }),
    ),
    undefined,
  )
})

test("the escape never lands on the session that is ending", () => {
  // A stale orchestrator id that names the very session being torn down would
  // be the start page under another name.
  assert.equal(
    routeEscapeTarget(query({ orchestratorID: CHILD, ...chain([CHILD, ROOT]) })),
    ROOT,
    "the live ancestor wins",
  )
  assert.equal(
    routeEscapeTarget(query({ orchestratorID: CHILD, ...chain([CHILD]) })),
    undefined,
    "and the ending session is refused as a fallback",
  )
})

// --------------------------------------------- what counts as still alive

// `isSessionLive` is the test every escape target has to pass. The panel's
// three sources of truth about the server: the deletion event, the last
// completed poll pass's listing, and the fact of being an orchestrator this
// panel polls — plus the pass counter that says whether the listing could have
// answered for this session at all.

function liveness(over = {}) {
  return {
    deleted: false,
    listed: false,
    isOrchestrator: false,
    knownAtPass: undefined,
    completedPass: 0,
    ...over,
  }
}

test("a session the last completed pass listed is alive", () => {
  assert.equal(isSessionLive(liveness({ listed: true, completedPass: 4 })), true)
})

test("an orchestrator this panel polls is alive though no listing names it", () => {
  assert.equal(isSessionLive(liveness({ isOrchestrator: true, completedPass: 4 })), true)
})

test("a deletion event outranks a listing and the orchestrator test alike", () => {
  // The pass that was in flight when the deletion landed still carries the
  // session; the event is the younger truth.
  assert.equal(
    isSessionLive(liveness({ deleted: true, listed: true, completedPass: 4 })),
    false,
  )
  assert.equal(
    isSessionLive(liveness({ deleted: true, isOrchestrator: true, knownAtPass: 4, completedPass: 4 })),
    false,
  )
})

test("a session the server never mentioned is not alive", () => {
  assert.equal(isSessionLive(liveness({ completedPass: 4 })), false)
})

test("a session spawned since the last completed pass is alive, not gone", () => {
  // The defect: a nested parent spawned after the last pass appears in no
  // listing, read as gone, and the view escaped past it to the orchestrator.
  // The pass could not have listed it, so its silence is not evidence.
  assert.equal(isSessionLive(liveness({ knownAtPass: 4, completedPass: 4 })), true)
  assert.equal(
    isSessionLive(liveness({ knownAtPass: 4, completedPass: 3 })),
    true,
    "a pass that completed before the panel even learned of it says nothing either",
  )
  assert.equal(
    isSessionLive(liveness({ knownAtPass: 0, completedPass: 0 })),
    true,
    "and before any pass has completed there is no listing to be judged by",
  )
})

test("once a pass has had its chance, the listing is the answer", () => {
  // Pass 5 started after the panel knew of the session, so pass 5 would have
  // listed it if the server still had it.
  assert.equal(isSessionLive(liveness({ knownAtPass: 4, completedPass: 5 })), false)
  assert.equal(
    isSessionLive(liveness({ knownAtPass: 4, completedPass: 5, listed: true })),
    true,
    "and it did list it",
  )
})

test("the escape lands on a freshly spawned nested parent rather than the orchestrator", () => {
  // The two halves together: the walk asks `isSessionLive`, and the parent is
  // a session the server has published a creation for that no completed pass
  // has had the chance to list.
  const knownAtPass = new Map([[PARENT, 7]])
  const isAlive = (id) =>
    isSessionLive({
      deleted: false,
      listed: false,
      isOrchestrator: id === ROOT,
      knownAtPass: knownAtPass.get(id),
      completedPass: 7,
    })
  assert.equal(routeEscapeTarget(query({ isAlive })), PARENT)
  const stale = (id) =>
    isSessionLive({
      deleted: false,
      listed: false,
      isOrchestrator: id === ROOT,
      knownAtPass: knownAtPass.get(id),
      completedPass: 8,
    })
  assert.equal(
    routeEscapeTarget(query({ isAlive: stale })),
    ROOT,
    "a pass that has since had its chance and did not list it makes it gone",
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

test("escapeRoute is the one place the view is moved off an ending session", () => {
  const body = bodyOf("const escapeRoute = (")
  assert.match(body, /routeEscapeTarget\(\{/)
  assert.match(body, /const route = api\.route\.current;/)
  assert.match(body, /routeName: route\.name/)
  assert.match(body, /route\.name === "session"/)
  assert.match(body, /route\.params\?\.sessionID as string \| undefined/)
  assert.match(body, /const knownParent = parentID \?\? parentOfGone\(sessionID\);/)
  assert.match(body, /parentID: knownParent,/)
  assert.match(body, /isAlive: isLiveSession/)
  assert.match(body, /parentOfGone,/)
  assert.match(body, /orchestratorID: orchestratorSessionID\(\)/)
  assert.match(body, /api\.route\.navigate\("session", \{ sessionID: escapeTo \}\)/)
  assert.equal(
    body.includes("finished.has("),
    false,
    "liveness is the server's answer, not the panel's row bookkeeping",
  )
})

test("liveness is the server's answer, and a deletion outranks a pass in flight", () => {
  const start = only("const isLiveSession = (sessionID: string): boolean =>")
  const body = source.slice(start, source.indexOf("\n    });", start))
  assert.match(body, /isSessionLive\(\{/)
  assert.match(body, /deleted: deletedSessions\.has\(sessionID\)/)
  assert.match(body, /listed: listed\.has\(sessionID\)/)
  assert.match(body, /isOrchestrator: isPrimarySession\(sessionID\)/)
  assert.match(body, /knownAtPass: knownAtPass\.get\(sessionID\)/)
  assert.match(body, /completedPass,/)
  only("const deletedSessions = new Set<string>()")
  // The deletion handler is what fills it, before it works out any escape.
  const deleted = bodyOf("const onSessionDeleted = (event: unknown): void => {")
  assert.match(deleted, /deletedSessions\.add\(sessionID\)/)
  assert.ok(
    deleted.indexOf("deletedSessions.add(sessionID)") < deleted.indexOf("const entry ="),
    "the session is marked deleted before the row is looked up and the escape is worked out",
  )
})

test("the poll counts its passes, so a listing is read only for what it saw", () => {
  // The counter is what separates "the server does not have it" from "no
  // completed pass has had the chance to list it yet".
  only("let startedPasses = 0;")
  only("let completedPass = 0;")
  only("const knownAtPass = new Map<string, number>();")
  const body = bodyOf("const refresh = async (): Promise<void> => {")
  assert.match(body, /const passIndex = \+\+startedPasses;/)
  assert.ok(
    body.indexOf("const passIndex = ++startedPasses;") < body.indexOf("api.client.session.status"),
    "the index is taken before the pass asks the server anything",
  )
  assert.match(body, /listed = seen;\n\s*completedPass = passIndex;/)
  assert.match(body, /noteSessionExists\(child\.id\);/, "a listed child is a session the server has")
})

test("a creation event is the server saying the session exists, ahead of any pass", () => {
  const note = bodyOf("const noteSessionExists = (sessionID: string | undefined): void => {")
  assert.match(note, /sessionID\.startsWith\("ses_"\)/, "the same id gate trackPolled applies")
  assert.match(note, /knownAtPass\.set\(sessionID, startedPasses\)/)
  assert.match(note, /if \(knownAtPass\.has\(sessionID\)\) return;/, "the first mention wins")
  const created = bodyOf("const onSessionCreated = (event: unknown): void => {")
  assert.match(created, /noteSessionExists\(info\.id\);/)
  assert.match(created, /noteSessionExists\(info\.parentID\);/, "the spawning session exists too")
  const deleted = bodyOf("const onSessionDeleted = (event: unknown): void => {")
  assert.match(deleted, /knownAtPass\.delete\(sessionID\);/, "and the record goes when the session does")
})

test("the orchestrator fallback is the first polled session that was never a subagent", () => {
  const body = bodyOf("const orchestratorSessionID = (): string | undefined => {")
  assert.match(body, /for \(const sessionID of polledIDs\)/)
  assert.match(body, /if \(isPrimarySession\(sessionID\)\) return sessionID;/)
})

test("retireRow escapes the route off the row it is retiring", () => {
  const body = bodyOf("const retireRow = (")
  assert.match(body, /escapeRoute\(sessionID, entry\?\.parentID, entry !== undefined, "retire"\)/)
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

test("a deletion for a session with no row still moves the view", () => {
  // The hole: the reap's escape fires only for the route as it stood at reap
  // time, so a view that arrived on the session afterwards was never moved,
  // and the deletion handler returned without doing anything at all.
  const body = bodyOf("const onSessionDeleted = (event: unknown): void => {")
  assert.match(body, /\} else \{\s*\n\s*escapeRoute\(sessionID, parentOfGone\(sessionID\), false, "deleted"\);/)
  assert.match(body, /retireRow\(next, sessionID\)/, "a row that is there is still retired")
})

test("no retiring call site carries a route jump of its own", () => {
  // A duplicated escape is an escape the other paths bypass, which is the
  // defect this file exists for.
  for (const marker of [
    "const refresh = async (): Promise<void> => {",
    "const onSessionDeleted = (event: unknown): void => {",
    "const dropRetained = async (id: string): Promise<void> => {",
    "const retireRow = (",
  ]) {
    assert.equal(
      bodyOf(marker).includes("api.route.navigate("),
      false,
      `${marker} must leave the route to escapeRoute`,
    )
  }
})

test("the only route jumps are opening a row and the escape itself", () => {
  const jumps = source.match(/api\.route\.navigate\(/g) ?? []
  assert.equal(jumps.length, 2, "exactly two: openSubagent and escapeRoute's escape")
  assert.match(bodyOf("const openSubagent = (id: string): void => {"), /api\.route\.navigate\(/)
})

test("the idle pre-escape goes through the same escape as an ending row", () => {
  // session.idle is not an ending, so it retires nothing; it moves the view off
  // a subagent that has stopped running before its session is torn down. That
  // move used to jump straight at `entry.parentID`, which puts the view on a
  // parent the server may no longer have — the start page one link further up.
  const idle = bodyOf("const onSessionIdle = (event: unknown): void => {")
  assert.match(idle, /escapeRoute\(sessionID, entry\.parentID, true, "idle"\)/)
  assert.equal(idle.includes("api.route.navigate("), false, "no jump of its own")
  assert.equal(idle.includes("retireRow"), false)
  // The one thing the idle path decides for itself: a subagent the poll still
  // lists and that carries no retention stamp is working, and is left alone.
  assert.match(idle, /const stillWorking = listed\.has\(sessionID\) && !isRetained\(entry\);/)
  assert.match(idle, /if \(!stillWorking\) escapeRoute\(/)
})

// ------------------------------------------------- the debug line

test("the escape writes one debug line carrying what it decided on", () => {
  // The run this repair came from could not be told apart from the other
  // candidate afterwards, because the TUI logged nothing at all. These are the
  // fields that settle it on the next occurrence.
  const body = bodyOf("const escapeRoute = (")
  assert.match(body, /debugLog\("tui route escape", \{/)
  for (const field of [
    /sessionID,/,
    /cause,/,
    /rowPresent,/,
    /route: route\.name,/,
    /routeSessionID: routeSessionID \?\? null,/,
    /parentID: knownParent \?\? null,/,
    /target: escapeTo \?\? null,/,
  ]) {
    assert.match(body, field)
  }
  assert.ok(
    body.indexOf("debugLog(") < body.indexOf("api.route.navigate("),
    "the line is written whether or not a jump follows",
  )
  only('import { debugLog } from "./debug-log.ts";')
})

test("all three callers of the escape are distinguishable in the log", () => {
  // `cause` is the whole point: it says which of the three paths fired, and
  // `rowPresent` whether a row was there to read the parent from.
  for (const [marker, call] of [
    ["const retireRow = (", /escapeRoute\(sessionID, entry\?\.parentID, entry !== undefined, "retire"\)/],
    [
      "const onSessionDeleted = (event: unknown): void => {",
      /escapeRoute\(sessionID, parentOfGone\(sessionID\), false, "deleted"\)/,
    ],
    [
      "const onSessionIdle = (event: unknown): void => {",
      /escapeRoute\(sessionID, entry\.parentID, true, "idle"\)/,
    ],
  ]) {
    assert.match(bodyOf(marker), call)
  }
  const calls = source.match(/escapeRoute\(sessionID/g) ?? []
  assert.equal(calls.length, 3, "and no fourth caller slipped past the log")
})
