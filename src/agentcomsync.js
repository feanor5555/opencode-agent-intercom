// Makes the `show agentcom` switch retroactive.
//
// The switch lives in the shared settings file
// (~/.config/opencode/agent-intercom.json, key `showAgentcom`) and is flipped
// by the companion TUI plugin, which is a separate package in a separate
// process: it writes the file and nothing else. opencode carries no event for
// that write, so this module makes one — an fs.watch on the directory the
// settings file sits in. The event says only that the file changed, never what
// changed in it, so the flip is still OBSERVED by comparing the resolved value
// against the last one seen, and a change is what triggers the sweep. A slow
// fallback tick covers a write the watch did not report.
//
// The sweep itself is applyAgentcomVisibility (src/client.js), run over two
// sets of sessions:
//   - the sessions tracked as primaries (state.js `primarySessions`), which is
//     every orchestrator that has called one of the plugin's tools in this
//     process;
//   - the sessions this process has actually posted switch-governed traffic
//     into (client.js `agentcomSessionIds`). The fresh orchestrator a handoff
//     creates is the case the first set misses: it receives its kickoff before
//     it has ever called a tool.
// The spawn task prompt is the one plugin posting the switch never governed —
// it lands in the SUBAGENT's session and is that session's whole instruction.
// It is not hideable, so its session enters neither set and the sweep never
// reaches it.
//
// A session this process did not itself post into and that has not called a
// tool since — an old orchestrator session opened again after an opencode
// restart — is outside both sets, and its notices keep the flag they were
// posted with until it uses the plugin again.
//
// Everything is best-effort: a sweep that fails leaves the notices as they
// were, and the flip itself — which is a file write in another process — is
// unaffected either way.

import { watch as watchPath } from "node:fs"
import { basename, dirname } from "node:path"

import { getSettings, invalidateSettingsCache, settingsFilePath } from "./settings.js"
import { primarySessions } from "./state.js"
import { agentcomSessionIds, applyAgentcomVisibility } from "./client.js"
import { log, errMsg } from "./log.js"

// The flip is noticed by watching the settings file, not by asking for it. The
// fallback tick below is the backstop for the one case the watch cannot cover
// on its own, and is deliberately slow: it is not how the switch is meant to
// arrive, so it must not be a heartbeat. A per-second tick is what grew
// ~/.cache/opencode-agent-intercom/debug.log to hundreds of megabytes.
export const AGENTCOM_FALLBACK_INTERVAL_MS = 300000

// How long the watch waits after a filesystem event before observing. One save
// of the file produces several events — a `rename` for the replace and a
// `change` for the content — and this collapses them into one sweep. Short
// enough that the switch still feels immediate.
export const AGENTCOM_WATCH_DEBOUNCE_MS = 120

// The value the last observation resolved. `undefined` means nothing has been
// observed yet: the first observation only records, since no flip has happened
// that this process could act on.
let lastSeen
// One sweep at a time. A sweep walks a session's whole history and may issue a
// PATCH per stale part, which can outlive one tick; a second sweep started on
// top of it would fight the first over the same parts.
let sweeping = false
let timer = null
let watcher = null
let debounceTimer = null

// Compares the switch against the last value seen and, on a change, brings
// every tracked primary's already-posted notices to the new visibility.
// `sessions` overrides the set swept (tests, and any caller that knows better
// than the tracked set). Returns what the observation did:
// { flipped, hidden, sessions } — `flipped` false means the value is unchanged
// or this was the first observation, and nothing was written.
export async function syncAgentcomVisibility(client, { sessions } = {}) {
  const show = getSettings().showAgentcom
  if (lastSeen === undefined) {
    lastSeen = show
    return { flipped: false, hidden: !show, sessions: 0 }
  }
  if (lastSeen === show) return { flipped: false, hidden: !show, sessions: 0 }
  // Advance BEFORE the sweep: a sweep that cannot write — a server without the
  // experimental part route, a refused request — must cost one attempt per
  // flip, not one per tick for the rest of the process's life.
  lastSeen = show
  const targets = sessions ?? [...new Set([...primarySessions, ...agentcomSessionIds()])]
  log("agentcom visibility flipped", { showAgentcom: show, sessions: targets.length })
  for (const sessionID of targets) {
    try {
      await applyAgentcomVisibility(client, sessionID, { hidden: !show })
    } catch (err) {
      // applyAgentcomVisibility swallows its own failures; this is the belt to
      // that braces, so one session can never end the sweep of the others.
      log("agentcom visibility sweep failed", { sessionID, err: errMsg(err) })
    }
  }
  return { flipped: true, hidden: !show, sessions: targets.length }
}

// Watches the settings file for the write that flips the switch, and calls
// `observe` once the events of one write have settled. Returns the FSWatcher,
// or null when the directory cannot be watched — a missing config directory, or
// a platform/filesystem fs.watch does not serve. Failure is not an error: the
// fallback tick still carries the flip, just later.
//
// The DIRECTORY is watched, not the file. The TUI plugin replaces the settings
// file rather than rewriting it in place, and a watch bound to a file follows
// the inode: after one replace it is watching a file nothing will ever write to
// again, and it goes deaf without saying so. A directory watch survives the
// replace and reports it as a `rename` of the file's own name.
function watchSettingsFile(observe) {
  const file = settingsFilePath()
  const name = basename(file)
  try {
    const w = watchPath(dirname(file), (_eventType, filename) => {
      // `filename` is null on the platforms that do not report it; there every
      // event in the directory has to count, since the one we want cannot be
      // told from the rest.
      if (filename != null && filename !== name) return
      // The write is younger than the settings TTL, so the cached answer is
      // still the value from before it — the flip would be missed until the
      // cache expired on its own.
      invalidateSettingsCache()
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        observe()
      }, AGENTCOM_WATCH_DEBOUNCE_MS)
      debounceTimer.unref?.()
    })
    // A watcher that dies later — the directory removed under it — must not
    // throw into opencode's event loop. The fallback tick keeps working.
    w.on("error", (err) => log("agentcom settings watch failed", errMsg(err)))
    w.unref?.()
    return w
  } catch (err) {
    log("agentcom settings watch unavailable", { dir: dirname(file), err: errMsg(err) })
    return null
  }
}

// Starts the observation. Idempotent: opencode calls the plugin factory once
// per session in one process, and one watch per process is what is wanted; the
// fallback timer is the handle that records whether it is already running, and
// is what comes back so a second call is visibly the same watch.
//
// Two ways in, and both end in the same comparison against `lastSeen`:
//   - the settings file being written, which is how the flip normally arrives;
//   - a slow fallback tick, for the write the watch did not see — no watcher at
//     all, or a watcher that stopped reporting.
// Both handles are unref'd so neither holds the process open.
export function startAgentcomVisibilityWatch(client, { intervalMs = AGENTCOM_FALLBACK_INTERVAL_MS } = {}) {
  if (timer) return timer
  // Seed from the value in effect at start, so a switch that was already off
  // when opencode came up is not read as a flip.
  lastSeen = getSettings().showAgentcom
  const observe = () => {
    if (sweeping) return
    sweeping = true
    void syncAgentcomVisibility(client)
      .catch((err) => log("agentcom visibility watch error", errMsg(err)))
      .finally(() => {
        sweeping = false
      })
  }
  watcher = watchSettingsFile(observe)
  timer = setInterval(observe, intervalMs)
  timer.unref?.()
  return timer
}

// Test-only: stops the watch and the fallback tick and forgets the observed
// value, so the next start or sync begins from nothing. Not part of the plugin
// contract.
export function resetAgentcomVisibilityWatch() {
  if (timer) clearInterval(timer)
  timer = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  if (watcher) watcher.close()
  watcher = null
  lastSeen = undefined
  sweeping = false
}
