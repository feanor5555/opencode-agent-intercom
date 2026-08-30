// Subagent bookkeeping: friendly handles and the sessionID <-> entry mapping.
// Operates on the module-level shared state in state.js.

import {
  registry,
  bySession,
  primarySessions,
  counters,
  aborted,
  pendingSpawns,
  pendingDeliveries,
  pendingTaskIds,
  registryMutex,
  primaryCtx,
  pendingHandoffs,
  handoffInProgress,
  handoffDrains,
  handoffRedirects,
  lastPrimaryTool,
  pendingEndless,
  endlessInProgress,
  endlessCooldowns,
  endlessPauses,
  endlessProgress,
  sessionAgent,
  primaryDirectory,
} from "./state.js"
// client.js does NOT import registry.js (verified — it only imports log /
// settings / pluginmsg), so importing forgetSessionDirectory here creates no
// import cycle. This is the clean cut the alternative (a dynamic import inside
// forgetPrimary) would only paper over.
import { forgetSessionDirectory } from "./client.js"

// Re-export so callers (e.g. hooks.js in the next slice) can grab the mutex
// from registry.js without having to know it lives in state.js.
export { registryMutex }

// Marks a session as one that has used this plugin's tools.
//
// A session that HAS a registry entry is a subagent, and a subagent is never a
// primary: the whole plugin classifies by exactly that test (the tool guard in
// hooks.js checks `entryForSession` before its primary branch, and
// `onSessionCreated` auto-registers a child only under a primary parent). A
// subagent that reaches a tool which tracks its caller — the spawn tool, once
// a nested spawn is admitted — would otherwise put its own session id into
// `primarySessions` for the life of the process, where it would make every
// session it creates look like a top-level subagent and survive its own
// teardown. Refusing it here is the source-side half of that; the cleanup half
// is in removeEntry / removeEntryLocked.
export function trackPrimary(sessionID) {
  if (!sessionID) return
  if (bySession.has(sessionID)) return
  primarySessions.add(sessionID)
}

// The primary session at the root of `sessionID`'s spawn chain: walk
// `entry.parentID` up and return the id at which the chain stops — a session
// with no registry entry, which is a primary since only subagents are ever
// registered, or (defensively) a tracked entry that carries no parentID. For a
// primary the walk stops at once, so every caller can pass its own session id
// unconditionally.
//
// This is what makes a primary-keyed decision reach a nested caller. The
// endless-mode spawn freeze is the case in hand: its latch sets are keyed on
// primary session ids only, so `isEndlessFrozen(subagentSessionID)` is always
// false and a subagent would spawn straight through a freeze whose purpose is
// to let the cycle reach quiesce.
//
// The walk is bounded twice: by a `seen` set, so a parentID cycle (which the
// spawn path cannot produce, but a reparent race could) returns instead of
// spinning, and by the chain simply running out of entries. Returns undefined
// only for a falsy argument.
export function rootPrimaryFor(sessionID) {
  if (!sessionID) return undefined
  const seen = new Set()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const entry = entryForSession(current)
    if (!entry?.parentID) return current
    current = entry.parentID
  }
  return current
}

export function isPrimary(sessionID) {
  return primarySessions.has(sessionID)
}

// Removes `sessionID` from BOTH the `primarySessions` set and the `primaryCtx`
// map. Sync, idempotent — calling on an unknown id is a safe no-op (`.delete`
// on a Set/Map returns false but does not throw). Used by the orchestrator-
// handoff sequence to drop the OLD primary from primary-tracking maps once its
// in-flight subagents have been reparented and its session deleted.
//
// Kept sync because the only caller (`performPrimaryHandoff` in handoff.js)
// invokes it as a fire-and-forget step after the async reparent/delete have
// already settled — there is nothing to await and adding an `async` would just
// hand the caller a Promise they immediately ignore.
export function forgetPrimary(sessionID) {
  if (!sessionID) return
  primarySessions.delete(sessionID)
  primaryCtx.delete(sessionID)
  // Per-session caches keyed by the OLD primary's id must die with it too,
  // otherwise they leak for the lifetime of the opencode process: the
  // directory cache in client.js (populated by getSessionDirectory on every
  // primary transform) and the last-tool marker used by the guard's list-spam
  // heuristic. Neither is reachable again once the session is deleted.
  forgetSessionDirectory(sessionID)
  lastPrimaryTool.delete(sessionID)
  // The turn's agent name goes with it: recorded per turn by the chat.message
  // hook, and a deleted session never has another turn.
  sessionAgent.delete(sessionID)
  // The project directory held for this primary dies with it too — same reason
  // as the directory cache above, and the same one-entry-per-live-primary bound.
  primaryDirectory.delete(sessionID)
  // Handoff bookkeeping for the OLD primary dies with it: clear the
  // in-progress latch (this is the success-path release — the failure path
  // is releaseHandoff) and any pending flag the doc-summary turn's transform
  // might have raced in. The session is deleted at this point; a stale flag
  // could never be claimed again (no further idle events) but would leak.
  pendingHandoffs.delete(sessionID)
  handoffInProgress.delete(sessionID)
  // Same for the endless latch, freeze and cooldown: the cycle that just
  // replaced this primary is over and its id is never scheduled again. The
  // cross-cycle progress record (endlessProgress) deliberately survives — it
  // is what the no-progress bound compares across replacements.
  pendingEndless.delete(sessionID)
  endlessInProgress.delete(sessionID)
  endlessCooldowns.delete(sessionID)
  // The self-stop pause goes with it. It is what holds a stopped run back for
  // the session it was set on, and this session is being replaced: the primary
  // that takes over is a different id, has no pause, and starts with endless
  // mode available again. Keeping the entry would leak one map row per
  // replaced primary and nothing else.
  endlessPauses.delete(sessionID)
}

// Per-agent monotonic friendly handle, e.g. "researcher#1".
//
// The counter is "monotonic w.r.t. live handles": it never goes below the
// highest-numbered handle currently held by a live entry for `agent`. This
// means a freshly allocated handle can never collide with one still in flight
// (whether that in-flight handle will be the same number we just released, or
// higher). Aborted/finished subagents release their handle back into the pool
// when doing so does NOT cause a collision with a still-live entry — see
// `releaseHandle` and the "decrement-when-max" policy in its doc-comment.
export function nextHandle(agent) {
  const n = (counters.get(agent) ?? 0) + 1
  counters.set(agent, n)
  return `${agent}#${n}`
}

// Extracts the numeric suffix of a handle ("researcher#7" → 7). Returns NaN
// for malformed handles (no '#' separator, non-numeric suffix). The current
// handle format is always `${agent}#${n}` so this never trips in production,
// but the NaN is a useful fail-safe for releaseHandle, which guards against
// it before touching the counter.
function parseHandleNumber(handle) {
  if (typeof handle !== "string") return NaN
  const i = handle.lastIndexOf("#")
  if (i < 0) return NaN
  return Number.parseInt(handle.slice(i + 1), 10)
}

// Decrements the per-agent counter when (and only when) the handle being
// released is the highest-numbered handle currently allocated for `agent`.
// This is the "decrement-when-max" policy: an aborted subagent reclaims its
// handle number ONLY if no live entry for the same agent holds a higher
// number. Rationale:
//
//   1. If a higher-numbered handle is still live (e.g. we just aborted
//      researcher#2 while researcher#3 is still running), the counter must
//      stay at 3 — a subsequent spawn must get #4, NOT #2, because
//      researcher#3 is using #3 right now and reusing #2 is harmless but
//      misleading (the count of *live* subagents would be 1 while the
//      counter says 2).
//
//   2. If the handle being released IS the current max (the common case:
//      spawn → abort with no other in-flight subagents), decrementing makes
//      the next spawn reuse the same number. So the typical lifecycle
//      "researcher#1 → abort → researcher#1" leaves the counter at 1
//      instead of inflating it to 2.
//
//   3. The counter stays monotonic w.r.t. live handles (it never goes below
//      the highest in-use number), so we cannot accidentally hand out a
//      number that collides with a live entry. That's the safety
//      invariant T6 calls out as "monotonic-safe (no collisions with live
//      handles)".
//
// The two call sites — removeEntry and removeEntryLocked — invoke this
// before the entry is actually deleted from `bySession`, so we still have
// the handle string to parse. We pass `agent` and `n` explicitly rather
// than re-reading the entry, because both call sites have already
// resolved the handle into a local variable and we want a single,
// parameter-shaped helper.
function releaseHandle(agent, n) {
  if (!agent) return
  if (!Number.isFinite(n) || n <= 0) return
  const cur = counters.get(agent)
  // Only decrement when this handle is the current max — see policy above.
  if (cur === n) counters.set(agent, n - 1)
  // If `cur` is undefined (shouldn't happen — we only release handles we
  // allocated, and allocation always sets the counter), leave it alone.
}

// Looks up an entry by friendly handle or raw sessionID.
export function resolve(ref) {
  if (!ref) return undefined
  if (registry.has(ref)) return registry.get(ref)
  return entryForSession(ref)
}

// Looks up an entry by sessionID only.
export function entryForSession(sessionID) {
  return registry.get(bySession.get(sessionID))
}

// Categorizes a registry entry into one displayed state:
//   "aborted"  — user/orchestrator killed it
//   "idle"     — opencode-idle (a brief transient between session.idle firing
//                and the event hook removing the entry); usually not seen
//   "busy" / "retry" — opencode's own status, work in flight
//   "unknown"  — registered but no status seen yet
//
// There is no "finished" state: once a subagent goes idle the event hook
// removes the entry from the registry entirely (one-shot lifecycle), so a
// "done" subagent disappears rather than lingering.
export function effectiveState(entry) {
  if (aborted.has(entry.sessionID)) return "aborted"
  return entry.status ?? "unknown"
}

// The lifecycle of a registry entry, orthogonal to `status`. `status` mirrors
// what opencode reports the session is doing; `lifecycle` says what the entry
// means to this plugin, and specifically whether it occupies a concurrency
// slot.
//
// Three values:
//   "running"  — a turn is in flight or about to be; the entry occupies a
//                concurrency slot. Set by `createEntry` and by nothing else.
//   "retained" — the wake was delivered and the opencode session was NOT
//                deleted: it is idle, alive and re-promptable until the
//                retention window runs out. Set by `retainEntryLocked`.
//   "closing"  — a teardown is in flight; the entry holds no slot and no path
//                may pick it up again. Set by `markEntryClosing` and by the
//                watchdog's reap before its first await.
// An entry built without the field reads as running, so a hand-built fixture
// keeps counting exactly as it did before the field existed.
export const LIFECYCLE_RUNNING = "running"
export const LIFECYCLE_RETAINED = "retained"
export const LIFECYCLE_CLOSING = "closing"

// The lifecycle of one entry, with the default applied.
export function entryLifecycle(entry) {
  return entry?.lifecycle ?? LIFECYCLE_RUNNING
}

// Whether an entry counts as a running subagent. This is the single definition
// of "active" behind the concurrency cap, the quiesce predicate, the in-flight
// taskId set and both renderings of the active list, so those four cannot
// drift apart.
//
// Two reasons an entry does not count: it was aborted (it no longer occupies a
// slot even before opencode has confirmed the abort), or its lifecycle is not
// "running". The two terms are a conjunction and neither can stand for the
// other: an abort is recorded in the `aborted` set and leaves `lifecycle`
// alone, so a lifecycle-only test would count aborted entries as active; and a
// retained or closing entry is not aborted at all, so an aborted-only test
// would count a finished session that is merely being held.
export function isActiveEntry(entry) {
  if (!entry) return false
  if (effectiveState(entry) === "aborted") return false
  return entryLifecycle(entry) === LIFECYCLE_RUNNING
}

// Whether the subagent that has just delivered its result may be held alive as
// a retained session instead of having its opencode session deleted.
//
// Pure and synchronous: it is called from inside the wake critical section, on
// the values that section already holds, and does no I/O. `maxRetained` is
// passed in rather than read from the settings, exactly as `spawnCapDecision`
// takes `maxSubagents` — the registry does not resolve settings.
//
// Retained only when all of:
//   1. retention is switched on at all (`maxRetained > 0`). At 0 — the default
//      — this is the only term that is ever reached, and every subagent is
//      deleted at idle exactly as it always was;
//   2. the entry has a parent to have been woken;
//   3. the subagent is top level. A nested child — one whose parent is itself
//      a tracked subagent — is never retained: its rows would be wiped
//      mid-life by its parent's own recursive DELETE, because the child-first
//      sweep reads its children from the waiter map and a finished child has
//      no waiter left. The parent having a registry entry IS the plugin's
//      definition of "the parent is a subagent" (see trackPrimary).
//
// Three further conditions are not decidable here and are the caller's, in the
// second phase of the decision: only a clean idle may retain — the error,
// timeout and abort paths never run this decision, they go straight to
// `teardownSubagent`; a `Blocked:` reply is not retained; and the session's
// context must fit the reuse ceiling. The last two are read off the result
// snapshot, which the critical section has not fetched yet (see
// onSessionIdle), and the context condition is the pure
// `retentionContextDecision` below.
//
// Capacity is not a term either. A retention that overshoots `maxRetained` is
// resolved by evicting the OLDEST retained entries afterwards
// (`claimRetentionEvictionsLocked`), not by refusing the newest: the entry the
// orchestrator was just told about is the one most likely to be asked a
// follow-up question.
export function retentionDecision(entry, maxRetained) {
  if (!entry) return { retain: false, reason: "no-entry" }
  if (!(maxRetained > 0)) return { retain: false, reason: "retention-off" }
  if (!entry.parentID) return { retain: false, reason: "no-parent" }
  if (entryForSession(entry.parentID)) return { retain: false, reason: "nested" }
  return { retain: true, reason: "retained" }
}

// Whether a finished subagent's context leaves it worth holding: the second
// phase of the retention decision, evaluated on the FRESHLY FETCHED snapshot
// rather than on the entry's own `ctxTokens`, which is cached for CTX_TTL_MS
// and can sit well below the truth after one large tool result.
//
// Without this term retention holds sessions of any size that every later
// reuse attempt would refuse: the entry occupies a retained slot, the
// orchestrator is offered a handle, and the gate turns it down at every try.
//
// Pure, and takes its two numbers rather than resolving them — the registry
// does not read settings. The caller passes `reuseCeilingFor(agent)` and
// `contextBudgetFor(agent)`.
//
// Retained only when all of:
//   1. the snapshot yielded a figure at all, and it is above 0. `fetchSnapshot`
//      returns {} on any failure, so `ctxTokens` may be undefined, and a
//      ceiling evaluated against a missing number is not a ceiling;
//   2. the context is at or below the type's reuse ceiling. A ceiling of 0
//      falls out of this same test as "never reuse this type";
//   3. where a budget is configured for the type, the context is below it. A
//      session at or over its budget is re-prompted straight into the STOP
//      block and a tool-denial loop, so it is nothing to hold. `budget === 0`
//      means the budget is disabled for that type and the ceiling is then the
//      only rule.
export function retentionContextDecision(ctxTokens, { ceiling, budget } = {}) {
  if (typeof ctxTokens !== "number" || !Number.isFinite(ctxTokens) || ctxTokens <= 0) {
    return { retain: false, reason: "no-context" }
  }
  if (!(ctxTokens <= ceiling)) return { retain: false, reason: "over-reuse-ceiling" }
  if (budget > 0 && !(ctxTokens < budget)) return { retain: false, reason: "over-budget" }
  return { retain: true, reason: "retained" }
}

// The share of an agent type's context budget a retained session must still be
// under before a further TASK may be handed to it (term G4 below). It is a
// share and not a second per-type number so that it follows a budget a user
// lowers for one type, where a hard figure would silently exceed that type's
// whole budget.
export const RETAIN_TASK_SHARE = 0.5

// The two things a follow-up can be. `question` — the default and the case the
// whole feature exists for — is one prompt and one answer, and is admitted up
// to the type's reuse ceiling. `task` is a further piece of work handed to a
// session that already has history, and needs room to run in, so it carries
// the stricter G4 term on top.
export const REUSE_QUESTION = "question"
export const REUSE_TASK = "task"

// The reuse admission gate: whether a retained session may be handed this
// follow-up. Pure, synchronous, and the single place the rule lives — the tool
// composes its refusal out of the answer and decides nothing itself.
//
// `ctxTokens` is the figure from a FRESHLY fetched snapshot, never the entry's
// own `ctxTokens`: that one is cached for CTX_TTL_MS, and a retained session is
// a real opencode session a user can open in the TUI and type into, so the
// stored figure is a value that WAS true rather than one that is.
//
// The four terms, in the order they are evaluated, each named in the answer so
// a refusal can say which one bound:
//
//   G1  a figure at all, above 0. `fetchSnapshot` leaves `ctxTokens` undefined
//       on a failure and on a session whose newest step is still all-zero, and
//       a ceiling evaluated against a missing number is not a ceiling. This is
//       also what makes a reuse ceiling of 0 mean "never reuse this type" with
//       no branch of its own: no real session is at or below it.
//   G2  the type's reuse ceiling, inclusive. The term that exists to be
//       configured; the other three protect contracts the plugin already holds.
//   G3  the context budget of the type, carrying the follow-up itself: a
//       session re-prompted to at or over its budget is STOP-injected on its
//       first transform and every tool call it makes is denied, so it would be
//       handed back to the orchestrator as a denial loop. `budget === 0` is the
//       budget switched off for that type, and the term falls away with it.
//   G4  half the budget, for a further task only. G3 asks only whether the
//       PROMPT fits; a task also needs room for what it produces. A question
//       does not, which is why G4 does not govern it — requiring a researcher
//       to be under half its budget before it can be asked which of two things
//       it meant would refuse the reuse in exactly the case the feature is for.
//
// `limit` is the number the failing term was decided against, so the refusal
// can name it; on G1 there is none.
export function reuseAdmission(
  ctxTokens,
  { pkgTokens = 0, mode = REUSE_QUESTION, ceiling = 0, budget = 0 } = {},
) {
  if (typeof ctxTokens !== "number" || !Number.isFinite(ctxTokens) || ctxTokens <= 0) {
    return { admit: false, term: "G1", reason: "no-context", limit: undefined }
  }
  if (!(ctxTokens <= ceiling)) {
    return { admit: false, term: "G2", reason: "over-reuse-ceiling", limit: ceiling }
  }
  if (budget > 0 && !(ctxTokens + pkgTokens < budget)) {
    return { admit: false, term: "G3", reason: "over-budget", limit: budget }
  }
  if (mode === REUSE_TASK && budget > 0 && !(ctxTokens <= budget * RETAIN_TASK_SHARE)) {
    return {
      admit: false,
      term: "G4",
      reason: "over-task-share",
      limit: budget * RETAIN_TASK_SHARE,
    }
  }
  return { admit: true, term: null, reason: "admitted", limit: ceiling }
}

// Turns the entry of `sessionID` into a retained one, in place. The exact
// opposite of removeEntryLocked: the entry stays in `registry` and
// `bySession`, its handle is NOT released back to the counter and the agent
// name recorded for its session is NOT forgotten, because the whole point is
// that the handle keeps addressing a session that is still there.
//
// `dispatched` is cleared: the latch means "a wake for THIS run is in flight",
// and that run is over. The idle path is kept off a retained entry by the
// lifecycle instead, which is a state rather than a one-way claim.
//
// Must be called with the registry mutex held (the "Locked" suffix, as in
// removeEntryLocked).
export function retainEntryLocked(sessionID, now = Date.now()) {
  const handle = bySession.get(sessionID)
  if (!handle) return false
  const entry = registry.get(handle)
  if (!entry) return false
  entry.lifecycle = LIFECYCLE_RETAINED
  entry.retainedAt = now
  entry.dispatched = false
  return true
}

// The inverse of retainEntryLocked: an accepted reuse puts a retained entry
// back to running, in place and under the same handle, because the point of the
// whole feature is that the orchestrator addresses `researcher#1` twice.
//
// What moves, and why each one:
//   - `lifecycle` back to running, so the entry occupies a concurrency slot
//     again (isActiveEntry) and the inactivity watchdog owns run 2 exactly as
//     it owned run 1;
//   - `status` to busy and `dispatched` to false, so the idle path of run 2
//     wakes the parent the way run 1's did;
//   - `lastActivityAt` to now, so the run is measured from the reuse and the
//     first watchdog tick after admission cannot reap it on run 1's silence;
//   - `retainedAt` cleared: the window is over, and a window is per retention
//     rather than per session — the next idle stamps a fresh one;
//   - `runs` up by one, and `packageTokens` replaced by this follow-up's
//     estimate, which is what the completion notice reports against the budget;
//   - `ctxTokens` / `lastTokensFetchAt` taken from the snapshot the gate ran
//     on, so run 2's first context check sees the figure the gate decided on.
//
// What deliberately does NOT move: `spawnedAt`, so the age column keeps telling
// the truth about how long the session has existed; `nestedSpawns`, which is a
// quota and would be unbounded if a re-prompt could refill it; `nestedRuns` /
// `nestedTokens`, which are cumulative reporting figures.
//
// Returns the entry together with the previous values of everything it moved,
// so a reuse whose prompt never reaches the session can put the entry back
// (restoreRetainedEntryLocked). Undefined where the entry is gone or is no
// longer retained — a reap or a drop got there first, and the caller must not
// prompt a session that is on its way out.
//
// Must be called with the registry mutex held.
export function reviveRetainedEntryLocked(
  sessionID,
  { ctxTokens, packageTokens, now = Date.now() } = {},
) {
  const entry = entryForSession(sessionID)
  if (!entry) return undefined
  if (entryLifecycle(entry) !== LIFECYCLE_RETAINED) return undefined
  const previous = {
    retainedAt: entry.retainedAt,
    runs: entry.runs ?? 1,
    packageTokens: entry.packageTokens,
    ctxTokens: entry.ctxTokens,
    lastTokensFetchAt: entry.lastTokensFetchAt,
    lastActivityAt: entry.lastActivityAt,
    status: entry.status,
  }
  entry.lifecycle = LIFECYCLE_RUNNING
  entry.status = "busy"
  entry.dispatched = false
  entry.lastActivityAt = now
  entry.retainedAt = undefined
  entry.runs = (entry.runs ?? 1) + 1
  entry.packageTokens = packageTokens || undefined
  if (Number.isFinite(ctxTokens) && ctxTokens > 0) {
    entry.ctxTokens = ctxTokens
    entry.lastTokensFetchAt = now
  }
  return { entry, previous }
}

// Puts a revived entry back to retained after a reuse that never reached the
// session — the prompt call itself failed, so no run started and nothing about
// the session changed. The ORIGINAL `retainedAt` is restored rather than a
// fresh one stamped: a failed reuse neither ends the retention window nor
// extends it.
//
// Must be called with the registry mutex held.
export function restoreRetainedEntryLocked(sessionID, previous) {
  const entry = entryForSession(sessionID)
  if (!entry || !previous) return false
  entry.lifecycle = LIFECYCLE_RETAINED
  entry.dispatched = false
  entry.retainedAt = previous.retainedAt
  entry.runs = previous.runs
  entry.packageTokens = previous.packageTokens
  entry.ctxTokens = previous.ctxTokens
  entry.lastTokensFetchAt = previous.lastTokensFetchAt
  entry.lastActivityAt = previous.lastActivityAt
  entry.status = previous.status
  return true
}

// Writes the context figure a retention was decided on onto the entry. The
// idle path fetches it AFTER the critical section that retained the entry, and
// without this the retained row would report the figure the entry happened to
// be carrying from its last in-run check — frequently none at all, since a
// short run never triggers one. It is the number the orchestrator decides a
// follow-up on and the number the reuse gate will be measured against, so it is
// the one the entry keeps. A missing or non-positive figure changes nothing.
export function recordRetainedContext(sessionID, ctxTokens, now = Date.now()) {
  const entry = entryForSession(sessionID)
  if (!entry) return false
  if (!Number.isFinite(ctxTokens) || ctxTokens <= 0) return false
  entry.ctxTokens = ctxTokens
  entry.lastTokensFetchAt = now
  return true
}

// How many finished subagents are being held alive right now.
export function countRetainedSubagents() {
  let n = 0
  for (const e of registry.values()) {
    if (entryLifecycle(e) === LIFECYCLE_RETAINED) n += 1
  }
  return n
}

// Trims the retained set down to `maxRetained`, oldest `retainedAt` first, and
// returns one teardown descriptor per evicted entry. The entries are moved to
// "closing" here, before the caller does any I/O, so the watchdog's reap and a
// second eviction pass cannot pick up the same entry twice.
//
// Must be called with the registry mutex held; the teardowns themselves run
// after it is released.
export function claimRetentionEvictionsLocked(maxRetained) {
  const retained = []
  for (const e of registry.values()) {
    if (entryLifecycle(e) === LIFECYCLE_RETAINED) retained.push(e)
  }
  const surplus = retained.length - Math.max(0, maxRetained)
  if (surplus <= 0) return []
  retained.sort((a, b) => (a.retainedAt ?? 0) - (b.retainedAt ?? 0))
  return retained.slice(0, surplus).map((e) => {
    e.lifecycle = LIFECYCLE_CLOSING
    return { sessionID: e.sessionID, handle: e.handle, parentID: e.parentID, agent: e.agent }
  })
}

// Whether a retained entry's window has run out. Only a retained entry can
// expire; a running one is governed by the inactivity watchdog and a closing
// one is already on its way out. An entry that is retained but carries no
// `retainedAt` reads as expired, so a half-written state is reaped rather than
// held forever.
export function isRetainedExpired(entry, ttlMs, now = Date.now()) {
  if (entryLifecycle(entry) !== LIFECYCLE_RETAINED) return false
  return (entry.retainedAt ?? 0) + ttlMs < now
}

// Moves a retained entry to "closing" before its teardown does any I/O. A
// running entry is left alone: its slot is accounted for by `removeEntry` and
// the pending-delivery reservation inside the teardown itself, and re-labelling
// it here would free its slot one network call earlier than it is freed today.
export function markEntryClosing(sessionID) {
  const entry = entryForSession(sessionID)
  if (!entry) return false
  if (entryLifecycle(entry) !== LIFECYCLE_RETAINED) return false
  entry.lifecycle = LIFECYCLE_CLOSING
  return true
}

// Counts ALL active subagents across every primary in this opencode process —
// the cap is global, not per-primary. What counts is isActiveEntry, not bare
// registry membership: an entry that does not hold a slot is invisible here.
// Finished subagents are not in the registry at all, so no special case for
// them. Pending spawns (between cap-check and upsertSession) are included so
// parallel spawn() calls in the same turn cannot bypass the cap.
//
// The `primaryID` arg is preserved for backwards compatibility with existing
// call sites but is ignored: with a global cap, the count is the same
// regardless of which primary asked.
export function countActiveSubagents(primaryID) {
  let n = pendingSpawns.count
  for (const e of registry.values()) {
    if (!isActiveEntry(e)) continue
    n += 1
  }
  return n
}

// The cap decision for one spawn call, in one synchronous read so the caller
// can reserve its slot with no await between counting and reserving.
//
// The rule: the cap GATES a spawn from a primary only; a spawn made by a
// subagent is admitted unconditionally and is still COUNTED. Counting is what
// keeps the orchestrator's slot figure, the quiesce predicate and the endless
// cycle honest about a nested run — `countActiveSubagents` is untouched and
// sees every entry in the process regardless of who spawned it.
//
// Gating a nested spawn would be a deadlock, not a brake: the default
// `maxSubagents` is 1 (settings.js), the caller already occupies the only
// slot, and the refusal it would get — wait for one to finish — names the very
// thing it is itself. What bounds a nested run instead is the per-run quota
// and the one-level depth bound of the delegation design.
//
// `nested` is the caller being a tracked subagent; `active` is reported back so
// the refusal can name the figure it was decided on.
export function spawnCapDecision(callerSessionID, maxSubagents) {
  const active = countActiveSubagents()
  const nested = Boolean(entryForSession(callerSessionID))
  return {
    active,
    nested,
    refused: maxSubagents > 0 && !nested && active >= maxSubagents,
  }
}

// The per-run nested-spawn quota decision for one spawn call, and the charge
// that consumes a unit of it. Kept beside spawnCapDecision because the two are
// the same kind of thing — a synchronous read the caller acts on with no await
// in between — and because the quota, not the cap, is what bounds a nested
// run: the cap deliberately does not gate one (see spawnCapDecision).
//
// `used` counts spawns ADMITTED by this run, not ones that went on to succeed.
// The failure mode the quota exists against is a small model looping, and a
// loop whose spawns all fail would be unbounded under a success-only count.
//
// A caller with no registry entry is a primary; it has no per-run quota and is
// never refused here. `limit <= 0` refuses every nested spawn — that is the
// escape hatch of `maxNestedSpawns: 0`, and `disabled` lets the refusal say so
// rather than report a count the user cannot raise by waiting.
export function nestedQuotaDecision(callerSessionID, maxNestedSpawns) {
  const entry = entryForSession(callerSessionID)
  if (!entry) return { used: 0, limit: maxNestedSpawns, disabled: false, refused: false }
  const used = entry.nestedSpawns ?? 0
  return {
    used,
    limit: maxNestedSpawns,
    disabled: maxNestedSpawns <= 0,
    refused: maxNestedSpawns <= 0 || used >= maxNestedSpawns,
  }
}

// Charges one unit of the caller's per-run quota and returns the new total.
// Synchronous and called in the same block as nestedQuotaDecision, before any
// await, so parallel spawn calls in one turn cannot both read the pre-charge
// figure. A no-op returning 0 for a primary caller, which has no quota.
export function chargeNestedSpawn(callerSessionID) {
  const entry = entryForSession(callerSessionID)
  if (!entry) return 0
  entry.nestedSpawns = (entry.nestedSpawns ?? 0) + 1
  return entry.nestedSpawns
}

// Books an ENDED nested run against its parent: one run, plus whatever context
// that child burned inside its own session.
//
// Separate from chargeNestedSpawn, and deliberately not the same counter. That
// one is the quota and counts spawns ADMITTED, so a model that loops on failing
// spawns is still bounded. This one counts children whose ending the parent
// actually received, which is what the completion notice reports: a run that was
// admitted but never got as far as being prompted cost the orchestrator nothing
// and must not appear as a run in the bill.
//
// `ctxTokens` is what the child's own snapshot reported and is frequently
// absent (an ending with no result — error, abort, timeout — carries no
// figure). The run is counted either way; only the token sum is left short, and
// the notice says so rather than implying a run was free.
//
// A no-op for a primary parent: the orchestrator's own children are not nested
// runs, they are its subagents, and they are already reported one by one.
export function chargeNestedRun(parentSessionID, ctxTokens) {
  const entry = entryForSession(parentSessionID)
  if (!entry) return { runs: 0, tokens: 0 }
  entry.nestedRuns = (entry.nestedRuns ?? 0) + 1
  if (Number.isFinite(ctxTokens) && ctxTokens > 0) {
    entry.nestedTokens = (entry.nestedTokens ?? 0) + ctxTokens
  }
  return { runs: entry.nestedRuns, tokens: entry.nestedTokens ?? 0 }
}

// Atomically reserve a global concurrency slot (synchronous, no awaits
// between caller's cap-check and this call). Caller MUST pair every reserve()
// with exactly one releasePendingSpawn() — typically in a `finally` so an
// error in the spawn pipeline doesn't leak a phantom slot.
//
// The `primaryID` arg is ignored (the cap is global).
export function reservePendingSpawn(primaryID) {
  pendingSpawns.count += 1
}

export function releasePendingSpawn(primaryID) {
  if (pendingSpawns.count > 0) pendingSpawns.count -= 1
}

// Reserve/release the delivery window of ONE subagent result: from the moment
// its registry entry stops being counted (the wake path removes it inside the
// mutex, the error and watchdog paths mark it aborted) until its wake notice
// has been posted and the subagent has been torn down. Synchronous and
// counter-shaped like reservePendingSpawn, so it can be called from inside a
// registryMutex section without nesting a second lock.
//
// Every reserve MUST be paired with exactly one release, in a `finally` — a
// leaked reservation would keep isQuiesced false for the life of the process
// and no endless cycle could ever start.
export function reservePendingDelivery() {
  pendingDeliveries.count += 1
}

export function releasePendingDelivery() {
  if (pendingDeliveries.count > 0) pendingDeliveries.count -= 1
}

// Task-id reservation, the pendingSpawns analogue for the duplicate-task guard.
// `spawn` calls reservePendingTaskId(taskId) in the SAME synchronous block as
// its duplicate check (before any await), so a second spawn() in the same turn
// carrying the same id observes it via isTaskIdPending and is rejected — closing
// the TOCTOU window between the check and upsertSession writing the id onto the
// entry. Every reserve MUST be paired with exactly one release (in the spawn
// handler's finally). No-op for a falsy id: prefix-free spawns opt out.
export function reservePendingTaskId(taskId) {
  if (taskId) pendingTaskIds.add(taskId)
}

export function releasePendingTaskId(taskId) {
  if (taskId) pendingTaskIds.delete(taskId)
}

export function isTaskIdPending(taskId) {
  return !!taskId && pendingTaskIds.has(taskId)
}

// Idempotent registration keyed by sessionID. opencode fires `session.created`
// for plugin-spawned sessions too — and it can fire *during* the `session.create`
// await, before `spawn` even has the sessionID. So either path may run first:
// whoever is first creates the entry, the second upgrades it in place.
export function upsertSession(
  sessionID,
  { agent, prompt, parentID, taskId, directory, packageTokens, title } = {},
) {
  if (!sessionID) return undefined
  const existing = entryForSession(sessionID)
  if (existing) {
    upgradeProvisionalAgent(existing, agent)
    if (prompt && !existing.prompt) existing.prompt = prompt
    if (parentID && !existing.parentID) existing.parentID = parentID
    if (taskId && !existing.taskId) existing.taskId = taskId
    if (directory && !existing.directory) existing.directory = directory
    if (packageTokens && !existing.packageTokens) existing.packageTokens = packageTokens
    if (title && !existing.title) existing.title = title
    return existing
  }
  return createEntry(
    sessionID,
    agent || "subagent",
    prompt || "",
    parentID,
    taskId,
    directory,
    packageTokens,
    title,
  )
}

// Returns the set of taskIds currently held by active subagents of a primary,
// "active" being isActiveEntry — the same predicate the concurrency cap uses.
// Used by `spawn` to reject a duplicate spawn for a task that's already in
// flight — without this, a small model that gets confused and re-spawns the
// same T-id would silently double-tick (or, worse, race) on completion.
export function activeTaskIdsFor(primaryID) {
  const ids = new Set()
  for (const e of registry.values()) {
    if (e.parentID !== primaryID) continue
    if (!isActiveEntry(e)) continue
    if (e.taskId) ids.add(e.taskId)
  }
  return ids
}

// The event hook registers sessions provisionally as "subagent" before `spawn`
// knows the real agent name. Once known, re-key the entry under e.g.
// "researcher#1".
function upgradeProvisionalAgent(entry, agent) {
  if (!agent || agent === "subagent" || entry.agent !== "subagent") return
  registry.delete(entry.handle)
  entry.handle = nextHandle(agent)
  entry.agent = agent
  registry.set(entry.handle, entry)
  bySession.set(entry.sessionID, entry.handle)
}

// Removes an entry from all shared maps. The event hook calls this immediately
// after delivering a subagent's completion notice (one-shot lifecycle), so the
// registry never holds a "finished" subagent.
//
// Also reclaims the per-agent handle counter via `releaseHandle` (the
// "decrement-when-max" policy in releaseHandle's doc-comment) so that
// aborting/finishing a subagent does not inflate the counter for future
// spawns. Without this, "researcher#1" that was immediately aborted would
// leave the counter at 1 forever, so every subsequent researcher spawn
// would get #2, #3, … and the visible handle number would diverge from the
// number of actually-lived researcher subagents.
//
// The body is wrapped in registryMutex.runExclusive so concurrent calls from
// different plugin instances (orchestrator + subagent session hooks) cannot
// interleave e.g. an in-flight `removeEntry` racing with an `upsertSession`
// for a re-spawn. The function's sync body is fine inside runExclusive —
// callers may still `await` the returned Promise.
// `clearAborted` (default true) controls whether the `aborted` set entry is
// dropped alongside the registry entry. Teardown paths that set an abort
// marker before deleting the opencode session pass `false` so the tool-guard
// keeps hard-denying in-flight tool calls throughout teardown (they clear the
// marker themselves once deleteSession is through — see hooks.js).
export async function removeEntry(sessionID, { clearAborted = true } = {}) {
  return registryMutex.runExclusive(() => {
    const handle = bySession.get(sessionID)
    if (!handle) return false
    // Capture the agent + handle number BEFORE we delete from bySession:
    // releaseHandle needs both, and we want the release decision made
    // against the same state this call is mutating (no TOCTOU window where
    // another spawn could increment the counter in between).
    const entry = registry.get(handle)
    if (entry) releaseHandle(entry.agent, parseHandleNumber(handle))
    registry.delete(handle)
    bySession.delete(sessionID)
    // A subagent that used a caller-tracking tool must not leave its session id
    // behind in primarySessions once its entry is gone — see trackPrimary.
    primarySessions.delete(sessionID)
    if (clearAborted) aborted.delete(sessionID)
    return true
  })
}

// Same body as removeEntry, but NO runExclusive wrapper. Use this only when
// the caller is ALREADY inside a registryMutex.runExclusive section — e.g.
// the wake-dispatch critical section, which must atomically read
// parentID and remove the entry under the same lock without deadlocking on
// the FIFO chain (removeEntry is itself a runExclusive call; nesting it
// inside another runExclusive blocks the tail forever). Returns boolean
// synchronously to match the inline body.
//
// Counter-reclaim (releaseHandle) is done here too, for the same reason as
// in removeEntry — see that function's doc-comment for the policy.
export function removeEntryLocked(sessionID) {
  const handle = bySession.get(sessionID)
  if (!handle) return false
  const entry = registry.get(handle)
  if (entry) releaseHandle(entry.agent, parseHandleNumber(handle))
  registry.delete(handle)
  bySession.delete(sessionID)
  // Same primary-set cleanup as removeEntry — see trackPrimary.
  primarySessions.delete(sessionID)
  aborted.delete(sessionID)
  // A subagent's session is deleted right after its entry is removed, so the
  // name the chat.message hook recorded for it is dead weight from here on.
  sessionAgent.delete(sessionID)
  return true
}

// Rewrites `parentID` on every in-flight registry entry from `fromID` to
// `toID`, returning the number of entries that were reparented. Used by the
// orchestrator→orchestrator handoff to ensure subagent results currently in
// flight wake the NEW primary instead of the (about-to-be-deleted) old one.
//
// "In-flight" here means: every entry still present in the registry whose
// `parentID === fromID` AND whose wake handler has not yet snapshotted it
// (`!dispatched`). The registry is one-shot — finished subagents are removed
// in the wake critical section (see onSessionIdle in hooks.js), so any entry
// still present is either actively running or already mid-dispatch. The
// `dispatched` latch is set by the wake handler BEFORE it reads parentID and
// removes the entry (both under the same mutex, see hooks.js:494-512), so
// observing `dispatched === true` means the handler has already captured the
// OLD parentID and will deliver to it — reparenting that entry would
// contradict the snapshotted target. We therefore skip dispatched entries
// and leave the in-flight delivery undisturbed.
//
// Locking: the entire rewrite happens under one registryMutex.runExclusive
// section. The body mutates `entry.parentID` directly on the live entry
// objects — it does NOT call any other registry function that would itself
// acquire the mutex (removeEntry, upsertSession, etc.); nesting
// runExclusive on the FIFO chain would deadlock. See removeEntryLocked
// for the same pattern used by the wake critical section.
//
// Returns 0 for: fromID === toID (no-op), unknown fromID (no match), or a
// fromID whose every matching entry is already dispatched.
//
// No persistent wake/results queue exists in this codebase (results are
// delivered inline by onSessionIdle, one-shot), so there is nothing to
// re-key outside the registry.
export async function reparentSubagents(fromID, toID) {
  return registryMutex.runExclusive(() => {
    if (!fromID || !toID || fromID === toID) return 0
    let n = 0
    for (const e of registry.values()) {
      if (e.parentID !== fromID) continue
      // Skip entries whose wake handler has already snapshotted them — the
      // snapshot pins the old parentID; touching parentID now would not
      // change where the in-flight delivery lands.
      if (e.dispatched) continue
      e.parentID = toID
      n += 1
    }
    return n
  })
}

// Returns a snapshot of every in-flight subagent of `parentID`, shaped for the
// orchestrator-handoff sequence (`performPrimaryHandoff` in handoff.js, step
// 1 — "Gather"). In-flight means: still present in the registry AND not yet
// dispatched, mirroring the criterion `reparentSubagents` uses (see its
// doc-comment above for why `!dispatched` is part of the definition). The
// output contract matches handoff.js's `InFlightSubagent` typedef: `{ handle,
// agent, task }` where `task` is the spawn-prompt the primary gave
// (entry.prompt) — falling back to the stable TODO id (entry.taskId) and then
// the agent name when both are absent (e.g. an event-hook-only registration
// that never went through `upsertSession`).
//
// Locking: the read runs under `registryMutex.runExclusive` so a concurrent
// `removeEntry` / `upsertSession` cannot splice the iteration in half. The
// function does NOT mutate state, only reads — nesting under runExclusive is
// fine here (no FIFO deadlock risk because there are no nested locking
// calls). Sync bodies inside runExclusive are allowed and resolve to the
// returned array, so callers can either `await` the Promise OR use the
// value inline; `performPrimaryHandoff` does the former.
export function inFlightSubagentsFor(parentID) {
  if (!parentID) return []
  return registryMutex.runExclusive(() => {
    const out = []
    for (const e of registry.values()) {
      if (e.parentID !== parentID) continue
      if (e.dispatched) continue
      out.push({
        handle: e.handle,
        agent: e.agent,
        task: e.prompt || e.taskId || e.agent,
      })
    }
    return out
  })
}

// ----------------------------------------------------------------------------
// Handoff delivery drain + redirect (the re-parent window).
//
// `reparentSubagents` only rewrites the in-memory registry's `parentID` — a
// wake handler that has ALREADY snapshotted the old primary as its delivery
// target (dispatched + removed from the registry, delivery in flight) is
// invisible to the registry, and a subagent can also finish at any point
// between the moment the handoff starts and the moment the new session has
// received its kickoff. In that window the old session is about to die (a
// notice posted there is lost with the delete — live-verified) and the new
// session either does not exist yet or has not seen the kickoff (a notice
// posted there would arrive before its context). The fix is a DELIVERY
// ROUTER, consulted at post time by every parent-notice path in hooks.js
// (completion / error / timeout / denial-loop):
//
//   beginHandoffDrain(oldID)            handoff step 0 — buffer opens
//   bindHandoffDrainTarget(oldID,newID) after createSession — the new id is
//                                       intercepted too (a reparented entry's
//                                       wake must not beat the kickoff)
//   flushHandoffDrain(oldID)            after the kickoff was sent — records
//                                       the old→new redirect and hands the
//                                       buffered notices to the caller for
//                                       delivery to the NEW session
//   abortHandoffDrain(oldID)            failure path — hands the buffer back
//                                       for delivery to the OLD session
//                                       (which survives a failed handoff);
//                                       never leaves a drain behind
//
// All four are synchronous Map/Set operations, so each transition is atomic
// w.r.t. a concurrently delivering wake handler (single-threaded JS: the
// router either sees the drain or the redirect, never a gap — flush installs
// the redirect BEFORE removing the drain keys).
// ----------------------------------------------------------------------------

// Opens the drain for an orchestrator handoff. Idempotent: a second begin for
// the same old primary returns the existing drain (runScheduledHandoff's
// claim gate makes concurrent handoffs for one primary impossible anyway).
export function beginHandoffDrain(oldID) {
  if (!oldID) return null
  let drain = handoffDrains.get(oldID)
  if (drain) return drain
  drain = { oldID, newID: null, notices: [] }
  handoffDrains.set(oldID, drain)
  return drain
}

// Binds the freshly created new-orchestrator session to the drain, keying the
// drain under the new id as well: from this moment until the flush, notices
// addressed to EITHER session are buffered. Necessary because the reparent
// step rewrites registry parentIDs to the new id BEFORE the kickoff is sent —
// a subagent finishing in that gap would otherwise deliver to the new session
// ahead of its kickoff.
export function bindHandoffDrainTarget(oldID, newID) {
  const drain = handoffDrains.get(oldID)
  if (!drain || !newID) return false
  drain.newID = newID
  handoffDrains.set(newID, drain)
  return true
}

// Success path: close the drain and return the buffer for delivery to the
// NEW session. Installs the old→new redirect FIRST, then removes the drain
// keys — a concurrently routing delivery therefore always finds either the
// drain (→ buffered) or the redirect (→ new session), never the bare old id.
// Returns { newID, notices } or null when no bound drain exists.
export function flushHandoffDrain(oldID) {
  const drain = handoffDrains.get(oldID)
  if (!drain || !drain.newID) return null
  handoffRedirects.set(oldID, drain.newID)
  handoffDrains.delete(oldID)
  handoffDrains.delete(drain.newID)
  return { newID: drain.newID, notices: drain.notices }
}

// Failure path: close the drain WITHOUT installing a redirect and return the
// buffer for delivery to the OLD session — a failed handoff never deletes the
// old primary, so it is alive and remains the correct target. Returns
// { notices } or null when no drain exists. Either way no drain survives, so
// a failed handoff cannot leak buffered notices.
export function abortHandoffDrain(oldID) {
  const drain = handoffDrains.get(oldID)
  if (!drain) return null
  handoffDrains.delete(oldID)
  if (drain.newID) handoffDrains.delete(drain.newID)
  return { notices: drain.notices }
}

// Follows the handoff-redirect chain from `sessionID` to the currently live
// primary. Multiple handoffs chain (old1→old2→new3); the seen-set guards
// against a (should-be-impossible) cycle.
export function resolveDeliveryTarget(sessionID) {
  let cur = sessionID
  const seen = new Set()
  while (handoffRedirects.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    cur = handoffRedirects.get(cur)
  }
  return cur
}

// Generation number of a primary session for handoff labelling: the original
// user session is #1, and each successful handoff produces the next number.
// Derived purely from the existing handoff-redirect chain (no extra state):
// walk it backward from `sessionID`, counting predecessors. The redirect for
// `sessionID`'s own (in-flight) handoff is installed only at flush time, so a
// new session created off `sessionID` is `handoffGeneration(sessionID) + 1`.
export function handoffGeneration(sessionID) {
  let gen = 1
  let cur = sessionID
  const seen = new Set()
  while (!seen.has(cur)) {
    seen.add(cur)
    let predecessor
    for (const [oldID, newID] of handoffRedirects) {
      if (newID === cur) {
        predecessor = oldID
        break
      }
    }
    if (predecessor === undefined) break
    gen++
    cur = predecessor
  }
  return gen
}

// THE router: every parent-notice post in hooks.js goes through here.
// Synchronous, so the buffered/direct decision is atomic. Resolution order:
//   1. Follow redirects (a completed handoff moved the target).
//   2. If the resolved target has an open drain (a handoff is executing for
//      it right now), buffer the notice → { buffered: true }.
//   3. Otherwise → { buffered: false, target } and the caller posts to
//      `target` (which may differ from `parentID` after a handoff).
export function routeParentNotice(parentID, notice) {
  const target = resolveDeliveryTarget(parentID)
  const drain = handoffDrains.get(target)
  if (drain) {
    drain.notices.push(notice)
    return { buffered: true }
  }
  return { buffered: false, target }
}

export function hasHandoffDrain(sessionID) {
  return handoffDrains.has(sessionID)
}

// ----------------------------------------------------------------------------
// Session -> agent name, recorded from the `chat.message` hook.
//
// Pure helpers around the `sessionAgent` Map in state.js. index.js writes on
// every user turn; hooks.js reads it as the first rung of the primary
// identification chain. Entries are pruned in forgetPrimary (primary gone) and
// removeEntryLocked (subagent gone).
// ----------------------------------------------------------------------------

// Records the agent name opencode resolved for this session's turn. A missing
// session id or a non-string / empty name is ignored rather than stored, so a
// later read cannot hand the caller an empty agent name.
export function recordSessionAgent(sessionID, agent) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return
  if (typeof agent !== "string" || agent.length === 0) return
  sessionAgent.set(sessionID, agent)
}

// The recorded agent name for a session, or null when no `chat.message` hook
// has run for it yet (a fresh session whose first request arrived by a path
// that skipped createUserMessage — the caller falls through to its next rung).
export function sessionAgentName(sessionID) {
  return sessionAgent.get(sessionID) ?? null
}

// The project scope of a primary session, held for the session's whole life.
//
// Called on every primary transform with whatever `getSessionDirectory` just
// answered: a non-empty directory is remembered the first time it is seen, and
// whatever was remembered is what comes back. So a `session.get` that fails
// with a transport error — it answers `undefined` and caches nothing — does not
// take the scope away from the turns that follow it. Returns null only while no
// turn of this session has ever resolved a directory; the caller then renders no
// override block at all rather than one selected under a null scope, which would
// pick up findings recorded with no directory and show them to a project they do
// not belong to.
//
// This is what keeps the block's bytes still: the block lives in the cached
// stable system-prompt element, and a scope that moved between two turns of one
// session would move the element with it.
export function rememberPrimaryDirectory(sessionID, directory) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  if (typeof directory === "string" && directory.length > 0 && !primaryDirectory.has(sessionID)) {
    primaryDirectory.set(sessionID, directory)
  }
  return primaryDirectory.get(sessionID) ?? null
}

// The project scope a primary session already holds, or null when no turn of it
// has resolved a directory yet. A pure read: it never writes.
//
// This is what a caller OUTSIDE the transform uses — the event path above all.
// `rememberPrimaryDirectory` writes the scope on first sight, and the event path
// has no directory of its own to offer that is worth remembering: an event
// carries the instance's own location, not the answer `getSessionDirectory` gave
// for this session, so writing from there would fix a scope the transform never
// resolved and could bind the session to the wrong project for the rest of its
// life. Reading is safe; writing belongs to the transform alone.
export function primaryDirectoryOf(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  return primaryDirectory.get(sessionID) ?? null
}

// ----------------------------------------------------------------------------
// Primary (non-subagent) context-token cache.
//
// Pure helpers around the `primaryCtx` Map in state.js. hooks.js (the real
// one, NOT a test) calls these on each primary turn to refresh the cached
// measurement; tests cover the read/write/TTL logic in isolation by seeding
// `lastFetchAt` directly. The hot path in hooks.js is therefore "if
// shouldRefreshPrimary then fetch and recordPrimaryContext", and the fetch
// itself stays in hooks.js — no client import here.
//
// Locking discipline: deferred to the handoff slice. In the measurement slice
// the cache is single-writer (the transform hook on the primary's session) and
// the only reader is the same hook on the next turn; the eventual handoff
// slice adds the lock when another reader shows up.
// ----------------------------------------------------------------------------

// Writes { tokens, lastFetchAt: Date.now() } for a primary session. tokens may
// be undefined (no completed assistant step yet) — that is still a valid
// measurement and is cached as-is so the next turn can see "we already looked".
export function recordPrimaryContext(sessionID, tokens) {
  if (!sessionID) return
  primaryCtx.set(sessionID, { tokens, lastFetchAt: Date.now() })
}

// Returns the cached tokens for a primary session, or undefined if no entry
// has been recorded yet. Does NOT check the TTL — callers that care about
// staleness must call shouldRefreshPrimary first.
export function primaryContextTokens(sessionID) {
  return primaryCtx.get(sessionID)?.tokens
}

// How long a cached ctx measurement stays valid before a re-fetch. Single
// source of truth for both the primary path (below) and the subagent ctx path
// in hooks.js, which imports this constant.
export const CTX_TTL_MS = 3000

// True when the cache has no entry for this primary OR the entry is older
// than `ttlMs` (default CTX_TTL_MS, mirroring the subagent ctx path). Kept as a
// pure predicate so tests can backdate `lastFetchAt` and assert the flip
// without any real clock or fetch.
export function shouldRefreshPrimary(sessionID, ttlMs = CTX_TTL_MS) {
  const entry = primaryCtx.get(sessionID)
  if (!entry) return true
  return Date.now() - entry.lastFetchAt >= ttlMs
}

// Pure predicate for the handoff trigger: should the primary session be
// handed off to a fresh orchestrator right now? Reads the cached token
// count (no I/O, no lock) and compares it to `maxPrimaryContext`.
//
// Returns false in three cases:
//   - `maxPrimaryContext` is not a positive number (0 / negative / NaN /
//     non-number ⇒ handoff disabled, regardless of usage).
//   - No cached token count yet for this session (`primaryContextTokens`
//     returns undefined when no measurement has been recorded).
//   - The cached count is somehow non-numeric (defensive — `recordPrimaryContext`
//     only stores numbers or undefined, so this should not occur in practice).
//
// Otherwise returns true iff `primaryContextTokens(sessionID) >= maxPrimaryContext`.
// The boundary case (tokens === threshold) counts as "trigger": once the
// primary has consumed the full budget it should hand off, not wait for
// the *next* turn to push it over.
//
// Intentionally side-effect free: does not bump `lastFetchAt`, does not
// clear the cache, does not touch the mutex. The next slice (hooks.js
// trigger) is responsible for the actual handoff.
export function shouldTriggerPrimaryHandoff(sessionID, maxPrimaryContext) {
  if (typeof maxPrimaryContext !== "number" || !Number.isFinite(maxPrimaryContext) || maxPrimaryContext <= 0) {
    return false
  }
  const tokens = primaryContextTokens(sessionID)
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return false
  return tokens >= maxPrimaryContext
}

// ----------------------------------------------------------------------------
// Idle-gated handoff scheduling.
//
// The transform hook fires WHILE the triggering turn is already running.
// Starting the handoff there deletes the old primary mid-turn: the triggering
// user message is never answered and the doc-summary prompt queues behind the
// busy turn (both live-verified). So the transform hook only SCHEDULES
// (markHandoffPending) and the `session.idle` handler EXECUTES
// (claimPendingHandoff → performPrimaryHandoff) — the idle EVENT is the
// load-bearing signal, not a `session.status` poll (which often returns `{}`
// even for actively running sessions).
//
// All four helpers are synchronous set operations over state.js, so a claim
// is atomic w.r.t. a duplicate idle event: the second claim in the same
// microtask queue sees the flag already consumed.
// ----------------------------------------------------------------------------

// Transform-side gate: schedule a handoff for this primary iff the context
// threshold is exceeded AND no handoff is already pending or executing.
// Returns true only when the flag was NEWLY set (callers use this to emit a
// one-shot "scheduled" toast — repeated over-budget turns don't re-toast).
export function scheduleHandoffIfNeeded(sessionID, maxPrimaryContext) {
  if (!shouldTriggerPrimaryHandoff(sessionID, maxPrimaryContext)) return false
  return markHandoffPending(sessionID)
}

// Marks a primary's handoff as pending. False when the id is falsy, a handoff
// is already executing for it, or the flag is already set.
export function markHandoffPending(sessionID) {
  if (!sessionID) return false
  if (handoffInProgress.has(sessionID)) return false
  if (pendingHandoffs.has(sessionID)) return false
  pendingHandoffs.add(sessionID)
  return true
}

export function hasHandoffPending(sessionID) {
  return pendingHandoffs.has(sessionID)
}

// Idle-side gate: atomically consume the pending flag and latch the
// in-progress state. True exactly once per scheduled handoff — a duplicate
// idle event (or an idle racing the executing handoff, e.g. after the
// doc-summary turn on the old primary) returns false.
export function claimPendingHandoff(sessionID) {
  if (!sessionID) return false
  if (!pendingHandoffs.has(sessionID)) return false
  if (handoffInProgress.has(sessionID)) return false
  pendingHandoffs.delete(sessionID)
  handoffInProgress.add(sessionID)
  return true
}

// Failure-path release: clears the in-progress latch so a LATER over-budget
// turn can re-schedule (its transform re-marks pending, the following idle
// re-claims). The consumed pending flag is intentionally NOT restored — the
// retry must go through a fresh schedule so a permanently failing handoff
// doesn't hot-loop on every idle event. The success path releases via
// forgetPrimary instead.
export function releaseHandoff(sessionID) {
  if (!sessionID) return
  handoffInProgress.delete(sessionID)
}

// Endless mode took this primary over: drop a plain-handoff latch that has not
// been claimed yet, the mirror of cancelPendingEndless on the other branch. A
// handoff already executing is NOT touched — it is past the point where it can
// be undone. Without this, a primary that crossed maxPrimaryContext with the
// mode off and then crossed endlessContext with it on carries BOTH latches,
// and the idle handler fires both executors back to back: two session
// replacements on one primary, two kickoffs, one shared drain, and one of the
// two new orchestrators left with no successor.
export function cancelPendingHandoff(sessionID) {
  if (!sessionID) return false
  if (handoffInProgress.has(sessionID)) return false
  return pendingHandoffs.delete(sessionID)
}

export function isHandoffInProgress(sessionID) {
  return handoffInProgress.has(sessionID)
}

// ----------------------------------------------------------------------------
// Endless mode: the latch, the spawn freeze, the quiesce predicate and the
// state the bounds need (cooldown after an abandoned cycle, open-task progress
// across cycles, and the per-session pause a self-stop leaves behind).
//
// The latch is the endless twin of pendingHandoffs and works the same way: the
// transform hook MARKS while the triggering turn runs, the `session.idle`
// event CLAIMS and executes. What it adds over the plain handoff is the
// freeze — from the mark until the end of the cycle, `spawn` refuses, so an
// orchestrator that spawns as fast as its subagents finish cannot keep the
// cycle from ever reaching quiesce.
// ----------------------------------------------------------------------------

// How long after an abandoned cycle (quiesce timeout, save failure, handoff
// failure) scheduleEndlessIfNeeded refuses to schedule again for that primary.
// Without it a primary already over the threshold re-schedules on its next
// turn and retries continuously — the hot loop releaseHandoff avoids by not
// restoring the pending flag.
export const ENDLESS_COOLDOWN_MS = 300_000

// Transform-side gate: schedule an endless cycle for this primary iff the
// threshold is reached, no cycle is pending or executing, the primary is not
// in the cooldown of a cycle that abandoned, and the mode has not stopped
// itself for this session. Returns true only when the latch was NEWLY set, so
// the "scheduled" log line and toast fire once per crossing rather than on
// every over-threshold turn.
export function scheduleEndlessIfNeeded(sessionID, endlessContext) {
  if (!shouldTriggerPrimaryHandoff(sessionID, endlessContext)) return false
  if (endlessCooldownActive(sessionID)) return false
  if (isEndlessPaused(sessionID)) return false
  return markEndlessPending(sessionID)
}

// Marks a primary's endless cycle as pending. False when the id is falsy, a
// cycle is already executing for it, or the latch is already set.
export function markEndlessPending(sessionID) {
  if (!sessionID) return false
  if (endlessInProgress.has(sessionID)) return false
  if (pendingEndless.has(sessionID)) return false
  pendingEndless.add(sessionID)
  return true
}

export function hasEndlessPending(sessionID) {
  return pendingEndless.has(sessionID)
}

// Idle-side gate: atomically consume the latch and latch the in-progress
// state. True exactly once per scheduled cycle — a duplicate idle event, or an
// idle racing the executing cycle (the old primary goes idle again after its
// open-points turn), returns false.
export function claimPendingEndless(sessionID) {
  if (!sessionID) return false
  if (!pendingEndless.has(sessionID)) return false
  if (endlessInProgress.has(sessionID)) return false
  pendingEndless.delete(sessionID)
  endlessInProgress.add(sessionID)
  return true
}

// Abandon-path release: clears the in-progress latch, which also lifts the
// spawn freeze. The consumed pending flag is NOT restored — a retry has to go
// through a fresh schedule, and the cooldown holds that back for five minutes.
// The success path releases via forgetPrimary instead.
export function releaseEndless(sessionID) {
  if (!sessionID) return
  endlessInProgress.delete(sessionID)
}

// The switch was turned off: drop a latch that has not been claimed yet. A
// cycle already executing is NOT touched — it has written to the todo file and
// must not leave the primary half-replaced.
export function cancelPendingEndless(sessionID) {
  if (!sessionID) return false
  if (endlessInProgress.has(sessionID)) return false
  return pendingEndless.delete(sessionID)
}

export function isEndlessInProgress(sessionID) {
  return endlessInProgress.has(sessionID)
}

// The spawn freeze: true from the moment the latch is set until the cycle
// ends, either way it ended. Read at the top of the `spawn` handler.
export function isEndlessFrozen(sessionID) {
  return pendingEndless.has(sessionID) || endlessInProgress.has(sessionID)
}

// Arms the post-abandon cooldown for this primary.
export function setEndlessCooldown(sessionID, ms = ENDLESS_COOLDOWN_MS) {
  if (!sessionID) return
  endlessCooldowns.set(sessionID, Date.now() + ms)
}

// True while the cooldown of an abandoned cycle is still running. An expired
// entry is dropped on read, so the map does not grow over a long process.
export function endlessCooldownActive(sessionID) {
  const until = endlessCooldowns.get(sessionID)
  if (until === undefined) return false
  if (Date.now() >= until) {
    endlessCooldowns.delete(sessionID)
    return false
  }
  return true
}

// The self-stop pause: endless mode stopped ITSELF on this primary — the cycle
// ceiling, the no-progress bound, or a cycle that found nothing left to do.
//
// A self-stop is a pause and never a switch-off: the settings file is not
// touched, so `endlessMode` keeps the value the user gave it (or the default
// it resolves to) and the next primary session has the mode available again.
// Only the user's own switch-off in the sidebar writes the file.
//
// `reason` is the same sentence the stop logs and toasts; it is what the
// orchestrator's per-turn limits block quotes back, so the two states the
// orchestrator can be in — paused for this session, switched off in the file —
// read differently on screen and in the prompt.
//
// The cross-cycle progress record goes with it: it measures one RUN of the
// mode (see resetEndlessProgress), and a run that has just stopped itself must
// not hand its streak to the next primary — a fresh orchestrator would
// otherwise get exactly one cycle before the no-progress bound fired again.
export function pauseEndless(sessionID, reason = "") {
  if (!sessionID) return false
  endlessPauses.set(sessionID, { reason: String(reason || ""), at: Date.now() })
  resetEndlessProgress()
  return true
}

// True while endless mode is paused for this primary session.
export function isEndlessPaused(sessionID) {
  return endlessPauses.has(sessionID)
}

// Why the mode paused itself for this primary, "" when it did not.
export function endlessPauseReason(sessionID) {
  return endlessPauses.get(sessionID)?.reason ?? ""
}

// Lifts the pause for one primary. The mode was never switched off, so there
// is nothing to write back — the next over-threshold turn arms a cycle again.
export function clearEndlessPause(sessionID) {
  if (!sessionID) return false
  return endlessPauses.delete(sessionID)
}

// The quiesce predicate: no subagent is running anywhere in this process, no
// result is still being delivered, and no handoff drain is open for this
// primary. Read inside ONE registryMutex section so a concurrent removeEntry /
// upsertSession cannot splice the count.
//
// The count is countActiveSubagents, i.e. PROCESS-WIDE and inclusive of
// pendingSpawns.count — a spawn that has reserved its slot but not yet reached
// upsertSession counts as running, which is exactly the window a naive
// registry scan would report as zero. Process-wide is an over-approximation
// with a second orchestrator in the same process (the endless primary waits
// for that one's subagents too); it is kept because the alternative is a
// second counting rule that disagrees with the cap the whole plugin is built
// on.
//
// pendingDeliveries.count closes the window at the OTHER end of a subagent's
// life: its entry leaves the registry (or is marked aborted) before the wake
// notice is posted, so without this term the cycle would see quiesce while the
// last result is still on its way into the very session it is about to replace
// — and that result would never reach the saved open points.
export function isQuiesced(sessionID) {
  return registryMutex.runExclusive(
    () =>
      countActiveSubagents() === 0 &&
      pendingDeliveries.count === 0 &&
      !hasHandoffDrain(sessionID),
  )
}

// Records the open-task count a cycle FOUND in the todo file — the file as the
// previous cycle's orchestrator left it, before this cycle wrote its own
// points into it — and reports how many consecutive cycles have failed to
// lower it. A count that fell resets the streak; a count equal to or above the
// previous one raises it. The first cycle of a process has nothing to compare
// against and never counts as stalled. The no-progress bound switches endless
// mode off at 2.
//
// It has to be the count BEFORE the write: the count after it includes the
// points this cycle just saved and is taken before the new orchestrator has
// done anything, so a productive loop that finishes what it inherited and
// saves a comparable number of fresh points would show a flat count and stop
// itself at the third cycle.
export function recordEndlessCycle(openTasks) {
  const previous = endlessProgress.lastOpenTasks
  if (typeof previous === "number" && openTasks >= previous) {
    endlessProgress.stalledCycles += 1
  } else {
    endlessProgress.stalledCycles = 0
  }
  endlessProgress.lastOpenTasks = openTasks
  return { stalledCycles: endlessProgress.stalledCycles, previousOpenTasks: previous }
}

// Clears the cross-cycle progress record. Called on every primary turn that
// observes endless mode switched off, and by pauseEndless when the mode stops
// itself: the record measures one RUN of the mode,
// and the streak that ended the previous run must not be inherited by the next
// arming — a user who turns the toggle back on would otherwise get exactly one
// cycle before the no-progress bound fired again, with nothing on screen
// saying why. The record is process-global, so any primary observing the mode
// off clears it.
export function resetEndlessProgress() {
  endlessProgress.lastOpenTasks = null
  endlessProgress.stalledCycles = 0
}

function createEntry(sessionID, agent, prompt, parentID, taskId, directory, packageTokens, title) {
  const now = Date.now()
  const entry = {
    handle: nextHandle(agent),
    sessionID,
    agent,
    prompt,
    parentID,
    // The session title WITHOUT the plugin's own title marker, as `spawn` set
    // it. Kept because the title is the channel the plugin publishes a
    // retention on (publishRetentionState in teardown.js): the stamp is written
    // in front of this text and taken off it again, so no read-back of the
    // session is needed to compose either form. Undefined for an entry the
    // event hook registered before `spawn` reached it, which then publishes the
    // stamp alone.
    title: title || undefined,
    // Stable TODO.md task id (e.g. "T5" / "R2") extracted by `spawn` from the
    // first line of the spawn-prompt. Used by the wake-hook to validate the
    // subagent's `DONE:`/`BLOCKED:` marker matches the task that was assigned —
    // a marker for a different id is treated as a hallucination and ignored.
    taskId: taskId || undefined,
    // Project directory of THIS session, captured per-call from toolCtx.directory.
    // Used by the wake-hook to locate TODO.md — the plugin-factory closure's
    // `directory` only reflects where opencode serve was started, NOT the
    // session's actual project (sessions created with ?directory=... land in a
    // different project but share the same factory ctx).
    directory: directory || undefined,
    // Estimated size of the work package this subagent was started with — the
    // project snapshot plus the orchestrator's prompt, as the spawn gate
    // measured it. Undefined for an entry the event hook registered before
    // `spawn` reached it. The completion notice prints it beside the run's
    // total so the orchestrator can tell an oversized package from a task
    // that sprawled once it was running.
    packageTokens: packageTokens || undefined,
    status: "busy",
    // How many runs this session has had. 1 from the spawn; incremented by
    // every accepted reuse (reviveRetainedEntryLocked), so the completion
    // notice can say which run finished and label the cumulative figures as
    // cumulative. Never reset — the whole point of a reuse is one session.
    runs: 1,
    // Whether this entry occupies a concurrency slot; see isActiveEntry. Set
    // here and nowhere else, so every registry entry is "running".
    lifecycle: LIFECYCLE_RUNNING,
    spawnedAt: now,
    // Wall-clock ms of the most recent lifecycle event observed for this
    // subagent (session.created / .status / .idle / any). Initialized at
    // spawnedAt; bumped on every event by the event handler. Read by the
    // inactivity watchdog (sweepWatchdog) to detect a hung LLM call: if the
    // gap exceeds maxSubagentAgeMs, the subagent is auto-aborted and its
    // slot freed. Distinct from `lastActivity` (a short string snapshot of
    // what the subagent was last doing, used by the system-prompt snapshot).
    lastActivityAt: now,
    lastActivity: undefined,
    ctxTokens: undefined,
    // wall-clock timestamp of the most recent fetchSnapshot() that returned
    // ctxTokens. Read by the hot-path cache in contextLimitNotice() so we
    // don't HTTP-fetch the full message history on every subagent LLM call.
    lastTokensFetchAt: 0,
    // Number of consecutive tool calls denied for hitting the context budget.
    // Used for logs only; the notify-parent threshold is driven by
    // stopInjections (LLM turns), not raw denials.
    budgetDenials: 0,
    // Number of LLM turns on which the contextLimitNotice STOP block was
    // injected into this subagent's system prompt. Counts "chances the LLM has
    // had to see the warning". When it reaches BUDGET_NOTIFY_AFTER, the parent
    // is notified once (see notifiedParentOfLoop). Resets when a tool call
    // gets through, i.e. when the subagent is no longer over budget.
    stopInjections: 0,
    // Number of LLM turns on which the contextLimitNotice RESERVE-band block
    // was injected — the turns the subagent spent between CTX_STOP_RESERVE of
    // its budget and the budget itself, told to wrap up while its tools still
    // worked. Kept apart from stopInjections, which counts turns spent under
    // the tool lockdown and is what the denial-loop notice to the parent
    // reads. For logs only; nothing escalates on it.
    contextWarnings: 0,
    // Latch: true after notifyParentOfDenialLoop has fired for this subagent
    // so the parent isn't spammed every subsequent over-budget turn.
    notifiedParentOfLoop: false,
    // How many nested spawns this subagent run has been ADMITTED so far. The
    // per-run quota (maxNestedSpawns) is checked against it in the spawn gate
    // and it is charged there, in the same synchronous block, so two spawn
    // calls in one turn cannot both pass on the same figure. Counted per RUN
    // because the entry lives exactly as long as the one-shot run does: a fresh
    // subagent starts at 0 and nothing ever has to reset it.
    nestedSpawns: 0,
    // How many nested runs this subagent has taken back a result from, and the
    // context those children burned inside their own sessions. Summed by
    // chargeNestedRun when a waited child ends, and reported on this
    // subagent's own completion notice: the parent's ctxTokens hold the
    // child's RETURNED text but nothing of what it spent getting there, so
    // without these two the true cost of a delegation is invisible to the
    // orchestrator paying for it. Per RUN, like nestedSpawns, and reset by
    // nothing — the entry lives exactly as long as the one-shot run.
    nestedRuns: 0,
    nestedTokens: 0,
    // Latch: set true the instant sweepWatchdog decides this subagent has
    // timed out, BEFORE we call signalAbort / postNotice / removeEntry.
    // Used to keep the watchdog and the normal onSessionIdle path from both
    // acting on the same session in the same sweep window.
    timedOut: false,
  }
  registry.set(entry.handle, entry)
  bySession.set(sessionID, entry.handle)
  return entry
}
