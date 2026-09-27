// The published half of a running endless cycle: which step it is in.
//
// While a cycle is pending or executing for a primary session, the in-process
// latches (`pendingEndless`, `endlessInProgress`, src/state.js) are the
// authority, and nothing here is read back into a decision the plugin takes.
// What this module adds is a READER outside the process — the sidebar panel,
// which otherwise paints `[on]` through the whole cycle, a wait that runs to
// minutes while the orchestrator cannot delegate.
//
// What the file holds, keyed by the primary session the cycle replaces:
//
//   { "ses_x": { "step": "quiesce", "running": 2, "at": 1757280000000, "pid": 4711 } }
//
// `step` is one of ENDLESS_CYCLE_STEPS. `running` is the count of the
// primary's own subagents still running, published for `quiesce` only. `at` is
// when the step was entered, `pid` the process whose latch the entry mirrors:
// the latch dies with that process, so an entry whose writer is gone is no
// cycle any more, and a reader ignores it and the next write here prunes it.
// Several opencode instances share this one file; each owns its own keys.
//
// Best-effort in the log.js sense: nothing in this module throws into the
// cycle. A failed write costs the sidebar its indicator and nothing else.

import fs from "node:fs"
import path from "node:path"

import { cacheDir, ensureCacheDir, log, errMsg } from "./log.js"
import { pauseWriterAlive } from "./endlesspause.js"

// The steps in the order a cycle passes them.
//
// `turn`      — latched; the primary's current turn has not ended yet
// `quiesce`   — waiting for the primary's own subagents to finish
// `wind-down` — the open points are being written to the todo file, from the
//               prepare step through the wind-down turn and its child's settle
// `successor` — the rewrite is being confirmed and the fresh session started
export const ENDLESS_CYCLE_STEPS = Object.freeze(["turn", "quiesce", "wind-down", "successor"])

export function endlessCycleFilePath() {
  return path.join(cacheDir(), "endless-cycles.json")
}

function normaliseEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const pid = value.pid
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (!ENDLESS_CYCLE_STEPS.includes(value.step)) return null
  const entry = {
    step: value.step,
    at: Number.isFinite(value.at) ? value.at : 0,
    pid,
  }
  if (Number.isInteger(value.running) && value.running >= 0) entry.running = value.running
  return entry
}

// The file's own object, entries normalised; `{}` for anything unreadable.
export function readPublishedEndlessCycles() {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(endlessCycleFilePath(), "utf8"))
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

export function pruneDeadEndlessCycles(cycles, isAlive = pauseWriterAlive) {
  const out = {}
  for (const [sessionID, entry] of Object.entries(cycles)) {
    if (isAlive(entry.pid)) out[sessionID] = entry
  }
  return out
}

// Atomic replace through a sibling temp file.
function writeCycles(cycles) {
  const target = endlessCycleFilePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    ensureCacheDir()
    fs.writeFileSync(tmp, JSON.stringify(cycles, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch (err) {
    log("endless: publishing the cycle step failed", { error: errMsg(err) })
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

// Publishes the step one primary's cycle is in, under this process's id. An
// entry already standing with the same step and count costs no write — the
// quiesce wait republishes on every poll, and only a changed count reaches the
// disk. `at` moves only when the step itself changes.
export function publishEndlessCycleStep(sessionID, step, { running } = {}, at = Date.now()) {
  if (!sessionID || !ENDLESS_CYCLE_STEPS.includes(step)) return false
  const cycles = readPublishedEndlessCycles()
  const count = step === "quiesce" && Number.isInteger(running) && running >= 0 ? running : undefined
  const current = cycles[sessionID]
  if (current && current.pid === process.pid && current.step === step && current.running === count) {
    return false
  }
  const entry = {
    step,
    at: current && current.pid === process.pid && current.step === step ? current.at : at,
    pid: process.pid,
  }
  if (count !== undefined) entry.running = count
  const next = pruneDeadEndlessCycles(cycles)
  next[sessionID] = entry
  return writeCycles(next)
}

// Takes one session's cycle off the file. A session with nothing published
// costs no write — every primary replacement runs through here.
export function unpublishEndlessCycle(sessionID) {
  if (!sessionID) return false
  const cycles = readPublishedEndlessCycles()
  if (!Object.prototype.hasOwnProperty.call(cycles, sessionID)) return false
  delete cycles[sessionID]
  return writeCycles(pruneDeadEndlessCycles(cycles))
}
