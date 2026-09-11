# Mid-run agent messaging

A channel for messages between a caller and a subagent **while the subagent is running**, in both
directions: the orchestrator steers a subagent after it has started, and a subagent puts a question
to its caller instead of only delivering one result and dying.

Boundary: this plugin. No new service, no new host, no opencode fork. Everything below is decided
inside `src/`, `tui/`, the prompt blocks and the settings file.

---

## 1. The material

### 1.1 What this plugin does today

- The whole tool map is `spawn` / `abort` / `list`, plus `reuse` only when retention is latched on
  (`src/tools.js:1523-1603`); the map is built once, at plugin load.
- Nothing addresses a running subagent. The three send sites into a session are the spawn prompt
  (`src/tools.js:773`), the reuse prompt into an already **finished** session (`src/tools.js:1252`)
  and the handoff kickoff (`src/handoffwiring.js:212,366,419`).
- The only upward channel is the final reply turned into a wake notice (`completionNotice`,
  `src/notices.js:108`, posted through `postParentNotice`, `src/teardown.js:169`), with `Blocked:`
  as a marker on its first line (`isBlockedResult`, `src/notices.js:29`).
- Subagents are denied the orchestration tools at the schema level:
  `const SUBAGENT_NO_DELEGATION = { task: "deny", abort: "deny", list: "deny" }`
  (`src/agents.js:189-191`); the runtime guard re-denies every agent-starting tool
  (`src/hooks.js:2262-2271`).
- The prompts state one-shot unconditionally: `"You are a one-shot subagent — do one focused task,
  then reply once and return."` (`src/prompts.js:86`), `"One-shot: it replies once then is
  destroyed."` (`src/prompts.js:29`), `"One-shot: a subagent replies once and is destroyed."`
  (`src/tools.js:1532`), `"Finished ones are gone (one-shot)"` (`src/tools.js:1559`).
- Retention is off in the shipped default — `export const DEFAULT_MAX_RETAINED_SUBAGENTS = 0`
  (`src/settings.js:153`) — latched at load (`retentionOffered`, `src/settings.js:754`), so `reuse`
  is not registered and `ORCHESTRATION_REUSE_GUIDE` is not injected (`src/prompts.js:378`). A live
  orchestrator therefore reads nothing but the one-shot claim.

### 1.2 What opencode 1.18.30 permits (read off the installed binary and SDK)

Long form with the surrounding code: `work/opencode-busy-prompt-semantics.md`.

- **A prompt into a BUSY session is accepted, persisted and queued — it does not start a second turn
  and it is not refused.** `SessionBusyError` (HTTP 409) exists but wraps only `shell`, `revert`,
  `unrevert` and `deleteMessage`; neither `prompt` nor `promptAsync` is wrapped. `promptAsync`
  answers 204 unconditionally and forks. The runner's state machine discards the new work and hands
  the caller the deferred of the fiber already running:
  `case"Running": case"ShellThenRun": return[y(m.run.done),m]`.
- **The queue is drained at each STEP boundary, not on idle.** `SessionPrompt.run` is a `while(!0)`
  loop that re-reads the whole message stream at the top of every iteration, and its exit test is
  `if(j?.finish && !["tool-calls","unknown"].includes(j.finish) && !fe && j.parentID===X.id){…break}`.
  A user message appended mid-turn changes `X` (the latest user message), so the last assistant
  message no longer replies to it, **the loop does not exit** and runs a further step with the new
  message in context. One iteration = one model call plus its tool executions; a message is therefore
  picked up after the in-flight step completes and never inside one.
- **`noReply: true` persists a user message WITHOUT starting a turn.** Both prompt routes accept it
  (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2252` and `:2337`); the server does
  `if(t.noReply===!0)return U;` — the message is written and the loop is not started. On a busy
  session the running loop still picks it up at its next step; on an idle session it simply sits.
  opencode uses this itself for synthetic notices.
- The TUI's own submit has no busy guard — typing while the agent works goes down the same
  `session.prompt` path.

That settles point 1 of the brief: **the message reaches the subagent at its next step boundary, and
if it is inside a long tool call, at the moment that call returns.** Nothing can be faster, because
the plugin and opencode alike see nothing at all between a tool call's announcement and its result
(`src/registry.js:230-243`).

---

## 2. Options for the downward channel

### Option A — a queued user message with `noReply: true` (recommended)

`message()` writes the text into the subagent's session through `promptSession(..., { noReply: true })`.
opencode's own runner picks it up at the subagent's next step.

- Cost: one new argument on `promptSession` (`src/client.js:325`), one tool, the bookkeeping fields.
- Delivery: guaranteed as long as the loop is still running — and *because* appending a user message
  keeps the loop from exiting, a steering message that lands while the subagent is writing its final
  reply **forces one more step** rather than being lost. That is the strongest guarantee available.
- Visibility: the message is a persisted part in the subagent's session, so the user can read it there
  (§7). Nothing synthetic, nothing invisible.
- Forecloses: nothing. `noReply` starts no turn, so no path can be tricked into a second run on a
  finished subagent.
- Demands of the builder: one race to close — a message must not be sent to an entry the idle path has
  already claimed (`e.dispatched`, `src/hooks.js:1589`). The read-and-decide goes under
  `registryMutex.runExclusive`, exactly as the wake's critical section does.

### Option B — in-process injection through `experimental.chat.messages.transform`

The plugin already carries per-turn text into a running session this way: the abort notice, the
active-subagent snapshot and the over-budget STOP ride on the last user message as a synthetic part
(`createTransformMessages`, `src/hooks.js:685-732`; wired at `src/index.js:228-243`), and that hook
fires before every LLM request, tool-loop steps included — which is why `entry.stopInjections` can
count turns inside one subagent's single user turn (`src/hooks.js:924-931`).

- Cost: zero I/O, cannot fail, needs no server route.
- But: the part is pushed into the per-request copy only — *"the push is in memory only and nothing is
  persisted to the session"* (`src/hooks.js:678-680`) — so the user never sees the message anywhere,
  and it can only be read on a request the subagent was going to make anyway. A subagent that has just
  emitted its final text makes no further request, and the steering is silently lost.
- Verdict: rejected as the delivery route, for the visibility gap and the lost-at-the-end case. It
  stays what it is today, the carrier for volatile plugin blocks.

### Option C — a plain prompt (no `noReply`) into the running session

- Works while the session is busy (the runner discards the duplicate work, §1.2), but on a session
  that has gone idle in the meantime it takes the `Idle` branch and **starts a fresh turn** on a
  subagent this plugin has already accounted as finished — past the wake, past the reply ceiling, past
  the slot count, on a session the teardown is about to delete.
- Verdict: rejected. `noReply` costs one flag and removes the whole class.

### Option D — a file or socket the subagent polls

- The subagent has to *decide* to poll, which is a token-burning loop on exactly the small models this
  plugin is written for, and a subagent inside a long tool call polls no sooner than A delivers.
  Needs its own on-disk contract and cleanup.
- Verdict: strictly worse than A on every axis.

### Option E — the status quo: abort and re-spawn with the correction

- The run, its context and its handle are lost. This is what the user is asking to be rid of.

**Recommendation: Option A.** It wins on the one axis the others fail: the message is delivered by
opencode's own loop at the first moment the subagent can act on it, it is persisted where the user can
see it, and it cannot start a second turn.

---

## 3. The design

### 3.1 Downward: `message(subagent, text)`

1. The primary calls `message("coder#1", "drop the SQLite path, use the HTTP API")`.
2. `resolve(ref)` (`src/registry.js:221`) maps handle or sessionID to the entry. The ownership check is
   the abort handler's, in rule verbatim: `if (!entry || entry.parentID !== toolCtx.sessionID) return
   unknown(args.subagent)` (`src/tools.js:1298-1307`) — a foreign handle reads as unknown, so ownership
   is not leaked.
3. Under `registryMutex.runExclusive`: the entry must be `LIFECYCLE_RUNNING`, not aborted, not
   `timedOut`, not `dispatched` (the fields the wake's own critical section tests,
   `src/hooks.js:1560-1562`). Failing that, the subagent is finished or on its way out and the tool
   refuses with the path forward (`spawn`, or `reuse` where retention is on).
4. If the entry holds an **open question** (`entry.pendingAsk`), the text is that question's ANSWER:
   the ask waiter is settled and the text becomes the return value of the subagent's blocked `ask`
   tool call — no session write at all, the subagent is already holding the call open.
5. Otherwise the text goes into the session as a queued user message:
   `promptSession(client, { sessionID, agent, prompt: framed, noReply: true })`.
6. The tool result names which of the two happened and when the subagent will see it: *"queued for
   `coder#1`; it reads it at its next step — it is inside `bash` right now."*

One tool for both, and no `mode` parameter: the plugin knows whether a question is open, and a small
model does not have to.

The text is framed by the plugin, never sent bare, so the subagent cannot mistake it for a fresh task:

```
📨 agent-intercom: message from the orchestrator that briefed you (this is NOT a new task).
Fold it into the task you are already on, and say in your final reply what you did with it.

<text>
```

### 3.2 Upward: `ask(question)`

1. The subagent calls `ask("the repo has two lockfiles — which one is authoritative?")`.
2. The handler registers an **ask waiter** (a promise in `src/agentmsg.js`, modelled on
   `registerChildWaiter`, `src/childwait.js:153`), stamps `entry.pendingAsk`, and posts the question to
   the caller with `postParentNotice(client, parentID, askNotice(...))` (`src/teardown.js:169`) — the
   same routed path the completion notice uses, so a question survives an orchestrator handoff
   (buffered by the drain, redirected to the successor, `routeParentNotice`, `src/registry.js:1220`).
3. The tool call **blocks** on the waiter.
4. It settles when the caller answers with `message()`, or when the wait window expires.
5. The tool result is either the answer, or — on expiry — *"No answer came within 5m. Go on with the
   best reading you can defend, or finish now with a `Blocked:` reply naming the question."* The run
   continues either way; nothing is killed.

The caller's own turn needs no special handling in any of its three states, and §1.2 is why: an **idle**
primary is woken by the notice exactly as by a completion notice; a **mid-turn** primary has the notice
persisted and picked up at its next step, with no second turn started; a caller that is **itself a
subagent** is refused at the tool (next section).

### 3.3 No deadlock, no spin

Four rules, each closing one way this could hang:

1. **`ask` is refused to a nested subagent.** A nested caller is blocked inside its own `spawn` tool
   call (`src/tools.js:1660-1690`) and cannot run a tool round, so it could never answer — a true
   deadlock. The handler refuses when `entryForSession(entry.parentID)` exists, with: *"your caller is
   itself a subagent and is blocked waiting for you; it cannot answer. Decide with what you have, or
   finish with `Blocked:`."* Nested delegation stays one-shot in both directions.
2. **The wait is finite.** `answerWaitMs`, default 300000 (5 min). `0` means do not wait: the question
   is delivered and the tool returns at once, and any answer arrives later as a queued message.
3. **The wait never outlives the watchdog window.** While `ask` is in flight the entry carries a tool
   call — `beginToolCall` runs for every tool of a tracked subagent, before any deny
   (`src/hooks.js:2246-2252`) — so the entry is measured against `maxSubagentToolCallMs` counted from
   that call's start (`watchdogLimit`, `src/watchdog.js:320-335`). The effective wait is therefore
   clamped to `min(answerWaitMs, maxSubagentToolCallMs - 60000)` where that window is finite, and left
   unclamped where it is `0` (the window is switched off). At the defaults 300 s < 600 s and the clamp
   is inert. **No new watchdog exemption is introduced**: an exemption needs its own lifting condition
   and its own bound (compare `isWaitingOnWatchdoggedChild`, `src/watchdog.js:272`), a clamp needs
   neither.
4. **Nothing polls.** The subagent blocks on a promise — zero tokens, zero LLM calls. The primary is
   woken by a notice. No loop anywhere.

---

## 4. Data model

### `src/client.js` — one argument

`promptSession(client, { sessionID, agent, prompt, hideable = false, noReply = false })`
(`src/client.js:325`): `noReply` is passed straight into the request body. Its doc-comment gains the
one sentence that matters — with `noReply` the call starts no turn, so the non-idempotency warning that
governs the retry policy (`src/client.js:309-323`) does not apply to it; a duplicate delivery costs a
repeated paragraph, not a second run. The retry policy for a `noReply` send may therefore match
`postNotice`'s (both failure kinds), and the doc says so.

### `src/state.js` — one new map

```
// subagentSessionID -> { parentID, id, question, askedAt, promise, settle, timer }
export const pendingAsks = new Map()
```

Keyed by the asking subagent's session id, for the reason `pendingChildResults` is keyed by the child's
(`src/childwait.js:14-24`): every path that ends a subagent has that id in hand. `resetState()` settles
leftovers exactly as it does for child waiters.

### `src/registry.js` — five fields on the entry (`createEntry`, `src/registry.js:1796`)

| field | meaning |
|---|---|
| `messagesIn` | `[{ text, sentAt, seen }]` — what the caller sent down this run; `seen` is raised when the subagent's next LLM request is observed |
| `pendingAsk` | `{ id, question, askedAt }` while a question is open, else undefined |
| `asksOut` | questions this run put up |
| `asksAnswered` | of those, answered |
| `asksUnanswered` | of those, expired |

Pure synchronous helpers beside the existing ones, so the registry stays the single owner of entry
shape: `noteMessageIn(entry, text)`, `markMessagesSeen(entry)`, `openAsk(entry, ask)`,
`clearAsk(entry, outcome)`. Lock-free like `beginToolCall` / `endToolCall`, so they may be called from
inside `registryMutex.runExclusive`.

`markMessagesSeen` is called from the one hook that fires per LLM request,
`createTransformMessages` (`src/hooks.js:685`): the subagent making a request after the message was
queued is the observation that it has been read. That is bookkeeping only — the transform injects
nothing for this feature.

### `src/agentmsg.js` — new module (the ask waiter)

`registerAskWaiter(sessionID, parentID, { timeoutMs })`, `settleAsk(sessionID, outcome)`,
`openAskFor(sessionID)`, `openAsksFor(parentID)`. Built as `childwait.js` is, including the idempotent
`settle` held on the record and the `clearTimeout` inside it (`src/childwait.js:182-198`).

Every ending path settles the ask, so a blocked `ask` can never outlive its session: `onSessionIdle`
(`src/hooks.js:1540`), `timeoutSubagent` (`src/watchdog.js:346`), `abortHandler`
(`src/tools.js:1296`), `teardownSubagent` and `resetState` — the same set that settles child waiters
today.

### `src/settings.js` — three new scalars

```
export const DEFAULT_ANSWER_WAIT_MS = 300000        // OPENCODE_AGENT_INTERCOM_ANSWER_WAIT_MS
export const DEFAULT_MAX_MESSAGE_TOKENS = 1000      // OPENCODE_AGENT_INTERCOM_MAX_MESSAGE_TOKENS
export const DEFAULT_MID_RUN_MESSAGING = true       // OPENCODE_AGENT_INTERCOM_MID_RUN_MESSAGING
```

`midRunMessaging` is the off switch for the channel, and it is read **live**, not latched: unlike
retention it gates no conditional tool registration (both tools are always registered outside solo
mode), so switching it needs no opencode restart and the tools simply refuse while it is off.
`maxMessageTokens` bounds both directions with one number, measured with `estimateReplyTokens`
(`src/format.js`). Every new key is mirrored in `tui/src/settings-file.ts` and asserted by
`test/settings-defaults-parity.test.js`.

---

## 5. Tool surface

Both tools are registered in the non-solo arm of the returned map (`src/tools.js:1523-1603`), beside
`spawn` / `abort` / `list` / `reuse`, and both handlers are wrapped in `guard(name, handler)`
(`src/tools.js:322`).

### `message` — the primary calls it

```
description:
  'Say something to a subagent that is STILL RUNNING — a correction, a further instruction, a fact it '
  'is missing, or your ANSWER to a question it asked you. It reads the text at its next step (as soon '
  'as the tool call it is inside returns) without being restarted and without costing you a spawn. '
  'Answering is the one thing that unblocks a waiting subagent: a notice opening with "asks you:" '
  'means it has STOPPED and is waiting for you. list() marks such a row `asking`. Refused for a '
  'subagent that has already finished — that one is gone.'
args:
  subagent: 'Handle ("coder#1") or raw sessionID of a RUNNING subagent of yours'
  text:     'What you want it to know — short and concrete; it is read as an instruction from you'
```

Refusals, each naming the figure or rule it refused on: unknown or foreign handle (the `abort`
wording); the entry is not running (finished, retained, closing, aborted, timed out) → *"it has
finished; spawn a fresh subagent"*, or, with retention on, *"put a follow-up with reuse()"*; the text is
over `maxMessageTokens`; the text would push the target over its context budget (`contextBudgetFor` vs
`entry.ctxTokens`); `midRunMessaging` is off; the session write failed (the `promptSession` throw,
reported verbatim so the primary can retry).

### `ask` — the subagent calls it

```
description:
  'Put ONE question to the orchestrator that briefed you and WAIT for its answer: an ambiguity in your '
  'task, a decision that is not yours, which of two readings was meant. Your run pauses while you wait '
  'and costs nothing; the answer comes back as the result of this call. Ask only where one answer lets '
  'you carry on inside this run — where you cannot carry on at all, finish with a `Blocked:` reply '
  'instead. This is a QUESTION, not a report: findings belong in your final reply. If no answer comes '
  'in time you are told so and you go on.'
args:
  question: 'Your question — one question, self-contained, answerable in a sentence or two'
```

Refusals: the caller is itself a subagent (§3.3 rule 1); a question is already open → *"one at a
time"*; over `maxMessageTokens`; `midRunMessaging` off.

### How the two sit beside the existing surface and the denial list

- `PRIMARY_TOOLS` (`src/hooks.js:153-161`) gains `"message"` and nothing else. `ask` stays out, so a
  primary calling it is refused by the orchestrator-pattern allowlist with its existing text, which
  already names what is available through `availablePrimaryTools()` (`src/hooks.js:224`).
- `SUBAGENT_NO_DELEGATION` (`src/agents.js:189-191`) becomes
  `{ task: "deny", abort: "deny", list: "deny", message: "deny" }` — a subagent may not steer another
  subagent, and its own nested child is one-shot by construction. `ask` is deliberately denied nowhere:
  every subagent role may ask, the `NO_SPAWN` roles included.
- The orchestrator's map (`src/agents.js:346-357`) gains `ask: "deny"`, so the tool is stripped from
  the primary's schema rather than only thrown at runtime — the reasoning of the comment at
  `src/agents.js:186-188`: *"Denying at the schema level is the primary defense: a tool that stays in
  the schema but gets thrown by the guard drives small models into a denial loop."*
- `SOLO_DENIED_TOOLS` (`src/hooks.js:199`) gains both names. In solo mode neither is registered (they
  live in the non-solo arm), and the denylist is what holds if one reappears by a route the tool map
  does not decide — the reason `spawn` / `reuse` / `abort` are listed there.
- `list` gains two columns on a running row: `msgs:N` and `asking` where a question is open, so the
  primary sees at a glance which subagent is waiting on it (`formatListRow`, `src/tools.js:1334`).

---

## 6. Prompt wording

The unconditional one-shot claim is replaced everywhere by a **two-part statement**: one reply, and
reachable while it runs.

**`ORCHESTRATION_GUIDE` (`src/prompts.js:26-50`)** — the tool list becomes:

```
- spawn(agent, prompt) — start a subagent non-blocking. It answers ONCE and is then destroyed, but it
  is NOT out of reach while it works. You are woken automatically with its reply.
- message(subagent, text) — say something to a subagent that is still running: a correction, a fact it
  is missing, or your answer to a question it asked. It reads it at its next step.
- abort(handle) — stop a subagent. Use only when the user asks you to.
- list() — your active subagents; a row marked `asking` is waiting for your answer.
```

and a new paragraph after the `Blocked:` paragraph:

```
A subagent can ask you back. A notice opening with `❓ agent-intercom: "coder#1" asks you:` means that
subagent has STOPPED and is waiting: answer it in THIS turn with message("coder#1", "<answer>"). An
unanswered question expires after a few minutes and the subagent carries on without you or comes back
`Blocked:` — what was lost then is your steering, not its work. A question is not a finished run: do
not report it to the user as a result, and spawn nothing for it.
```

**`SUBAGENT_GUIDE_CORE` (`src/prompts.js:84-91`)** — the first line becomes:

```
You reply ONCE — do one focused task, then reply and return. While you work you are not out of
contact: the orchestrator can send you a message at any time (it arrives under `📨 agent-intercom:
message from the orchestrator` — treat it as an instruction from the agent that briefed you, and say
in your final reply what you did with it), and you can put a question to it with `ask(question)`,
which pauses you until the answer arrives.
```

and the `Blocked:` sentence gains the discrimination rule:

```
Ask vs. Blocked: — `ask` where ONE answer lets you carry on inside this run; `Blocked:` where you
cannot carry on at all, where the answer would change the task itself, or where you already asked and
no answer came. Never ask twice about the same thing, and never use `ask` to deliver findings.
```

**Tool descriptions** — `spawn` (`src/tools.js:1530-1538`) drops *"One-shot: a subagent replies once
and is destroyed."* for *"It answers once and is then destroyed — but while it runs you can reach it
with message(subagent, text), and it can ask you back."*; `list` (`src/tools.js:1558-1566`) drops
*"Finished ones are gone (one-shot)"* for *"Finished ones are gone; their result already arrived in the
wake notice. A row marked `asking` is waiting for your answer — reply with message()."*

**Unchanged on purpose**: the two delegation blocks (`src/prompts.js:122-123,144-145`) keep *"There is
no wake and no second chance to ask — one answer, then that subagent is gone."* That sentence is about
the child a *subagent* spawns, and it stays literally true (§3.3 rule 1).

**Contract bookkeeping**: the `blocked-contract` element (`CONTRACT_ELEMENTS`, `src/prompts.js:216`)
selects `` /`Blocked:`/ `` in blocks whose text changes here, so `test/fixtures/prompt-contract.json` is
re-pinned with `scripts/pin-prompt-contract.js`, and `PROMPT_CONTRACT` (`src/prompts.js:196`) is bumped
1 → 2: a prompt file written before this change describes a subagent that cannot be reached, and a user
file carrying no `{{guide}}` placeholder would go on saying so.

**Retention's default.** The one-shot claim can only stop being unconditional if the whole ladder is
coherent: reachable while it runs, reachable for a follow-up just after it has answered. Decided:
`DEFAULT_MAX_RETAINED_SUBAGENTS` goes `0 → 2` (`src/settings.js:153`), so a shipped install offers
`message` during the run and `reuse` after it, and the `ORCHESTRATION_REUSE_GUIDE` exception
(`src/prompts.js:63-70`) is actually injected instead of standing as dead text behind a flag the model
never reads. Two held sessions are bounded by the TTL reap and the capacity eviction that already exist
(`src/watchdog.js:193-215`). Rollback is one key: `maxRetainedSubagents: 0`. Where the user declines
(§10), the messaging wording stands on its own — the two features are independent in code and in text.

---

## 7. Visibility in the chat

- The primary's `message(...)` call is a **real tool part** in the primary's session and renders in the
  transcript like `spawn` does. Nothing synthetic.
- The message itself is a **persisted user message in the subagent's session**, so the user reading
  that child session sees the steering in place, in order, between the subagent's own steps. It is
  marked with `intercomTextPart` (`metadata: { agentIntercom: true }`, `src/pluginmsg.js:41`) so the
  handoff's goal scan skips it, and it is sent **not hideable** — the same decision the spawn task
  prompt takes, *"it lands in the SUBAGENT's session and is that session's entire instruction"*
  (`src/client.js:317-322`). `showAgentcom` does not touch it.
- The subagent's `ask(...)` call and the answer it returns are a real tool part in the subagent's
  session, visible the same way.
- The question notice posted to the primary is an intercom notice and follows `showAgentcom`: hidden
  (`synthetic: true`, `src/pluginmsg.js:61`) while the switch is off, exactly as the completion notice
  is today. That is acceptable **because the primary's answer is a visible tool call**: the user sees
  `message("coder#1", …)` in the transcript even where the notice that prompted it is suppressed, and
  the exchange is reported in full in the completion notice (next bullet).
- The wake notice at the end of a run reports the traffic — `📨 exchange: 2 messages down, 1 question
  answered, 1 unanswered` — from `messagesIn` / `asksAnswered` / `asksUnanswered`, appended in
  `completionNotice` (`src/notices.js:108`) beside the nested-runs line. A message queued but never
  read (`seen` still false) is named explicitly: *"the message you sent at 14:02 was never read — it
  was still inside a tool call when it finished."* A steering attempt cannot be silently lost.
- TUI: the subagent row gains an `asking` marker (`tui/src/subagent-store.ts`, rendered in
  `tui/src/tui.tsx`); no new sidebar block and no new setting row. The three new settings are file and
  env only.

---

## 8. Interaction with the rest of the plugin

**Watchdog.** §3.3 rule 3: the clamp, not an exemption. `timeoutNotice` (`src/notices.js:274`) gains a
sentence where the entry had a question open at the reap, so the primary learns that the subagent it
never answered was then cut off.

**Result-token ceiling.** Untouched. `capReplyForAgent` (`src/resultfile.js:153`) governs the final
reply and nothing here changes that. Mid-run traffic has its own, much smaller ceiling
(`maxMessageTokens`, 1000) in both directions, with no overflow file: a question or a steering note
that does not fit in 1000 tokens is the wrong instrument, and the refusal says so. The prompt says it
too (*"a QUESTION, not a report"*), so `ask` cannot be used to route findings past the reply ceiling.

**Solo mode.** No second agent exists, so neither tool is registered (both sit in the non-solo arm of
`createTools`) and both names go into `SOLO_DENIED_TOOLS`. The blocks that name them are the primary's
orchestration guide, which solo mode already suppresses entirely (`guideBlocks`,
`src/prompts.js:374-377`), and the subagent guide, which is never assembled in solo mode because
nothing spawns.

**Endless mode / handoff.** The question notice goes through `postParentNotice`, so it is buffered
during a handoff and redirected after one, like every other parent notice; `reparentSubagents`
(`src/registry.js:1035`) has already moved `entry.parentID` to the successor, so the successor's
`message()` passes the ownership check. A subagent blocked in `ask` is a **running** entry, so it holds
its slot and `isQuiesced` (`src/registry.js:1743`) keeps a cycle from firing its wind-down while a
question is open — which is right: the cycle must not replace the orchestrator that owes an answer.

**Abort.** Unchanged and still user-only. `abortHandler` settles the ask waiter with `aborted` beside
the child waiter it already settles (`src/tools.js:1317-1322`).

**The end-of-run race.** A queued message extends the subagent's loop (§1.2), so a message accepted by
the tool is a message the subagent will take a step on. The one window to close is the other side: the
idle event has fired and the wake's critical section has claimed the entry (`e.dispatched`) while the
`message` handler is deciding. Closed by taking that decision under the same mutex and refusing on the
same fields the critical section tests (`src/hooks.js:1560-1562`).

---

## 9. Assumptions, and what would falsify each

| # | Assumption | Why it is held | Falsified by |
|---|---|---|---|
| A1 | A user message appended to a busy session is picked up at the next step of the running loop, without a second turn | The runner's `Running` branch returns the existing deferred, and the exit test `j.parentID===X.id` fails for a newer user message (§1.2, `work/opencode-busy-prompt-semantics.md`) | A subagent that reports seeing a steering message only in a *later* session, or two assistant turns for one subagent |
| A2 | `noReply: true` persists the message and starts no loop | `if(t.noReply===!0)return U;` in the server; the flag is in the SDK types (`types.gen.d.ts:2252,:2337`) | A subagent session that goes busy on a `noReply` send into an idle session |
| A3 | A plugin tool call of a subagent passes `tool.execute.before`, so a blocked `ask` sits on the wide watchdog window | `beginToolCall` is unconditional for a tracked entry and runs before every deny (`src/hooks.js:2246-2252`) | A subagent reaped at `maxSubagentAgeMs` while inside `ask` |
| A4 | A tool call may block for minutes without an opencode-side timeout | The nested spawn already blocks its caller for the whole child run (`src/tools.js:1660-1690`) and is in production | An opencode error on a long-blocking tool call |
| A5 | A model told it can be messaged acts on the message | It arrives as a user message, the strongest position in the context; the framing block is the same style as the STOP injection, which demonstrably changes behaviour | An e2e run in which the steering is visibly ignored |
| A6 | opencode's own behaviour here is stable across versions | Read off the installed 1.18.30 binary, not from documentation | An opencode upgrade after which the e2e driver of §12 fails |

---

## 10. Open point for the user

**One**, and it is the reserved kind — a change to a file that does not belong to this project: the
live global config `~/.config/opencode/agent-intercom.json` carries `"maxRetainedSubagents": 0`
explicitly, and a file value overrides both env and the shipped default (`src/settings.js:462-465`).
Flipping `DEFAULT_MAX_RETAINED_SUBAGENTS` to 2 therefore changes nothing on this machine until that key
is edited or removed there. The code change is decided; the edit to that file is not taken without the
user's word. Everything else in this concept is decided and needs no further decision.

---

## 11. Build plan

Seven steps. Each leaves the tree building (`npm run check`) and the suite green (`npm test`), and each
can be handed out on its own.

| # | Step | Depends on | Ends with |
|---|---|---|---|
| 1 | **State and registry.** `pendingAsks` in `src/state.js` (incl. its `resetState` settle); the five entry fields in `createEntry`; the four pure helpers in `src/registry.js`. No behaviour change yet. | — | `test/entry-lifecycle.test.js` extended: the helpers are pure and idempotent, and a fixture entry without the fields reads as "nothing sent, no ask open" |
| 2 | **Settings and client.** The three scalars with their env reads, the file merge and the `tui/src/settings-file.ts` mirror; `noReply` on `promptSession` with its retry note. | — (parallel to 1) | `test/settings.test.js`, `test/settings-defaults-parity.test.js`, `test/client-failure-contract.test.js` green; a `noReply` send carries the flag in the body |
| 3 | **The ask waiter.** `src/agentmsg.js`: register / settle / inspect, the clamped ceiling, the idempotent settle. | 1, 2 | New `test/ask-waiter.test.js`: settles once, clamps against `maxSubagentToolCallMs`, expires as `unanswered`, `answerWaitMs: 0` returns at once |
| 4 | **The two tools.** `message` and `ask` in `createTools`, with every refusal path and the mutex-guarded running check; `PRIMARY_TOOLS`, `SOLO_DENIED_TOOLS`, `SUBAGENT_NO_DELEGATION`, the orchestrator's `ask: "deny"`; the `list` columns. | 3 | New `test/agent-message-tool.test.js` and `test/ask-tool.test.js`; `test/delegation-authority.test.js` and `test/solo-no-second-agent.test.js` extended |
| 5 | **Upward notice and lifecycle wiring.** `askNotice` in `src/notices.js`; settle-on-every-ending in idle / timeout / abort / teardown / reset; `markMessagesSeen` from the message transform; the exchange lines in `completionNotice` and `timeoutNotice`. | 4 | New `test/ask-notice.test.js`; `test/wake-critical-section.test.js`, `test/abort-quiescence.test.js`, `test/watchdog-activity.test.js` extended — no ending path leaves a waiter, no `ask` outlives its session |
| 6 | **Prompts and contract.** The wording of §6, `PROMPT_CONTRACT` 1 → 2, the re-pinned fixture, `DEFAULT_MAX_RETAINED_SUBAGENTS` 0 → 2. | 4, 5 | `test/prompt-contract-pin.test.js`, `test/system-prompt-stability.test.js`, `test/prompt-guide-placeholder.test.js`, `test/retention-texts.test.js` green |
| 7 | **Documentation and e2e.** README, `specs/mid-run-messaging.md`, project `CLAUDE.md`, `todos.md`; the two e2e drivers of §12. | 6 | One e2e run proving the delivery moment and one proving the question round trip |

Steps 1 and 2 are independent and may run in parallel; 3 needs both; 4 is the first step at which the
feature is reachable by a model; 5 makes it survive every ending; 6 is what makes the model use it; 7
proves it against a live server.

**Target state after step 7:** a subagent is a correspondent for the length of its run — steerable by
its caller at every step boundary, able to ask one question at a time and to wait for the answer
without burning tokens or tripping a clock — and still exactly one reply at the end.

---

## 12. Documentation and tests

**Documentation**

- `README.md` — the tool table (`README.md:203-211`) gains `message` and `ask` with who may call each;
  a new section on the mid-run channel beside the retention section (`README.md:241`); the three
  settings in the settings table with their env names; the note that `midRunMessaging` needs no
  restart, unlike retention (`README.md:777`).
- `specs/mid-run-messaging.md` — the feature specification in the style of
  `specs/result-token-ceiling.md`: the two tools, the delivery moment, the refusal table, the wait
  window and its clamp, the framing block, the exchange lines in the notices.
- Project `CLAUDE.md` — the header paragraph gains one sentence naming the channel and its defaults.
- `learnings.md` — a new section pinning what §1.2 established about opencode 1.18.30: a prompt into a
  busy session is queued and drained at the next step boundary, `noReply: true` persists without
  starting a turn, and an appended user message keeps the runner's loop from exiting. That is a fact
  about opencode nobody should have to re-derive from the binary.
- `todos.md` — the open point of §10 until the user has answered it.

**Tests** (`node --test`, concurrency 1, Node ≥ 22.18)

New: `test/ask-waiter.test.js`, `test/agent-message-tool.test.js`, `test/ask-tool.test.js`,
`test/ask-notice.test.js`.

Extended: `entry-lifecycle`, `settings`, `settings-defaults-parity`, `client-failure-contract` (the
`noReply` body and its retry policy), `delegation-authority` (subagents denied `message`, primaries
denied `ask`), `solo-no-second-agent` (neither tool registered, both denied), `wake-critical-section`
and `abort-quiescence` (no ending path leaves a waiter or an entry with an open ask),
`watchdog-activity` (a subagent inside `ask` is measured on the tool-call window and is not reaped
inside the clamped wait), `result-token-ceiling` (mid-run traffic is bounded by its own ceiling and
writes no overflow file), `prompt-contract-pin`, `system-prompt-stability`, `prompt-guide-placeholder`,
`retention-texts`, `tui-sidebar-rows`.

E2E (`test/e2e/`, opt-in, against a real `opencode serve` — pre-approved for this project):
`message-task.sh` spawns a subagent on a task with several tool calls, sends a steering message
mid-run, and asserts from the subagent's own final reply that it acted on it and from the session's
parts that the message sits between two of its steps; `ask-task.sh` has a subagent `ask`, answers from
the orchestrator, and asserts the answer came back as the tool result of the `ask` call. Those two are
the only proof of A1, A2 and A5, and the only end-to-end proof that the delivery moment is the next
step and not the next turn.
