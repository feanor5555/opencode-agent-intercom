// The published half of the endless self-stop pause.
//
// A self-stop pauses endless mode for ONE primary session, in the in-process
// `endlessPauses` map (registry.pauseEndless). That map is the authority and
// stays the authority: nothing here is read back into a decision the plugin
// takes. What this module adds is a READER outside the process — the sidebar
// panel, which runs in its own module graph and cannot see a Map of ours, and
// which otherwise paints `[on]` on a session whose loop has stopped.
//
// Why a file. The only channel this plugin already publishes state on is the
// session title (publishRetentionState, src/teardown.js), and that channel
// exists because a SUBAGENT's title is the plugin's own field. A primary's
// title is the user's chat title; the plugin does not own it and must not
// stamp it. So the pause travels the way the plugin's other machine state
// does: a file under the user-private cache dir (0700), next to the debug log
// and the result overflow files.
//
// What the file holds, keyed by the paused session id:
//
//   { "ses_x": { "reason": "no open points left — paused for this session",
//                "at": 1757280000000, "pid": 4711 } }
//
// `pid` is the process that set the pause, and it is what makes the file safe
// to read. The pause is process-local: it dies with the plugin process, and an
// opencode session outlives that process — it can be resumed by the next
// instance, which has no pause for it. An entry whose writer is gone is
// therefore not a pause any more, and both sides drop it: a reader ignores it
// and the next write here prunes it. Several opencode instances share this one
// file; each owns its own keys and no writer ever truncates another's, so an
// instance's own load needs no sweep.
//
// Best-effort in the log.js sense: nothing in this module throws into the
// pause path. A failed write costs the sidebar its indicator and nothing else
// — the mode's behaviour is decided by the map, never by this file.

import fs from "node:fs"
import path from "node:path"

import { cacheDir, ensureCacheDir, log, errMsg } from "./log.js"

// Where the published pauses live: one JSON object in the plugin's cache dir.
export function endlessPauseFilePath() {
  return path.join(cacheDir(), "endless-pauses.json")
}

// Whether the process that wrote an entry is still running. `process.kill(pid,
// 0)` sends no signal; it answers whether the id can be signalled. EPERM means
// the process exists and belongs to somebody else, which is still alive — only
// ESRCH (and an id that is no id) means gone.
export function pauseWriterAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

// One entry as it is published, or null for anything that is not one.
function normaliseEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const pid = value.pid
  if (!Number.isInteger(pid) || pid <= 0) return null
  return {
    reason: typeof value.reason === "string" ? value.reason : "",
    at: Number.isFinite(value.at) ? value.at : 0,
    pid,
  }
}

// The file's own object, entries normalised. `{}` for a file that is not there,
// cannot be read, does not parse, or holds something other than an object: this
// file is a published indicator, so an unreadable one reads as "nothing
// published" rather than as an error anybody has to handle.
export function readPublishedEndlessPauses() {
  let text
  try {
    text = fs.readFileSync(endlessPauseFilePath(), "utf8")
  } catch {
    return {}
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out = {}
  for (const [sessionID, value] of Object.entries(raw)) {
    const entry = normaliseEntry(value)
    if (entry) out[sessionID] = entry
  }
  return out
}

// Drops every entry whose writer is gone. Applied to each write, which is what
// bounds the file: a process that crashed with pauses set leaves entries that
// the next writer on this machine clears.
export function pruneDeadEndlessPauses(pauses, isAlive = pauseWriterAlive) {
  const out = {}
  for (const [sessionID, entry] of Object.entries(pauses)) {
    if (isAlive(entry.pid)) out[sessionID] = entry
  }
  return out
}

// Atomic replace: write a sibling temp file and rename it over the target, so a
// reader never sees a half-written object. Returns whether it reached the disk.
function writePauses(pauses) {
  const target = endlessPauseFilePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    ensureCacheDir()
    fs.writeFileSync(tmp, JSON.stringify(pauses, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch (err) {
    log("endless: publishing the pause failed", { error: errMsg(err) })
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

// Publishes the pause of one primary session under this process's id.
export function publishEndlessPause(sessionID, reason = "", at = Date.now()) {
  if (!sessionID) return false
  const pauses = pruneDeadEndlessPauses(readPublishedEndlessPauses())
  pauses[sessionID] = {
    reason: String(reason || ""),
    at: Number.isFinite(at) ? at : Date.now(),
    pid: process.pid,
  }
  return writePauses(pauses)
}

// Takes one session's pause off the file. A session that has nothing published
// costs no write — every primary replacement runs through here (forgetPrimary),
// and the common case is a primary that was never paused.
export function unpublishEndlessPause(sessionID) {
  if (!sessionID) return false
  const pauses = readPublishedEndlessPauses()
  if (!Object.prototype.hasOwnProperty.call(pauses, sessionID)) return false
  delete pauses[sessionID]
  return writePauses(pruneDeadEndlessPauses(pauses))
}
