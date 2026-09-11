// The ask waiter: the state that makes "this subagent has stopped and is
// waiting for its caller's answer" expressible.
//
// A registry entry describes a subagent that talks in one direction — it is
// spawned, it works, it replies once — and carries no field for "I asked a
// question and I am holding". That is exactly the state the `ask` tool needs:
// the subagent's tool call does not return until an answer arrives, so the
// waiter's promise IS the subagent's block and the answer IS the tool result.
//
// Built as childwait.js is, and for the same reasons: one record per waiting
// session, keyed by the ASKING subagent's session id (the id every ending path
// already has in hand), carrying the caller's id (the direction "which of my
// subagents is waiting on me?" asks in), with an idempotent `settle` held on
// the record so state.js can release a leftover without importing this module.
//
// What it is NOT is a second watchdog. The blocked `ask` call is an ordinary
// tool call of a tracked subagent — `beginToolCall` runs for every tool before
// any deny (src/hooks.js) — so the entry is already measured against
// `maxSubagentToolCallMs` from that call's start. This module's own ceiling is
// therefore CLAMPED to stay inside that window rather than exempting anything
// from it: an exemption would need its own lifting condition and its own bound,
// a clamp needs neither. See askWaitMs.
//
// Every function in this module is SYNCHRONOUS and takes no lock, so it can be
// called from inside a `registryMutex.runExclusive` section without nesting the
// non-re-entrant FIFO mutex — which is where the `message` tool has to settle
// an answer, in the same critical section that decides the subagent is still
// running.

import { pendingAsks } from "./state.js"
import { getSettings, workingWindowMs } from "./settings.js"
import { log } from "./log.js"

// How a question ended. The subagent's `ask` tool call renders its tool result
// from this, so every value has to be one the subagent can act on.
//
//   answered    — the caller replied; `answer` carries the text
//   unanswered  — the wait window ran out; the caller never answered
//   not-waiting — no wait was taken at all: the question was delivered and the
//                 call returned at once, because `answerWaitMs` is 0 or the
//                 clamp left no room. An answer may still arrive later, as an
//                 ordinary queued message
//   aborted     — the asking subagent was aborted
//   timeout     — the inactivity watchdog reaped the asking subagent
//   ended       — the subagent was torn down by a path that named no outcome
//   abandoned   — resetState() cleared the process state out from under it
export const ASK_OUTCOMES = Object.freeze([
  "answered", "unanswered", "not-waiting", "aborted", "timeout", "ended", "abandoned",
])

// The margin the wait keeps below the watchdog window the blocked `ask` call is
// measured against. One minute: enough for the answer to travel the whole way —
// the caller's `message` tool settles the waiter, the subagent's tool call
// returns, its next step starts — inside the window, so a question answered at
// the last moment is not thrown away by a reap that fires while the answer is
// in flight.
export const ASK_WAIT_WATCHDOG_MARGIN_MS = 60000

// The wait in ms this process will actually take on one question, or 0 for "do
// not wait at all".
//
// Two numbers decide it. `answerWaitMs` is what the user asked for, and 0 there
// means the question is delivered and the tool returns at once. Against it
// stands the watchdog window the blocked call sits on, resolved by the one
// helper `watchdogLimit` (src/watchdog.js) resolves it with — `workingWindowMs`
// in src/settings.js — so the clamp is measured against the window that will
// really fire rather than against a second reading of the same two settings.
//
// An explicit 0 on that window means "no ceiling while a subagent works", so
// there is nothing to clamp against and the requested wait stands unclamped.
// Any finite window is clamped to `window - ASK_WAIT_WATCHDOG_MARGIN_MS`, and
// where that leaves nothing — a window at or below the margin — the answer is 0
// rather than a negative or zero wait: there is no room to wait inside a window
// that short, and blocking anyway would only hand the subagent a reap instead
// of an answer. At the shipped defaults the clamp is inert, 300 s of wait under
// a 660 s window.
export function askWaitMs(settings = getSettings()) {
  const requested = settings?.answerWaitMs
  if (!Number.isFinite(requested) || requested <= 0) return 0
  const windowMs = workingWindowMs(settings)
  if (!Number.isFinite(windowMs) || windowMs <= 0) return requested
  const room = windowMs - ASK_WAIT_WATCHDOG_MARGIN_MS
  if (room <= 0) return 0
  return Math.min(requested, room)
}

// Monotonic within one process, so a question can be named in a log line, in
// the notice to the caller and in the entry's `pendingAsk` without any of the
// three having to carry the text. Never reset — an id is only ever compared for
// equality, and a fresh one per ask is all that is asked of it.
let askCounter = 0

function nextAskId() {
  askCounter += 1
  return `ask${askCounter}`
}

// Registers a question from `sessionID` to `parentID` and returns
// `{ id, question, askedAt, waitMs, promise }`:
//
//   - `id`, `question` and `askedAt` are the descriptor the caller stamps onto
//     the registry entry with `openAsk` and posts to the asking subagent's
//     caller, so the two sides name the same question.
//   - `waitMs` is the wait actually taken, after the clamp — the figure the
//     tool result and the notice quote, so neither promises a window that was
//     cut down.
//   - `promise` is what the `ask` tool call blocks on. It RESOLVES on every
//     path and never rejects: an ending is a result the subagent has to act on,
//     not an exception in its own tool call.
//
// A wait of 0 registers NO record and hands back an already-resolved
// `not-waiting` promise. That keeps "there is an open question" and "somebody
// is blocked on it" the same statement: nothing is waiting, so `openAskFor`
// must not report one, and no ending path has a waiter to settle.
//
// Throws on a double registration for the same session. One question at a time
// is enforced on the entry (`openAsk`, src/registry.js); a collision reaching
// here is a bug, and handing the second caller the first caller's promise would
// give two tool calls one answer.
export function registerAskWaiter(sessionID, parentID, { question, id, timeoutMs } = {}) {
  if (!sessionID) throw new Error("registerAskWaiter: sessionID is required")
  if (!parentID) throw new Error("registerAskWaiter: parentID is required")
  if (pendingAsks.has(sessionID)) {
    throw new Error(`registerAskWaiter: a question is already open for ${sessionID}`)
  }

  const askId = id || nextAskId()
  const askedAt = Date.now()
  const waitMs = timeoutMs === undefined ? askWaitMs() : timeoutMs
  const descriptor = { id: askId, question, askedAt }

  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    log("ask registered without a wait", { sessionID, parentID, id: askId })
    return {
      ...descriptor,
      waitMs: 0,
      promise: Promise.resolve({
        status: "not-waiting",
        detail: "the answer wait is switched off; an answer would arrive as a queued message",
        sessionID,
        parentID,
        id: askId,
        question,
        waitedMs: 0,
      }),
    }
  }

  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })

  const record = {
    sessionID,
    // The caller as it stood when the question was asked. Used for the log line
    // and carried back in the resolved outcome; it is NOT re-read by any
    // routing decision, which is why an orchestrator handoff (reparentSubagents,
    // src/registry.js) rewrites `parentID` on the registry entry and leaves this
    // one as the historical record of who was asked.
    parentID,
    id: askId,
    question,
    askedAt,
    waitMs,
    promise,
    settled: false,
    timer: null,
    // Idempotent, and the ONLY place the promise is resolved. Kept on the
    // record (rather than reached through the map) so resetState can settle a
    // leftover without importing this module — state.js is imported by
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
        sessionID,
        parentID,
        id: askId,
        question,
        waitedMs: Date.now() - askedAt,
      })
      return true
    },
  }

  // One-shot, and deliberately NOT the re-arming rescue childwait.js uses. That
  // timer guards against an ending path that never fires and re-arms while the
  // watchdog still owns the child; this one IS the answer window the caller was
  // promised, and a window that re-armed itself would be no window at all. The
  // clamp above is what keeps it inside the watchdog's.
  record.timer = setTimeout(() => {
    record.timer = null
    pendingAsks.delete(sessionID)
    if (
      record.settle({
        status: "unanswered",
        detail: `no answer within ${waitMs} ms`,
      })
    ) {
      log("ask expired unanswered", { sessionID, parentID, id: askId, waitMs })
    }
  }, waitMs)

  pendingAsks.set(sessionID, record)
  log("ask registered", { sessionID, parentID, id: askId, waitMs })
  return { ...descriptor, waitMs, promise }
}

// Settles the open question of `sessionID`, if there is one, and drops it.
// Returns true when this call was the one that settled it, so a caller can tell
// "I answered it" from "somebody got there first".
//
// Every path that ends a subagent calls this unconditionally — idle, watchdog
// timeout, abort, teardown, reset — so a blocked `ask` can never outlive its
// session. Safe to call for a session with no question, for an already settled
// one, and twice from the same path.
export function settleAsk(sessionID, outcome = {}) {
  if (!sessionID) return false
  const record = pendingAsks.get(sessionID)
  if (!record) return false
  pendingAsks.delete(sessionID)
  const settled = record.settle(outcome)
  if (settled) {
    log("ask settled", {
      sessionID,
      parentID: record.parentID,
      id: record.id,
      status: outcome.status ?? "ended",
    })
  }
  return settled
}

// The question `sessionID` has open, as `{ id, question, askedAt, parentID,
// waitMs }`, or undefined when it has none. The read behind "this subagent is
// waiting on me" wherever the registry entry is not at hand — and the entry may
// already be gone by the time an ending path asks.
export function openAskFor(sessionID) {
  const record = sessionID ? pendingAsks.get(sessionID) : undefined
  if (!record || record.settled) return undefined
  return {
    id: record.id,
    question: record.question,
    askedAt: record.askedAt,
    parentID: record.parentID,
    waitMs: record.waitMs,
  }
}
