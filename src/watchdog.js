// ---- Inactivity watchdog (dead-man's switch) ---------------------------------
//
// What this guards against: an LLM call inside a subagent that hangs forever
// (server timeout, network partition, model that never streams a token). No
// `session.idle` event ever fires, so the normal wake-on-finish path never
// runs, and the registry entry + global slot stay occupied for the life of
// the opencode process. The orchestrator also never gets woken, so it sits
// idle waiting for a result that will never arrive.
//
// The fix is a periodic sweep over the registry: any entry whose `lastActivityAt`
// is older than `maxSubagentAgeMs` is treated as hung, aborted cooperatively,
// and its slot is freed. The orchestrator is woken with a timeout notice so it
// can re-dispatch.
//
// Important: the threshold is INACTIVITY (time since the last event), not
// total lifetime. A long-running subagent that keeps emitting events is
// healthy — its `lastActivityAt` gets bumped on every event by `handleEvent`
// in hooks.js, so it never trips. Only a subagent that produces ZERO events for
// `maxSubagentAgeMs` (default 90 s) gets killed.

import { registry, aborted } from "./state.js"
import { getSettings } from "./settings.js"
import { abortSession } from "./client.js"
import { teardownSubagent } from "./teardown.js"
import { timeoutNotice } from "./notices.js"
import { log, errMsg } from "./log.js"

// How often the sweep runs. 5 s is a good balance: cheap (just a Map scan
// over a handful of entries) and timely enough that the worst-case extra
// hang over the configured threshold is 5 s. The sweep is asynchronous, but
// the work per tick is small (a Map scan + maybe one abort call) so it
// doesn't need to be unref'd.
const WATCHDOG_INTERVAL_MS = 5000

// Module-level: the interval handle + the flag that ensures we only arm the
// timer once per process. createEventHandler may be invoked more than once
// across plugin reloads within the same opencode process — restarting the
// timer on every call would leak intervals.
let watchdogInterval = null
let watchdogClient = null

export function ensureWatchdogStarted(client) {
  if (watchdogInterval) {
    // Already running; keep the freshest client so future sweeps use it.
    watchdogClient = client
    return
  }
  watchdogClient = client
  const handle = setInterval(() => {
    void sweepWatchdog()
  }, WATCHDOG_INTERVAL_MS)
  // Don't pin the opencode event loop on this interval: the watchdog only
  // matters while subagents (and therefore the plugin) are alive. If
  // opencode tears the plugin factory down for a clean shutdown, the interval
  // goes with it. (setInterval is the kind of handle that would otherwise
  // keep node alive indefinitely — see node's "active handles" semantics.)
  if (typeof handle.unref === "function") handle.unref()
  watchdogInterval = handle
  log("watchdog started", { intervalMs: WATCHDOG_INTERVAL_MS })
}

// Sweeps the registry once and times out any subagent whose last event is
// older than the configured inactivity window. Best-effort: a single failed
// abort on one entry doesn't stop the others from being checked.
export async function sweepWatchdog() {
  const maxAge = getSettings().maxSubagentAgeMs
  if (maxAge <= 0) return // watchdog disabled
  const now = Date.now()
  // Snapshot the entries first — we mutate the registry (removeEntry) below,
  // so iterating the live Map would skip or revisit entries.
  const entries = [...registry.values()]
  for (const entry of entries) {
    if (entry.timedOut) continue
    if (entry.errored) continue
    if (aborted.has(entry.sessionID)) continue
    // session.idle fires just before the entry is removed; if a stray idle
    // sneaks through the gap, `entry.status === "idle"` covers it.
    if (entry.status === "idle") continue
    const last = entry.lastActivityAt ?? entry.spawnedAt
    if (now - last <= maxAge) continue

    // Latch FIRST so any racing event handler / onSessionIdle skips this entry.
    entry.timedOut = true
    await timeoutSubagent(entry, maxAge, now - last)
  }
}

// Performs the actual timeout for one entry: abort the opencode session,
// post a wake notice to the parent, and free the slot by running the same
// cleanup path as onSessionIdle (removeEntry + deleteSession +
// forgetSessionDirectory). Best-effort; failures are logged, never thrown.
export async function timeoutSubagent(entry, maxAgeMs, silentMs) {
  const sessionID = entry.sessionID
  const handle = entry.handle
  const agent = entry.agent
  const parentID = entry.parentID
  log("subagent timed out (inactivity)", {
    handle,
    sessionID,
    agent,
    silentMs,
    maxAgeMs,
  })

  // 1. Cooperative abort (best-effort, mirrors signalAbort in tools.js).
  try {
    await abortSession(watchdogClient, sessionID)
  } catch (err) {
    log("watchdog: abort failed", { handle, sessionID, err: errMsg(err) })
  }
  // 2. Wake the parent with a timeout notice + free the slot — same teardown
  //    as onSessionIdle / onSessionError. markAborted keeps the abort marker in
  //    place across removeEntry(clearAborted:false) + deleteSession so the guard
  //    never falls back to primary-classification mid-teardown; see
  //    teardownSubagent. No toast on this path (watchdog is silent in the TUI).
  //    The notice is suppressed when watchdogClient is unset (mirrors the old
  //    `parentID && watchdogClient` guard).
  await teardownSubagent(watchdogClient, entry, {
    notice: watchdogClient ? timeoutNotice(entry, maxAgeMs, silentMs) : null,
    markAborted: true,
    label: "watchdog",
  })
}

// Test-only: stop the watchdog interval so unit tests don't leak timers.
export function _stopWatchdogForTests() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
    watchdogClient = null
  }
}
