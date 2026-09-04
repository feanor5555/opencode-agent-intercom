# Client failure contract

How `src/client.js` detects a failed opencode request, what each wrapper returns or throws,
and what every call site does with it.

## 1. The ground fact

opencode builds the plugin's SDK client **without `throwOnError`**. A failed request does not
reject: it resolves with an envelope `{ error, request, response }` carrying the HTTP status —
`response.status: 404`, `error.name: "NotFoundError"` for a session that is gone.

One function in the module reads that today, `src/client.js:38`:

```js
export function noticePostFailure(result) {
```

and one caller uses it, `src/client.js:106`: `failure = noticePostFailure(result)`.

Every other write in the module awaits the promise and reports success unconditionally:

| Site | Line | What it reports on a resolved failure |
| --- | --- | --- |
| `promptSession` | `src/client.js:169` `await client.session.promptAsync({` | returns normally — "sent" |
| `abortSession` | `src/client.js:177` `return Boolean(unwrap(await client.session.abort({ path: { id: sessionID } })))` | `false` — correct by accident (see §4.4) |
| `deleteSession` | `src/client.js:253-254` `await client.session.delete(...)` / `return true` | `true` — "deleted" |
| `updateSessionTitle` | `src/client.js:269-270` `await client.session.update(...)` / `return true` | `true` — "written" |
| `archiveSession` | `src/client.js:308-312` `await client.session.update({ ... time: { archived: Date.now() } })` / `return true` | `true` — "archived" |
| `createChildSession` | `src/client.js:144-147` `unwrap(await client.session.create(...))` then `created?.id` | `undefined` — right outcome, no reason |

The reads have a second, subtler form of the same defect. `fetchSnapshot` unwraps to `undefined`
on an envelope, so `messages = []` and it returns `src/client.js:367`
`messageCount: messages.length` = `0`. `snapshotOutcome` then reads that as `src/client.js:397`
`return snapshot.messageCount > 0 ? "ok" : "gone"`. A 500 from `session.messages` is therefore
classified as **"the session was deleted underneath the plugin"**, and `reuse` acts on it —
`src/tools.js:936-937`:

```js
      await removeEntry(entry.sessionID)
      forgetSessionDirectory(entry.sessionID)
```

A transient server error permanently destroys a retained handle.

Two sites in the module already read failures correctly and stay as they are, because they bypass
the SDK client and use `fetch` directly: `patchPartSynthetic` (`src/client.js:543` `if (res?.ok) return "ok"`)
and `selectTuiSession` (`src/client.js:667` `if (res?.error) throw new Error(errMsg(res.error))`).

## 2. Target state

Three primitives in `src/client.js`, above every wrapper, and exactly three contracts below them.

### 2.1 `requestFailure(result, op)`

`noticePostFailure` generalised: same envelope reading, an operation label instead of the
hard-coded `"session.promptAsync failed"` in `src/client.js:50`, and one new field.

Returns `undefined` for a delivered request, or an `Error` carrying:

- `status` — the HTTP status, or `undefined`;
- `errorName` — `error.name`;
- `terminal` — `true` for any 4xx and for `errorName === "NotFoundError"`. Retrying cannot repair
  a request the server refused on its content; today's `src/client.js:55` narrows this to 404,
  which is the same rule stated too tightly;
- `kind` — **new, and the axis the retry policy turns on**:
  - `"refused"` — an envelope with a status. The server answered; the write did not take effect.
  - `"indeterminate"` — a thrown transport error. No response was seen; the write may or may not
    have taken effect.

Success keeps the shapes the current reader accepts (`src/client.js:24-28`): `undefined`, a bare
payload, `{ data }`, and `{ data, request, response }` with a 2xx/3xx status.

### 2.2 `attempt(op, call)`

Runs `call()` and folds both failure routes into one value: `{ ok: true, data }` or
`{ ok: false, error }`, never throwing. A thrown error is tagged `kind: "indeterminate"`, an
envelope goes through `requestFailure`. Every wrapper in the module is written on this and on
nothing else — no wrapper awaits an SDK call bare again.

### 2.3 `withRetry(op, call, { retries, backoffMs, retryKinds })`

The loop that stands in `postNotice` today (`src/client.js:94-131`), lifted out unchanged in its
mechanics: linear backoff `attempt * backoffMs` plus 0–25 % jitter, `terminal` breaks out at once,
the last error is thrown after the budget is spent. One addition: `retryKinds` names which failure
kinds are worth another attempt.

Settings stay as they are — `postNoticeRetries` / `postNoticeRetryBackoffMs`
(`src/settings.js:329-330`) become the client's single retry policy, read per call. No new
configuration surface: a second budget is only justified once a measurement shows the spawn path
needs a different one.

### 2.4 The three contracts

| Contract | Members | On failure |
| --- | --- | --- |
| **Required write** | `promptSession` | throws, after the retry policy |
| **Reported write** | `deleteSession`, `archiveSession`, `updateSessionTitle`, `abortSession` | returns `false`, logs once, no retry |
| **Best-effort read** | `getSessionDirectory`, `listSessions`, `fetchMessages`, `fetchSnapshot` | returns the empty value, logs once |

`postNotice` keeps its own shape — a required write with a retry policy of its own — and
`createChildSession` stays a `undefined`-returning creator (§4.5).

## 3. Retry policy per call, and why

The `kind` split is what makes a retry safe to reason about. `promptAsync` is **not idempotent**:
a second delivery of a spawn prompt starts a second turn in the child, and a second kickoff gives
the fresh orchestrator its instructions twice.

- **`postNotice` — retry both kinds.** Unchanged from today. A duplicate wake notice costs the
  primary a repeated paragraph; a lost one costs it the result of a whole subagent run. The
  asymmetry is decided and stays decided.
- **`promptSession` — retry `"refused"` with status ≥ 500 only.** The server answered, so the
  prompt provably did not run; a 5xx is the transient case. A `"refused"` 4xx is `terminal`
  (the session is gone, or the body was rejected) and an `"indeterminate"` throw is ambiguous —
  there the duplicate-prompt risk outweighs the retry, so it throws on the first failure.
- **Reported writes — no retry.** `deleteSession` has a reconciliation path already:
  `sweepOrphanedSubagentSessions` (`src/teardown.js:588`) collects, at the next plugin load,
  exactly the sessions a failed delete leaves behind, and its criteria (marker in the title, a
  parentID, no children, unknown to this process, old enough) admit them. A retry loop on the
  teardown hot path buys nothing the sweep does not already give, and it delays a wake that has
  already been delivered. `updateSessionTitle` and `archiveSession` are cosmetic and one-shot
  respectively; `abortSession` is cooperative and its callers all proceed regardless.
- **Reads — no retry.** Every reader has a degraded answer designed for it.

## 4. Call sites, one by one

### 4.1 `spawn` — `src/tools.js:627`

```js
        await promptSession(client, { sessionID, agent: args.agent, prompt: fullPrompt })
```

**Should throw.** The catch that receives it already exists and is already correct: it settles the
child waiter with `detail: "the child session was never prompted"`, calls `removeEntry`,
`deleteSession` (`src/tools.js:642`) and `forgetSessionDirectory`, then re-throws so `guard`
(`src/tools.js:307-315`) renders `spawn failed: <message>` to the orchestrator.

Contract change: that catch **currently never fires for an HTTP failure**. Today the spawn
reports a running subagent, registers an entry, holds a concurrency slot, and the child never
receives its task — the inactivity watchdog reaps it minutes later as a hang. After the change the
orchestrator is told at once, with the status in the message, and may re-spawn.

No new catch is added: `guard`'s output is the right channel — the orchestrator asked for this
spawn and is waiting on the tool result. A notice would arrive at the same session by a second
route for no gain.

### 4.2 `reuse` — `src/tools.js:1032`

```js
        await promptSession(client, { sessionID, agent, prompt })
```

**Should throw**, into the catch already written below it, which restores the retained entry on its
original window (`restoreRetainedEntryLocked`), re-publishes the original retention stamp and
re-throws to `guard`. Same shape as spawn: today a refused follow-up leaves a *running* entry
whose run never started, and the orchestrator is told to wait for a wake that is not coming.

### 4.3 Handoff kickoff — `src/handoffwiring.js:183` → `src/handoff.js:283`

```js
    await deps.promptAsync(newID, kickoffMessage)
```

**Should throw.** This is the largest silent failure in the plugin. `src/handoff.js:283` is the
last statement before the documented point of no return; its catch un-reparents the subagents back
to the old primary, deletes the orphaned new session (`src/handoff.js:302`) and aborts the drain so
buffered notices go back to the surviving old primary. Past that line the sequence archives the old
primary (`src/handoff.js:352`) and forgets it.

Today a refused kickoff walks straight through: the old primary is archived, every in-flight
subagent is reparented to a session that was never prompted and will never wake, and the drain is
flushed into it. The orchestrator is lost with no error anywhere. After the change the handoff
fails cleanly and the old primary keeps working; a later over-budget turn re-schedules it.

`deps.promptAsync` is typed `Promise<void>` (`src/handoff.js:120`) and the failure-path test
`test/handoff.test.js:678` already drives it with a throwing double. The test was never wrong —
the production wiring was unfaithful to it. §6 adds the wiring-level test that pins the two
together.

### 4.4 DOC_SUMMARY / open-points prompt — `src/handoffwiring.js:318`

**Should throw**, and the two callers keep their existing, deliberately asymmetric answers
(`src/handoffwiring.js:333-342`): the plain handoff catches and substitutes
`FALLBACK_DOC_SUMMARIES`; the endless cycle abandons, because replacing a primary after failing to
save its open points is the data loss the mode exists to prevent.

Contract change is timing only, and in the right direction: a refused prompt fails at once instead
of polling `fetchSnapshot` for the full `DOC_SUMMARIES_TIMEOUT_MS` (120 s) to reach the same
conclusion.

### 4.5 `abortSession` — `src/tools.js:323`, `src/teardown.js:232`, `src/watchdog.js:273`

**Reported write, no behaviour change for the callers.** `Boolean(unwrap(...))` already yields
`false` on an envelope, so the abort tool already renders
`"(abort call did not confirm)"` and `endLiveChildrenOf` and the watchdog already proceed. What
changes is only that the reason is logged. Its result stays `ok && Boolean(data)`: a `{ data: false }`
answer means "not confirmed", not "the request failed", and the two must keep rendering the same
way to the orchestrator.

### 4.6 `deleteSession` — `src/teardown.js:406`, `src/teardown.js:606`, `src/tools.js:642`, `src/tools.js:1136`

**Reported write.** `src/teardown.js:406-407` is already written for a truthful boolean:

```js
      const ok = await deleteSession(client, sessionID)
      if (ok) log(`${tag}deleted opencode session`, { handle, sessionID })
```

Two consequences the callers must absorb:

- the `try`/`catch` wrapped around that call becomes dead — `deleteSession` does not throw — and is
  removed, so the failure is logged once, inside the wrapper, with its status;
- `src/teardown.js:606` `if (await deleteSession(client, sessionID)) {` gates
  `forgetSessionDirectory` and the sweep's return array. A session whose delete was refused is no
  longer counted as deleted and no longer dropped from the directory cache. That is the correct
  reading — it still exists — and the next sweep will find it again.

**Deliberately swallowed** at `src/tools.js:642`: it runs inside the spawn's cleanup path, whose
job is to surface the *original* prompt failure. A cleanup failure must never mask it.

### 4.7 `archiveSession` — `src/handoffwiring.js:210` → `src/handoff.js:352`

**Reported write, and its failure stays swallowed at the caller.** `src/handoff.js:352` sits after
the point of no return and is already wrapped: "post-kickoff failures do NOT revert" — a zombie old
session is strictly better than deleting a live successor. Pinned by
`test/handoff.test.js:731`. Only the log gains the status.

Note the type mismatch that is now visible: `deps.archiveSession` is declared
`Promise<void>` (`src/handoff.js:123`) while the wrapper returns a boolean. Widen the JSDoc to
`Promise<boolean>` for `archiveSession` and `deleteSession`; `handoff.js` ignores both values and
needs no code change.

### 4.8 `updateSessionTitle` — `src/teardown.js:522`

```js
  return updateSessionTitle(client, sessionID, title)
```

**Reported write, swallowed by design.** `publishRetentionState`'s own doc-comment settles it:
the retention stamp is a reading aid, and a title that could not be written costs a reader the row
it would have shown, never a wrong one. Its callers in `src/tools.js` and `src/teardown.js` ignore
the boolean. Keep it that way.

### 4.9 The reads — `fetchSnapshot`, `fetchMessages`, `listSessions`, `getSessionDirectory`

**Best-effort, but the envelope must reach the same `catch` outcome the throw reaches today:**
`{}`, `[]`, `[]`, `undefined`. Routing them through `attempt` does exactly that.

One deliberate refinement in `fetchSnapshot`, which is the only read whose caller branches on
*why* it is empty: a failure with `status === 404` returns `{ messageCount: 0 }` (the session is
genuinely gone), every other failure returns `{}`. `snapshotOutcome` (`src/client.js:395`) then
answers "gone" only where the session really is gone and "unavailable" for a 500 or a timeout, and
`reuse` stops destroying a retained handle on a transient error — it takes the branch at
`src/tools.js:946` instead, which leaves the subagent held and tells the orchestrator to call again.

`listSessions` returning `[]` on a refused call is what keeps the orphan sweep from deleting
anything on a bad read — it does nothing rather than something wrong. Unchanged, now for a reason
rather than by luck.

### 4.10 `createChildSession` — `src/tools.js:595`, `src/handoffwiring.js:171`

**Keeps returning `undefined`**, and gains a log line naming the status. `src/tools.js:596`
`if (!sessionID) return { output: "Failed to create subagent session." }` is the correct branch and
stays; the output gains the reason so the orchestrator can tell a refusal from a server outage.

`src/handoff.js:197` `newID = await deps.createSession(...)` does **not** check for `undefined` and
would carry it into `bindDrainTarget` and `promptAsync`. Add an explicit throw there: it lands in
the same pre-kickoff catch as every other step-1..6 failure, which is where a handoff that has no
successor session belongs. Pinned already in spirit by `test/handoff.test.js:713`
("createSession throws — drain aborted, nothing reparented, nothing deleted").

## 5. What is a breaking change

For the plugin's own callers, exactly one function changes its contract: **`promptSession` throws
where it used to resolve**. Every one of its three call sites already has the catch that the throw
belongs in (§4.1, §4.2, §4.3), so no caller needs new structure — but all three change behaviour,
and the handoff one changes it drastically.

For the test doubles, nothing breaks. The shapes the suite's fake clients return —
`promptAsync: async () => ({ data: undefined })`, `abort: async () => ({ data: true })`,
`update: async () => ({ data: {} })`, a bare `undefined` from `delete` — all carry no `error` and no
status ≥ 400, so `requestFailure` reads every one of them as delivered. The ~30 doubles across
`test/` stay as they are.

Two test-level changes are needed:

- `test/postNotice-retry.test.js:17` imports `noticePostFailure` and `test/postNotice-retry.test.js:240`
  asserts on it by name; the rename to `requestFailure` (with its `op` argument) updates the import,
  those assertions, and the message expectation built on `"session.promptAsync failed"`.
- `test/subagent-reuse.test.js:248-252` tests `snapshotOutcome` as a pure function and stays valid;
  the new 404-vs-other mapping is tested at `fetchSnapshot`, not there.

## 6. Steps

Each step leaves the tree building and `npm test` green, and can be handed out on its own.

**Step 1 — the primitives.** Add `requestFailure` (renamed, with `op`, `kind`, widened `terminal`),
`attempt` and `withRetry` to `src/client.js`. Rewrite `postNotice` on `withRetry` with
`retryKinds: ["refused", "indeterminate"]` so its observable behaviour is identical. Update
`test/postNotice-retry.test.js` for the rename and add cases for `kind` and for a non-404 4xx being
terminal. *Depends on: nothing.*

**Step 2 — the reads.** Route `getSessionDirectory`, `listSessions`, `fetchMessages` and
`fetchSnapshot` through `attempt`; add the 404 → `{ messageCount: 0 }` mapping in `fetchSnapshot`.
New tests: an envelope failure yields the same empty value a throw yields, and a 500 from
`session.messages` classifies as `"unavailable"` while a 404 classifies as `"gone"`. No caller
changes. *Depends on: step 1.*

**Step 3 — the reported writes.** Rewrite `deleteSession`, `archiveSession`, `updateSessionTitle`
and `abortSession` on `attempt`, each logging once with `op` + `status`. Remove the now-dead
`try`/`catch` around `deleteSession` in `teardownSubagent` (`src/teardown.js:405-410`). Widen the
`deleteSession` / `archiveSession` JSDoc in `src/handoff.js:122-123` to `Promise<boolean>`. New
tests: each returns `false` on an envelope; the orphan sweep does not count a refused delete
(`src/teardown.js:606`). *Depends on: step 1. Independent of step 2.*

**Step 4 — `promptSession`.** The breaking one, and last, so it lands on a green tree. Wrap it in
`withRetry` with `retryKinds: ["refused"]` and a 5xx-only predicate, throwing otherwise. New tests
at three levels: the wrapper itself (retries a 502, does not retry a thrown transport error, does
not retry a 404); the spawn path (a refused prompt tears the child session down, settles the
waiter, and reaches `guard`); the reuse path (the entry returns to retained on its original window).
*Depends on: step 1.*

**Step 5 — the two guards.** Add the status to `createChildSession`'s log and to the spawn's
"Failed to create subagent session." output; add the `if (!newID) throw` at `src/handoff.js:197`.
Test: a `createSession` that answers `undefined` takes the pre-kickoff revert path.
*Depends on: step 4 (shares the handoff failure-path tests).*

**Step 6 — record it.** One entry in `learnings.md`: the client carries no `throwOnError`, every SDK
call in this plugin goes through `attempt`, and a bare `await client.*` in `src/client.js` is a
defect by construction. *Depends on: steps 1–5.*

## 7. Assumptions

**A1 — one client, one failure shape.** Every SDK namespace the plugin uses (`session.create`,
`.delete`, `.update`, `.abort`, `.messages`, `.list`, `.promptAsync`) resolves the same
`{ error, request, response }` envelope on failure, because opencode builds one client with one
error interceptor. Verified for `promptAsync`; assumed for the rest.
*Falsified by:* an operation that demonstrably failed while no `requestFailure` log appeared for it —
i.e. a namespace that throws where the others resolve. Harmless if so: `attempt` catches both routes,
so a throwing namespace degrades to today's `catch` behaviour with a better log.

**A2 — a status response means the write did not take effect.** The server rejected the request
before applying it, so a retry cannot duplicate it. This is what licenses retrying `promptSession`
on a 5xx.
*Falsified by:* a subagent receiving its task prompt twice, or a fresh orchestrator receiving two
kickoffs, after a retried spawn or handoff.
*Repair if so:* set the retry budget for `promptSession` to zero — one predicate, no structural change.

**A3 — `session.abort` answering `{ data: false }` means "not confirmed", not "failed".** This is how
`src/client.js:177` reads it today and how the abort tool's output wording is built.
*Falsified by:* an abort that is confirmed by the server yet answers falsy — observable as the
"(abort call did not confirm)" suffix on aborts that visibly worked.

**A4 — the orphan sweep is the reconciliation path for a refused delete.** A subagent session whose
`DELETE` failed is collected at the next plugin load by `sweepOrphanedSubagentSessions`.
*Falsified by:* a leaked subagent session that survives a restart — it would mean one of the sweep's
five criteria (`src/teardown.js:593-604`) excludes it, most likely the age bound.
*Consequence if so:* `deleteSession` needs the retry policy after all, which is one argument at one
call site.

## 8. Open, and designed around

**Whose boundary the retry budget is.** `postNoticeRetries` / `postNoticeRetryBackoffMs` are named
for one call site and would become the whole client's policy. Whether the spawn prompt deserves a
budget of its own is a question a measurement answers, not this design. The recommendation is to
reuse the existing pair and add no key: `withRetry` takes the budget as an argument, so a second
setting is a one-line change at one call site if and when the figure demands it.
