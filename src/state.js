// Shared mutable state for opencode-agent-intercom.
//
// This MUST live at module scope. opencode instantiates the plugin factory
// once per project (or less often) within a single process — NOT per session
// (see the "Plugin-Factory" footgun in CLAUDE.md). Closure-local state from a
// factory invocation therefore is NOT a reliable per-session store. The module
// itself is imported exactly once per process, so module-level state IS shared
// across every hook invocation: `spawn` runs while the subagent's
// `chat.system.transform` hook runs, and they must see the same registry.

// handle -> { handle, sessionID, agent, prompt, parentID, status, spawnedAt,
//             lastActivityAt, lastActivity, ctxTokens, lastTokensFetchAt,
//             timedOut }
//
// One-shot subagent lifecycle: each entry lives from `spawn` until the
// subagent goes idle (= completed its single reply). At that point the event
// hook delivers the result to the primary, removes the entry from this map,
// and deletes the underlying opencode session. There is no follow-up channel
// to a finished subagent; if more work is needed, the orchestrator spawns a
// fresh one.
export const registry = new Map()

// sessionID -> handle (reverse lookup)
export const bySession = new Map()

// sessionIDs that have used this plugin's tools — treated as "primary"
export const primarySessions = new Set()

// sessionIDs that have been aborted — used to hard-deny lingering tool calls
export const aborted = new Set()

// agent name -> monotonic counter, for friendly handles
export const counters = new Map()

// GLOBAL count of spawn() calls currently between the cap check and the final
// upsertSession (i.e. holding a reserved slot but not yet visible in the
// registry), across ALL primaries running in this opencode process. Without
// this counter, N parallel spawn tool-calls in the same orchestrator turn all
// read "0 active" before any of them reaches upsert -> the cap is silently
// bypassed. countActiveSubagents adds this counter so the reservation is
// atomic across the synchronous check-and-increment.
//
// The cap itself is global (shared across every orchestrator primary in the
// process) — see countActiveSubagents / reservePendingSpawn in registry.js.
//
// Wrapped in an object so the binding can be reassigned by resetState() and
// shared across importers via a single live reference (ES module exports are
// bindings, not values; a bare `let pendingSpawns` would be read-only at the
// importer).
export const pendingSpawns = { count: 0 }

// GLOBAL set of task-ids (T<n>) currently reserved by an in-flight spawn()
// call that passed the duplicate-task check but has not yet written the id onto
// its registry entry via upsertSession. Mirrors pendingSpawns for the task-id
// guard: the id is checked-and-reserved in the same synchronous block (before
// the first await), so two spawn() calls in the same turn carrying the same
// task-id cannot both slip past the check while the awaits of createChildSession
// / promptSession are in flight. The reservation is released in the spawn
// handler's finally (success, cap-reject, or exception). Only real task-ids are
// reserved — prefix-free spawns opt out of the guard entirely and never touch
// this set, so they cannot block one another.
export const pendingTaskIds = new Set()

// primaryID -> name of the last tool the primary successfully invoked. Used by
// the guard to deny back-to-back `list` calls (small LLMs poll status instead
// of ending the turn after a spawn; one snapshot per turn is plenty).
export const lastPrimaryTool = new Map()

// sessionID -> { tokens:number|undefined, lastFetchAt:number }.
// Cached context-token measurement for primary (non-subagent) sessions. The
// transform hook refreshes this on each primary turn (TTL-guarded, mirroring
// the subagent ctx path) and a future slice will read it to drive the
// context-refresh handoff. MEASUREMENT ONLY in this slice — the threshold
// comparison and handoff trigger are intentionally NOT here.
export const primaryCtx = new Map()

// sessionIDs of primary sessions whose context crossed maxPrimaryContext and
// whose orchestrator handoff is SCHEDULED but not yet started. The transform
// hook only MARKS (it fires while the triggering turn is already running —
// starting the handoff there would delete the old session mid-turn and
// swallow the triggering user message, live-verified). EXECUTION is gated on
// the primary's next `session.idle` event, i.e. after the triggering turn has
// been fully answered. See markHandoffPending / claimPendingHandoff in
// registry.js.
export const pendingHandoffs = new Set()

// sessionIDs with an orchestrator handoff currently EXECUTING (between
// claimPendingHandoff and forgetPrimary on success / releaseHandoff on
// failure). Guards against double execution: a second idle event, a re-mark
// from the doc-summary turn's transform, and any other scheduling path all
// check this set. Lives here (not module-local in hooks.js) so registry.js
// can gate on it and resetState() can clear it between tests.
export const handoffInProgress = new Set()

// sessionID -> drain object { oldID, newID, notices: [] }. A drain is opened
// at the START of an orchestrator handoff (beginHandoffDrain) and keyed under
// the OLD primary's id; once the new session exists it is ALSO keyed under
// the new id (bindHandoffDrainTarget). While a drain is open, every parent
// notice addressed to either id (subagent completion / error / timeout /
// denial-loop) is BUFFERED into `notices` instead of being posted — the old
// session is about to be deleted (a notice there would be lost) and the new
// session must receive its kickoff FIRST (a notice before the kickoff would
// arrive without context). On success flushHandoffDrain removes both keys and
// delivers the buffer to the new session; on failure abortHandoffDrain
// removes both keys and the buffer is delivered back to the still-existing
// old session — either way the buffer cannot leak. See registry.js.
export const handoffDrains = new Map()

// oldPrimaryID -> newPrimaryID, recorded by flushHandoffDrain on a SUCCESSFUL
// handoff. Late deliveries whose wake snapshot still carries the old (now
// deleted) primary id are re-routed to the new session via this map
// (resolveDeliveryTarget follows chains across multiple handoffs). Entries
// are never removed within a process: one tiny record per successful handoff,
// and a straggler can in principle arrive arbitrarily late.
export const handoffRedirects = new Map()

// Minimal async mutex (promise-chain FIFO lock) for serializing critical
// sections over the shared state in this module. Dependency-free.
//
// Usage: `await registryMutex.runExclusive(() => doStuff())`. Subsequent
// callers queue behind any in-flight holder; the returned Promise resolves
// with whatever `fn` resolves to (or rejects with whatever it rejects with —
// rejections do NOT poison the lock, the next waiter still gets to run).
// Sync functions are fine: `runExclusive` returns a Promise that resolves to
// the function's return value.
//
// We expose only `runExclusive` because every caller in this codebase has the
// shape "do a few mutations, return; on error report and bail" — they don't
// need to hold the lock across awaits manually, so acquire/release would only
// be a footgun.
export const registryMutex = {
  _tail: Promise.resolve(),
  runExclusive(fn) {
    const next = this._tail.then(() => fn())
    // Swallow rejections on the tail itself so one failure doesn't break the
    // chain for every subsequent caller. Each waiter's own promise (`next`)
    // still rejects if fn rejects — only the lock's bookkeeping is reset.
    this._tail = next.catch(() => {})
    return next
  },
}

// Test-only: clears all shared state so unit tests run in isolation.
// Not part of the plugin contract — opencode never calls this.
export function resetState() {
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()
  counters.clear()
  pendingSpawns.count = 0
  pendingTaskIds.clear()
  lastPrimaryTool.clear()
  primaryCtx.clear()
  pendingHandoffs.clear()
  handoffInProgress.clear()
  handoffDrains.clear()
  handoffRedirects.clear()
}
