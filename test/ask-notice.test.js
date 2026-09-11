// The notice texts of the mid-run channel, and the entry read they are built
// from. Pure composition — no plugin, no client, no filesystem.
//
// What is pinned here:
//   - the question notice a subagent's `ask` posts to its caller: the marker
//     the orchestration guide names (`asks you:`), the one action that answers
//     it, and that it is not reported as a finished run;
//   - the framing every queued message is wrapped in before it enters the
//     subagent's session;
//   - the exchange line on the completion notice, including the sentence that
//     names a steering message the subagent never read;
//   - the sentence the timeout notice gains when the reaped subagent had a
//     question open to the orchestrator that was never answered;
//   - `exchangeSnapshot`, the registry read all of that is composed from.
//
// Run: node --test test/ask-notice.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  askNotice,
  framedAgentMessage,
  completionNotice,
  timeoutNotice,
} from "../src/notices.js"
import { exchangeSnapshot, noteMessageIn, markMessagesSeen } from "../src/registry.js"

const ENTRY = { handle: "coder#1", agent: "coder", sessionID: "ses_sub1" }
const PRIMARY = "ses_primary"
const SILENCE_LIMIT = { ms: 90000, setting: "maxSubagentAgeMs", kind: "silence" }

test("askNotice names the subagent, the question and the one call that answers it", () => {
  const notice = askNotice(ENTRY, {
    id: "ask1",
    question: "the repo has two lockfiles — which one is authoritative?",
    waitMs: 300000,
  })
  assert.match(notice, /^❓ agent-intercom: your subagent "coder#1" \(coder\, session ses_sub1\) asks you:/)
  assert.match(notice, /two lockfiles/)
  assert.match(notice, /message\("coder#1", "<your answer>"\)/)
  assert.match(notice, /waits 300s/)
  assert.match(notice, /STOPPED and is waiting/)
  // The two mistakes the notice exists to prevent.
  assert.match(notice, /do not report it to the user as a result/)
  assert.match(notice, /spawn\s+nothing for it/)
})

test("askNotice says so where the run takes no wait at all", () => {
  const notice = askNotice(ENTRY, { id: "ask1", question: "which one?", waitMs: 0 })
  assert.match(notice, /It is NOT waiting/)
  assert.doesNotMatch(notice, /waits \d+s/)
})

test("framedAgentMessage marks the text as an instruction and not a new task", () => {
  const framed = framedAgentMessage("drop the SQLite path, use the HTTP API")
  assert.match(framed, /^📨 agent-intercom: message from the orchestrator/)
  assert.match(framed, /this is NOT a new task/)
  assert.match(framed, /say in your final reply what you did with it/)
  assert.ok(framed.endsWith("drop the SQLite path, use the HTTP API"))
})

// The exchange line is a tail of the completion notice, so it is read through
// the notice itself rather than through a private helper.
function notice(exchange) {
  return completionNotice(
    "coder#1", "coder", "done", PRIMARY, undefined, 0, 0, undefined, 1, false, exchange,
  )
}

test("a run with no mid-run traffic renders the completion notice it always did", () => {
  const without = completionNotice("coder#1", "coder", "done", PRIMARY, undefined, 0, 0, undefined)
  assert.equal(notice(exchangeSnapshot({})), without, "an untouched entry adds nothing")
  assert.doesNotMatch(without, /📨 exchange/)
})

test("the exchange line reports messages down, answered and unanswered questions", () => {
  const text = notice({ messages: 2, unread: 0, asksOut: 2, asksAnswered: 1, asksUnanswered: 1 })
  assert.match(text, /📨 exchange: 2 messages down, 1 question answered, 1 unanswered\./)
})

test("a question that took no wait is its own clause, not an unanswered one", () => {
  // `answerWaitMs: 0`: the question was delivered and the call returned at once,
  // so nobody was given the chance to answer it and nobody failed to.
  const text = notice({ messages: 0, unread: 0, asksOut: 2, asksAnswered: 0, asksUnanswered: 0 })
  assert.match(text, /📨 exchange: 2 questions delivered without a wait\./)
  assert.doesNotMatch(text, /unanswered/)

  // And it is countable beside the ones that did take a wait.
  const mixed = notice({ messages: 0, unread: 0, asksOut: 2, asksAnswered: 0, asksUnanswered: 1 })
  assert.match(mixed, /📨 exchange: 1 unanswered, 1 question delivered without a wait\./)
})

test("a message the subagent never read is named, with the time it was sent", () => {
  const sentAt = new Date(2026, 0, 2, 14, 2).getTime()
  const text = notice({ messages: 1, unread: 1, unreadAt: sentAt, asksAnswered: 0, asksUnanswered: 0 })
  assert.match(text, /📨 exchange: 1 message down — the message you sent at 14:02 was never read/)
  assert.match(text, /still inside a tool call when it finished/)
})

test("exchangeSnapshot reads the entry the notice is composed from", () => {
  const entry = { messagesIn: [], asksAnswered: 0, asksUnanswered: 0 }
  noteMessageIn(entry, "first", 1000)
  noteMessageIn(entry, "second", 2000)
  markMessagesSeen(entry)
  noteMessageIn(entry, "third", 3000)
  entry.asksOut = 3
  entry.asksAnswered = 1
  entry.asksUnanswered = 2

  assert.deepEqual(exchangeSnapshot(entry), {
    messages: 3,
    unread: 1,
    unreadAt: 3000,
    asksOut: 3,
    asksAnswered: 1,
    asksUnanswered: 2,
  })
  // An entry from before the fields existed reads as no traffic at all.
  assert.deepEqual(exchangeSnapshot({}), {
    messages: 0,
    unread: 0,
    unreadAt: undefined,
    asksOut: 0,
    asksAnswered: 0,
    asksUnanswered: 0,
  })
})

test("timeoutNotice names a question the reaped subagent never got answered", () => {
  const reaped = { ...ENTRY, lastActivity: "[tool: bash]" }
  const bare = timeoutNotice(reaped, SILENCE_LIMIT, 91000)
  assert.doesNotMatch(bare, /❓/, "a reap with no open question is the notice it always was")

  const asked = timeoutNotice(reaped, SILENCE_LIMIT, 91000, "", {
    id: "ask1",
    question: "which lockfile is authoritative?",
  })
  assert.ok(asked.startsWith(bare), "the timeout wording itself is untouched")
  assert.match(asked, /❓ It had a question open to YOU when the clock ran out/)
  assert.match(asked, /which lockfile is authoritative\?/)
  assert.match(asked, /Decide that question before you re-dispatch/)
})
