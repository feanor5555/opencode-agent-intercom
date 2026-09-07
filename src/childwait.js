// The child-waiter mechanism: the state that makes "this session has live
// children" expressible.
//
// Every registry entry describes a ONE-SHOT leaf (see the lifecycle invariant
// in state.js): it lives from `spawn` until its subagent goes idle, and no
// field on it says "I am blocked on somebody else's answer". That is exactly
// the state a nested spawn needs — a subagent P that started a child C must be
// distinguishable from a subagent that has simply stopped talking, or the idle
// handler tears P down the moment it waits, the teardown cascades a DELETE
// over C mid-write, and the inactivity watchdog reaps whichever of the two is
// merely waiting.
//
// A waiter is that state, in the shape the blocking nested spawn needs: the
// caller's `spawn` tool call does not return until its child has finished, so
// the waiter's promise IS the parent's block and the child's outcome IS the
// tool result. One record per child session, keyed by the CHILD's session id
// (the id every ending path already has in hand) and carrying the parent's id
// (the direction every "does this session have live children?" question asks
// in).
//
// Why a map and not a field on the parent's registry entry: the parent of a
// waited child may be a primary as well as a subagent, and a primary has no
// registry entry at all. Keying on the child also keeps the record and the
// promise it guards impossible to desynchronise — one settle closes both.
//
// Nested spawns register a waiter in `src/tools.js:625`. Production reads and
// cleanup are split across the paths that hold a parent's idle in `src/hooks.js`
// (`hasLiveChildren`), end children before teardown in `src/teardown.js`
// (`liveChildSessionIDs`), exempt blocked parents in `src/watchdog.js`
// (`liveChildSessionIDs`), and settle endings in the spawn, hook, abort and
// teardown paths. `hasChildWaiter` and `waitingParentOf` remain exported for
// direct inspection, while `detachedParentOf` lets an ending path preserve the
// late-result addressee before settlement drops the detached record; tests
// exercise the inspection reads.
//
// Every function in this module is SYNCHRONOUS and takes no lock, so it can be
// called from inside a `registryMutex.runExclusive` section without nesting the
// non-re-entrant FIFO mutex.

import { pendingChildResults, registry, bySession } from "./state.js"
import { getSettings } from "./settings.js"
import { log } from "./log.js"

// How a waited child's run ended. The parent's `spawn` tool call renders its
// tool result from this, so every value has to be one the parent can act on.
//
//   completed — the child went idle with a reply; `result` carries it
//   error     — the child's LLM call failed; `detail` carries the message
//   aborted   — the child was aborted (user, or its parent's abort tool)
//   timeout   — the inactivity watchdog reaped the child; `result` carries the
//               text rescued off the session before the teardown deleted it,
//               already through the reply token ceiling, and is absent or
//               empty when nothing could be read
//   expired   — the waiter's OWN ceiling fired; the child may still be running,
//               and its record stays behind as a DETACHED child (see below) so
//               a teardown of the parent still ends it first
//   ended     — the child was torn down by a path that named no outcome
//   abandoned — resetState() cleared the process state out from under it
export const CHILD_OUTCOMES = Object.freeze([
  "completed", "error", "aborted", "timeout", "expired", "ended", "abandoned",
])

// The waiter's own ceiling, as a multiple of the WIDEST watchdog window.
//
// It cannot simply BE a watchdog window: those windows measure silence, and a
// healthy child that streams tokens for ten minutes never trips one. The
// watchdog is the mechanism that ends a hung child (and, through
// teardownSubagent, settles this waiter); the ceiling here only exists for the
// case where no ending path fires at all — an event the plugin never sees, a
// session that vanishes server-side — in which case the parent's tool call
// would hang for the life of the opencode process.
//
// So it must be comfortably LONGER than the watchdog's own worst case, and the
// watchdog measures a child against one of TWO windows (watchdogLimit,
// src/watchdog.js): `maxSubagentAgeMs` (90 s by default) for a child with
// nothing in flight, `maxSubagentToolCallMs` (660 s) for one inside a tool call
// A ceiling built on the silence
// window alone is SHORTER than the working window, and would hand the parent
// `expired` for a child that is legally inside a long tool call and that no
// sweep has touched — the rescue firing on a run that is not stuck.
//
// The base is therefore the wider of the two, and the factor is the margin over
// it: one 5 s sweep tick, the abort and teardown behind the sweep, and room for
// the working child that keeps its window alive across a few consecutive calls.
// 4x — 44 minutes at the 660 s default, 6 minutes when the two windows are
// equal — is longer than any single window the watchdog would let a child live
// under, and shorter than a session the user has given up on.
//
// A child's legal lifetime is not one window, though: each tool call and each
// event restarts the clock the window is measured against, so consecutive long
// calls can carry a healthy child past any fixed multiple. The number alone
// therefore cannot separate "stuck" from "slow", and the timer does not try to:
// when it fires it ASKS, and re-arms for another period while the child is
// still a tracked registry entry (registerChildWaiter). The ceiling expires a
// parent only over a child the watchdog no longer owns — which is the case it
// exists for.
export const CHILD_WAITER_TIMEOUT_FACTOR = 4

// Resolves the ceiling in ms from the settings, or 0 for "no ceiling".
//
// Only `maxSubagentAgeMs = 0` lifts the ceiling: that switches the inactivity
// watchdog off entirely, and a user who has taken out the dead-man's switch has
// asked for runs no clock cuts off — a rescue timer firing anyway would
// contradict the setting rather than back it up. The registry entry of such a
// child is never reaped, so the re-arm below would never expire it in any case.
//
// `maxSubagentToolCallMs = 0` does NOT lift it. That 0 says "no ceiling while a
// subagent works", and the re-arm in registerChildWaiter is what honours it: a
// child that is still a tracked entry is never expired, however long it works.
// Returning 0 here instead would drop the rescue for the one case the ceiling
// exists for — a child session that vanished server-side, whose ending path
// never fires, leaving the parent's `spawn` tool call blocked for the life of
// the opencode process. The window is then read as "no window wider than the
// silence one", so the ceiling keeps a finite value to rescue from.
//
// Reads the settings object rather than calling watchdogLimit: src/watchdog.js
// imports this module (liveChildSessionIDs), so the dependency cannot run both
// ways. A settings object that carries no tool-call window at all is read the
// same way as an explicit 0 here — both leave the silence window as the base —
// which is the reading the sweep in src/teardown.js also takes for an absent
// key.
export function childWaiterTimeoutMs(settings = getSettings()) {
  const maxAgeMs = settings?.maxSubagentAgeMs
  const toolCallMs = settings?.maxSubagentToolCallMs
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0
  const workingWindowMs = Number.isFinite(toolCallMs) && toolCallMs > 0 ? toolCallMs : maxAgeMs
  return Math.max(maxAgeMs, workingWindowMs) * CHILD_WAITER_TIMEOUT_FACTOR
}

// The registry entry for a session, or undefined. A two-line copy of
// registry.js's `entryForSession` on purpose: registry.js is far above this
// module in the import order, and this module is imported by watchdog.js,
// teardown.js, hooks.js and tools.js, so reaching for it here would close a
// cycle. The maps themselves come from state.js, which this module already
// imports and which imports nothing of ours.
function trackedEntryFor(sessionID) {
  return registry.get(bySession.get(sessionID))
}

// Registers a waiter for `childSessionID` on behalf of `parentSessionID` and
// returns the promise the parent blocks on. The promise RESOLVES with the
// outcome on every path — completion, error, abort, timeout, expiry — and
// never rejects: an ending is a result the parent has to report, not an
// exception in the parent's own tool call.
//
// `timeoutMs` overrides the derived ceiling (0 disables it); tests use it to
// avoid real waiting.
//
// Throws on a double registration for the same child session. That cannot
// happen from a correct spawn path (the child session id is fresh), so a
// collision is a bug, and silently handing back the first waiter would give
// two callers one answer.
export function registerChildWaiter(childSessionID, parentSessionID, { timeoutMs } = {}) {
  if (!childSessionID) throw new Error("registerChildWaiter: childSessionID is required")
  if (!parentSessionID) throw new Error("registerChildWaiter: parentSessionID is required")
  if (pendingChildResults.has(childSessionID)) {
    throw new Error(`registerChildWaiter: waiter already registered for ${childSessionID}`)
  }

  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })

  const record = {
    childSessionID,
    parentSessionID,
    promise,
    createdAt: Date.now(),
    settled: false,
    // Set by the ceiling alone: the parent has been freed with `expired`, but
    // the child was never ended, so the record stays in the map as a DETACHED
    // child. It answers `liveChildSessionIDs` (the teardown ordering that keeps
    // a parent's DELETE from cascading over it) and no longer answers
    // `hasLiveChildren` (nobody is blocked on it any more).
    detached: false,
    timer: null,
    // Idempotent, and the ONLY place the promise is resolved. Kept on the
    // record (rather than reached through the map) so resetState can settle a
    // leftover waiter without importing this module — state.js is imported by
    // everything, so the dependency could only run the other way.
    settle(outcome) {
      if (record.settled) return false
      record.settled = true
      if (record.timer) {
        clearTimeout(record.timer)
        record.timer = null
      }
      resolve({
        status: "ended",
        ...outcome,
        childSessionID,
        parentSessionID,
        waitedMs: Date.now() - record.createdAt,
      })
      return true
    },
  }

  const ceiling = timeoutMs === undefined ? childWaiterTimeoutMs() : timeoutMs
  if (ceiling > 0) {
    // Re-arming rather than one-shot. A child that is still a tracked registry
    // entry is a child the watchdog owns: it is measured against one of the two
    // windows on every sweep and ended when it trips one, and that ending
    // settles this waiter. There is nothing for the rescue to rescue while that
    // holds, so it waits another period instead of expiring a parent over a
    // child that is legally working — which is what a raised or switched-off
    // `maxSubagentToolCallMs` asks for, and what no fixed multiple of a window
    // can decide on its own (CHILD_WAITER_TIMEOUT_FACTOR).
    //
    // The expiry that remains is the case the ceiling was built for: no entry,
    // so no watchdog clock, so no ending path — a session that vanished
    // server-side or an event the plugin never saw.
    const arm = () =>
      setTimeout(() => {
        record.timer = null
        if (trackedEntryFor(childSessionID)) {
          record.timer = arm()
          log("child waiter re-armed: the child is still watchdogged", {
            childSessionID,
            parentSessionID,
            ceiling,
          })
          return
        }
        // The ceiling frees the PARENT, not the child. The child may still be
        // running server-side, so the record is DETACHED rather than dropped:
        // the parent's own teardown still has to end this session before its
        // DELETE cascades over it. The child's own ending path, if one ever
        // fires, finds a settled record and drops it; the ending path reads
        // detachedParentOf first and delivers the late result to that parent
        // as a wake notice even though the parent is still a tracked subagent.
        record.detached = true
        if (
          record.settle({
            status: "expired",
            detail: `no outcome within ${ceiling} ms; the child may still be running`,
          })
        ) {
          log("child waiter expired; the child stays a detached child", {
            childSessionID,
            parentSessionID,
            ceiling,
          })
        }
      }, ceiling)
    // Keep the rescue timer referenced while its promise is pending.
    // settleChildWaiter clears it once an outcome arrives.
    record.timer = arm()
  }

  pendingChildResults.set(childSessionID, record)
  log("child waiter registered", { childSessionID, parentSessionID, ceiling })
  return promise
}

// Settles the waiter for `childSessionID`, if there is one, and drops it.
// Returns true when this call was the one that settled an active waiter. Every
// ending path calls this unconditionally. A detached record returns false
// because its promise already resolved with `expired`; ending paths use
// detachedParentOf before this call when they need to route the late result.
//
// A DETACHED record (the ceiling fired, the parent was freed, the child was
// not) is dropped here and answers false: its promise already carries the
// `expired` outcome. The ending path reads `detachedParentOf` immediately
// before this call and uses that preserved address to deliver the late result
// as a wake notice, so the result is not lost merely because the parent is a
// tracked subagent again.
//
// Safe to call for an unwaited child, for an already settled one, and twice
// from the same path.
export function settleChildWaiter(childSessionID, outcome = {}) {
  if (!childSessionID) return false
  const record = pendingChildResults.get(childSessionID)
  if (!record) return false
  pendingChildResults.delete(childSessionID)
  const settled = record.settle(outcome)
  if (settled) {
    log("child waiter settled", {
      childSessionID,
      parentSessionID: record.parentSessionID,
      status: outcome.status ?? "ended",
    })
  } else if (record.detached) {
    log("detached child ended; its record is dropped", {
      childSessionID,
      parentSessionID: record.parentSessionID,
      status: outcome.status ?? "ended",
    })
  }
  return settled
}

// The parent ID held by a DETACHED waiter, or undefined when the child is not
// detached. Ending paths call this before settleChildWaiter drops the record so
// they can opt into the one wake-notice route that is valid for a tracked
// subagent parent. An active waiter deliberately returns undefined: its result
// still belongs in the blocked spawn tool call and must not be posted as well.
export function detachedParentOf(childSessionID) {
  if (!childSessionID) return undefined
  const record = pendingChildResults.get(childSessionID)
  return record?.detached ? record.parentSessionID : undefined
}

// True while `childSessionID` is a child somebody is blocked on. A detached
// child is not: its parent has been freed with `expired` and is running again.
export function hasChildWaiter(childSessionID) {
  if (!childSessionID) return false
  const record = pendingChildResults.get(childSessionID)
  return !!record && !record.detached
}

// The session ids of the children of `parentSessionID` that may still be
// running — the ones it is blocked on AND its detached ones, whose ceiling
// freed the parent while the child itself was never ended.
//
// Detached children are in on purpose: this is the read the teardown ordering
// uses (endLiveChildrenOf, src/teardown.js), and opencode's DELETE cascades
// recursively over child sessions, so a child left out here is a child whose
// rows the parent's delete wipes mid-write. It is also the read the watchdog
// exemption uses (isWaitingOnWatchdoggedChild, src/watchdog.js), which narrows
// it again to children that are tracked registry entries — and a detached child
// is one nothing tracks, so no exemption is granted for it and nothing is held
// open that could not be lifted.
//
// A linear scan: a parent has at most one live child under the blocking shape
// (its own tool call is what waits), and the map holds one record per waited
// child across the whole process — single digits at the very most. A reverse
// index would be a second thing to keep in step for no measurable gain.
export function liveChildSessionIDs(parentSessionID) {
  if (!parentSessionID) return []
  const out = []
  for (const record of pendingChildResults.values()) {
    if (record.parentSessionID === parentSessionID) out.push(record.childSessionID)
  }
  return out
}

// True when `parentSessionID` is blocked on at least one child — i.e. its
// `spawn` tool call has not returned. This is the predicate the idle hold asks
// for (onSessionIdle, src/hooks.js): an idle event from a session whose tool
// call is still outstanding is not the one-shot reply that path delivers, so
// taking it would post a premature result to the grandparent and free a slot
// that is not free.
//
// A DETACHED child does NOT make this true, and that is the difference between
// this predicate and `liveChildSessionIDs`: once the ceiling has handed the
// parent `expired`, its tool call HAS returned, so its next idle is genuine and
// must be taken. What still has to happen to the detached child — being ended
// before the parent's DELETE reaches it — is teardown's business and is carried
// by that other read.
export function hasLiveChildren(parentSessionID) {
  if (!parentSessionID) return false
  for (const record of pendingChildResults.values()) {
    if (record.parentSessionID === parentSessionID && !record.detached) return true
  }
  return false
}

// The waiter's parent, or undefined when the child is not being waited on — a
// detached child included, whose parent is no longer blocked on it. Lets an
// ending path address the blocked session without a registry lookup: the
// registry entry may already be gone by then.
export function waitingParentOf(childSessionID) {
  const record = pendingChildResults.get(childSessionID)
  return record && !record.detached ? record.parentSessionID : undefined
}
