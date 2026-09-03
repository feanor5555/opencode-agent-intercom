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
import { abortSession, fetchSnapshot } from "./client.js"
import {
  entryForSession,
  entryLifecycle,
  isRetainedExpired,
  LIFECYCLE_CLOSING,
  LIFECYCLE_RETAINED,
} from "./registry.js"
import { liveChildSessionIDs } from "./childwait.js"
import { teardownSubagent } from "./teardown.js"
import { timeoutNotice } from "./notices.js"
import { capReplyForAgent } from "./resultfile.js"
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

// Sweeps the registry once. Two clocks run on this one tick, one per
// lifecycle, and they never meet:
//
//   running  — times out any subagent whose last event is older than the
//              configured inactivity window (`maxSubagentAgeMs`).
//   retained — reaps any finished subagent whose retention window
//              (`retainedSubagentTtlMs`, measured from `retainedAt`) is up.
//   closing  — skipped; a teardown is already in flight.
//
// `maxSubagentAgeMs` is never read for a retained entry and `lastActivityAt`
// is never compared against it: a retained session emits no events, so its
// last-activity stamp stands still at the last event of the run that ended,
// and the inactivity window would tear it down about 90 s later with a false
// hang report about a subagent that finished cleanly. The switch below is what
// keeps the two apart; the `status === "idle"` skip in the running branch
// stays what its comment says it is, a race guard for the removal gap.
//
// For the same reason `maxSubagentAgeMs <= 0` — the watchdog switched off —
// disables the running branch alone. It must not also switch off the reap:
// nothing outside this plugin ever deletes a subagent session, so a user who
// turns the inactivity timer off precisely because they do not want subagents
// killed on a clock would otherwise be given an unbounded leak instead.
//
// Best-effort: a single failed abort or delete on one entry doesn't stop the
// others from being checked.
export async function sweepWatchdog() {
  const settings = getSettings()
  const maxAge = settings.maxSubagentAgeMs
  const ttl = settings.retainedSubagentTtlMs
  const now = Date.now()
  // Snapshot the entries first — we mutate the registry (removeEntry) below,
  // so iterating the live Map would skip or revisit entries.
  const entries = [...registry.values()]
  for (const entry of entries) {
    try {
      const lifecycle = entryLifecycle(entry)
      if (lifecycle === LIFECYCLE_CLOSING) continue
      if (lifecycle === LIFECYCLE_RETAINED) {
        if (!isRetainedExpired(entry, ttl, now)) continue
        await reapRetainedSubagent(entry, ttl, now - (entry.retainedAt ?? 0))
        continue
      }
      if (maxAge <= 0) continue // watchdog disabled
      if (entry.timedOut) continue
      if (entry.errored) continue
      if (aborted.has(entry.sessionID)) continue
      // session.idle fires just before the entry is removed; if a stray idle
      // sneaks through the gap, `entry.status === "idle"` covers it.
      if (entry.status === "idle") continue
      // A subagent blocked on a child of its own emits no events: every event of
      // the run belongs to the CHILD's session, so `lastActivityAt` stands still
      // for as long as the child works, and a child that outlives the inactivity
      // window would time out its own parent — which then cascades a DELETE over
      // the very child it was waiting for. Waiting on a live child IS activity.
      //
      // The exemption is bounded by that child being watchdogged itself: it only
      // holds while at least one live child is a tracked entry this same sweep
      // walks, so the parent can be held open no longer than the child can, and a
      // waiter left behind by a child that has vanished from the registry frees
      // the parent to be reaped normally.
      //
      // Bumping `lastActivityAt` rather than just skipping is what makes the
      // exemption safe on the other side: when the child ends, the parent gets
      // its tool result back and starts an LLM call that may not emit for a few
      // seconds, and a stale timestamp from before the whole child run would
      // otherwise have the next sweep reap it instantly.
      if (isWaitingOnWatchdoggedChild(entry.sessionID)) {
        entry.lastActivityAt = now
        continue
      }
      const last = entry.lastActivityAt ?? entry.spawnedAt
      if (now - last <= maxAge) continue

      // Latch FIRST so any racing event handler / onSessionIdle skips this entry.
      entry.timedOut = true
      await timeoutSubagent(entry, maxAge, now - last)
    } catch (err) {
      // Per-entry best effort, and a latch release. Each branch above marks the
      // entry BEFORE the I/O that tears it down — `timedOut` in the running
      // branch, the closing lifecycle in the retained one — so that a racing
      // handler skips an entry already on its way out. Both marks are read
      // everywhere as "another path owns this now", and if the teardown that was
      // to follow throws, no path owns it and none will look at it again: a live
      // opencode session with no route left to delete it, and, in the running
      // case, a concurrency slot held for the life of the process. Undo the mark
      // on an entry that is still registered so the next tick tries again, and go
      // on to the other entries either way.
      recoverFailedSweep(entry, err)
    }
  }
}

// Undoes the mark one sweep set on an entry whose teardown then threw, so the
// next tick can try that entry again.
//
// Only an entry that is still the registered one for its session is touched: a
// teardown that got as far as removing the entry and then failed has already
// taken the entry out of every path this could matter to, and the detached
// object is nobody's business. `timedOut` goes back to false and a closing
// lifecycle goes back to retained on its ORIGINAL `retainedAt`, which
// reapRetainedSubagent never clears — the window it expired on is the window it
// will expire on again at the next tick, five seconds later.
//
// A running entry that is NOT marked has thrown somewhere before the mark, in a
// read that changed nothing; there is nothing to undo and the entry is left as
// it stands.
function recoverFailedSweep(entry, err) {
  const registered = entryForSession(entry.sessionID) === entry
  const relatched = registered && (entry.timedOut || entryLifecycle(entry) === LIFECYCLE_CLOSING)
  log("watchdog: sweep failed for one entry", {
    handle: entry.handle,
    sessionID: entry.sessionID,
    err: errMsg(err),
    retry: relatched,
  })
  if (!registered) return
  if (entry.timedOut) entry.timedOut = false
  if (entryLifecycle(entry) === LIFECYCLE_CLOSING) entry.lifecycle = LIFECYCLE_RETAINED
}

// True when `sessionID` is blocked on at least one live child that is itself a
// tracked subagent — i.e. one this same watchdog will reap if it hangs. That
// bound is the whole point: an exemption that also covered an untracked child
// would be an exemption nothing could ever lift.
export function isWaitingOnWatchdoggedChild(sessionID) {
  for (const childSessionID of liveChildSessionIDs(sessionID)) {
    if (entryForSession(childSessionID)) return true
  }
  return false
}

// Performs the actual timeout for one entry: abort the opencode session,
// recover the text it had produced so far, post a wake notice carrying that
// text to the parent, and free the slot by running the same cleanup path as
// onSessionIdle (removeEntry + deleteSession + forgetSessionDirectory).
// Best-effort; failures are logged, never thrown.
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
  // 2. Read the session ONE more time, purely to recover what the subagent
  //    already produced. This is the last moment it can be read: the teardown
  //    below deletes it. A run reaped on the inactivity clock is not an empty
  //    one — it is typically several finished steps deep — and without this
  //    read every one of them died with the session and the orchestrator's
  //    whole inheritance was the sentence "timed out".
  //
  //    Mirrors onSessionError, including its best-effort construction:
  //    fetchSnapshot swallows its own failures and answers `{}`, so an
  //    unreadable session leaves the text empty and the notice simply omits
  //    the block. Ordered AFTER the abort so the step that was streaming has
  //    been stopped and its parts stand still while we read them.
  //
  //    The same reply ceiling the idle and error paths apply — this text is
  //    about to be pushed into the orchestrator's context — and the overflow
  //    file under the results cache is written HERE, while the session it
  //    belongs to still exists. `retained: false`: a timed-out subagent is
  //    never held. Skipped without a client, like the notice below.
  let rescued = ""
  if (watchdogClient) {
    const { result: lastText } = await fetchSnapshot(watchdogClient, sessionID)
    rescued = capReplyForAgent(lastText, {
      handle,
      agent,
      sessionID,
      taskId: entry.taskId,
      runs: entry.runs ?? 1,
      retained: false,
    }).text
  }
  // 3. Wake the parent with a timeout notice + free the slot — same teardown
  //    as onSessionIdle / onSessionError.
  //
  //    The rescued text rides on BOTH channels, because a timed-out child has
  //    two kinds of parent: one woken by the notice, and one blocked inside its
  //    own nested `spawn` tool call, which is settled from `outcome` and never
  //    sees a notice at all. `result` is empty when nothing could be read, and
  //    both renderings then fall back to their bare timeout wording.
  //
  //    markAborted keeps the abort marker in
  //    place across removeEntry(clearAborted:false) + deleteSession so the guard
  //    never falls back to primary-classification mid-teardown; see
  //    teardownSubagent. No toast on this path (watchdog is silent in the TUI).
  //    The notice is suppressed when watchdogClient is unset (mirrors the old
  //    `parentID && watchdogClient` guard).
  await teardownSubagent(watchdogClient, entry, {
    outcome: {
      status: "timeout",
      handle,
      agent,
      result: rescued,
      detail: `no activity for ${silentMs} ms (inactivity limit ${maxAgeMs} ms)`,
    },
    notice: watchdogClient ? timeoutNotice(entry, maxAgeMs, silentMs, rescued) : null,
    markAborted: true,
    label: "watchdog",
  })
}

// Deletes one retained subagent whose retention window is up: the session goes,
// the entry goes, the slot was never held. Silent towards the parent — it was
// woken when this subagent's run finished, and a second notice would cost it an
// LLM turn to be told that something it may never think about again has gone.
// No abort call either: a retained session is idle, there is nothing to stop.
export async function reapRetainedSubagent(entry, ttlMs, retainedForMs) {
  // Latch before any I/O, exactly as the timeout path does, so a racing
  // eviction or a second sweep skips this entry.
  entry.lifecycle = LIFECYCLE_CLOSING
  log("retention window expired", {
    handle: entry.handle,
    sessionID: entry.sessionID,
    agent: entry.agent,
    retainedForMs,
    ttlMs,
  })
  await teardownSubagent(
    watchdogClient,
    {
      sessionID: entry.sessionID,
      handle: entry.handle,
      parentID: entry.parentID,
      agent: entry.agent,
    },
    { notice: null, markAborted: false, label: "retention" },
  )
}

// Test-only: stop the watchdog interval so unit tests don't leak timers.
export function _stopWatchdogForTests() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
    watchdogClient = null
  }
}
