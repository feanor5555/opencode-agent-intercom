// Shared mutable state for opencode-agent-intercom.
//
// This MUST live at module scope. opencode instantiates the plugin factory
// once per project (or less often) within a single process — NOT per session
// (see the "Plugin-Factory" footgun in CLAUDE.md). Closure-local state from a
// factory invocation therefore is NOT a reliable per-session store. The module
// itself is imported exactly once per process, so module-level state IS shared
// across every hook invocation: `spawn` runs while the subagent's
// `chat.system.transform` hook runs, and they must see the same registry.

// handle -> { handle, sessionID, agent, prompt, parentID, status, lifecycle,
//             spawnedAt, retainedAt, lastActivityAt, lastActivity, ctxTokens,
//             lastTokensFetchAt, timedOut }
//
// `status` is what opencode reports the session is doing; `lifecycle` is what
// the entry means to this plugin, and is what decides whether the entry counts
// as a running subagent (see isActiveEntry in registry.js).
//
// One-shot subagent lifecycle: each entry lives from `spawn` until the
// subagent goes idle (= completed its single reply). At that point the event
// hook delivers the result to the primary, removes the entry from this map,
// and deletes the underlying opencode session. If more work is needed, the
// orchestrator spawns a fresh one.
//
// The one exception is retention, and it is off unless `maxRetainedSubagents`
// is configured above 0: a top-level subagent that ended cleanly keeps its
// entry and its opencode session after the wake, with `lifecycle` on
// "retained" and `retainedAt` stamped. Such an entry holds no concurrency slot
// and is deleted when its retention window runs out, when capacity evicts it,
// or on any other teardown.
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

// GLOBAL count of subagent results currently BEING DELIVERED to a primary,
// across ALL primaries in this opencode process: the window between the
// registry entry being claimed for delivery (or marked aborted, which drops it
// from the count just as effectively) and the wake notice having been posted
// and the subagent torn down. The entry is gone from the registry for that
// whole window, so countActiveSubagents alone reports zero while the last
// subagent's result is still on its way — and an endless cycle polling for
// quiesce would fire its open-points prompt into a session that is about to be
// replaced, losing exactly the result the mode exists to preserve. isQuiesced
// therefore reads this counter too.
//
// Wrapped in an object for the same reason as pendingSpawns (resetState
// reassigns the field, importers share the one live reference).
export const pendingDeliveries = { count: 0 }

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

// sessionID -> the agent name opencode resolved for that session's current
// turn, as reported by the `chat.message` hook (`input.agent`, falling back to
// the created user message's own `agent` field). That hook fires once per user
// turn inside createUserMessage, BEFORE the request loop that triggers the
// system transform, so the name is in hand at the first transform of the turn.
//
// This is the authoritative source for a PRIMARY session's agent name: unlike
// the `# Role:` header in the role prompt, it survives a project markdown file
// that displaces the plugin's own prompt, and unlike `default_agent` it is the
// name of the agent actually running. Subagents are identified from their
// registry entry instead and never read this map.
//
// One short string per live session; pruned in forgetPrimary and
// removeEntryLocked, mirroring lastPrimaryTool.
export const sessionAgent = new Map()

// instance directory ("" when the hook ran without one) -> the `default_agent`
// value that project resolved at the `config` hook. Written by installAgents,
// which is also what puts the plugin's own default there when the project set
// none, so this holds whatever opencode will actually start that project's
// primary as. Last rung of the primary identification chain in hooks.js.
//
// Keyed by directory rather than held as one value because the `config` hook
// runs once per plugin instance, i.e. once per project: with two projects in
// one process a single slot would answer every session with the name the last
// hook to run captured. Read through agents.js `defaultAgentName(directory)`.
export const defaultAgentByDirectory = new Map()

// primary sessionID -> the project directory that session was first resolved
// to. `getSessionDirectory` answers `undefined` on a transport error and caches
// nothing, so a failed `session.get` would otherwise collapse the primary's
// project scope to null for that turn: the override block would render empty
// and the stable system-prompt element would move its bytes mid-session — the
// one thing that element must never do. Written on the first primary transform
// that resolves a directory and read by every later one.
//
// One short string per live primary; pruned in forgetPrimary, mirroring
// sessionAgent and the directory cache in client.js.
export const primaryDirectory = new Map()

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

// sessionIDs of primary sessions whose context crossed the endless threshold
// and whose endless cycle is SCHEDULED but not yet started. The endless twin
// of pendingHandoffs, and marked by the same transform hook for the same
// reason: prompting, aborting or replacing the active session from inside its
// own hook is re-entrant and can hang, so the hook only MARKS and the
// primary's next `session.idle` executes. From the moment the latch is set,
// `spawn` refuses new subagents — a subagent started now would be reparented
// onto a session that has no memory of asking for it. See
// scheduleEndlessIfNeeded / claimPendingEndless in registry.js.
export const pendingEndless = new Set()

// sessionIDs with an endless cycle currently EXECUTING (between
// claimPendingEndless and forgetPrimary on success / releaseEndless on
// abandon). Guards against double execution by a second idle event, and holds
// the spawn freeze for the whole cycle.
export const endlessInProgress = new Set()

// sessionID -> wall-clock ms until which scheduleEndlessIfNeeded refuses to
// schedule again. Set when a cycle abandons (quiesce timeout, save failure,
// handoff failure): a primary already over the threshold would otherwise
// re-schedule on its very next turn and retry continuously.
export const endlessCooldowns = new Map()

// sessionID -> { reason, at } for a primary whose endless run stopped ITSELF:
// the cycle ceiling, the no-progress bound, or a cycle that found nothing left
// to do. A pause is RUNTIME state and nothing else — the settings file is
// never touched by it, so `endlessMode` keeps whatever the user put there and
// the mode stays available to the next primary session.
//
// It is what makes a self-stop a stop at all: without it the primary is still
// over `endlessContext`, so its very next turn would re-arm the latch and the
// same cycle would run again on the next idle. The pause is keyed by session
// id, so a primary that a handoff replaced takes its pause with it — the
// fresh orchestrator starts with the mode available (forgetPrimary drops the
// old key; the new id was never in the map).
//
// The no-progress bound is the one stop that fires AFTER the replacement, so
// it pauses the NEW primary — pausing the session it just retired would bound
// nothing.
export const endlessPauses = new Map()

// Cross-cycle progress bookkeeping for the no-progress bound. NOT keyed by
// session id: each cycle replaces the primary, so the record has to survive the
// replacement to be comparable at all. `lastOpenTitles` is the array of
// normalised open-task titles the cycle LEFT in the todo file, after it wrote
// its own points (null before the first cycle), `stalledCycles` counts
// consecutive cycles from which not one of those titles had disappeared by the
// time the next cycle read the file. Wrapped in an object for the same reason
// as pendingSpawns (resetState reassigns the fields, importers share the one
// live reference).
//
// The record is PROCESS-GLOBAL, not per orchestrator chain: two orchestrators
// running endless cycles in one process interleave their counts into one
// streak. That is the same over-approximation the process-wide subagent count
// makes, and it is bounded by resetEndlessProgress, which clears the record on
// every primary turn that observes the mode switched off — so re-arming the
// mode always starts from a fresh streak rather than inheriting the one that
// switched it off.
export const endlessProgress = { lastOpenTitles: null, stalledCycles: 0 }

// childSessionID -> waiter record { childSessionID, parentSessionID, promise,
//                                   createdAt, settled, timer, settle }.
//
// The one place a session's live children are recorded. A record exists from
// the moment a session starts a child it will block on until that child's run
// ends by any path (idle, error, abort, watchdog timeout, or the waiter's own
// ceiling), and `record.promise` is what the starting session's `spawn` tool
// call is suspended on for exactly that span. Everything that reads or writes
// it lives in childwait.js; the map is here because it is process-wide shared
// state like every other map in this file, and because resetState has to be
// able to settle a leftover waiter without importing childwait.js (which
// imports this module).
//
// The registry entries in `registry` above cannot express this: they describe
// a one-shot leaf and carry no field for "blocked on somebody else", and the
// parent of a waited child may be a primary, which has no entry at all.
export const pendingChildResults = new Map()

// sessionID -> record for an abort/error teardown waiting for the session's
// post-abort cleanup to finish. The record's promise resolves when the matching
// `session.idle` event arrives or its bounded rescue timer expires. Kept here so
// resetState can release a waiter without importing teardown.js.
export const pendingSessionQuiescence = new Map()

// sessionID -> the epoch ms at which that session's `session.idle` event was
// seen. The counterpart to the map above, for the case it cannot cover: an
// idle that arrives BEFORE anybody armed a wait for it. opencode publishes
// `session.idle` for an aborted session from inside the abort request itself,
// so every path that awaits its own abort call has already let that event go by
// when it comes to wait for it. Read and written only by teardown.js
// (waitForSessionQuiescence / signalSessionIdle), which also bounds this map by
// age and by size; kept here so resetState can clear it between tests.
export const quiescedSessions = new Map()

// Session ids whose `session.deleted` event was seen, newest last. The event is
// the only signal that separates a cascade from a lone delete, and the guard in
// hooks.js reads this set after its grace period. Kept here so resetState can
// clear it between tests.
export const deletedSessions = new Set()

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
  pendingDeliveries.count = 0
  pendingTaskIds.clear()
  // Settle before clearing: a leftover waiter's promise would otherwise never
  // resolve, and its rescue timer would fire into the next test. `settle` is
  // idempotent and clears the timer, so both hazards go with one call.
  for (const record of pendingChildResults.values()) {
    record.settle({ status: "abandoned", detail: "process state reset" })
  }
  pendingChildResults.clear()
  for (const record of pendingSessionQuiescence.values()) {
    record.settle("abandoned")
  }
  pendingSessionQuiescence.clear()
  quiescedSessions.clear()
  deletedSessions.clear()
  lastPrimaryTool.clear()
  sessionAgent.clear()
  defaultAgentByDirectory.clear()
  primaryDirectory.clear()
  primaryCtx.clear()
  pendingHandoffs.clear()
  handoffInProgress.clear()
  handoffDrains.clear()
  handoffRedirects.clear()
  pendingEndless.clear()
  endlessInProgress.clear()
  endlessCooldowns.clear()
  endlessPauses.clear()
  endlessProgress.lastOpenTitles = null
  endlessProgress.stalledCycles = 0
}
