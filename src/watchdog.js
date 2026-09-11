// ---- Inactivity watchdog (dead-man's switch) ---------------------------------
//
// What this guards against: an LLM call inside a subagent that hangs forever
// (server timeout, network partition, model that never streams a token). No
// `session.idle` event ever fires, so the normal wake-on-finish path never
// runs, and the registry entry + global slot stay occupied for the life of
// the opencode process. The orchestrator also never gets woken, so it sits
// idle waiting for a result that will never arrive.
//
// The mechanism is a periodic sweep over the registry: an entry that has shown
// no sign of life for its silence limit is treated as hung, aborted
// cooperatively, and its slot is freed. The orchestrator is woken with a
// timeout notice so it can re-dispatch.
//
// Important: the threshold is SILENCE (time since the last sign of life), not
// total lifetime. A long-running subagent that keeps showing signs of life is
// healthy, so it never trips. Two things count as a sign of life:
//   - any event on the session — `lastActivityAt` is bumped by `handleEvent`
//     in hooks.js;
//   - the start and the end of any tool call — bumped by `guardToolExecute`
//     and `recordToolCallFinished`, also hooks.js.
// The tool call additionally says the subagent is WORKING, for as long as it is
// in flight: it goes into `entry.toolCalls` on `tool.execute.before` and comes
// out on `tool.execute.after`, and opencode publishes nothing in between, so
// such an entry is measured against `maxSubagentToolCallMs` (default 660 s,
// above the 600 000 ms ceiling opencode's own bash tool allows) rather than
// `maxSubagentAgeMs` (default 90 s), which is the window for one with nothing
// in flight. Neither is unbounded: a session that died inside a tool call still
// frees its slot at the wider window, counted from that call's start.
// See watchdogLimit.

import { registry, aborted } from "./state.js"
import { getSettings, retentionCapacity } from "./settings.js"
import { abortSession, fetchSnapshot } from "./client.js"
import {
  countRetainedSubagents,
  entryForSession,
  entryLifecycle,
  isRetainedExpired,
  oldestToolCall,
  clearAsk,
  LIFECYCLE_CLOSING,
  LIFECYCLE_RETAINED,
} from "./registry.js"
import { liveChildSessionIDs } from "./childwait.js"
import { settleAsk } from "./agentmsg.js"
import { teardownSubagent, dropRetainedSubagents } from "./teardown.js"
import { lastSeenPhrase, timeoutNotice } from "./notices.js"
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
  // The live capacity, applied to the set already held, before anything else
  // on this tick. See trimRetainedToCapacity for why it is enforced here.
  await trimRetainedToCapacity()
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
      // Which of the two windows this entry is measured against, and from when
      // — see watchdogLimit. A subagent with a tool call in flight is measured
      // against `maxSubagentToolCallMs` from the start of that call (`since`),
      // one with nothing in flight against `maxSubagentAgeMs` from its last
      // sign of life; the limit that fires travels with the reap so the parent
      // is told which one it was.
      //
      // NOT bumped like the child-wait exemption above: the bump there is safe
      // because the child is watchdogged on its own clock, whereas a working
      // subagent has no second clock behind it, and bumping would push its
      // ceiling out on every tick — i.e. never reap it.
      const limit = watchdogLimit(entry, settings)
      if (limit.ms <= 0) continue // this window switched off
      const last = limit.since ?? entry.lastActivityAt ?? entry.spawnedAt
      const silentMs = now - last
      if (silentMs <= limit.ms) continue

      // Latch FIRST so any racing event handler / onSessionIdle skips this entry.
      entry.timedOut = true
      await timeoutSubagent(entry, limit, silentMs)
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

// Trims the retained set back to the capacity in effect RIGHT NOW, oldest
// `retainedAt` first, and does it on the clock rather than on an event.
//
// `maxRetainedSubagents` is read live, so a user lowering it in a running
// instance changes the capacity at once. The only other enforcement of that
// number — `evictRetainedOverCapacity` in hooks.js — runs on the idle path,
// after one more entry has JOINED the set. That is enough to keep the set from
// growing past the capacity and nothing else: it cannot act on a capacity that
// fell under an already-held set, and at capacity 0 it can never run again at
// all, because no further entry is ever retained. An entry held under the old,
// higher capacity would then stay held for the whole retention window as
// something the orchestrator can no longer use — `list` stops offering it and
// `reuse` refuses it on the very capacity that stranded it — while its opencode
// session stands.
//
// It belongs on this sweep because this sweep is the only thing that looks at
// the retained set without a retention having happened, and because it already
// owns the other rule that ends a retention from outside the entry's own
// lifecycle: the TTL reap. Both answer the same question once every tick — is
// this entry still allowed to be held — so they share one clock and one owner.
// The alternatives each fail on their own terms: `retentionCapacity()`
// (settings.js) is a synchronous read with no client and no registry, called
// from `list` rendering and prompt composition, and evicting there would invert
// the module layering; the settings-file read that notices the new number is in
// that same module; and hooks.js's own eviction is the site whose trigger is
// the defect.
//
// Cheap on the common tick: a Map scan, and the drop — which takes the registry
// mutex and deletes sessions — only where the set is really too large. Run
// BEFORE the per-entry loop takes its snapshot, so its victims are already
// "closing" and the loop leaves them to the teardown in flight.
//
// Silent towards the parent and a real teardown, both through
// dropRetainedSubagents: the same eviction hooks.js runs, so a subagent dropped
// on a lowered capacity ends exactly as one dropped by a newer retention does.
// Best-effort — a failed trim must not cost the tick its timeout and TTL work,
// and the next tick tries again five seconds later.
async function trimRetainedToCapacity() {
  const keep = retentionCapacity()
  if (countRetainedSubagents() <= keep) return
  try {
    await dropRetainedSubagents(watchdogClient, { keep, label: "capacity" })
  } catch (err) {
    log("watchdog: capacity trim failed", { keep, err: errMsg(err) })
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

// Which window one entry is measured against, what to call it when it fires,
// and from when it is counted. Three cases, two windows:
//
//   tool-call  — the subagent has at least one tool call IN FLIGHT
//                (`entry.toolCalls`, filled by `tool.execute.before` and emptied
//                by `tool.execute.after`, hooks.js). opencode publishes nothing
//                while a call runs, so the silence is the call, not a hang:
//                `maxSubagentToolCallMs`, counted from the START of the oldest
//                call in flight (`since`).
//   compaction — the plugin is compacting this subagent's session
//                (`entry.compactingSince`, src/compaction.js). Same statement as
//                the tool-call case and the same window: it is work in flight,
//                opencode publishes nothing useful about it, and a compaction of
//                a large session outlasts the 90 s silence window comfortably —
//                without this case the sweep would reap the entry in the middle
//                of the very relief it was given. Counted from the start of the
//                compaction, so the window is a ceiling on it and not a lease
//                the events of the compaction turn could keep renewing.
//   silence    — nothing in flight. This is the case the dead-man's switch was
//                built for: `maxSubagentAgeMs`, counted from the last sign of
//                life.
//
// The order of the three: a tool call in flight wins, because it is the case
// with a `tool` name to report and the compaction latch can only be set on an
// entry whose crossing found none. A compaction beats silence for the reason
// the tool call does.
//
// What is deliberately NOT a case: `entry.status === "busy"`. That field is
// this plugin's own — `createEntry` seeds it on every spawn and
// `reviveRetainedEntryLocked` on every reuse — so every running entry carries
// it from birth, and a branch on it would put every subagent on the wide window
// and leave the silence window governing nothing. opencode's own verdict
// (`onSessionStatus`) writes the same field, and it holds `busy` for the whole
// of a turn including the hung LLM call this watchdog exists to end, so even
// the genuine value cannot separate working from hung. The in-flight map can:
// it is written only where the plugin has actually seen a call start.
//
// `since` is what makes the wide window a ceiling rather than a renewable
// lease. Events DO arrive during a tool call — the part that flips it to
// running, a republished `session.status` — and each bumps `lastActivityAt`, so
// a window counted from there would restart on every one of them and a call
// that never returns would never be reaped. Counted from the call's own start
// it fires at `maxSubagentToolCallMs` after that start, whatever else happens
// in between, which is also what bounds a call whose `after` never comes.
//
// The descriptor travels with the reap so that the log, the wake notice and the
// nested-spawn detail all name the limit that actually fired and its value —
// a subagent cut off at 660 s reported against a 90 s window would read as a
// timeout that should not have happened.
//
// A settings object carrying no tool-call window at all is read as "no window
// wider than the silence one", exactly as childWaiterTimeoutMs reads it
// (childwait.js): absent is not the same statement as an explicit 0, and
// defaulting it to `undefined` would reap every working entry on the first tick
// (`silentMs <= undefined` is false) and report a NaN limit to the parent.
export function watchdogLimit(entry, settings = getSettings()) {
  const toolCallMs = Number.isFinite(settings?.maxSubagentToolCallMs)
    ? settings.maxSubagentToolCallMs
    : settings?.maxSubagentAgeMs
  const oldest = oldestToolCall(entry)
  if (oldest) {
    return {
      ms: toolCallMs,
      setting: "maxSubagentToolCallMs",
      kind: "tool-call",
      tool: oldest.tool,
      since: oldest.startedAt,
    }
  }
  if (entry?.compactingSince) {
    return {
      ms: toolCallMs,
      setting: "maxSubagentToolCallMs",
      kind: "compaction",
      since: entry.compactingSince,
    }
  }
  return { ms: settings?.maxSubagentAgeMs, setting: "maxSubagentAgeMs", kind: "silence" }
}

// Performs the actual timeout for one entry: abort the opencode session,
// recover the text it had produced so far, post a wake notice carrying that
// text to the parent, and free the slot by running the same cleanup path as
// onSessionIdle (removeEntry + deleteSession + forgetSessionDirectory).
// Best-effort; failures are logged, never thrown.
//
// `limit` is the descriptor watchdogLimit returned for THIS entry — which of
// the two windows fired, its value and its setting key — so the figure the
// parent is given is the one it was measured against.
export async function timeoutSubagent(entry, limit, silentMs) {
  const sessionID = entry.sessionID
  const handle = entry.handle
  const agent = entry.agent
  const parentID = entry.parentID
  log("subagent timed out", {
    handle,
    sessionID,
    agent,
    silentMs,
    limitMs: limit.ms,
    limit: limit.kind,
    setting: limit.setting,
    tool: limit.tool,
    status: entry.status,
    lastActivity: entry.lastActivity,
  })

  // 0. A question this subagent was blocked on ends here, before any I/O: its
  //    `ask` call is a tool call inside the session the steps below abort and
  //    delete, and leaving it holding would keep it there until its own window
  //    ran out, inside a session that no longer exists. The descriptor is
  //    captured first because the notice reports it — the orchestrator has to
  //    learn that the subagent it never answered was then cut off.
  const openQuestion = entry.pendingAsk
  settleAsk(sessionID, {
    status: "timeout",
    detail: "the subagent was cut off by the inactivity watchdog while its question was open",
  })
  clearAsk(entry, "timeout")

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
  //
  //    The same read also refreshes what the subagent was last seen doing. The
  //    entry's `lastActivity` is otherwise only restamped on the LLM-turn path
  //    (contextLimitNotice), behind a cache, so on the very silence that gets a
  //    subagent reaped it is by definition stale — and a stale phrase is the
  //    one thing the parent must not be handed here, since it reads it as the
  //    last thing the subagent did before it stopped. Costs nothing: the
  //    snapshot is already being fetched and already carries the field.
  let rescued = ""
  if (watchdogClient) {
    const { result: lastText, lastActivity } = await fetchSnapshot(watchdogClient, sessionID)
    if (lastActivity) entry.lastActivity = lastActivity
    rescued = capReplyForAgent(lastText, {
      handle,
      agent,
      sessionID,
      taskId: entry.taskId,
      runs: entry.runs ?? 1,
      retained: false,
    }).text
  }
  const lastSeen = lastSeenPhrase(entry)
  // 3. Wake the parent with a timeout notice + free the slot — same teardown
  //    as onSessionIdle / onSessionError.
  //
  //    The rescued text rides on BOTH channels, because a timed-out child has
  //    two kinds of parent: one woken by the notice, and one blocked inside its
  //    own nested `spawn` tool call, which is settled from `outcome` and never
  //    sees a notice at all. `result` is empty when nothing could be read, and
  //    both renderings then fall back to their bare timeout wording.
  //
  //    What the subagent was last seen doing rides on both channels too, and
  //    from the same source (lastSeenPhrase over `entry.lastActivity`): the two
  //    parents are told the same thing about the same reap, in the shape each
  //    channel takes — a sentence in the notice, a clause in the detail.
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
      detail:
        `no sign of life for ${silentMs} ms (${limit.setting} ${limit.ms} ms)` +
        (lastSeen ? `; last seen: ${lastSeen}` : ""),
    },
    notice: watchdogClient ? timeoutNotice(entry, limit, silentMs, rescued, openQuestion) : null,
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
