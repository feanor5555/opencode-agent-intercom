# Mid-run messaging

The channel between a caller and a subagent **while the subagent is running**, in
both directions: the orchestrator steers a subagent after it has started, and a
subagent puts a question to its caller instead of only delivering one result and
dying. Current design only.

## The two tools

Both are registered in the non-solo arm of `createTools` (`src/tools.js`), beside
`spawn` / `abort` / `list` / `reuse`, and both handlers go through
`guard(name, handler)`. `midRunMessaging` gates no registration — it is read live
in each handler — so switching the channel off needs no opencode restart and the
tools simply refuse while it is off.

### `message(subagent, text)` — the caller calls it

1. `resolve(ref)` maps handle or raw sessionID to the entry. A foreign handle
   reads as unknown, in the `abort` handler's words, so ownership is not leaked.
2. Under `registryMutex.runExclusive` the entry must be running: not aborted, not
   timed out, not `dispatched` — the same fields the wake's own critical section
   tests. That shared section is what closes the end-of-run race: a message can
   never be written to an entry the idle path has already claimed.
3. Where the entry holds an open question (`entry.pendingAsk`), the text is that
   question's ANSWER. The ask waiter is settled and the text becomes the return
   value of the subagent's blocked `ask` call. Nothing is written to the session.
4. Otherwise the text is framed (`framedAgentMessage`, `src/notices.js`) and
   queued into the subagent's session with
   `promptSession(client, { …, noReply: true })`.

`PRIMARY_TOOLS` (`src/hooks.js`) carries `message`; `SUBAGENT_NO_DELEGATION`
(`src/agents.js`) denies it at the schema level, so a subagent may not steer
another subagent.

### `ask(question)` — the subagent calls it

1. The handler registers an ask waiter (`registerAskWaiter`, `src/agentmsg.js`),
   stamps `entry.pendingAsk`, and posts `askNotice` to the caller through
   `postParentNotice` — the routed path the completion notice uses, so a question
   is buffered during an orchestrator handoff and redirected after one.
2. The tool call blocks on the waiter. Nothing polls; the subagent costs nothing
   while it waits.
3. It settles when the caller answers with `message()`, or when the window
   expires; on expiry the result says no answer came and the run carries on.

The orchestrator's own map denies `ask` at the schema level, the reasoning being
that a tool left in the schema and thrown by the guard drives small models into a
denial loop. `ask` is denied to no subagent role, the `NO_SPAWN` roles included.

## The delivery moment

opencode 1.18.30, read off the binary (`learnings.md`): a prompt into a busy
session is accepted, persisted and queued rather than refused; `noReply: true`
persists the message without starting a turn; and the runner's loop re-reads the
message stream at the top of every iteration, so an appended user message keeps
the loop from exiting and gets a further step. A message therefore reaches the
subagent **at its next step boundary** — as soon as the tool call it is inside
returns, and never inside one. A message that lands while the subagent is writing
its final reply forces one more step rather than being lost.

## The wait window and its clamp

`answerWaitMs` (default 300000 ms) bounds one `ask`. `0` means do not wait: the
question is delivered and the tool returns at once, and an answer that comes later
arrives as an ordinary queued message.

While `ask` is in flight the entry carries a tool call — `beginToolCall` runs for
every tool of a tracked subagent, before any deny — so it is measured against
`maxSubagentToolCallMs` counted from that call's start. The effective wait is
therefore clamped to `min(answerWaitMs, maxSubagentToolCallMs - ASK_WAIT_WATCHDOG_MARGIN_MS)`
where that window is finite, and left unclamped where it is `0`. At the defaults
300 s under a 660 s window the clamp is inert. It is a clamp and not a watchdog
exemption: an exemption would need its own lifting condition and its own bound.

## No deadlock, no spin

- `ask` is refused to a nested subagent: its caller is blocked inside its own
  `spawn` call, cannot run a tool round, and could never answer. Nested
  delegation stays one-shot in both directions.
- One question at a time per subagent; a second is refused.
- The wait is finite and clamped (above).
- Nothing polls on either side. The subagent blocks on a promise, the caller is
  woken by a notice.

Every ending path settles the waiter — `onSessionIdle`, `timeoutSubagent`,
`abortHandler`, `teardownSubagent`, `resetState` — so a blocked `ask` can never
outlive its session.

## Refusals

| Refused when | Tool | What the refusal names |
|---|---|---|
| unknown or foreign handle | `message` | the handle, in the `abort` handler's wording |
| the entry is not running | `message` | that it has finished, and the way forward: `reuse()` where retention is on, a fresh `spawn` where it is not |
| the text is over `maxMessageTokens` | both | the figure it refused on |
| `midRunMessaging` is off | both | the switch |
| the session write failed | `message` | the `promptSession` throw, verbatim, so the caller can retry |
| the caller is itself a subagent | `ask` | that its caller is blocked and cannot answer |
| a question is already open | `ask` | one at a time |

## Ceilings

`maxMessageTokens` (default 1000, `estimateReplyTokens`) bounds one message in
either direction, with **no overflow file** behind it. That is deliberate: a
question or a correction that does not fit in 1000 tokens is the wrong
instrument, and it is what keeps `ask` from being used to route findings past the
final-reply ceiling. `capReplyForAgent` and the result-token ceiling are
untouched by this feature.

## Visibility

- The caller's `message(...)` call is a real tool part in its own session.
- The framed message is a persisted user message in the subagent's session,
  marked with `intercomTextPart` so the handoff's goal scan skips it, and sent
  not hideable — it lands in that session and is read there.
- The subagent's `ask(...)` call and the answer it returns are a real tool part in
  the subagent's session.
- The question notice is an intercom notice and follows `showAgentcom`, like the
  completion notice. That is acceptable because the caller's answer is a visible
  tool call and the exchange is reported in full at the end of the run.
- `list` marks a running row `msgs:N` and `asking`. The TUI sidebar's subagent
  row carries no such marker: the channel has no TUI half.

## The exchange line

`completionNotice` ends with `📨 exchange: 2 messages down, 1 question answered,
1 unanswered`, read off `messagesIn` / `asksAnswered` / `asksUnanswered` inside
the critical section that removes the entry. Absent for a run with no traffic, so
an ordinary completion notice is unchanged.

A message queued but never read (`seen` still false — `markMessagesSeen` is called
from the one hook that fires per LLM request) is named explicitly: the caller was
told the message had been queued, and without this line it would believe a
correction landed that never did. `timeoutNotice` carries the matching sentence
where the entry had a question open at the reap.

## Settings

| Key | Env | Default |
|---|---|---|
| `midRunMessaging` | `OPENCODE_AGENT_INTERCOM_MID_RUN_MESSAGING` | `true` |
| `answerWaitMs` | `OPENCODE_AGENT_INTERCOM_ANSWER_WAIT_MS` | `300000` |
| `maxMessageTokens` | `OPENCODE_AGENT_INTERCOM_MAX_MESSAGE_TOKENS` | `1000` |

All three are mirrored in `tui/src/settings-file.ts` and pinned against the
plugin's own copies by `test/settings-defaults-parity.test.js`. None has a
sidebar row: they are file and env only.

## What the prompts say

The unconditional one-shot claim is gone. `ORCHESTRATION_GUIDE` names `message`
in its tool list, marks an `asking` row in `list()`, and carries a paragraph on
answering a question in the same turn. `SUBAGENT_GUIDE_CORE` opens with one reply
AND reachability, and discriminates `ask` from `Blocked:` — `ask` where one
answer lets the run carry on, `Blocked:` where it cannot carry on at all, where
the answer would change the task, or where a question already went unanswered.
The two nested-delegation blocks keep "There is no wake and no second chance to
ask — one answer, then that subagent is gone", which is about the child a
*subagent* spawns and stays literally true.

`PROMPT_CONTRACT` is `2` for this change; the element text is pinned in
`test/fixtures/prompt-contract.json` and re-pinned with `npm run pin:contract`.

## Solo mode

No second agent exists, so neither tool is registered (both sit in the non-solo
arm) and both names are in `SOLO_DENIED_TOOLS` — the denylist is what holds if one
reappears by a route the tool map does not decide.
