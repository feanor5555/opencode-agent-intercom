// Where the interactive TUI's view is, as far as this process can know it, and
// which session it has to be moved to when the one it is on is deleted.
//
// Why the plugin needs to know at all. opencode's own bus handler answers a
// `session.deleted` for the session the TUI is showing by navigating to its
// start page and toasting "The current session was deleted". The sidebar panel
// carries a guard for exactly that — `escapeRoute` (tui/src/tui.tsx), which
// moves the view up to the caller's session — but it runs on the same event
// and loses: opencode has already navigated home by the time it reads
// `api.route.current`, so it finds `home` instead of the dying session and
// does nothing. The two lie 6 ms apart in the recorded evidence, in that
// order. The panel's guard therefore cannot be the only one; the view has to
// be moved BEFORE the DELETE goes out, which is this side of the plugin.
//
// This module is the half that says whether the move applies. Its whole point
// is that the user is moved ONLY where the view really is on the session being
// deleted: a user sitting in the orchestrator chat while a subagent is reaped
// must not be navigated anywhere at all.
//
// The channel is a file, and it is the mirror image of src/endlesspause.js:
// there the plugin publishes state the panel cannot see, here the PANEL
// publishes state the plugin cannot see. The panel runs in its own module
// graph — a different process where the TUI talks to `opencode serve` — so a
// variable of ours is not readable from it in either direction.
//
//   ~/.cache/opencode-agent-intercom/tui-route.json
//   { "<writer pid>": { "sessionID": "ses_x" | null, "at": <epoch ms> } }
//
// One entry per TUI process, keyed by that process's pid, written by
// tui/src/route-file.ts whenever the route CHANGES (and never on a timer that
// finds it unchanged). `sessionID` is null for a route that names no session —
// the start page, the plugin's own route — and that is what makes "the user is
// not in a session" a published fact rather than an absence.
//
// The pid is what makes the file safe to read: a TUI's route dies with the
// TUI, while the file outlives it, so an entry whose writer is gone is not a
// route any more and is dropped on read. Several opencode instances share the
// one file; each owns its own key.
//
// The in-process latch is the other half of the reading. A plugin that has
// just moved the view itself knows something no file sample older than that
// move can contradict: a cascade deletes a child and then its parent
// milliseconds apart, and the panel's next sample is up to a second away. So
// the latch stands in for the file until a sample taken after it arrives.
//
// Best-effort throughout, in the log.js sense: nothing here throws into a
// teardown path. An absent, unreadable or malformed file reads as "no TUI is
// showing anything", which is exactly the behaviour that stood before this
// existed — the panel's late guard and nothing else.

import fs from "node:fs"
import path from "node:path"

import { cacheDir, log } from "./log.js"

// The sessions this process has seen deleted, most recent last. An escape must
// not land the user on one of them: that is the same start page one link
// further up. Bounded by size alone — the ids are short and the set is a
// negative test, so nothing is lost by forgetting the oldest.
const GONE_SESSIONS_MAX = 256
const goneSessions = new Set()

// The view this process last moved itself, and when. `sessionID` undefined
// means it has moved nothing.
const routeLatch = { sessionID: undefined, at: 0 }

let routeFilePath = ""

// Where the panel publishes its route. Test seam: `setTuiRouteFilePath` points
// reads at another file.
export function tuiRouteFilePath() {
  return routeFilePath || path.join(cacheDir(), "tui-route.json")
}

export function setTuiRouteFilePath(p) {
  routeFilePath = typeof p === "string" ? p : ""
}

// Whether the process that wrote an entry is still running. `process.kill(pid,
// 0)` sends no signal; it asks whether the id can be signalled. EPERM is a live
// process owned by somebody else, ESRCH one that is gone.
export function routeWriterAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

// The entries in a parsed file body that are shaped like one and whose writer
// is still running, as `{ pid, sessionID, at }`. Pure, so the drop rules can be
// asserted without a filesystem or a process table. `sessionID` is null for a
// route that names no session.
export function parseTuiRoutes(raw, isAlive = routeWriterAlive) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const out = []
  for (const [key, value] of Object.entries(raw)) {
    const pid = Number(key)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    if (!isAlive(pid)) continue
    const sessionID =
      typeof value.sessionID === "string" && value.sessionID !== "" ? value.sessionID : null
    out.push({ pid, sessionID, at: Number.isFinite(value.at) ? value.at : 0 })
  }
  return out
}

// The routes published by TUI processes that are still running. `[]` for a file
// that is not there, cannot be read, does not parse, or holds something other
// than an object: this file is a published indicator, so an unreadable one
// reads as "nothing published" rather than as an error anybody has to handle.
export function readPublishedTuiRoutes() {
  let text
  try {
    text = fs.readFileSync(tuiRouteFilePath(), "utf8")
  } catch {
    return []
  }
  try {
    return parseTuiRoutes(JSON.parse(text))
  } catch {
    return []
  }
}

// Record that this process has just moved a TUI view onto `sessionID`. Read
// back by `tuiRouteIsOnSession` until a file sample taken after it arrives.
export function noteTuiRouteSession(sessionID, at = Date.now()) {
  if (typeof sessionID !== "string" || sessionID === "") return
  routeLatch.sessionID = sessionID
  routeLatch.at = at
}

// Record that a session is gone, so no later escape offers it as a target.
export function noteTuiSessionGone(sessionID) {
  if (typeof sessionID !== "string" || sessionID === "") return
  goneSessions.delete(sessionID)
  goneSessions.add(sessionID)
  for (const id of goneSessions) {
    if (goneSessions.size <= GONE_SESSIONS_MAX) break
    goneSessions.delete(id)
  }
}

export function tuiSessionGone(sessionID) {
  return goneSessions.has(sessionID)
}

// Whether a TUI is showing `sessionID` right now.
//
// A published sample taken at or after this process's own last move is an
// observation and outranks the latch — it is what the TUI is really on. Where
// every live writer's sample is older than that move (or there is no live
// writer left to have taken one), the move itself is the youngest thing known
// and the latch answers. No sample and no latch is `false`: nothing is known to
// be showing this session, so nothing is moved.
export function tuiRouteIsOnSession(sessionID) {
  if (typeof sessionID !== "string" || sessionID === "") return false
  const fresh = readPublishedTuiRoutes().filter((entry) => entry.at >= routeLatch.at)
  if (fresh.length > 0) return fresh.some((entry) => entry.sessionID === sessionID)
  return routeLatch.sessionID === sessionID
}

// The session a view sitting on `sessionID` has to be carried to: the first
// candidate that is a session of its own and is not known to be gone. The
// candidates come from the caller in order of preference — the dying session's
// own caller first, its root primary behind it — because the user belongs in
// the session they came from, not on the start page.
//
// `undefined` means there is nowhere known-good to go; the view is then left
// where it is and opencode's own handler does what it did before.
export function tuiEscapeTarget(sessionID, candidates) {
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== "string" || candidate === "") continue
    if (candidate === sessionID) continue
    if (goneSessions.has(candidate)) continue
    return candidate
  }
  return undefined
}

// The debug line every escape decision writes, so a route move is dated and
// attributable in the same log the panel writes its own samples to.
export function logTuiRouteEscape(fields) {
  log("tui route escape before delete", fields)
}

// Test seam: drop the in-process halves (the latch and the gone set) between
// runs. The file is not touched — a test that seeded one owns it.
export function resetTuiRouteState() {
  goneSessions.clear()
  routeLatch.sessionID = undefined
  routeLatch.at = 0
}
