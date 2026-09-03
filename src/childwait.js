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
// NOTHING registers a waiter yet. Registration is the spawn path's job and the
// five places that must consult `hasLiveChildren` (teardown ordering, the
// watchdog exemption, the concurrency cap, the endless freeze, the primary-set
// cleanup) are separate work. What is complete here is the mechanism and its
// bookkeeping: register, settle, expire, and the read side.
//
// Every function in this module is SYNCHRONOUS and takes no lock, so it can be
// called from inside a `registryMutex.runExclusive` section without nesting the
// non-re-entrant FIFO mutex.

import { pendingChildResults } from "./state.js"
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
//   expired   — the waiter's OWN ceiling fired; the child may still be running
//   ended     — the child was torn down by a path that named no outcome
//   abandoned — resetState() cleared the process state out from under it
export const CHILD_OUTCOMES = Object.freeze([
  "completed", "error", "aborted", "timeout", "expired", "ended", "abandoned",
])

// The waiter's own ceiling, as a multiple of the inactivity window.
//
// It cannot simply BE `maxSubagentAgeMs`: that window measures silence, and a
// healthy child that streams tokens for ten minutes never trips it. The
// watchdog is the mechanism that ends a hung child (and, through
// teardownSubagent, settles this waiter); the ceiling here only exists for the
// case where no ending path fires at all — an event the plugin never sees, a
// session that vanishes server-side — in which case the parent's tool call
// would hang for the life of the opencode process.
//
// So it must be comfortably LONGER than the watchdog's own worst case
// (`maxSubagentAgeMs` plus one 5 s sweep interval), which any factor > 1
// satisfies, and short enough to still be a rescue. 4x the window — 6 minutes
// at the 90 s default — is that: longer than any run the watchdog would let
// live, shorter than a session the user has given up on.
export const CHILD_WAITER_TIMEOUT_FACTOR = 4

// Resolves the ceiling in ms, or 0 for "no ceiling". `maxSubagentAgeMs = 0`
// disables the inactivity watchdog; it disables this ceiling too, because the
// two are one decision — a user who has switched off the dead-man's switch has
// asked for runs that are not cut off by a clock, and a rescue timer that
// fires anyway would contradict the setting rather than back it up.
export function childWaiterTimeoutMs(maxAgeMs = getSettings().maxSubagentAgeMs) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0
  return maxAgeMs * CHILD_WAITER_TIMEOUT_FACTOR
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
    const timer = setTimeout(() => {
      // The ceiling frees the PARENT, not the child: the child keeps running
      // and is still reaped by its own idle / error / watchdog path, whose
      // later settle attempt then finds no waiter and is a no-op.
      if (settleChildWaiter(childSessionID, {
        status: "expired",
        detail: `no outcome within ${ceiling} ms; the child may still be running`,
      })) {
        log("child waiter expired", { childSessionID, parentSessionID, ceiling })
      }
    }, ceiling)
    // Keep the rescue timer referenced while its promise is pending.
    // settleChildWaiter clears it once an outcome arrives.
    record.timer = timer
  }

  pendingChildResults.set(childSessionID, record)
  log("child waiter registered", { childSessionID, parentSessionID, ceiling })
  return promise
}

// Settles the waiter for `childSessionID`, if there is one, and drops it.
// Returns true when this call was the one that settled it — every ending path
// calls this unconditionally, so the return value is also the answer to "was
// this child being waited on?", which is how a caller decides whether the
// result still needs to go to the parent as a wake notice.
//
// Safe to call for an unwaited child (every child today), for an already
// settled one, and twice from the same path.
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
  }
  return settled
}

// True while `childSessionID` is a child somebody is blocked on.
export function hasChildWaiter(childSessionID) {
  return !!childSessionID && pendingChildResults.has(childSessionID)
}

// The session ids of the live children `parentSessionID` is blocked on.
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

// True when `parentSessionID` has at least one live child. This is the
// predicate the nesting fixes ask for — an idle parent with live children must
// not be torn down, its DELETE must not cascade, and the watchdog must not
// count its silence against it.
export function hasLiveChildren(parentSessionID) {
  if (!parentSessionID) return false
  for (const record of pendingChildResults.values()) {
    if (record.parentSessionID === parentSessionID) return true
  }
  return false
}

// The waiter's parent, or undefined when the child is not being waited on.
// Lets an ending path address the blocked session without a registry lookup —
// the registry entry may already be gone by then.
export function waitingParentOf(childSessionID) {
  return pendingChildResults.get(childSessionID)?.parentSessionID
}
