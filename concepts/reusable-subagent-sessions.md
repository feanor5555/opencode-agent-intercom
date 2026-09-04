# Concept: keeping a finished subagent alive for a later follow-up

Scope: the server half of `opencode-agent-intercom` (`src/`, `test/`,
`README.md`) and, in the last step, the TUI half (`tui/src/`). No service
boundary moves — everything here runs inside the one opencode plugin process,
in the modules that already own the subagent lifecycle (`src/registry.js`,
`src/hooks.js`, `src/teardown.js`, `src/watchdog.js`, `src/tools.js`,
`src/notices.js`).

Evidence base: this plugin's `src/`, `test/` and `tui/src/` as they stand; the
installed `@opencode-ai/sdk` 1.18.23 type declarations under `node_modules/`;
and the three established findings
`work/code-explorer-subagent-lifecycle.md`,
`work/code-explorer-context-budget-enforcement.md` and
`work/researcher-opencode-session-lifetime.md`.

Given and not re-opened: the one-shot design is a deliberate decision (a
subagent that hits a problem its briefing does not cover stops, reports
`Blocked:`, and the task continues only via a fresh spawn); a non-blocking
nested spawn was rejected earlier.

---

## 0. The requirement this design serves

Three things are fixed by the user and are not derived here.

1. **The primary purpose is a late follow-up question.** The orchestrator
   finishes reading a subagent's result, works on, and something strikes it
   afterwards — a clarification, a "which of the two did you mean", a "did you
   also look at X". That question must still be answerable **30 minutes or more
   after the subagent's run ended**. This is the case the design is sized for.
2. **A subagent whose context exceeds 70 000 tokens must never be reused.**
   70 000 is the **default**, not a constant: the ceiling is settable **per
   agent type**, and settable from the TUI, exactly as the per-type context
   budget already is. It is not derived from any budget and it does not move
   when a budget moves.
3. **"Still has very little context" stays a second admission criterion**, for
   the secondary case only: handing a retained subagent a further *related
   task* rather than a question. That case is a bonus, not the driver.

Two figures this design is written against are decided changes to the current
source rather than what the source says today, and are named as such wherever
they carry an argument:

- **The per-agent context budget default becomes 100 000 tokens for every agent
  type.** Today the source says `DEFAULT_MAX_CONTEXT = 40000` (`settings.js:78`)
  and a per-type table of 30 000–60 000 (`settings.js:85-94`). Every threshold
  argument below uses 100 000.
- **The endless-mode restart threshold default becomes 250 000 tokens.** That
  governs the primary session's own handoff (`primaryContextThreshold`,
  `settings.js:438-441`), not subagents, and enters this design only through
  §3.6: a longer retention window is more often cut short by a handoff than by
  its own ceiling.

---

## 1. What the code says today

The invariant is written down as an invariant, `src/state.js:15-20`:

    // One-shot subagent lifecycle: each entry lives from `spawn` until the
    // subagent goes idle (= completed its single reply). At that point the event
    // hook delivers the result to the primary, removes the entry from this map,
    // and deletes the underlying opencode session. There is no follow-up channel
    // to a finished subagent; if more work is needed, the orchestrator spawns a
    // fresh one.

It is enforced in one place. `onSessionIdle` latches and removes inside the
wake mutex, `src/hooks.js:1140-1150`:

    e.dispatched = true
    …
    const removed = removeEntryLocked(sessionID)

and the shared teardown deletes the underlying session,
`src/teardown.js:296-302`:

    try {
      const ok = await deleteSession(client, sessionID)
      if (ok) log(`${tag}deleted opencode session`, { handle, sessionID })
    …
    forgetSessionDirectory(sessionID)

`deleteSession` is the real thing, `src/client.js:155-158`:

    export async function deleteSession(client, sessionID) {
      try {
        await client.session.delete({ path: { id: sessionID } })

Two consequences the rest of the plugin is built on. First, there is no
finished state — `src/registry.js:219-221`:

    // There is no "finished" state: once a subagent goes idle the event hook
    // removes the entry from the registry entirely (one-shot lifecycle), so a
    // "done" subagent disappears rather than lingering.

Second, **registry membership *is* the definition of "running"**,
`src/registry.js:237-243`:

    export function countActiveSubagents(primaryID) {
      let n = pendingSpawns.count
      for (const e of registry.values()) {
        if (effectiveState(e) === "aborted") continue
        n += 1
      }
      return n
    }

That one function is the basis of the concurrency cap
(`src/registry.js:263-270`), the quiesce predicate
(`src/registry.js:1076-1082`), and both slot lines the orchestrator is shown
(`src/notices.js:174-179`, `src/tools.js:663-679`). The default cap is one,
`src/settings.js:74`:

    export const DEFAULT_MAX_SUBAGENTS = 1

The capability retention would use is available. Re-prompting a session by id
is a supported operation that keeps history
(`work/researcher-opencode-session-lifetime.md` §2), and the plugin's own
wrapper already takes a session id and an agent name,
`src/client.js:96-101`:

    export async function promptSession(client, { sessionID, agent, prompt, hideable = false }) {
      const hidden = hideable && getSettings().hideChatter
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { agent, parts: [intercomTextPart(prompt, { hidden })] },

There is no session TTL and no garbage collection on the opencode side
(`work/researcher-opencode-session-lifetime.md` §1: the maintainer's answer in
issue #4980 is "No it does not"), and the plugin has no reload teardown that
walks the registry (`work/code-explorer-subagent-lifecycle.md` §2j). Whatever
the plugin stops deleting, nothing else deletes.

---

## 2. Open questions, designed around

Three questions stand open and are not settled here; the design below works
either way.

- **Whether retention belongs in this plugin at all.** Keeping a session alive
  is not an action — it is the *absence* of `deleteSession`. opencode already
  retains every session it is not told to delete. So "reusable subagents" could
  equally be framed as an opencode-side session-management feature with the
  plugin merely opting out of its own delete. The design below keeps the
  decision in the plugin because the plugin owns the registry, the cap and the
  notices, and none of those have an opencode-side equivalent — but if the
  boundary is ever revisited, only §3.4 (the reap), §6 (the bootstrap sweep)
  and §4 (the tool) are plugin-specific; §3.2 is a policy that could live
  anywhere.
- **Which half owns the truth about a retained row.** The two halves do not
  need a new interface between them. The plugin publishes a held subagent's
  state in the opencode session title — `[agent-intercom]
  [retained:<epoch ms when the retention window ends>] <work title>`, written
  by `publishRetentionState` (`src/teardown.js`) through `updateSessionTitle`
  (`src/client.js`) — and the TUI reads it on every poll via
  `readRetentionStamp` (`tui/src/subagent-label.ts`). Both halves already own
  and read the title field; the stamp rides on what is already there, no new
  transport between server and TUI. The TUI holds a row only when the stamp is
  present in the title it polls — over the reuse ceiling, a `Blocked:` reply,
  a nested child, an error ending, or a retention the plugin simply refused,
  the title carries no stamp and the row is never shown as held, even briefly.
  The cost is one `session.update` per retention that becomes final and one per
  accepted reuse; the title change is best-effort and a failed write costs the
  reader the row it would have shown, never a wrong one.
- **Whether the feature ships on.** The default proposed below is off
  (`maxRetainedSubagents = 0`), which keeps a project that never opts in
  byte-identical to today and keeps `test/system-prompt-stability.test.js`
  meaningful. Turning it on by default is a one-line change and is the only
  setting in this design whose default is a judgement rather than a derivation.

---

## 3. The lifecycle model

### 3.1 States

Today an entry has `status` (`src/registry.js:1147`), which mirrors opencode's
own session status — `busy` / `retry` / `idle` — plus `aborted` derived from a
set, `src/registry.js:222-225`:

    export function effectiveState(entry) {
      if (aborted.has(entry.sessionID)) return "aborted"
      return entry.status ?? "unknown"
    }

`status` cannot carry retention: a retained session's opencode status *is*
`idle`, and stays `idle` forever. So retention needs a second, orthogonal
field, `entry.lifecycle`, with exactly three values:

| `lifecycle` | meaning | set where |
|---|---|---|
| `running` | a turn is in flight or about to be; the entry occupies a concurrency slot | `createEntry` (`registry.js:1121`), and again on every accepted reuse |
| `retained` | the wake was delivered, the opencode session is alive and re-promptable | the idle critical section, when the retention decision says keep |
| `closing` | teardown has begun; no reuse admitted, delete in flight | `teardownSubagent` entry, before its first await |

`effectiveState` gains `retained` ahead of the `status` fallback, so every
renderer that already calls it (`tools.js:267`, `hooks.js:936`,
`registry.js:240`, `registry.js:418`) sees the new state rather than a stale
`idle`.

### 3.2 What replaces the unconditional delete

The idle path stays exactly as it is up to and including the wake delivery —
the `dispatched` latch, the delivery reservation, the snapshot fetch, the
child-waiter settle, the TODO auto-tick and the parent notice
(`hooks.js:1140-1216`) all keep running unchanged, because the orchestrator
still gets its result at the same moment. Only the two lines that dispose of
the session change:

- `removeEntryLocked(sessionID)` (`hooks.js:1149`) becomes
  `retainOrRemoveLocked(sessionID, decision)`. On `remove` its body is
  today's. On `retain` it leaves the entry in `registry` and `bySession`,
  sets `lifecycle = "retained"`, stamps `retainedAt = Date.now()`, and — this
  matters, see §7.6 — clears `dispatched` back to `false`, because the latch
  means "a wake for *this run* is in flight" and that run is over.
- `teardownSubagent(…, { entryRemoved: true })` (`hooks.js:1224-1228`) is
  called only on the `remove` branch. On the `retain` branch nothing after the
  notice runs: no `endLiveChildrenOf`, no quiescence wait, no `deleteSession`,
  no `forgetSessionDirectory` (the directory cache is what a reuse needs).

The retention decision is taken in **two phases**, because the conditions do
not all become knowable at the same moment: the mutex section holds the entry
but not the reply, and the result snapshot is fetched only after the lock is
released (`hooks.js:1175`). Splitting it is what lets the delivery half of the
idle path stay exactly as it is.

**Phase 1, inside the critical section.** A pure function in `registry.js`,
`retentionDecision(entry, maxRetained)`, computed on the values the section
already holds and doing no I/O. It grants a retention only when all of:

1. `maxRetainedSubagents > 0`;
2. the ending is a clean idle — never `session.error`
   (`hooks.js:1254-1304`), never a watchdog timeout (`watchdog.js:126-163`),
   never the abort tool (`tools.js:682-764`). A run that failed or hung is not
   a session to hand more work to, and those three paths keep deleting exactly
   as today. This is not a term of the function but of its caller: those three
   paths go straight to `teardownSubagent` and never take the decision at all;
3. the entry is a top-level subagent, i.e. its parent is a primary and it has
   no waiter — nested children are excluded outright (§7.4).

On a grant the section calls `retainEntryLocked` instead of
`removeEntryLocked`; on a refusal it removes the entry exactly as it always
did. Either way the wake is delivered from the same snapshot a moment later.

**Phase 2, after the snapshot, before the teardown.** The conditions that need
the delivered result are evaluated where that result is, and a phase-1 grant
they fail is **revoked**: the retention flag the teardown is called with goes
back to false, and `teardownSubagent` then disposes of the session on the very
same path it always used. Two conditions live here:

4. the reply is not a `Blocked:` report — `isBlockedResult`
   (`notices.js:29-33`) already classifies it, and the established decision is
   that a blocked task continues through a fresh spawn carrying the
   orchestrator's decision (`notices.js:89-92`);
5. **the question-mode admission gate of §4 passes on the freshly fetched
   `snapshot.ctxTokens`** — i.e. `0 < ctx ≤ 70 000` and, where a budget is
   configured, `ctx < budget`. A session that could never be admitted for even
   a one-line question is deleted at once rather than held for an hour and
   refused at every attempt. Under a 100 000-token budget this is not a corner
   case: a large but perfectly healthy run that ended at 85 000 was never over
   its budget, was never STOP-injected, produced a good result — and is still
   not retainable, because the user's ceiling is 70 000. That outcome is
   intended and is the visible face of requirement 2.

A failed snapshot fetch or a failed wake revokes the retention too: a subagent
whose result never reached the orchestrator is nothing to hold a session for.

Capacity is not a term of either phase. A retention that overshoots
`maxRetainedSubagents` is resolved afterwards, by evicting the OLDEST retained
entries (§3.4) rather than by refusing the newest — the entry the orchestrator
was just told about is the one most likely to be asked a follow-up question.
The eviction runs through `evictRetainedOverCapacity` (`hooks.js:1627-1642`),
which calls `dropRetainedSubagents(client, { keep: retentionCapacity() })`
(`teardown.js:366-379`): `keep` is the live value of
`maxRetainedSubagents` from `retentionCapacity()` (`settings.js:600-602`), the
victims are claimed under the registry mutex and moved to `LIFECYCLE_CLOSING`
before any I/O, and each is then handed to `teardownSubagent` with
`notice: null` and `markAborted: false` — the same teardown every ending path
uses, and silent towards the parent for the same reason §3.4 gives for the
TTL reap.

That covers a capacity that the set crosses on the way up. A capacity that is
LOWERED while the set is already held is a different case — no entry joins at
that moment, so `evictRetainedOverCapacity` is not reached, and at capacity 0
no entry ever joins the set again, so the idle path can never fire. The set
would otherwise hold entries the orchestrator can no longer use: `list`
stops offering them and `reuse` refuses them on the very capacity that
stranded them, while the opencode session stands for the whole retention
window. That gap is closed on the same 5 s watchdog tick, by
`trimRetainedToCapacity` (`watchdog.js:204-214`): it reads `retentionCapacity`
live, so a settings edit takes effect at the next tick, and drops the
over-capacity tail — oldest `retainedAt` first — through the same
`dropRetainedSubagents(..., { keep, label: "capacity" })` the idle eviction
runs. The teardown is identical to the capacity eviction above; the parent is
silent; the victims become `LIFECYCLE_CLOSING` under the registry mutex before
the per-entry loop of `sweepWatchdog` takes its snapshot, so the reap and the
trim never race on the same entry. A failed trim is logged and retried on the
next tick — it must not cost the tick its timeout and TTL work.

Anything else deletes, and the whole feature reduces to today's behaviour when
`maxRetainedSubagents` is 0 — which is its default: phase 1's first condition
is then the only one ever reached.

### 3.3 Settings and defaults

Added to `getSettings` (`src/settings.js:266-287`), to the file-parse block
below it, and to the TUI's copy `tui/src/settings-file.ts` with the parity
test extended (`test/settings-defaults-parity.test.js`):

| key | env var | default | meaning |
|---|---|---|---|
| `maxRetainedSubagents` | `OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS` | **0** | how many finished subagents may be held per process. 0 switches the whole feature off — today's behaviour, byte for byte. Recommended non-zero value: **3** |
| `retainedSubagentTtlMs` | `OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS` | **3600000** (60 min) | the retention ceiling, measured from `retainedAt`. Clamped to a minimum of 1: "no ceiling" is deliberately not offered, because nothing else in the system will ever delete the session |
| `reuseContext` | — (map, file only) | `{}` | the reuse ceiling **per agent type**, in whole tokens, exactly as the file holds it. Read through `reuseCeilingFor`, never directly (§4.6) |
| `maxReuseContext` | `OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT` | **70000** | the reuse ceiling for every type `reuseContext` does not name |

Plus one module constant, not a setting, in `registry.js` beside the existing
share constants (`notices.js:17-18` is the precedent):

    RETAIN_TASK_SHARE = 0.5   // requirement 3, secondary case only

and one exported default in `settings.js` beside `DEFAULT_MAX_CONTEXT`:

    DEFAULT_MAX_REUSE_CONTEXT = 70000

**Why 60 minutes and not 30.** The requirement is "30 minutes or more". A TTL
of exactly 30 minutes fails its own stated case at the boundary: the reap runs
on the 5 s watchdog tick (`WATCHDOG_INTERVAL_MS = 5000`, `watchdog.js:35`), so
a question asked at 30:01 finds nothing, and a question asked at 29:58 races
the sweep. 60 minutes is the smallest round wall-clock unit that clears "or
more" with room, and an hour is the unit a user actually reasons in. 45 minutes
(2 700 000) is the defensible alternative if the leak exposure of §6 is judged
too high and the bootstrap sweep is cut; it buys a 25 % smaller exposure and
gives up the round number.

**Why capacity 3 and not 1.** The driver is "something strikes the orchestrator
later", and what strikes it later is usually about an *earlier* subagent — the
most recent one is still in the wake notice it just read. With capacity 1 and
oldest-first eviction, the second subagent to finish evicts exactly the one the
orchestrator is most likely to want. Three covers a normal working stretch — a
review, a fix, a check — without becoming a pool. Eviction when capacity is
full stays **oldest `retainedAt` first**.

### 3.4 When a retained session is finally torn down

Four ways out, in the order they are likely:

- **Reuse ends it.** A reused run goes back to `lifecycle = "running"` and, on
  its own idle, faces the same retention decision again. `retainedAt` is
  re-stamped, so the TTL is per retention, not per session.
- **The ceiling fires.** A new branch inside the existing watchdog tick — not a
  second timer; `sweepWatchdog` already runs every 5 s and its handle is
  `unref`'d (`watchdog.js:35`, `:51-60`). Entries with
  `lifecycle === "retained"` and `retainedAt + retainedSubagentTtlMs < now` go
  through `teardownSubagent` with `notice: null` and `markAborted: false`.
  **No wake notice on expiry**: the parent was already woken when the run
  finished, and a second notice costs the primary an LLM turn to be told that
  something it may never think about again has gone. The expiry is surfaced
  instead in the next turn's snapshot block (§7.8), which costs nothing.
- **Capacity evicts it**, same teardown, same silence.
- **The parent's world ends** — handoff, endless cycle, plugin reload (§3.5,
  §6).

**Sizing the reaping pass.** It does not need any. It rides the tick that
already exists, iterates the same `[...registry.values()]` snapshot the sweep
already takes (`watchdog.js:73`), and adds at most `maxRetainedSubagents`
integer comparisons per tick — 3 comparisons every 5 s, 2 160 over a full
retained hour. The only quantity the longer window changes here is granularity:
a 5 s tick against a 3 600 000 ms TTL is a 0.14 % overshoot. Neither
`WATCHDOG_INTERVAL_MS` nor the sweep's shape needs to move.

### 3.5 The inactivity watchdog, and exactly how a retained entry is exempted

This is the part of the design where the longer window is won or lost, so it is
stated as an edit rather than as an intent.

**What would happen without an exemption.** `lastActivityAt` is bumped only by
the event handler, on an observed event (`registry.js:1148-1156` documents it;
`hooks.js:1007` does it). A retained session emits no events — it is idle and
nobody is prompting it — so its `lastActivityAt` freezes at the last event of
run 1. The sweep compares exactly that value against `maxSubagentAgeMs`
(`DEFAULT_MAX_SUBAGENT_AGE_MS = 90000`, `settings.js:110`):

    const last = entry.lastActivityAt ?? entry.spawnedAt
    if (now - last <= maxAge) continue

so a retained entry crosses the threshold about 90 s after its run ended, 18
ticks in. The 60-minute window would in practice be a 90-second window, and
every retained subagent would be torn down by `timeoutSubagent`
(`watchdog.js:126-163`) with a `timeoutNotice` posted to the parent — a false
hang report about a subagent that finished cleanly and was already reported as
finished.

**What would hide the bug.** Today the sweep would in fact skip such an entry
by accident, `watchdog.js:78-80`:

    // session.idle fires just before the entry is removed; if a stray idle
    // sneaks through the gap, `entry.status === "idle"` covers it.
    if (entry.status === "idle") continue

and `hooks.js:1134` sets `e.status = "idle"` on the idle path. That line is
documented as a race guard for the removal gap, not as a retention rule.
Leaning on it would leave the retention ceiling with no owner and would break
silently the day someone narrows the guard to what its comment describes.

**The edit.** `sweepWatchdog` becomes one loop with a switch on
`entry.lifecycle`, and nothing about a running subagent changes:

1. `case "running"` — today's body, byte for byte: the four skips
   (`timedOut`, `errored`, `aborted.has(sessionID)`, `status === "idle"`), the
   `isWaitingOnWatchdoggedChild` exemption with its `lastActivityAt` bump
   (`watchdog.js:96-100`), the `maxSubagentAgeMs` comparison, the `timedOut`
   latch before any I/O, `timeoutSubagent`. The `status === "idle"` guard stays
   with its comment intact; it keeps being a race guard.
2. `case "retained"` — the retention branch of §3.4. `maxSubagentAgeMs` is
   never read here and `lastActivityAt` is never compared; the only clock that
   applies is `retainedAt + retainedSubagentTtlMs`.
3. `case "closing"` — `continue`. A teardown is already in flight.

4. **The one non-obvious move.** `sweepWatchdog` opens with
   `if (maxAge <= 0) return` (`watchdog.js:69`, "watchdog disabled"). That
   early return currently short-circuits the whole sweep, so leaving it in
   place would mean `maxSubagentAgeMs = 0` also switches off the retention
   reap — and the leak of §6 becomes unbounded, silently, in the one
   configuration a user picks precisely because they do not want subagents
   killed on a timer. The check moves *into* the `running` branch. This is the
   edit I expect to be got wrong, and it deserves its own test: with
   `maxSubagentAgeMs = 0` and `maxRetainedSubagents = 3`, a retained entry past
   its TTL must still be reaped.

**Reuse restores watchdog ownership.** An accepted reuse sets
`lifecycle = "running"` and `lastActivityAt = Date.now()` in the same
synchronous block, before `promptSession` is awaited, so run 2 is measured from
the reuse and cannot be reaped on the first tick after admission. From that
moment the inactivity watchdog owns run 2 exactly as it owned run 1.

Net effect: the inactivity threshold stops applying only to entries in a state
that does not exist today. No running subagent's treatment changes.

### 3.6 Parent ends, plugin reloads

- **Primary handoff.** Retained children are dropped at the start of the
  sequence, before the gather — not reparented. Reason: a retained session's
  only value is its context, and its context is the *old* primary's task; the
  new orchestrator receives a summary and has never seen that history, so a
  fresh spawn is a better offer than a warm session it cannot read. Dropping
  first also means `reparentSubagents` (`registry.js:534-549`) and
  `inFlightSubagentsFor` (`registry.js:569-584`) never meet a retained entry
  and stay untouched.
- **Endless cycle.** Same drop, inside the cycle itself: step 2b of
  `runEndlessCycle` (`endless.js:204-216`), after the cycle-ceiling check and
  before the quiesce wait.

  The reason is the exclusion, not the quiesce wait. A retained session must not
  outlive the primary it belongs to, and from step 2b on the cycle is committed
  to replacing that primary; a retention that survived would leave a handle
  addressing a warm session whose orchestrator is gone. The quiesce wait forces
  nothing here: a retained entry is not `isActiveEntry` (`registry.js:264-268`),
  so `isQuiesced` (`registry.js:1270-1277`) already passes over it and no
  retention can hold a cycle to its `endlessQuiesceTimeoutMs` (default 600 s,
  `settings.js:185`).

  The two neighbouring positions are what fix the placement. The cycle ceiling
  stays **ahead** of the drop: at `maxCycles` the mode switches itself off,
  replaces nothing and lifts the spawn freeze again, so that path must leave
  retention standing. Everything **after** the drop is a way out that has
  already paid it — an abandoned quiesce wait, a failed save — and that is the
  safe direction: a dropped retention costs a fresh spawn, a surviving one
  points a handle at a primary the next cycle replaces. The drop is
  best-effort: it is skipped where no dependency is injected, and a failure is
  logged rather than abandoning a cycle that can still save its open points.
- **A consequence of the longer window worth naming.** With a 60-minute ceiling
  and an endless-mode restart threshold of 250 000 tokens, the handoff will
  often end a retention window before the TTL does. The effective retention is
  `min(TTL, time-to-next-handoff)`, and 60 minutes is the ceiling, not the
  expectation. This is not a defect — it is the reason the TTL can be generous
  without the DB filling up — but it does mean a user who observes retention
  ending early should look at the handoff before the TTL.
- **Plugin reload / process end.** The one genuinely new durable cost; §6.

---

## 4. The admission rule

### 4.1 The figure the gate is evaluated on

`entry.ctxTokens` (`registry.js:1158`) is the sum of the newest assistant
step's `input + output + cache.read + cache.write`, reasoning deliberately
excluded, `client.js:298-307`:

    function latestContextTokens(messages) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const t = messages[i]?.info?.tokens
        …
        const sum =
          (t.input ?? 0) + (t.output ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)

There is no remaining-window field anywhere in the v1 surface
(`work/researcher-opencode-session-lifetime.md` §3). The model's own window
*is* obtainable — the installed SDK 1.18.23 types carry it on the model,
`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1323-1326`:

        limit: {
            context: number;
            output: number;
        };

served by `GET /config/providers` and exposed as `client.config.providers()`
(`sdk.gen.d.ts:76`), with the agent's model resolvable in-process
(`src/llmmodel.js:72-82`). **The design does not fetch it.** The gate's job is
not "how much window is left" but "may this session be handed another prompt",
and that question is now answered by a number the user fixed. The window route
is named here so the choice is on the record, and §10 states the single
observation that would force it.

### 4.2 The gate

At reuse time, three inputs:

- `budget = contextBudgetFor(entry.agent)` (`settings.js:403-409`); `0` means
  the budget is disabled for that type, and is a real value at every resolution
  level, never "unset"
- `ceiling = reuseCeilingFor(entry.agent)` — the per-type reuse ceiling of
  §4.6, default 70 000; `0` means this type is never reused
- `ctx` = `ctxTokens` from a **fresh** `fetchSnapshot` (§5.2)
- `pkg` = `estimateTokens(prompt)`, the same estimator `packageSizeVerdict`
  uses (`tools.js:100-135`)

<!-- -->

    admitted  ⟺  ctx is a number > 0                                      (G1)
              ∧  ctx ≤ ceiling                                            (G2)
              ∧  (budget === 0  ∨  ctx + pkg < budget)                    (G3)
              ∧  (mode !== "task"  ∨  budget === 0
                                   ∨  ctx ≤ budget × RETAIN_TASK_SHARE)   (G4)

**G1 — a figure, not a guess.** `fetchSnapshot` returns `{}` on any failure
(`client.js:262-263`), so `ctxTokens` may be `undefined`. The ceiling the user
set must never be evaluated against a missing number; an unreadable snapshot
refuses.

**G2 — the user's ceiling, 70 000 by default.** Unconditional in both modes,
and evaluated per agent type (§4.6). It is the term that exists to be
configured; the others exist to protect contracts the plugin already holds.

**G3 — the existing budget contract, kept intact.** A session must not be
re-prompted into an immediate STOP. `contextLimitNotice` (`hooks.js:652-732`)
injects the STOP block on run 2's first transform whenever
`ctxTokens >= maxContext`, and `guardToolExecute` denies every tool call from
that moment, `hooks.js:1467-1468`:

    const maxContext = contextBudgetFor(entry.agent)
    if (maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext) {

Admitting a reuse over budget would hand the orchestrator a subagent that is
locked to text-only on its first breath and reports it as a denial loop
(`work/code-explorer-context-budget-enforcement.md` §1.5). G3 also carries the
reuse prompt: at a high `ctx` it is stricter than the spawn-time package gate,
which measures `pkg` against `PACKAGE_REFUSE_SHARE = 0.4` of the whole budget
(`settings.js:384`) — 40 000 tokens under a 100 000 budget, where a session at
70 000 has only 30 000 left. The reuse path runs `packageSizeVerdict` too, for
its wording; G3 is what actually decides.

**G4 — "still very little context", secondary case only.** A further task needs
room for what the task produces, which G3 does not measure: G3 asks only
whether the *prompt* fits.

### 4.3 The two modes

`reuse` takes `mode` with values `question` (the default) and `task`.

The alternative — inferring the mode from `pkg` — is rejected: prompt size
measures what is asked, not what the run will need. "Run the suite and fix what
fails" is a small prompt and a large run.

A model that labels a task `question` to slip past G4 is not stopped by the
tool, and deliberately so. Its run passes G3, so it starts clean; as soon as
its own work carries `ctxTokens` past `budget`, the existing STOP escalation
takes its tools away, exactly as it would for an oversized fresh spawn. The
backstop already exists and a second one would be a second place to keep
coherent.

### 4.4 Which term actually binds

Against the decided default of a **100 000-token budget for every agent type**:

| case | binding term | effective ceiling |
|---|---|---|
| question, both defaults | **G2** | 70 000 |
| task, both defaults | **G4** | 50 000 (= 0.5 × 100 000) |
| either mode, `budget === 0` (disabled for that type) | **G2** | the type's reuse ceiling |
| either mode, budget configured below the reuse ceiling | **G3** | just under the budget |
| either mode, reuse ceiling configured to `0` | **G2** | nothing; this type is never reused |
| any mode, large reuse prompt | **G3** | `budget − pkg` |

So **G2 binds in the normal case**. This is the substantive difference the new
budget default makes: with the old per-type budgets of 40 000–60 000
(`settings.js:78`, `:85-94`) the budget term was always the tighter one and the
70 000 ceiling was dead code except where a type had its budget disabled with
`0`. At 100 000 it is the other way round — the ceiling is the operative rule
for the primary case, and the budget only takes over when a user lowers it
below 70 000 or when the reuse prompt itself is large.

Two consequences follow and should be expected rather than diagnosed:

- **A healthy run can be unretainable.** Between 70 000 and 100 000 a subagent
  is under its budget, was never STOP-injected, and returned a good result — and
  is still refused, both for retention (§3.2 condition 5) and for reuse. Nothing
  is wrong; requirement 2 is simply stricter than the budget.
- **The overshoot case stops mattering.** A session can *end* above its own
  budget, because the budget check fires only on tool calls and reads a
  `ctxTokens` cached for `CTX_TTL_MS = 3000` (`registry.js:830`, read at
  `hooks.js:657`), so one large tool result can carry a subagent well past its
  ceiling before anything looks again. Under a 100 000 budget such a session is
  far above 70 000 and G2 refuses it long before G3 would. What it still means
  for the *retention* decision is that its context term is a **phase-2**
  condition (§3.2): it is evaluated on the snapshot the idle path fetches after
  the lock is released (`hooks.js:1175`), never on the entry's older value, and
  a phase-1 grant it fails is revoked before the teardown runs.

### 4.5 Is a separate "very little context" threshold still needed?

**Yes, for the secondary case, and it is not a new number.** G4 is
`RETAIN_TASK_SHARE = 0.5` of the per-agent budget — 50 000 under the decided
default, which sits below the 70 000 ceiling and therefore does real work
rather than being shadowed by it. The reason it survives:

- G2 alone would admit a further task at 70 000, leaving 30 000 of budget for a
  run that has to read, think and write. That is a third of what a fresh
  subagent of the same type gets, handed to a task that was not scoped for it.
- G3 alone only checks that the prompt fits. A 2 000-token task prompt fits at
  `ctx = 69 000` and the run then has 29 000 to work in.
- G4 leaves the second task 50 000 tokens of room — half a full budget, which is
  the same order as an entire subagent under the old defaults, and is the
  denominator the orchestrator is already taught to reason in
  (`PACKAGE_WARN_SHARE` / `PACKAGE_REFUSE_SHARE` against `contextBudgetFor`,
  `settings.js:383-384`).

It stays a **share** rather than a second per-type number even though the
budget is now uniform, for two reasons. The share survives a user lowering one
type's budget: at `agentContext[coder] = 40000` the task gate becomes 20 000 by
itself, where a hard-coded 50 000 would silently exceed that type's whole
budget. And the requirement asks for **one** per-type figure to be settable —
the reuse ceiling — so a second per-type map for the task case would be a
setting nobody asked for and a third number for the user to keep consistent
with the other two. Where the budget is `0`, there is no share to take and G4
falls back to G2 — the type's own reuse ceiling is then the only rule, which is
the right answer because it is the only number that exists.

And the reason G4 must **not** govern the primary case: a follow-up question is
one prompt and one answer. Requiring a researcher to be under 50 000 before it
can be asked "which of the two did you mean?" refuses the reuse in exactly the
situation the feature exists for. Under a single share-based gate the primary
use case is refused in the common case; that is the part of the earlier design
this requirement overturns.

### 4.6 The per-type reuse ceiling: where it lives, how it is set

Requirement 2 fixes 70 000 as the **default**, not as a constant. The ceiling
is per agent type and settable from the TUI.

#### The mechanism to mirror, and the one place the mirror is shorter

The plugin already has exactly this shape for the context budget: a per-type
map in the settings file, a resolver that walks the levels, and a TUI stepper
that edits one type's value. The reuse ceiling reuses that shape rather than
inventing a second one.

    reuseCeilingFor(agent):
      1. settings.reuseContext[agent]        // the type's own entry, file
      2. settings.maxReuseContext            // flat: file, else env var
      3. DEFAULT_MAX_REUSE_CONTEXT = 70000

Beside `contextBudgetFor` (`settings.js:403-409`) this is deliberately one
level shorter, and the difference is worth stating because someone will
otherwise "fix" it. `contextBudgetFor` needs five levels and a
`maxContextSource` flag because it has a **built-in per-type table**
(`DEFAULT_AGENT_CONTEXT`, `settings.js:85-94`) *and* a legacy flat key, so it
must tell "the user set the flat value" from "the built-in table happens to
apply" — that is the entire job of `maxContextSource`
(`settings.js:267-268`, `:406`). The reuse ceiling has neither: one number for
every type, because the user named one number, and no history to migrate. With
no built-in per-type table there is nothing for a source flag to disambiguate,
so there is none. The file parse follows the same discipline as `agentContext`
(`settings.js:303-309`): a key survives only as a whole non-negative integer,
one garbage entry costs the user that entry and not the map, and a value that
is not a plain object leaves the map empty.

#### What `0` means: never reuse this type

**Decision: `0` means this agent type is never reused.** Not "no limit".

The neighbouring map reads `0` the other way — `agentContext[agent] = 0`
disables the budget, i.e. removes the enforcement, and both enforcement sites
check `maxContext > 0` before doing anything (`hooks.js:654`, `hooks.js:1468`).
Three reasons the reuse ceiling reads it the opposite way and is not being
inconsistent:

1. **The two numbers are different kinds of number.** The budget is an
   *enforcement* threshold — a guard that either fires or does not, so "0 = do
   not fire" is its natural off switch. The reuse ceiling is an *admission*
   threshold, and the literal reading of "admit sessions up to 0 tokens" is
   "admit none". The rule needs no special case at all: G1 already requires
   `ctx > 0`, so `ctx ≤ 0` is false for every real session and `0` falls out of
   the formula as "never admitted". Nothing branches on it; only the
   documentation has to say so.
2. **Monotonicity in the TUI.** `stepAgentContext` steps a per-type value down
   and documents that a step below zero removes the entry so the inherited
   value shows again, with `0` itself reachable
   (`tui/src/settings-file.ts`, `stepAgentContext`'s doc comment). A user
   stepping a reuse ceiling toward zero is narrowing what may be reused; if the
   last step flipped to "unlimited", the strictest setting on the row would be
   its loosest. That is a trap, and it is one keystroke deep.
3. **Expressiveness.** Under this reading, "no limit for this type" is still
   expressible — set a large number. Under the other reading, "never reuse this
   type" would have no expression at all short of switching retention off for
   the whole process.

#### Which file owns it, and how it reaches the TUI

The premise that the two halves are configured through different files does not
hold for this plugin, and the design depends on that, so it is stated with the
lines behind it. **Both halves read and write the same file,**
`~/.config/opencode/agent-intercom.json`:

- the plugin, `src/settings.js:171`:

      let settingsPath = join(homedir(), ".config", "opencode", "agent-intercom.json")

- the TUI, `tui/src/settings-file.ts`:

      const file = createJsonObjectFile("agent-intercom.json")

  resolved against the same directory in `tui/src/json-object-file.ts`:

      let path = join(homedir(), ".config", "opencode", fileName)

`opencode.json` carries only the `plugin` array that loads this plugin, and is
read by opencode once at instance bootstrap (`learnings.md`, "opencode resolves
external plugins once, at instance bootstrap"); no setting of this design goes
there, and none goes into a TUI-only file. So there is no ownership question to
settle between two files — there is one file, and the question is only which
half owns the *shape*.

**The plugin owns the value; the TUI is a second reader and the only writer.**
`getSettings` (`settings.js:266-287`) is the reader of record: it is what every
gate actually runs on. The TUI carries a duplicated copy of the defaults and the
resolution order because it is a separate npm package that cannot import
`settings.js` at runtime, and `test/settings-defaults-parity.test.js` is what
keeps the two copies honest — `DEFAULT_MAX_REUSE_CONTEXT` is added on both sides
and to that test in the same step.

What the TUI side needs, named as mechanisms rather than as rows, because
another run is editing that surface and its layout is not settled here:

- `Settings` gains `reuseContext: AgentContext` and `maxReuseContext: number`;
  `SETTING_VALIDATORS` gains an entry for each — `reuseContext` validated by
  the same `filterAgentContext` the budget map uses, `maxReuseContext` by
  `isLimit` — so a key the plugin would reject is dropped by the next write, as
  `pruneSettings` already guarantees for every other key.
- `resolveSettings` resolves both the way `reuseCeilingFor` does, so the panel
  shows what is actually in effect rather than what is on disk.
- An `effectiveReuseContext(settings, agent)` beside `effectiveAgentContext`,
  returning the same `{ value, source: "agent" | "inherited" }` pair, so the
  row can carry the same own-versus-inherited marker.
- A `stepReuseContext(agent, delta, agents)` beside `stepAgentContext`, with
  the same read-modify-write through `applySetting`, the same
  "step below zero removes the entry" behaviour, and the same first-edit
  migration — freeze the effective ceiling of every listed agent into
  `reuseContext`, drop the flat `maxReuseContext` key, so a type's ceiling has
  one home from then on.
- `maxRetainedSubagents` and `retainedSubagentTtlMs` are scalars and join
  `LimitKey`, stepped through the existing `stepSetting`. The TTL row steps
  in whole minutes and writes milliseconds; its floor is one whole minute,
  the unit the row is shown in. The 1 ms floor `resolveSettings` clamps
  the file value to is what a hand-written `0` in the file resolves to —
  it is not somewhere the `[-]` key can take the user.

Nothing about this needs an opencode restart: the TUI's writes go to the file
the plugin reads, and `getSettings` re-reads it when its cache expires
(`settings.js:264-265`) — the same live-edit path the context budget already
uses.

#### A reuse ceiling above the budget: neither rejected nor clamped

With the budget default at 100 000 and the reuse default at 70 000, a user can
set `reuseContext[coder] = 150000` over an `agentContext[coder]` of 100 000.
**That configuration is accepted as written.**

It is not dangerous, because G3 already dominates it: at `ctx = 120 000` the
ceiling passes and `ctx + pkg < budget` refuses. The effective reuse ceiling is
`min(ceiling, budget − pkg)` by construction of the gate, so a ceiling above the
budget admits nothing the budget would not have admitted anyway. It is inert,
not unsafe.

Rejecting it would be worse than the problem. The two numbers legitimately
cross while being edited: a user raising the budget from 100 000 to 200 000 and
then the ceiling to 150 000 is blocked at whichever edit comes first, so the
validator's verdict would depend on edit order. And the file's own discipline is
that a rejected key is *dropped* on the next write
(`tui/src/settings-file.ts`, `pruneSettings`) — a cross-key rule would therefore
silently delete a number the user typed because of a different number
elsewhere.

Clamping would be worse still: it writes a value the user did not type, and it
would have to re-run whenever the *other* key changes, which no writer in that
module does — `stepSetting` clamps only at a floor (`Math.max(min, …)`), never
against another key.

The one case where the configuration is **not** inert is `budget === 0`, the
type whose budget is disabled. There G3 collapses and the reuse ceiling is the
only gate — which is exactly the configuration in which a user who set a high
ceiling meant it. That is the same carve-out §4.4 already names, and it is the
reason the ceiling must stay independently settable rather than being derived
from the budget.

What is left is a display question, and it gets a display answer: the panel row
shows the configured value and marks when the budget is the tighter of the two,
the same way the row already marks an inherited value against an own one. A
number that is set but not in effect is a thing the user should be able to see,
not a thing the file should refuse to hold.

### 4.7 Who decides

**The orchestrator, explicitly, through a new tool — never the plugin.**

The alternative, plugin automatism inside `spawn` (silently re-prompting a
retained session of the same agent type), is rejected on two grounds that are
visible in the code. The orchestrator writes its prompt for a fresh context —
"read X, then do Y" — and prepending that to a session that has already read X
yields a run whose briefing contradicts its own history. And the package-size
gate measures the prompt against a full budget (`tools.js:398-412`), which is
the wrong denominator for a session that has already spent part of it.

So: `reuse(subagent, prompt, mode?)`, beside `spawn` and `abort` in the tool map
(`tools.js:861-897`) and added to `PRIMARY_TOOLS` (`hooks.js:92-96`). It
refuses, always naming `spawn` as the alternative so the orchestrator can never
be stuck, when: retention is off; the handle is unknown or belongs to another
primary (mirroring the ownership check at `tools.js:692`, with the same uniform
"unknown" wording so foreign ownership does not leak); the entry is not
`retained`; any of G1–G4 fails, with the failing term named in tokens so the
orchestrator learns the rule; or the caller is itself a subagent.

### 4.8 How a reused run is charged and reported

- **No new entry.** The existing entry flips to `lifecycle = "running"`,
  `status = "busy"`, `dispatched = false`, `lastActivityAt = now`, `runs += 1`,
  `packageTokens` replaced by this package's estimate. `spawnedAt` is **not**
  reset: the age column (`tools.js:267`, `hooks.js:938`) keeps telling the
  truth about how long the session has existed.
- **The concurrency slot is taken like a spawn's**, through the same
  `spawnCapDecision` / `reservePendingSpawn` pair
  (`registry.js:263-270`, `tools.js:491-502`). It must be, or the cap stops
  meaning "how many LLM runs are in flight".
- **The handle is unchanged**, which is the point: the orchestrator addresses
  `researcher#1` twice.
- **The completion notice changes tense.** `completionNotice`
  (`notices.js:69-104`) currently ends "has finished and been destroyed" and
  "spawn a fresh subagent — the one above is gone". For a run that is being
  retained it says instead that the session is held, until when, at what
  context against the 70 000 ceiling, whether a further *task* would also be
  admitted, and that `reuse("<handle>", …)` is open. For run *n* > 1 the
  run-size line (`notices.js:142-167`) reports a figure that is cumulative over
  the session, so it is labelled as such ("run 2 of researcher#1 — 31k
  cumulative"); the number is already the honest one, only its caption is wrong
  today.
- **The per-run counters split in two.** `nestedSpawns` (`registry.js:1176-1182`)
  is a quota and must **not** reset across a reuse — a session that could
  refill its nested quota by being re-prompted would have an unbounded one.
  `nestedRuns` / `nestedTokens` (`registry.js:1183-1192`) are reporting figures
  and stay cumulative, with the notice caption adjusted. `stopInjections`,
  `budgetDenials` and `notifiedParentOfLoop` need nothing: they are already
  cleared on any accepted tool call (`hooks.js:1496-1500`). The doc-comments at
  `registry.js:1179-1181` and `:1189-1190` — "the entry lives exactly as long as
  the one-shot run" — are false after this change and are rewritten in the same
  step.

---

## 5. Is a 30-minute-old retained session still usable?

### 5.1 The model side

Nothing on the model side holds a session, so nothing on the model side can
expire it.

- **The provider keeps no conversation state.** opencode assembles each request
  from its own stored messages: the v1 prompt operation takes only a session id
  and a new part (`POST /session/:id/message`, `client.js:96-101` calls
  `promptAsync` with `path.id` plus `parts`), and the history it replays comes
  from the durable `MessageTable` / `PartTable` rows
  (`work/researcher-opencode-session-lifetime.md` §1). There is no server-side
  handle that ages. Anthropic's Messages API and Gemini's generate-content are
  stateless and take the full history on every request; OpenAI's optional
  server-side conversation state is retained in days, not minutes. Nothing in
  the 30-to-60-minute range expires anywhere except the cache.
- **What does age is the provider's prompt cache**, and every provider's
  cache is shorter than this window. Anthropic's default cache-breakpoint TTL
  is 5 minutes, refreshed on each hit, with 1 hour the only longer option and
  it costs extra; OpenAI's is model-dependent and tops out around 30 minutes
  for current models; Gemini's explicit context cache defaults to 60 minutes
  and its implicit cache publishes no figure. A reuse 30 or 60 minutes later
  therefore replays a history whose cache entries have expired, and its first
  turn pays full input-token price for tokens that would have been cache reads
  minutes after the run. This is the real per-reuse cost of a long window: money
  and latency, not correctness. It is also an argument *for* the ceiling — the
  bigger the retained session, the bigger the uncached replay — and it is the
  one figure that would argue for a shorter TTL if the cost ever mattered more
  than the capability.
- **Compaction is turn-driven, not time-driven.** A session carries
  `time.compacted` (`types.gen.d.ts:244`) and opencode emits `session.compacted`
  (`types.gen.d.ts:420`); both are consequences of a turn. An idle retained
  session runs no turn and is therefore not compacted while it waits. What can
  happen is a compaction on the *reuse* turn if the replayed request is large —
  one more reason G2 and G3 keep `ctx` modest.
- **opencode itself does nothing.** No session TTL, no garbage collection
  (`work/researcher-opencode-session-lifetime.md` §1, maintainer's answer in
  issue #4980: "No it does not"), rows durable in SQLite. On the opencode side a
  60-minute-old session is exactly as promptable as a 60-second-old one.
- **The one thing that does end inside the window is the plugin's process.** An
  opencode restart or a plugin reload drops the registry maps
  (`work/code-explorer-subagent-lifecycle.md` §2j) — the handle is gone even
  though the session is not. That is §6, and from the orchestrator's side it
  looks like a `reuse` on an unknown handle, which the tool already answers by
  pointing at `spawn`.

### 5.2 The plugin side: must `entry.ctxTokens` be refetched?

**Yes, unconditionally, before the gate is evaluated.**

Formally the stored figure stays *correct* while nothing prompts the session:
`latestContextTokens` reads the newest assistant step (`client.js:298-310`) and
no new step appears while the session is idle. But correct-if-nothing-happened
is not a property the design may assume, for one concrete reason: a retained
session is a real opencode session the user can open in the TUI and type into.
`guardToolExecute` classifies it as a subagent because a registry entry exists
(`hooks.js:1410-1416`), which gates its tools but does not prevent the turn or
the context growth. The plugin's only refresh sites are the idle path
(`hooks.js:1175`) and `contextLimitNotice` (`hooks.js:660-673`); neither is
guaranteed to have run, and neither moves `retainedAt`.

So `reuse` calls `fetchSnapshot` first — one HTTP call bounded by
`SNAPSHOT_TIMEOUT_MS = 5000` (`client.js:193`) on the orchestrator's tool path,
against the alternative of a whole `session.create` + `promptAsync`. Three
outcomes, all decided:

- **a number** → the gate runs on it, and `entry.ctxTokens` /
  `entry.lastTokensFetchAt` are updated in passing, so run 2's first
  `contextLimitNotice` sees the same figure the gate did;
- **`{}`** from a timeout or transport error (`client.js:262-263`) → refuse this
  reuse, keep the entry retained, tell the orchestrator to retry or spawn. The
  stale value is never substituted: a ceiling evaluated on a guess is not a
  ceiling;
- **an empty message list where a session used to be** → the session was deleted
  underneath the plugin (`opencode session delete`, a database reset, some
  future cascade) → refuse *and* drop the entry, so the handle stops being
  offered in the snapshot and the `list` tool.

Age is never itself a reason to distrust the figure. A missing figure is.

---

## 6. The reload leak under a one-hour window

Nothing else deletes an opencode session: no TTL, no GC
(`work/researcher-opencode-session-lifetime.md` §1), and the plugin gets no
shutdown hook — opencode offers none, and `process.on("exit")` cannot do
network I/O. Every plugin reload or process end that happens while a session is
retained leaks that session permanently.

What the requirement changes: the count per reload is still bounded by
`maxRetainedSubagents` (3), but the **exposure** — the chance that a reload
falls inside a retention window — scales with the window, and the window went
from 5 minutes to 60. That is a twelvefold increase in the one cost the earlier
design accepted, and it is the reason this section now carries its own decision
rather than a paragraph.

The row cost itself did not change in kind: a retained session is one
`SessionTable` row plus its message and part rows, all of which existed already
during the run — retention postpones the DELETE, it does not create rows. The
steady-state addition is `maxRetainedSubagents` sessions' worth, independent of
the TTL. The TTL multiplies dwell, not volume.

Three ways to handle the exposure:

**A — accept and bound.** At most 3 orphan sessions per reload that lands in a
window; a user can clear them by hand with `opencode session list` /
`opencode session delete`.
*Costs*: orphans accumulate across a working life of the project and nothing
ever removes them. *Forecloses*: nothing. *Demands*: nothing.

**B — a bootstrap sweep.** On the plugin factory call (`index.js:75`), before
anything else, list sessions (`client.session.list()`, `sdk.gen.d.ts:110`) and
delete those that are (i) marked as this plugin's own, (ii) not in this
process's registry — at bootstrap it is empty, so every candidate qualifies —
and (iii) idle for longer than `2 × retainedSubagentTtlMs`.
*Costs*: one list call per plugin load; and a prerequisite — the plugin does
**not** mark its sessions today, `tools.js:506` sets
`title: args.description || `${args.agent}: ${args.prompt.slice(0, 60)}``, so a
fixed marker prefix has to be added to that title first, and the sweep only
covers sessions created after it. *Risk*: a second concurrent opencode instance
on the same database has its own children in that list. The `2 × TTL` age
condition is what makes that tolerable — a *running* subagent is never idle for
two hours, because the inactivity watchdog reaps it at 90 s, so the worst the
sweep can wrongly delete is another instance's retained session, itself an
orphan-in-waiting. *Forecloses*: nothing.

**C — a retention journal.** Persist retained session ids to a small file,
replay and delete at bootstrap.
*Costs*: new persistent state outside the registry, a write on every retain and
every release, and a liveness question the file cannot answer by itself — two
concurrent instances must not reap each other's entries, so each entry needs a
pid and a pid-liveness check at replay. *Forecloses*: nothing. *Demands*: the
largest new mechanism in this design, for its smallest problem.

**Recommendation: B**, as its own step, severable from the tool. It converts a
permanent leak into one that self-heals at the next plugin load, which is what
makes a 60-minute window defensible where a 5-minute one did not need it. If B
is cut, A stands and the TTL should come back to 45 minutes to hold the exposure
down — which still meets "30 minutes or more", so cutting B is a real option and
not a blocker. C is not recommended: it buys precision the age heuristic does
not need.

---

## 7. The collisions, place by place

Every place that assumes a subagent session dies at idle, what has to change,
and what breaks if it does not.

### 7.1 The idle teardown — `hooks.js:1094-1232`, `teardown.js:240-307`

Change: the split described in §3.2. If unchanged, nothing is ever retained
and the feature does not exist. Low risk: the branch is one decision inside a
critical section that already holds every value it needs, and the delivery
half of the path is untouched.

### 7.2 `countActiveSubagents` and its five consumers — `registry.js:237-243`

Change: count an entry only where it is **not aborted AND**
`lifecycle === "running"`. The two terms are a conjunction, not alternatives:
no path sets a lifecycle other than `running` — the abort paths included, since
an abort is recorded in the `aborted` set and leaves `lifecycle` alone — so
dropping the aborted term would put aborted entries back into the count.

Both terms live in one exported predicate, `isActiveEntry(entry)` in
`registry.js`, and every consumer calls it rather than restating either term.
That predicate is the definition of "active" for the whole plugin, so the
consumers cannot drift apart. Consumers that inherit it for free: the cap
(`registry.js:263-270`), the quiesce predicate (`registry.js:1076-1082`), both
slot lines (`notices.js:174-179`, `tools.js:663-679`).

**If unchanged, this is the collision that breaks everything else, and the
longer window makes it worse rather than better.** With
`DEFAULT_MAX_SUBAGENTS = 1` (`settings.js:74`), one retained subagent
permanently refuses every further spawn — and the refusal text
(`tools.js:672-676`) tells the orchestrator that no further spawn will succeed
"until a subagent finishes (you will be woken)", which will never happen.
`isQuiesced` never returns true, so an endless cycle abandons at its 600 s
quiesce timeout (`endless.js:206-208`) and the idle-gated handoff stalls. Under
the earlier 5-minute design that deadlock lasted five minutes; at a 60-minute
TTL it lasts an hour, and the endless cycle's own 600 s timeout expires inside
it. **The count split is not an optional refinement of this design; it is its
precondition**, which is why it is step 1 below and lands on its own. The new
requirement does not weaken this finding — it makes it more load-bearing.

Sibling with the same shape: `activeTaskIdsFor` (`registry.js:414-421`) reads
the same `isActiveEntry` and so skips retained entries too — without that, a
retained entry still holding `T5` refuses
every fresh spawn for `T5` for the whole retention window
(`tools.js:430-442`) — an hour, not five minutes.

### 7.3 The inactivity watchdog — `watchdog.js:67-109`

Change: the `lifecycle` switch, the retention branch, and the move of the
`maxAge <= 0` early return, all as spelled out in §3.5. If unchanged, the
accidental `status === "idle"` skip at `watchdog.js:80` means retained entries
are never reaped by anything and live for the process lifetime — the leak this
design exists to bound becomes unbounded.

### 7.4 The delete cascade — `teardown.js:128-190`, `client.js:145-163`

opencode's DELETE recurses over children; the plugin enforces child-first
teardown because of it (`teardown.js:131-138`). Two facts keep a retained
top-level subagent safe: nothing in this plugin ever deletes a *primary* (the
handoff archives instead — `handoff.js:318`, `client.js:178-189`), and a
retained top-level subagent has no children of its own.

A retained *nested* child would not be safe. `endLiveChildrenOf` reads its
children from the waiter map, `childwait.js:193-199`:

    for (const record of pendingChildResults.values()) {
      if (record.parentSessionID === parentSessionID) out.push(record.childSessionID)

and a retained child has no waiter — its waiter was settled when it ended. It
would therefore be invisible to the child-first sweep and get its rows wiped
mid-life by its parent's delete, which is exactly the `FOREIGN KEY constraint
failed` failure the child-first rule exists to prevent
(`teardown.js:132-137`).

**Retention is refused for nested spawns outright.** It costs nothing real — a
nested child's result is consumed as the caller's tool result
(`tools.js:613-637`) and the caller is one-shot by design — and it keeps the
entire nesting machinery untouched. Building retention for nested children
instead would mean making `liveChildSessionIDs` registry-aware, which re-opens
the coupling the waiter map was introduced to avoid (`childwait.js:20-24`). The
new requirement does not touch this exclusion: a follow-up question is asked by
the orchestrator, and the orchestrator never has nested children.

### 7.5 The child-waiter — `childwait.js`, `hooks.js:1127-1133`

No change. The idle-held branch runs before the retention decision, so a
subagent blocked on a live child is never retained; and by §7.4 a retained
session can be neither a waited child nor a nested caller.

### 7.6 Handoff and archiving — `handoff.js:318-324`, `registry.js:534-549`, `:569-584`

Change: drop retained entries at the start of the handoff (§3.6).

If unchanged, two things break. A retained entry carries `dispatched = true`
from its first wake, and both `reparentSubagents` and `inFlightSubagentsFor`
skip dispatched entries (`registry.js:543`, `:575`) — so the entry survives
the handoff still pointing at the archived old primary, and a later reuse
posts its wake into a session the user has left. The delivery router
(`registry.js:719-727`) would redirect it only while the old→new redirect is
in place. Clearing `dispatched` on retention (§3.2) removes the second half of
that hazard by itself, but the first half — a warm session handed to an
orchestrator that never saw its history — is a design decision, and the answer
is: drop.

### 7.7 The wake notice and task marking — `hooks.js:1189-1216`, `notices.js:69-104`, `hooks.js:1355-1380`

Change: `completionNotice` takes a `retained` argument (§4.8); the spawn tool
description (`tools.js:863-871`) gains a sentence; the orchestrator guide
(`prompts.js:20`) gains one about `reuse` that names the follow-up question as
its purpose, since that is the behaviour the feature has to elicit.

`autoMarkTask` itself needs nothing. The subagent guide line
(`prompts.js:55`, "You are a one-shot subagent — do one focused task, then
reply once and return") **stays exactly as it is**: it is still true of the
run. Whether the session is deleted afterwards is the orchestrator's business,
not the subagent's, and telling a subagent it might be re-prompted invites it
to leave work for a second turn — the opposite of what the line is for.

If unchanged: the notice tells the orchestrator its subagent "has finished and
been destroyed" and that "the one above is gone" while the session is in fact
sitting there for an hour, and the model has no way to learn that `reuse`
applies to it.

### 7.8 The `list` tool and the system-prompt snapshot — `tools.js:766-779`, `hooks.js:932-951`

Change: a separate `retained` section in both renderings, with time left on the
ceiling and the reuse verdict, and the snapshot's prose rewritten. The snapshot
currently asserts the opposite of the feature, `hooks.js:944-947`:

    "…They are one-shot — a finished subagent disappears from this " +
    "list. To stop one, use `abort` (only on user request); for more work, spawn a fresh " +
    "subagent:\n"

If unchanged, retained entries render as `idle` rows with a growing age inside
a block that tells the model such rows cannot exist. Note the asymmetry that
already exists and is inherited: `list` filters by the caller's session
(`tools.js:773-776`) while the snapshot deliberately does not
(`hooks.js:933`, `:940` marks foreign rows) — the retained section follows
each renderer's existing rule rather than introducing a third.

Cost to watch, and it grows with the window: the snapshot is memoised per user
turn precisely so its bytes do not move mid-turn (`hooks.js:468-485`). A
countdown ("expires in 47m12s") is a figure that moves; it must be rendered
from the per-turn memo like the age already is, never re-computed per step. At
a 60-minute TTL the countdown is also long-lived enough to sit in the
orchestrator's prompt across many turns, so it is rendered coarsely — whole
minutes — rather than to the second.

### 7.9 `guardToolExecute` — `hooks.js:1398-1502`

**No change, and this is worth stating.** Classification is "has a registry
entry → subagent, else primary" (`hooks.js:1410-1416`, `:1504-1517`). A
retained entry keeps its session classified as a subagent, so if the user opens
that session in the TUI and types into it, it is still gated by the subagent
rules rather than being misread as a primary — which is what a retained session
should be. Retention costs nothing here; §5.2 covers the one thing it does
imply, that such a turn can move `ctxTokens` behind the plugin's back.

### 7.10 The TUI sidebar — `tui/src/tui.tsx:933-959`, `:663-667`, `:680-686`

The panel drops a session the moment it goes idle and files it in a set that
the poll then keeps out permanently, `tui/src/tui.tsx:663-666`:

          // Already finished and removed — keep it gone, do not re-add.
          if (finished.has(child.id)) {
            next.delete(child.id);

and `:952-955`:

        const next = new Map(subagents());
        next.delete(sessionID);
        setSubagents(next);
        finished.add(sessionID);

Change: a `retained` row status; `finished` fed by a terminal signal rather
than by idle; the `x` control on a retained row meaning "drop it now".

If unchanged, a retained session vanishes from the panel and a reuse never
brings it back — the user watches a run they cannot see, on a session they
cannot abort from the panel, and now for up to an hour rather than five
minutes. **This is where the risk is highest relative to the gain.** The
panel's entire model is "idle means gone"; it is a separate npm package with
its own duplicated state (see the parity test's own account of why,
`test/settings-defaults-parity.test.js:1-10`); and its only evidence of
correctness is an optical check of a rendered terminal. It is the last step
below for that reason, and the first thing to cut if the feature is dropped.

---

## 8. The three ways to build it

### Option A — leave the one-shot design as it is

- **Costs**: the primary requirement is not merely expensive but impossible. A
  fresh spawn cannot answer "which of the two did you mean?", because the new
  session never saw the work — the orchestrator would have to re-brief the whole
  task to get a clarification on it. The `Blocked:` path pays a full session —
  system prompt, project snapshot (`tools.js:402-403`), re-reads — to answer
  what is often one sentence.
- **Forecloses**: nothing.
- **Demands of the builder**: nothing.

### Option B — the follow-up window (recommended)

Up to 3 retained sessions per process, TTL 60 minutes, admitted by the gate of
§4: a **question** at up to 70 000 tokens, a **further related task** at up to
half the agent's budget. All of §3, §4, §5, §6 and §7 apply. The three
exclusions stand: no retention for nested children, no survival across a
handoff or an endless cycle, no plugin automatism. A bootstrap sweep bounds the
reload leak.

- **Costs**: the count split and its five consumers (§7.2), the lifecycle
  field, the watchdog switch, the retention branch, the bootstrap sweep plus a
  session-title marker, one tool, five strings, one TUI row state. Roughly
  eight files plus tests. Up to 3 leaked opencode sessions per plugin reload
  that lands in a window, self-healing at the next load if the sweep is built.
- **Forecloses**: nothing structurally — C remains reachable by raising a
  setting and relaxing the exclusions.
- **Demands**: that the builder holds the count split coherent before anything
  else lands; that the `maxAge <= 0` early return is moved rather than left
  (§3.5); and that the default stays 0 so a project that never opts in is
  byte-identical to today.

### Option C — a full reuse pool

N retained sessions surviving handoffs and reparenting, nested children
retained too, no capacity worth the name.

- **Costs**: everything in B, plus registry-aware child teardown (§7.4), warm
  sessions handed to orchestrators that never read them (§7.6), a
  cumulative-vs-per-run accounting story in every notice, and the full TUI
  rework. The reload leak scales with N.
- **Forecloses**: it makes the one-shot invariant at `state.js:15-20` false in
  general rather than by opt-in, so every future change to the lifecycle has
  to reason about warm sessions.
- **Demands**: that whoever builds it keeps the count split, the eviction
  policy and the notice-text contract coherent across `registry.js`,
  `hooks.js`, `teardown.js`, `watchdog.js`, `tools.js`, `notices.js`,
  `prompts.js` and a separate npm package — a coherence no single test pins.

---

## 9. Target state and the step order

Each step leaves the tree building and the suite green, and can be handed out
on its own.

**Step 1 — split "an entry exists" from "a run is in flight".** Add
`entry.lifecycle`, set to `"running"` by `createEntry` (`registry.js:1121`) and
by nothing else. Add the exported predicate `isActiveEntry(entry)` to
`registry.js` — not aborted **and** `lifecycle === "running"`, with a missing
field read as `running` so a hand-built entry keeps counting — and make
`countActiveSubagents` (`registry.js:237`), `activeTaskIdsFor` (`:414`),
`formatSubagentSnapshot` (`hooks.js:932`) and `listHandler` (`tools.js:766`)
call it in place of their own aborted check. The aborted check is kept inside
the predicate, not replaced by the lifecycle one: nothing sets a lifecycle
other than `running`, so a lifecycle-only test would count aborted entries as
active. Behaviour-neutral: no value other than `running` is ever set yet.
Tests: the whole suite green, plus new tests pinning that a non-`running` entry
is invisible to the cap, to `isQuiesced`, to `activeTaskIdsFor` and to both
renderings, and that an aborted entry stays excluded from all four.
*Depends on: nothing.* This is the dangerous step and it lands alone.

**Step 2 — settings, constants and the pure decision functions, still inert.**
Add `maxRetainedSubagents` (0), `retainedSubagentTtlMs` (3600000),
`maxReuseContext` (70000) and the `reuseContext` map to `settings.js:266-287`
and its file-parse block, the map parsed with the same discipline as
`agentContext` (`settings.js:303-309`). Add `DEFAULT_MAX_REUSE_CONTEXT` beside
`DEFAULT_MAX_CONTEXT` and `reuseCeilingFor(agent)` beside `contextBudgetFor`
(`settings.js:403-409`), with the three-level order of §4.6. Add
`RETAIN_TASK_SHARE` (0.5) to `registry.js`. Mirror the four new keys and the
new default into `tui/src/settings-file.ts` — `Settings`,
`SETTING_VALIDATORS`, `resolveSettings` — and extend
`test/settings-defaults-parity.test.js`, which is what keeps the two copies
honest. Add the pure `retentionDecision(entry, snapshot, settings)` (the six
conditions of §3.2) and `reuseAdmission(entry, ctx, pkg, mode, settings)`
(G1–G4 of §4.2) to `registry.js`, unit-tested in isolation — including the
table of §4.4, so the binding term per configuration is pinned rather than
inferred, and including `reuseContext[agent] = 0` meaning never-reuse and a
ceiling above the budget being inert rather than rejected. Nothing calls them.
*Depends on: step 1.*

**Step 3 — retain at idle, and reap.** Wire `retentionDecision` into the idle
critical section (`hooks.js:1110-1171`); give `teardownSubagent` the retain
short-circuit (`teardown.js:277-302`); rewrite `sweepWatchdog`
(`watchdog.js:67-109`) as the `lifecycle` switch of §3.5, moving the
`maxAge <= 0` early return into the `running` branch; add the drop-all at
handoff start and at the endless freeze. After this step retention is real and
observable with no way to use it — a session is retained, then reaped. That is
a deliberately testable intermediate state, and the test that matters most is
the pair: a retained entry survives past `maxSubagentAgeMs` (default 90 000) and
is still reaped at `retainedSubagentTtlMs`, including with
`maxSubagentAgeMs = 0`.
*Depends on: step 2.*

**Step 4 — the bootstrap sweep.** Add the fixed marker prefix to the child
session title (`tools.js:506`, `:577`), and the bootstrap pass in the plugin
factory (`index.js:77`) that lists sessions and deletes marker-titled children
idle for longer than `2 × retainedSubagentTtlMs`, gated on
`maxRetainedSubagents > 0`. §6, option B.
*Depends on: step 3. Independent of step 5 — the two can be handed out beside
each other.*

**Step 5 — the `reuse` tool.** Add it to `tools.js` beside `spawn`, with the
fresh `fetchSnapshot` of §5.2 ahead of the gate, the `mode` argument of §4.3,
the package-size wording (`tools.js:398-412`), the cap reservation
(`tools.js:491-502`) and `promptSession` against the existing id
(`client.js:96-102`); add it to `PRIMARY_TOOLS` (`hooks.js:92-96`). All
refusals of §4.7, each naming the term that failed and its number.
*Depends on: step 3.*

**Step 6 — the texts.** `completionNotice` (`notices.js:69-104`), the snapshot
prose (`hooks.js:943-950`), the `list` description (`tools.js:891-897`), the
spawn description (`tools.js:863-871`), the orchestrator guide
(`prompts.js:20`). All gated so that at `maxRetainedSubagents = 0` every string
is byte-identical to today — which `test/system-prompt-stability.test.js`
checks.
*Depends on: step 5.*

**Step 7 — the TUI settings surface.** `effectiveReuseContext` and
`stepReuseContext` beside their `agentContext` counterparts in
`tui/src/settings-file.ts`, `maxRetainedSubagents` and `retainedSubagentTtlMs`
joining `LimitKey`, and the rows that edit them in the panel — the per-type
ceiling with the same own-versus-inherited marker the budget row carries, the
TTL stepped in whole minutes. §4.6. Lower risk than step 8 because every
mechanism it uses already exists for the context budget; it is separated from
step 8 for exactly that reason. Another run is editing this surface, so the row
layout is taken from whatever that leaves behind rather than from this concept.
*Depends on: step 2 for the keys, step 6 for the wording it displays.*

**Step 8 — the TUI sidebar row.** `tui/src/tui.tsx` keeps a retained session in
the panel with its own status and a coarse countdown; `x` drops it. Verified
optically on a rendered terminal, per the project's own rule. This is the last
and most fragile step (§7.10).
*Depends on: step 7.*

**Step 9 — `README.md` (the one-shot statements at `README.md:20`, `:185`,
`:655`) and `learnings.md`.**
*Depends on: step 8.*

---

## 10. Assumptions

Each with what would have to hold, and what would show it wrong.

1. **A second `promptSession` against a retained child starts a normal turn and
   emits `session.idle` at its end, exactly as the first did.** Holds if
   opencode treats a second input on an idle child no differently from the
   first; the research finding establishes the endpoint and the history
   retention (`work/researcher-opencode-session-lifetime.md` §2) but not the
   event behaviour of a *second* turn on a child. Shown wrong by: no
   `session.idle` after a reuse — under this design the run then hangs until
   the inactivity watchdog reaps it, because a reused entry is `running` again,
   so the failure is contained but visible as a timeout notice.
2. **A session idle for an hour is re-promptable with no degradation beyond a
   lost prompt cache.** Holds because opencode replays history from durable
   rows and the provider keeps no session state (§5.1). Shown wrong by: a
   provider or opencode error on the first reuse after a long gap, or a
   `session.compacted` event firing on the reuse turn — the latter would mean
   the replayed request is large enough to trip compaction and would argue for
   lowering `RETAIN_MAX_CTX_TOKENS` rather than shortening the window.
3. **The agent binding survives, or `promptSession`'s `body.agent`
   (`client.js:100`) re-establishes it.** Shown wrong by: run 2 behaving as a
   different role, or `entry.agent` disagreeing with what the tool guard sees.
4. **The system transform runs again for run 2**, so the plugin's role prompt,
   budget notice and STOP machinery apply. The transform is per message, not
   per session (`hooks.js:508-556`), which supports it; it is not verified for
   a second turn of a child session. Shown wrong by: a reused run passing its
   budget with no STOP injection.
5. **The `ctxTokens` fetched at reuse time is the figure the budget guard will
   see on run 2's first transform.** Both read `latestContextTokens` off the
   same message list (`client.js:298-310`), and the reuse writes the value onto
   the entry. Shown wrong by: a run 2 that is STOP-injected on its first turn
   despite having passed G3.
6. **This plugin never issues a DELETE against a primary**, so a retained child
   is never cascaded away mid-life. Read from `handoff.js:318` (archive, not
   delete) and `client.js:178-189`. Shown wrong by: any future path calling
   `deleteSession` on a primary session id.
7. **70 000 is below the context window of every model an agent runs on**, so a
   session admitted just under the ceiling can still absorb a question and its
   answer. This is given by the user, not derived, and the plugin does not check
   it. Shown wrong by: a provider window error on a reuse admitted near the
   ceiling — which is precisely the observation that would force the
   `limit.context` route of §4.1 (`types.gen.d.ts:1323-1326` via
   `client.config.providers()`) into the gate as a fourth term.
8. **The orchestrator distinguishes question from task honestly when it sets
   `mode`.** Shown wrong by: task-shaped prompts sent as `mode:"question"`
   piling up `budgetDenials` on reused entries. Not a defect to fix in the tool
   — the STOP guard is the backstop, by design (§4.3).
9. **Both halves keep reading one settings file.** The plugin reads
   `~/.config/opencode/agent-intercom.json` (`settings.js:171`) and the TUI
   writes the same path (`tui/src/settings-file.ts` via
   `json-object-file.ts`); the per-type reuse ceiling has one home because of
   that. Shown wrong by: a TUI edit that the plugin does not pick up after its
   settings cache expires, or a divergence caught by
   `test/settings-defaults-parity.test.js`.
10. **The orchestrator model will actually reach for `reuse` when the question
   strikes it later.** Not decidable from the source, and it is the whole
   premise. Shown wrong by: a session's worth of real work in which a
   clarification is wanted and a fresh spawn is used instead. This is the drop
   criterion, not a defect to fix.

---

## 11. Recommendation

**Build option B — the follow-up window — with the feature off by default, and
recommend against option C.**

The reasoning, in the order it carries:

- The requirement cannot be met any other way. A fresh spawn is not a
  substitute for a follow-up question: the new session never saw the work the
  question is about, so answering it means re-briefing the whole task. Option A
  does not make the primary case expensive, it makes it impossible.
- The capability is real and cheap on the opencode side. Re-prompting a session
  by id is supported and keeps history, the plugin's own `promptSession`
  already has the shape (`client.js:96-102`), and a session idle for an hour is
  exactly as promptable as one idle for a second — no TTL, no GC, durable rows
  (§5.1). The plugin only has to stop deleting.
- The 70 000 ceiling is what makes the long window affordable. Against a
  100 000-token budget it binds in the normal case (§4.4), so what is held for
  an hour is always a session small enough to be replayed cheaply and to have
  room for the answer. The task case keeps its own, stricter line at half the
  budget, because a task needs room to work and a question does not.
- That ceiling is per agent type and editable from the TUI, through the
  mechanism the context budget already uses and the one file both halves share
  (§4.6). `0` on a type means that type is never reused, which needs no branch
  in the gate — G1 already refuses a non-positive context — and a ceiling set
  above a type's budget is left as written, because G3 makes it inert and a
  cross-key validator would delete a number the user typed on account of a
  different one.
- But the change is not local. "A registry entry exists" currently *means* "a
  run is in flight", and five consumers depend on that meaning, one of which
  has a default of 1 (`settings.js:74`). Retention without the count split does
  not degrade — it deadlocks, and at a 60-minute TTL it deadlocks for an hour,
  long enough for the endless cycle's own 600 s timeout to expire inside it.
  That is why the split is step 1, lands alone, and is not negotiable.
- The inactivity watchdog is the second thing that must be got right rather
  than got working. Today a retained entry would survive by accident, through a
  guard whose comment describes a different purpose; and the disabled-watchdog
  early return would silently switch off the retention reap. Both are one-line
  edits and both are the difference between a 60-minute window and a 90-second
  one (§3.5).
- The new durable cost is a session leak that nothing will ever clean up, and
  the requirement multiplies its exposure twelvefold. The bootstrap sweep
  (§6, option B) is the price of the longer window; without it the honest TTL is
  45 minutes rather than 60, which still meets the requirement. Either answer is
  defensible; leaving the question unanswered is not.
- Option C is refused because it makes the one-shot invariant false in general
  rather than by opt-in, and because the exclusions it drops each remove a whole
  class of hazard for no practical loss: **no retention for nested children**
  (§7.4 — the child-first sweep cannot see them), **no survival across a handoff
  or an endless cycle** (§7.6 — a warm session handed to an orchestrator that
  never read it is worth less than a fresh spawn), and **no plugin automatism**
  (§4.7 — the orchestrator's prompt is written for a fresh context).
- If, after the feature is available, the orchestrator does not reach for
  `reuse` when a question strikes it, the right move is to delete it rather than
  grow it into C. Steps 7 and 6 are the cheapest to reverse; step 1 is worth
  keeping either way, because "the registry is the active set" is an implicit
  coupling that is better made explicit whatever happens to retention.
