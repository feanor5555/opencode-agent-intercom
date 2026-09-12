// The route escape that runs BEFORE a session is deleted (src/tuiroute.js,
// wired into deleteSession in src/client.js).
//
// The defect it repairs: a user watching a SUBAGENT's session was thrown to the
// start page the moment that subagent was reaped. The panel's own guard
// (escapeRoute, tui/src/tui.tsx) exists for exactly that case and cannot win —
// opencode's `session.deleted` handler navigates home on the same event, and
// the panel then reads the route, finds `home` and does nothing. In the
// recorded evidence the delete and the panel's sample lie 6 ms apart, in that
// order, and the escape logged `target:null`.
//
// So the move happens on this side of the wire, before the DELETE goes out, and
// two things have to hold together:
//
//   * the user is moved only where the view REALLY is on the dying session, and
//     then to that session's caller — never to `home`, never anywhere at all
//     for a user who is sitting in another session while a subagent is reaped;
//   * every path that deletes a session carries the guard. It rides inside
//     deleteSession for that reason: teardown, abort, the watchdog's timeout,
//     the retention drop, the child-first cascade, the spawn cleanup, the
//     orphan sweep and the handoff's orphaned session all go through that one
//     function, and a path added later gets it without knowing about it.
//
// Everything runs against a temporary route file, so the machine's own
// ~/.cache/opencode-agent-intercom/tui-route.json is never read or written.
//
// Run: node --test --test-timeout=5000 test/tui-route-predelete.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { deleteSession } from "../src/client.js"
import {
  noteTuiRouteSession,
  noteTuiSessionGone,
  parseTuiRoutes,
  readPublishedTuiRoutes,
  resetTuiRouteState,
  setTuiRouteFilePath,
  tuiEscapeTarget,
  tuiRouteIsOnSession,
} from "../src/tuiroute.js"

const DIR = mkdtempSync(join(tmpdir(), "intercom-tuiroute-"))
const ROUTE_FILE = join(DIR, "tui-route.json")
setTuiRouteFilePath(ROUTE_FILE)

const CHILD = "ses_child"
const PARENT = "ses_parent"
const ROOT = "ses_orchestrator"

// A pid that is certainly gone: a child that has already exited. Asked for
// once — pids are not recycled inside one test run.
const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

// Publish a route as the panel would, under this live process's own pid.
function publishRoute(sessionID, at = Date.now()) {
  writeFileSync(
    ROUTE_FILE,
    JSON.stringify({ [String(process.pid)]: { sessionID, at } }, null, 2) + "\n",
  )
}

function clearRouteFile() {
  rmSync(ROUTE_FILE, { force: true })
}

// A client double that records the order of everything the escape and the
// delete do. `session.delete` answers a confirmed delete; `tui.selectSession`
// is the first of selectTuiSession's three routes, so nothing else is tried.
function fakeClient({ selectOk = true } = {}) {
  const calls = []
  return {
    calls,
    tui: {
      selectSession: async (args) => {
        calls.push(["select", args?.sessionID])
        if (!selectOk) return { error: { name: "InternalError" }, response: { status: 500 } }
        return { data: true }
      },
    },
    session: {
      delete: async (args) => {
        calls.push(["delete", args?.path?.id])
        return { data: true }
      },
    },
  }
}

test.beforeEach(() => {
  resetTuiRouteState()
  clearRouteFile()
})

// ------------------------------------------------- what the file says

test("a published route is read back, and a dead writer's is not", () => {
  const live = parseTuiRoutes({
    [String(process.pid)]: { sessionID: CHILD, at: 5 },
    [String(deadPid)]: { sessionID: PARENT, at: 9 },
  })
  assert.deepEqual(live, [{ pid: process.pid, sessionID: CHILD, at: 5 }])
})

test("a route naming no session is published as null, not as an absence", () => {
  const [entry] = parseTuiRoutes({ [String(process.pid)]: { sessionID: "", at: 3 } })
  assert.equal(entry.sessionID, null)
  assert.equal(entry.at, 3)
})

test("junk in the file is dropped entry by entry, never thrown", () => {
  assert.deepEqual(parseTuiRoutes(null), [])
  assert.deepEqual(parseTuiRoutes([{ sessionID: CHILD }]), [])
  assert.deepEqual(
    parseTuiRoutes({
      notapid: { sessionID: CHILD, at: 1 },
      "0": { sessionID: CHILD, at: 1 },
      [`${process.pid}`]: 42,
    }),
    [],
  )
  const [entry] = parseTuiRoutes({ [String(process.pid)]: { sessionID: CHILD } })
  assert.equal(entry.at, 0, "a sample with no timestamp is the oldest there is")
})

test("an absent or unparsable file reads as nothing published", () => {
  clearRouteFile()
  assert.deepEqual(readPublishedTuiRoutes(), [])
  writeFileSync(ROUTE_FILE, "{ not json")
  assert.deepEqual(readPublishedTuiRoutes(), [])
  assert.equal(tuiRouteIsOnSession(CHILD), false)
})

// ------------------------------------------------- whose view is moved

test("the view is moved off the dying session, to its caller, before the delete", async () => {
  publishRoute(CHILD)
  const client = fakeClient()
  assert.equal(await deleteSession(client, CHILD, { parentID: PARENT, fallbackID: ROOT }), true)
  assert.deepEqual(client.calls, [
    ["select", PARENT],
    ["delete", CHILD],
  ])
})

test("a user sitting in another session is left alone: no navigation at all", async () => {
  publishRoute(ROOT)
  const client = fakeClient()
  assert.equal(await deleteSession(client, CHILD, { parentID: PARENT, fallbackID: ROOT }), true)
  assert.deepEqual(client.calls, [["delete", CHILD]])
})

test("a route on no session at all moves nobody", async () => {
  publishRoute(null)
  const client = fakeClient()
  await deleteSession(client, CHILD, { parentID: PARENT })
  assert.deepEqual(client.calls, [["delete", CHILD]])
})

test("no TUI publishing anything is the behaviour that stood before: delete and nothing else", async () => {
  clearRouteFile()
  const client = fakeClient()
  await deleteSession(client, CHILD, { parentID: PARENT })
  assert.deepEqual(client.calls, [["delete", CHILD]])
})

test("a delete with no parent named still deletes, and moves nobody with no target", async () => {
  publishRoute(CHILD)
  const client = fakeClient()
  assert.equal(await deleteSession(client, CHILD), true)
  assert.deepEqual(client.calls, [["delete", CHILD]])
})

// ------------------------------------------------- where the view lands

test("the caller comes first, the root primary behind it", () => {
  assert.equal(tuiEscapeTarget(CHILD, [PARENT, ROOT]), PARENT)
  assert.equal(tuiEscapeTarget(CHILD, [undefined, ROOT]), ROOT)
  assert.equal(tuiEscapeTarget(CHILD, ["", ROOT]), ROOT)
  assert.equal(tuiEscapeTarget(CHILD, [CHILD, ROOT]), ROOT, "never the dying session itself")
  assert.equal(tuiEscapeTarget(CHILD, []), undefined)
  assert.equal(tuiEscapeTarget(CHILD, undefined), undefined)
})

test("a session this process already deleted is never offered as a target", async () => {
  noteTuiSessionGone(PARENT)
  assert.equal(tuiEscapeTarget(CHILD, [PARENT, ROOT]), ROOT)
  noteTuiSessionGone(ROOT)
  assert.equal(tuiEscapeTarget(CHILD, [PARENT, ROOT]), undefined)
  // And with nowhere good to go the delete still happens: the escape is a
  // guard, never a gate.
  publishRoute(CHILD)
  const client = fakeClient()
  assert.equal(await deleteSession(client, CHILD, { parentID: PARENT, fallbackID: ROOT }), true)
  assert.deepEqual(client.calls, [["delete", CHILD]])
})

test("a confirmed delete marks the session gone for every later escape", async () => {
  const client = fakeClient()
  await deleteSession(client, PARENT)
  assert.equal(tuiEscapeTarget(CHILD, [PARENT, ROOT]), ROOT)
})

test("a delete the server refused leaves the session usable as a target", async () => {
  const client = {
    session: { delete: async () => ({ data: false }) },
  }
  assert.equal(await deleteSession(client, PARENT), false)
  assert.equal(tuiEscapeTarget(CHILD, [PARENT, ROOT]), PARENT)
})

// ------------------------------------------------- the cascade

test("a cascade escapes at every level, on the move this process just made", async () => {
  // The panel publishes on a change and up to a tick later; a parent deleted
  // milliseconds after its child would otherwise read a sample that still names
  // the child and leave the user on the parent that is going.
  publishRoute(CHILD, 1000)
  const client = fakeClient()
  await deleteSession(client, CHILD, { parentID: PARENT, fallbackID: ROOT })
  await deleteSession(client, PARENT, { parentID: ROOT, fallbackID: ROOT })
  assert.deepEqual(client.calls, [
    ["select", PARENT],
    ["delete", CHILD],
    ["select", ROOT],
    ["delete", PARENT],
  ])
})

test("a sample taken after this process's own move outranks it", async () => {
  noteTuiRouteSession(PARENT, 1000)
  assert.equal(tuiRouteIsOnSession(PARENT), true)
  // The user navigated on, and the panel published it.
  publishRoute(ROOT, 2000)
  assert.equal(tuiRouteIsOnSession(PARENT), false)
  assert.equal(tuiRouteIsOnSession(ROOT), true)
  const client = fakeClient()
  await deleteSession(client, PARENT, { parentID: ROOT })
  assert.deepEqual(client.calls, [["delete", PARENT]], "nobody is there to move")
})

test("a move that the TUI refused is not latched", async () => {
  publishRoute(CHILD, 1000)
  const client = fakeClient({ selectOk: false })
  await deleteSession(client, CHILD, { parentID: PARENT })
  assert.deepEqual(client.calls, [
    ["select", PARENT],
    ["delete", CHILD],
  ])
  // The view never reached PARENT, so deleting PARENT moves nothing on the
  // strength of a move that did not happen.
  assert.equal(tuiRouteIsOnSession(PARENT), false)
})

// ------------------------------------------------- every path carries it

const SRC = fileURLToPath(new URL("../src", import.meta.url))

function read(file) {
  return readFileSync(join(SRC, file), "utf8")
}

// One whole call, from `deleteSession(` to the parenthesis that closes it. A
// fixed window would cut a call that spans lines, and a lazy regex stops at the
// first inner `)` — both would read an argument list as absent that is there.
function callText(body, start) {
  let depth = 0
  for (let i = body.indexOf("(", start); i < body.length; i += 1) {
    if (body[i] === "(") depth += 1
    else if (body[i] === ")") {
      depth -= 1
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  return body.slice(start)
}

test("the escape sits inside deleteSession, ahead of the request", () => {
  const body = read("client.js")
  const escape = body.indexOf("await escapeTuiRouteOffSession(client, sessionID,")
  const request = body.indexOf('const op = "deleteSession (session.delete)"')
  assert.ok(escape !== -1 && request !== -1)
  assert.ok(escape < request, "the view is moved before the DELETE is sent, or the race is lost")
  assert.match(body, /if \(deleted\) noteTuiSessionGone\(sessionID\)/)
  // The guard asks before it acts: a user who is elsewhere is not navigated.
  assert.match(
    body,
    /if \(!tuiRouteIsOnSession\(sessionID\)\) return undefined/,
    "no route on the dying session means no navigation and no toast",
  )
})

test("every session delete in the plugin names where a watching user lands", () => {
  // The call sites, as they stand in the tree: teardown (idle, error, watchdog
  // timeout, retention drop, child-first cascade), the orphan sweep, the spawn
  // cleanup after a failed prompt, the abort tool, the wind-down cleanup and
  // the handoff's orphaned new session.
  const sites = []
  for (const file of ["teardown.js", "tools.js", "handoffwiring.js"]) {
    const body = read(file)
    for (const match of body.matchAll(/deleteSession\(\s*client,/g)) {
      sites.push([file, callText(body, match.index)])
    }
  }
  assert.equal(sites.length, 6, "the delete sites this repair was written against")
  for (const [file, call] of sites) {
    assert.match(call, /cause:/, `${file}: ${call} names no cause`)
    assert.match(call, /parentID/, `${file}: ${call} names no session to escape to`)
  }
})

test("the teardown's fallback is read while the registry still holds the chain", () => {
  const body = read("teardown.js")
  assert.match(body, /fallbackID: rootPrimaryFor\(parentID\)/)
  const escape = body.indexOf("fallbackID: rootPrimaryFor(parentID)")
  const forget = body.indexOf("forgetSessionDirectory(sessionID)\n  } finally {")
  assert.ok(escape !== -1 && escape < forget)
})
