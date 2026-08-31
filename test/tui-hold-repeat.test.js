// Unit tests for the press-and-hold auto-repeat of the sidebar's stepper
// buttons (tui/src/hold-repeat.ts).
//
// One press must be one step, and the run must end on release with no timer
// left armed — including when the action writes the very signal the row's JSX
// reads, which rebuilds the handler object mid-press: the mouseup then reaches
// a different handler object than the mousedown did, and the timers still have
// to be cancelled by it.
//
// Run: node --test test/tui-hold-repeat.test.js

import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  HOLD_REPEAT_DELAY_MS,
  HOLD_REPEAT_INTERVAL_MS,
  holdRepeat,
  isHoldRepeatActive,
  stopHoldRepeat,
} from "../tui/src/hold-repeat.ts"

// The timers are module state shared by every handler pair, so each test leaves
// them ended.
afterEach(() => stopHoldRepeat())

// node:test's mock timers do not run an interval that was created during the
// tick they are in, so the delay is always ticked off on its own before the
// repeat is ticked.
const withFakeTimers = (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  return t.mock.timers
}

test("a tap fires the action exactly once and arms nothing beyond it", (t) => {
  const timers = withFakeTimers(t)
  let calls = 0
  const button = holdRepeat(() => {
    calls += 1
  })

  button.onMouseDown()
  assert.equal(calls, 1)
  button.onMouseUp()

  assert.equal(isHoldRepeatActive(), false)
  timers.tick(HOLD_REPEAT_DELAY_MS + 100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 1)
})

test("a press whose action rebuilds the handler pair still ends on release", (t) => {
  const timers = withFakeTimers(t)
  let calls = 0
  // What the effort row does: the action writes the signal the reactive spread
  // reads, so a fresh handler pair is built and mounted while the mousedown of
  // the old pair is still running. The release then reaches the new pair.
  let mounted
  const build = () => {
    mounted = holdRepeat(() => {
      calls += 1
      build()
    })
  }
  build()

  const pressed = mounted
  pressed.onMouseDown()
  assert.equal(calls, 1)
  assert.notEqual(mounted, pressed, "the action must have remounted a fresh pair")

  mounted.onMouseUp()
  assert.equal(isHoldRepeatActive(), false)
  timers.tick(HOLD_REPEAT_DELAY_MS + 100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 1, "the release cancelled the run the other pair started")
})

test("holding repeats only after the delay, and only while held", (t) => {
  const timers = withFakeTimers(t)
  let calls = 0
  const button = holdRepeat(() => {
    calls += 1
  })

  button.onMouseDown()
  timers.tick(HOLD_REPEAT_DELAY_MS - 1)
  assert.equal(calls, 1, "nothing repeats before the delay is out")

  timers.tick(1)
  timers.tick(3 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 4)

  button.onMouseUp()
  timers.tick(100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 4, "the repeat stops with the release")
  assert.equal(isHoldRepeatActive(), false)
})

test("a rebuilt pair cancels the repeat a held press already started", (t) => {
  const timers = withFakeTimers(t)
  let calls = 0
  let mounted
  const build = () => {
    mounted = holdRepeat(() => {
      calls += 1
      build()
    })
  }
  build()

  mounted.onMouseDown()
  timers.tick(HOLD_REPEAT_DELAY_MS)
  timers.tick(2 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 3)

  mounted.onMouseUp()
  timers.tick(100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 3)
  assert.equal(isHoldRepeatActive(), false)
})

test("mouseout ends the run the same way mouseup does", (t) => {
  const timers = withFakeTimers(t)
  let calls = 0
  const button = holdRepeat(() => {
    calls += 1
  })

  button.onMouseDown()
  button.onMouseOut()
  assert.equal(isHoldRepeatActive(), false)
  timers.tick(HOLD_REPEAT_DELAY_MS + 100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(calls, 1)
})

test("a second press replaces the run instead of stacking one beside it", (t) => {
  const timers = withFakeTimers(t)
  let first = 0
  let second = 0
  const a = holdRepeat(() => {
    first += 1
  })
  const b = holdRepeat(() => {
    second += 1
  })

  // Two presses in a row with no release between them — what a terminal
  // delivers when it drops a button-release event.
  a.onMouseDown()
  b.onMouseDown()
  assert.equal(first, 1)
  assert.equal(second, 1)

  timers.tick(HOLD_REPEAT_DELAY_MS)
  timers.tick(2 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(first, 1, "the first press's repeat was taken over, not left running")
  assert.equal(second, 3)

  b.onMouseUp()
  timers.tick(100 * HOLD_REPEAT_INTERVAL_MS)
  assert.equal(first, 1)
  assert.equal(second, 3)
  assert.equal(isHoldRepeatActive(), false)
})
