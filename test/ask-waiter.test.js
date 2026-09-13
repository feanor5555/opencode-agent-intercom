// The ask waiter (src/agentmsg.js): the state that makes "this subagent has
// stopped and is waiting for its caller's answer" expressible.
//
// Four things are pinned here, because each closes one way the channel could
// hang or lie:
//
//   - the wait is settled exactly ONCE, whichever path gets there first, and
//     the promise resolves on every path rather than rejecting;
//   - the wait is CLAMPED against the watchdog window the blocked `ask` call is
//     measured on, so it can never outlive the reap that would cut the subagent
//     off inside it — and is left unclamped where that window is switched off;
//   - the window expiring settles as `unanswered` and the run carries on;
//   - `answerWaitMs: 0` takes no wait at all and registers no record, so
//     nothing reads as "a question is open" that nobody is blocked on.
//
// Run: node --test --test-timeout=5000 test/ask-waiter.test.js

import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pendingAsks, resetState } from "../src/state.js"
import { getSettings, resetSettings, setSettingsPath } from "../src/settings.js"
import {
  ASK_OUTCOMES,
  ASK_WAIT_BOUNDS,
  ASK_WAIT_RUN_MARGIN_MS,
  ASK_WAIT_WATCHDOG_MARGIN_MS,
  askWaitDecision,
  askWaitMs,
  openAskFor,
  registerAskWaiter,
  settleAsk,
} from "../src/agentmsg.js"
import { WATCHDOG_INTERVAL_MS } from "../src/watchdog.js"

const dir = mkdtempSync(join(tmpdir(), "ask-waiter-"))
const file = join(dir, "agent-intercom.json")

const ENV = [
  "OPENCODE_AGENT_INTERCOM_ANSWER_WAIT_MS",
  "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_TOOL_CALL_MS",
  "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS",
  "OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_RUN_MS",
]

const NOW = 1_700_000_000_000

// A running subagent as the clamp reads it: its type, which decides the run
// ceiling, and the stamp its run is counted from (`entry.runStartedAt`,
// src/registry.js).
function running(elapsedMs, agent = "coder") {
  return { agent, runStartedAt: NOW - elapsedMs }
}

beforeEach(() => {
  resetState()
  rmSync(file, { force: true })
  setSettingsPath(file)
  for (const name of ENV) delete process.env[name]
  resetSettings()
})

afterEach(() => {
  resetState()
  rmSync(file, { force: true })
  resetSettings()
})

// Points both sides of the clamp at chosen values through the settings file,
// which is the resolution order the production read takes.
function withSettings(content) {
  writeFileSync(file, JSON.stringify(content))
  resetSettings()
  return getSettings()
}

test("the wait is clamped a minute under the window the blocked call sits on", () => {
  // The blocked `ask` is an ordinary tool call of a tracked subagent, so the
  // entry is measured against maxSubagentToolCallMs from that call's start. The
  // clamp is what keeps the wait inside it without any watchdog exemption.
  assert.equal(ASK_WAIT_WATCHDOG_MARGIN_MS, 60000)

  // At the shipped defaults the clamp is inert: 300 s of wait, 660 s of window.
  assert.equal(askWaitMs(getSettings()), 300000)

  // A window the requested wait would overrun cuts it down to window - margin.
  assert.equal(askWaitMs(withSettings({ answerWaitMs: 300000, maxSubagentToolCallMs: 200000 })), 140000)

  // A window at or below the margin leaves no room to wait at all: blocking
  // there would hand the subagent a reap instead of an answer.
  assert.equal(askWaitMs(withSettings({ answerWaitMs: 300000, maxSubagentToolCallMs: 60000 })), 0)
  assert.equal(askWaitMs(withSettings({ answerWaitMs: 300000, maxSubagentToolCallMs: 10000 })), 0)

  // A requested wait already inside the window is not stretched to fill it.
  assert.equal(askWaitMs(withSettings({ answerWaitMs: 30000, maxSubagentToolCallMs: 600000 })), 30000)
})

test("a tool-call window of 0 means no ceiling while it works, so nothing is clamped", () => {
  // 0 on that window says "no ceiling while a subagent works". There is nothing
  // to stay under, so the requested wait stands whole.
  assert.equal(askWaitMs(withSettings({ answerWaitMs: 300000, maxSubagentToolCallMs: 0 })), 300000)
})

test("a settings object carrying no tool-call window is clamped against the silence one", () => {
  // Read exactly as watchdogLimit reads it: absent is not the same statement as
  // an explicit 0, and the silence window is what would fire.
  assert.equal(askWaitMs({ answerWaitMs: 300000, maxSubagentAgeMs: 90000 }), 30000)
  assert.equal(askWaitMs({ answerWaitMs: 300000, maxSubagentAgeMs: 0 }), 300000)
})

// The second clamp, over the same wait: the run ceiling is the window the whole
// RUN sits under, and the wrap-up band points a subagent at `ask` at 0.75 of
// it — so without this clamp the plugin would offer a wait it is itself about
// to cut off, on the very path it recommends.
test("the wait is clamped a sweep tick under what is left of the run ceiling", () => {
  // One sweep tick, because that is how often the ceiling is compared against
  // the run's wall clock: a wait ending exactly at the ceiling would be settled
  // by the tick that reaps the session.
  assert.equal(ASK_WAIT_RUN_MARGIN_MS, WATCHDOG_INTERVAL_MS)

  const settings = withSettings({ answerWaitMs: 300000, maxSubagentRunMs: 600000 })

  // Early in the run there is more room left than the wait asks for, so nothing
  // is cut and the working-window clamp is the only one that could speak.
  assert.equal(askWaitMs(settings, running(60000), NOW), 300000)

  // Late in the run the remainder decides: 600 000 - 500 000 - one tick.
  assert.equal(askWaitMs(settings, running(500000), NOW), 95000)

  // Past the ceiling — the sweep has not reached this entry yet — there is
  // nothing left to wait inside.
  assert.equal(askWaitMs(settings, running(600000), NOW), 0)
  assert.equal(askWaitMs(settings, running(900000), NOW), 0)
})

test("the run clamp reads the type's own agentRunMs entry", () => {
  const settings = withSettings({
    answerWaitMs: 300000,
    maxSubagentRunMs: 600000,
    agentRunMs: { researcher: 7200000 },
  })

  // The flat ceiling still governs a type without an entry of its own.
  assert.equal(askWaitMs(settings, running(500000, "coder"), NOW), 95000)
  // The type with one is measured against it and keeps the whole wait.
  assert.equal(askWaitMs(settings, running(500000, "researcher"), NOW), 300000)
})

test("no run ceiling and no run stamp both leave the wait unclamped", () => {
  // 0 means the type has no run ceiling, exactly as it does on the other two
  // windows: there is nothing to stay under.
  const off = withSettings({ answerWaitMs: 300000, maxSubagentRunMs: 0 })
  assert.equal(askWaitMs(off, running(900000), NOW), 300000)

  // An entry with no run clock — a hand-built one, or no entry at all — is read
  // as having none, the way watchdogLimit reads it: the run case fails open.
  const on = withSettings({ answerWaitMs: 300000, maxSubagentRunMs: 600000 })
  assert.equal(askWaitMs(on, { agent: "coder" }, NOW), 300000)
  assert.equal(askWaitMs(on, undefined, NOW), 300000)
})

// The figure alone cannot say which setting to raise, and the tool result has
// to: a subagent told `answerWaitMs` is 0 when it is 300 s acts on the wrong
// number.
test("the decision names the bound that produced the wait", () => {
  assert.deepEqual([...ASK_WAIT_BOUNDS], ["answer-wait", "working-window", "run-ceiling"])

  // Nothing clamped: the wait is what was asked for.
  const inert = withSettings({ answerWaitMs: 300000, maxSubagentRunMs: 2640000 })
  assert.deepEqual(askWaitDecision(inert, running(60000), NOW), {
    waitMs: 300000,
    requestedMs: 300000,
    bound: "answer-wait",
    boundMs: 300000,
  })

  // answerWaitMs itself is 0: no bound cut anything.
  assert.deepEqual(askWaitDecision(withSettings({ answerWaitMs: 0 }), running(60000), NOW), {
    waitMs: 0,
    requestedMs: 0,
    bound: "answer-wait",
    boundMs: 0,
  })

  // The working window cuts it, and `boundMs` is the window itself rather than
  // the room left inside it, so the text built from it names a real setting.
  const narrowWindow = withSettings({
    answerWaitMs: 300000,
    maxSubagentToolCallMs: 200000,
    maxSubagentRunMs: 2640000,
  })
  assert.deepEqual(askWaitDecision(narrowWindow, running(60000), NOW), {
    waitMs: 140000,
    requestedMs: 300000,
    bound: "working-window",
    boundMs: 200000,
  })

  // The run ceiling cuts it below what the window left: the tighter of the two
  // is the one named.
  const shortRun = withSettings({
    answerWaitMs: 300000,
    maxSubagentToolCallMs: 200000,
    maxSubagentRunMs: 600000,
  })
  assert.deepEqual(askWaitDecision(shortRun, running(520000), NOW), {
    waitMs: 75000,
    requestedMs: 300000,
    bound: "run-ceiling",
    boundMs: 600000,
  })

  // And where the window is the tighter of the two, the run does not take the
  // name from it: a bound is only reported where it actually decided.
  assert.deepEqual(askWaitDecision(shortRun, running(60000), NOW), {
    waitMs: 140000,
    requestedMs: 300000,
    bound: "working-window",
    boundMs: 200000,
  })
})

test("answerWaitMs 0 takes no wait, registers nothing and resolves not-waiting", async () => {
  withSettings({ answerWaitMs: 0 })
  const ask = registerAskWaiter("ses_sub", "ses_primary", { question: "which lockfile?" })
  assert.equal(ask.waitMs, 0)
  assert.equal(pendingAsks.size, 0, "no record, so no ending path has a waiter to settle")
  assert.equal(openAskFor("ses_sub"), undefined, "nothing is open that nobody waits on")

  const outcome = await ask.promise
  assert.equal(outcome.status, "not-waiting")
  assert.equal(outcome.sessionID, "ses_sub")
  assert.equal(outcome.parentID, "ses_primary")
  assert.equal(outcome.id, ask.id)
  assert.match(outcome.detail, /queued message/)
})

test("an answer settles the wait once and carries the text back", async () => {
  const ask = registerAskWaiter("ses_sub", "ses_primary", {
    question: "which lockfile?",
    timeoutMs: 5000,
  })
  assert.equal(pendingAsks.size, 1)
  assert.deepEqual(openAskFor("ses_sub"), {
    id: ask.id,
    question: "which lockfile?",
    askedAt: ask.askedAt,
    parentID: "ses_primary",
    waitMs: 5000,
  })

  assert.equal(settleAsk("ses_sub", { status: "answered", answer: "the npm one" }), true)
  // Whoever gets there second is told so rather than silently overwriting.
  assert.equal(settleAsk("ses_sub", { status: "aborted" }), false)

  const outcome = await ask.promise
  assert.equal(outcome.status, "answered")
  assert.equal(outcome.answer, "the npm one")
  assert.equal(outcome.question, "which lockfile?")
  assert.equal(typeof outcome.waitedMs, "number")
  assert.equal(pendingAsks.size, 0)
  assert.equal(openAskFor("ses_sub"), undefined)
})

test("the window expiring settles as unanswered and the run carries on", async () => {
  const ask = registerAskWaiter("ses_sub", "ses_primary", { question: "which?", timeoutMs: 20 })
  const outcome = await ask.promise
  assert.equal(outcome.status, "unanswered")
  assert.match(outcome.detail, /no answer within 20 ms/)
  assert.equal(pendingAsks.size, 0, "the expired record is dropped, not left behind")
  assert.equal(openAskFor("ses_sub"), undefined)
  // A late answer finds nothing to settle and says so, rather than resolving a
  // promise the subagent has already acted on.
  assert.equal(settleAsk("ses_sub", { status: "answered", answer: "too late" }), false)
})

test("every ending path settles the same way and none leaves a waiter", async () => {
  for (const status of ["aborted", "timeout", "ended"]) {
    resetState()
    const ask = registerAskWaiter("ses_sub", "ses_primary", { question: "q", timeoutMs: 5000 })
    assert.equal(settleAsk("ses_sub", { status }), true)
    const outcome = await ask.promise
    assert.equal(outcome.status, status)
    assert.equal(pendingAsks.size, 0, `${status} leaves no waiter`)
  }

  // A path that named no outcome at all still resolves, as "ended".
  const bare = registerAskWaiter("ses_sub2", "ses_primary", { question: "q", timeoutMs: 5000 })
  assert.equal(settleAsk("ses_sub2"), true)
  assert.equal((await bare.promise).status, "ended")

  // And settling a session that never asked is a no-op, so every ending path
  // may call it unconditionally.
  assert.equal(settleAsk("ses_never"), false)
  assert.equal(settleAsk(undefined), false)
})

test("resetState settles a leftover waiter instead of stranding its promise", async () => {
  const ask = registerAskWaiter("ses_sub", "ses_primary", { question: "q", timeoutMs: 5000 })
  resetState()
  const outcome = await ask.promise
  assert.equal(outcome.status, "abandoned")
  assert.equal(pendingAsks.size, 0)
})

test("a second question for the same session is a bug, not a shared answer", () => {
  registerAskWaiter("ses_sub", "ses_primary", { question: "first", timeoutMs: 5000 })
  assert.throws(
    () => registerAskWaiter("ses_sub", "ses_primary", { question: "second", timeoutMs: 5000 }),
    /already open for ses_sub/,
  )
  assert.throws(() => registerAskWaiter("", "ses_primary", {}), /sessionID is required/)
  assert.throws(() => registerAskWaiter("ses_x", "", {}), /parentID is required/)
})

test("the outcome vocabulary is closed and every status used here is in it", async () => {
  assert.deepEqual(
    [...ASK_OUTCOMES],
    ["answered", "unanswered", "not-waiting", "aborted", "timeout", "ended", "abandoned"],
  )
  // The one status the module produces without a caller naming it.
  const ask = registerAskWaiter("ses_sub", "ses_primary", { question: "q", timeoutMs: 10 })
  assert.ok(ASK_OUTCOMES.includes((await ask.promise).status))
})
