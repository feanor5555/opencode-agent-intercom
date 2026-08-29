// Unit tests for the two-step confirmation of a subagent abort
// (tui/src/abort-arming.ts). Abort kills a running session and cannot be
// undone, so the panel's three entry points — the row's cross, the `x`/`d` keys
// and the `agent-intercom.abort-selected` command — all go through the one
// decision this module makes: the first request arms an entry, only a second
// request for that same entry aborts, and the arming falls away on its own.
//
// Run: node --test test/tui-abort-arming.test.js

import test from "node:test"
import assert from "node:assert/strict"
import {
  ABORT_CONFIRM_MS,
  ABORT_CONFIRM_TEXT,
  armingAfterSelection,
  armingAfterTimeout,
  decideAbort,
  isAbortArmed,
} from "../tui/src/abort-arming.ts"
import { displayWidth, subagentLabelWidth } from "../tui/src/subagent-label.ts"

const A = "ses_a"
const B = "ses_b"
const T0 = 1_700_000_000_000

test("the first request arms the entry and aborts nothing", () => {
  const decision = decideAbort(undefined, A, T0)
  assert.equal(decision.kind, "arm")
  assert.equal(decision.armed.sessionID, A)
  assert.equal(decision.armed.armedAt, T0)
})

test("a second request for the armed entry aborts it", () => {
  const armed = decideAbort(undefined, A, T0).armed
  const decision = decideAbort(armed, A, T0 + 500)
  assert.equal(decision.kind, "abort")
  assert.equal(decision.sessionID, A)
})

test("a request for another entry arms that one instead of aborting either", () => {
  const armed = decideAbort(undefined, A, T0).armed
  const decision = decideAbort(armed, B, T0 + 100)
  assert.equal(decision.kind, "arm")
  assert.equal(decision.armed.sessionID, B)
  // ...and the entry that was armed before is no longer armed.
  assert.equal(isAbortArmed(decision.armed, A, T0 + 100), false)
})

test("a request after the timeout arms afresh rather than aborting", () => {
  const armed = decideAbort(undefined, A, T0).armed
  const late = decideAbort(armed, A, T0 + ABORT_CONFIRM_MS)
  assert.equal(late.kind, "arm")
  assert.equal(late.armed.armedAt, T0 + ABORT_CONFIRM_MS)
  // A third request, now within the fresh window, is the one that aborts.
  assert.equal(decideAbort(late.armed, A, T0 + ABORT_CONFIRM_MS + 1).kind, "abort")
})

test("the confirmation window is open up to the timeout and closed at it", () => {
  const armed = { sessionID: A, armedAt: T0 }
  assert.equal(isAbortArmed(armed, A, T0), true)
  assert.equal(isAbortArmed(armed, A, T0 + ABORT_CONFIRM_MS - 1), true)
  assert.equal(isAbortArmed(armed, A, T0 + ABORT_CONFIRM_MS), false)
  assert.equal(isAbortArmed(armed, A, T0 + ABORT_CONFIRM_MS * 10), false)
})

test("only the armed entry counts as armed, and nothing counts while nothing is", () => {
  const armed = { sessionID: A, armedAt: T0 }
  assert.equal(isAbortArmed(armed, B, T0), false)
  assert.equal(isAbortArmed(undefined, A, T0), false)
})

test("a clock that jumped backwards does not expire a fresh arming", () => {
  const armed = { sessionID: A, armedAt: T0 }
  assert.equal(isAbortArmed(armed, A, T0 - 5000), true)
  assert.equal(armingAfterTimeout(armed, T0 - 5000), armed)
})

test("the arming survives its own timeout window and no longer", () => {
  const armed = { sessionID: A, armedAt: T0 }
  assert.equal(armingAfterTimeout(armed, T0 + ABORT_CONFIRM_MS - 1), armed)
  assert.equal(armingAfterTimeout(armed, T0 + ABORT_CONFIRM_MS), undefined)
  assert.equal(armingAfterTimeout(undefined, T0), undefined)
})

test("the arming survives only the selection of its own entry", () => {
  const armed = { sessionID: A, armedAt: T0 }
  assert.equal(armingAfterSelection(armed, A), armed)
  assert.equal(armingAfterSelection(armed, B), undefined)
  assert.equal(armingAfterSelection(armed, undefined), undefined)
  assert.equal(armingAfterSelection(undefined, A), undefined)
})

test("a request after the selection moved away and back does not abort", () => {
  // Arm A, move the selection to B — which disarms — then come back to A and
  // press once: that press has to arm again, not abort.
  const armed = decideAbort(undefined, A, T0).armed
  const afterMove = armingAfterSelection(armed, B)
  assert.equal(afterMove, undefined)
  assert.equal(decideAbort(afterMove, A, T0 + 200).kind, "arm")
})

test("a request after Escape took the arming back does not abort", () => {
  const armed = decideAbort(undefined, A, T0).armed
  assert.equal(isAbortArmed(armed, A, T0 + 100), true)
  // Escape drops the arming; the next press starts over.
  assert.equal(decideAbort(undefined, A, T0 + 100).kind, "arm")
})

test("the three entry points share one arming, whichever order they come in", () => {
  // The cross of the row arms it, the `x` key confirms it: the module sees only
  // the requests, so both routes are the same two calls.
  let state = undefined
  const request = (id, now) => {
    const decision = decideAbort(state, id, now)
    state = decision.kind === "arm" ? decision.armed : undefined
    return decision.kind
  }
  assert.equal(request(A, T0), "arm")
  assert.equal(request(A, T0 + 100), "abort")
  // ...and after the abort nothing is left armed.
  assert.equal(request(A, T0 + 200), "arm")
})

test("the confirm text fits the label budget of the default panel", () => {
  assert.ok(
    displayWidth(ABORT_CONFIRM_TEXT) <= subagentLabelWidth(undefined),
    `${ABORT_CONFIRM_TEXT} is ${displayWidth(ABORT_CONFIRM_TEXT)} columns`,
  )
})
