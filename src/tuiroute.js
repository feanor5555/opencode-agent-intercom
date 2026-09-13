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
//   { "<writer pid>": { "sessionID": "ses_x" | null, "at": <epoch ms>,
//                       "server": "pid:4711" | "url:http://127.0.0.1:4788",
//                       "panel": "primary" | "observer" } }
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
// `server` is what makes the file safe to ACT on. The pid says only that a
// writer is alive, not that it is looking at this plugin's sessions: two TUIs
// on one machine — two attached to one `opencode serve`, or two interactive
// instances side by side — share the file, and a session id from one server
// means nothing on the other. Without the field the escape moved ANY live
// writer whose sample named the dying session, so a panel with nothing to do
// with the delete was navigated too. So each side names its own server, in the
// one form both can produce out of what they already hold (`serverIdentity`):
//
//   * an `opencode serve` has a listening address, and the panel attached to it
//     holds that same address as its client's base URL. That is `url:<address>`
//     and it is unique per server on the machine (one port, one server).
//   * an interactive `opencode` binds nothing: the server runs IN the TUI's own
//     process (learnings.md, "PluginInput.serverUrl is a placeholder on an
//     interactive TUI instance"; the process table shows one `opencode` process
//     with no child). Its address is the placeholder nothing listens on and
//     names no server, so the process itself is the identity: `pid:<pid>`,
//     written by both halves out of `process.pid` and equal because it is one
//     process.
//
// An entry therefore belongs to this server when its `server` equals this
// plugin's own identity, and equally when the entry's writer IS this process —
// same process, same server, whatever either side made of its address.
//
// An entry that names no server at all — a panel bundle from before this field,
// still running — is MOVED, as it was before this existed. Dropping it silently
// would take the escape away from that panel with nothing to show for it, while
// moving it is the behaviour it was written under; the mixed state lasts until
// that TUI restarts, and every read that meets one says so in the log
// (`tui route scope`).
//
// `panel` is what keeps a SECOND TUI on THIS server out of the move. The
// select-session post is server-wide: one writer whose sample names the dying
// session is enough to navigate every panel attached to it. So a panel that is
// not the owner publishes `panel: "observer"` and is not read as a reason to
// move while a live primary remains. If this server has no live primary, one
// remaining observer is taken as the owner (lowest pid) so delete-time does
// not wait on that panel's next write. If several primaries are in the file —
// two first publishes that raced — only one of them is a reason to move, the
// same lowest-pid rule. Missing `panel` is `"primary"` — the behaviour the
// field was written under, and the only value a single panel ever needs.
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

// The address this plugin's server listens on, "" where it listens on none.
// Set from `setServerUrl` (src/client.js), which is the one funnel the plugin's
// address goes through and which already knows the placeholder address of an
// in-process server for what it is.
let serverAddress = ""

// The identity of the server a route entry belongs to, in the one form both
// halves can produce without asking anybody: the listening address where there
// is one, and otherwise the process the server runs in. Mirrored verbatim in
// tui/src/route-file.ts — the two must agree character for character, which
// test/tui-route-publish.test.js pins.
export function serverIdentity(address, pid = process.pid) {
  const normalized = typeof address === "string" ? address.replace(/\/+$/, "") : ""
  return normalized ? `url:${normalized}` : `pid:${pid}`
}

// Records the address of the server this plugin runs in. An empty value is an
// in-process server, and identity falls back to this process.
export function setTuiRouteServerAddress(address) {
  serverAddress = typeof address === "string" ? address.replace(/\/+$/, "") : ""
}

export function ownServerIdentity() {
  return serverIdentity(serverAddress)
}

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
// is still running, as `{ pid, sessionID, at, server, panel }`. Pure, so the
// drop rules can be asserted without a filesystem or a process table.
// `sessionID` is null for a route that names no session; `server` is null for
// an entry that names no server — a panel bundle from before that field.
// `panel` is `"observer"` only when the file says so; anything else, including
// a missing field, is `"primary"`.
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
    const server = typeof value.server === "string" && value.server !== "" ? value.server : null
    const panel = value.panel === "observer" ? "observer" : "primary"
    out.push({ pid, sessionID, at: Number.isFinite(value.at) ? value.at : 0, server, panel })
  }
  return out
}

// The one same-server panel that is a reason to move: the live primary with
// the lowest pid, or, if this server has no live primary, the remaining
// observer with the lowest pid. A raced first-publish can leave two primaries
// in the file; a primary that has just exited can leave only observers —
// delete-time must not wait on the remaining panel's next write.
function owningPanel(entries) {
  if (!entries.length) return undefined
  const primaries = []
  for (const entry of entries) {
    if (entry.panel !== "observer") primaries.push(entry)
  }
  const pool = primaries.length > 0 ? primaries : entries
  let owner = pool[0]
  for (const entry of pool) {
    if (entry.pid < owner.pid) owner = entry
  }
  return owner
}

// The published entries this plugin's server may act on, split from the ones it
// may not, as `{ mine, foreign, unscoped, observers }` — `mine` holds the
// entries the escape reads, `unscoped` the ones inside it that named no server,
// `observers` a same-server panel that is not the owner, `foreign` the count
// that was left alone. Pure over the entries, so the rule can be asserted
// without a file.
//
// Three ways an entry is this server's:
//   * its writer IS this process. An interactive `opencode` runs the server in
//     the TUI's process, so this is the whole interactive case and it holds
//     however either half read its own address.
//   * it names this server's identity. Among those, only the owning panel (see
//     `owningPanel`) is a reason to move.
//   * it names no server at all — the pre-field panel, moved as it was before.
export function routesOnThisServer(entries, self = ownServerIdentity(), pid = process.pid) {
  const mine = []
  let foreign = 0
  let unscoped = 0
  let observers = 0
  const here = []
  for (const entry of entries ?? []) {
    if (entry.server === null || entry.server === undefined) {
      unscoped += 1
      mine.push(entry)
      continue
    }
    if (entry.pid === pid || entry.server === self) {
      here.push(entry)
      continue
    }
    foreign += 1
  }
  const owner = owningPanel(here)
  for (const entry of here) {
    if (owner && entry.pid === owner.pid) mine.push(entry)
    else observers += 1
  }
  return { mine, foreign, unscoped, observers }
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

// Whether a TUI ON THIS SERVER is showing `sessionID` right now.
//
// Another server's panel is not read at all — neither as a reason to move nor
// as a fresher sample that could outrank the latch — because its route says
// nothing about a session it cannot even see.
//
// A published sample taken at or after this process's own last move is an
// observation and outranks the latch — it is what the TUI is really on. Where
// every live writer's sample is older than that move (or there is no live
// writer left to have taken one), the move itself is the youngest thing known
// and the latch answers. No sample and no latch is `false`: nothing is known to
// be showing this session, so nothing is moved.
export function tuiRouteIsOnSession(sessionID) {
  if (typeof sessionID !== "string" || sessionID === "") return false
  const { mine, foreign, unscoped, observers } = routesOnThisServer(readPublishedTuiRoutes())
  // Only when the file held something this decision had to rule on: an entry
  // another server owns, one from a panel that names no server, or a second
  // panel on this server.
  if (foreign > 0 || unscoped > 0 || observers > 0) {
    log("tui route scope", {
      sessionID,
      server: ownServerIdentity(),
      mine: mine.length,
      foreign,
      unscoped,
      observers,
    })
  }
  const fresh = mine.filter((entry) => entry.at >= routeLatch.at)
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

// Test seam: drop the in-process halves (the latch, the gone set and the
// server address) between runs. The file is not touched — a test that seeded
// one owns it.
export function resetTuiRouteState() {
  goneSessions.clear()
  routeLatch.sessionID = undefined
  routeLatch.at = 0
  serverAddress = ""
}
