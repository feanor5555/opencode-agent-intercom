// Subagent bookkeeping: friendly handles and the sessionID <-> entry mapping.
// Operates on the module-level shared state in state.js.

import {
  registry,
  bySession,
  primarySessions,
  counters,
  aborted,
  pendingSpawns,
  pendingTaskIds,
  registryMutex,
  primaryCtx,
  pendingHandoffs,
  handoffInProgress,
  handoffDrains,
  handoffRedirects,
  lastPrimaryTool,
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
export function trackPrimary(sessionID) {
  if (sessionID) primarySessions.add(sessionID)
}

export function isPrimary(sessionID) {
  return primarySessions.has(sessionID)
}

// Removes `sessionID` from BOTH the `primarySessions` set and the `primaryCtx`
// map. Sync, idempotent — calling on an unknown id is a safe no-op (`.delete`
// on a Set/Map returns false but does not throw). Used by the orchestrator-
// handoff sequence (§14.7 in ARCHITECTURE.md, step 8) to drop the OLD primary
// from primary-tracking maps once its in-flight subagents have been reparented
// and its session deleted.
//
// ARCHITECTURE.md §14.7 references this function under the name
// `forgetPrimary` — but the helper did NOT actually exist (the §14.7 plan
// assumed a one-liner the slice never built). This is the real definition.
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
  // Handoff bookkeeping for the OLD primary dies with it: clear the
  // in-progress latch (this is the success-path release — the failure path
  // is releaseHandoff) and any pending flag the doc-summary turn's transform
  // might have raced in. The session is deleted at this point; a stale flag
  // could never be claimed again (no further idle events) but would leak.
  pendingHandoffs.delete(sessionID)
  handoffInProgress.delete(sessionID)
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

// Counts ALL active subagents across every primary in this opencode process —
// the cap is global, not per-primary. Aborted subagents are excluded (they no
// longer occupy a concurrency slot, even before opencode has confirmed the
// abort). Finished subagents are not in the registry at all, so no special
// case for them. Pending spawns (between cap-check and upsertSession) are
// included so parallel spawn() calls in the same turn cannot bypass the cap.
//
// The `primaryID` arg is preserved for backwards compatibility with existing
// call sites but is ignored: with a global cap, the count is the same
// regardless of which primary asked.
export function countActiveSubagents(primaryID) {
  let n = pendingSpawns.count
  for (const e of registry.values()) {
    if (effectiveState(e) === "aborted") continue
    n += 1
  }
  return n
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
export function upsertSession(sessionID, { agent, prompt, parentID, taskId, directory } = {}) {
  if (!sessionID) return undefined
  const existing = entryForSession(sessionID)
  if (existing) {
    upgradeProvisionalAgent(existing, agent)
    if (prompt && !existing.prompt) existing.prompt = prompt
    if (parentID && !existing.parentID) existing.parentID = parentID
    if (taskId && !existing.taskId) existing.taskId = taskId
    if (directory && !existing.directory) existing.directory = directory
    return existing
  }
  return createEntry(sessionID, agent || "subagent", prompt || "", parentID, taskId, directory)
}

// Returns the set of taskIds currently held by active subagents of a primary.
// Used by `spawn` to reject a duplicate spawn for a task that's already in
// flight — without this, a small model that gets confused and re-spawns the
// same T-id would silently double-tick (or, worse, race) on completion.
export function activeTaskIdsFor(primaryID) {
  const ids = new Set()
  for (const e of registry.values()) {
    if (e.parentID !== primaryID) continue
    if (effectiveState(e) === "aborted") continue
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
    if (clearAborted) aborted.delete(sessionID)
    return true
  })
}

// Same body as removeEntry, but NO runExclusive wrapper. Use this only when
// the caller is ALREADY inside a registryMutex.runExclusive section — e.g.
// the wake-dispatch critical section (§14.7), which must atomically read
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
  aborted.delete(sessionID)
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

export function isHandoffInProgress(sessionID) {
  return handoffInProgress.has(sessionID)
}

function createEntry(sessionID, agent, prompt, parentID, taskId, directory) {
  const now = Date.now()
  const entry = {
    handle: nextHandle(agent),
    sessionID,
    agent,
    prompt,
    parentID,
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
    status: "busy",
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
    // Latch: true after notifyParentOfDenialLoop has fired for this subagent
    // so the parent isn't spammed every subsequent over-budget turn.
    notifiedParentOfLoop: false,
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
