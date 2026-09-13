# Concept: a run ceiling over one subagent — bounding the subagent that polls

Scope: the one opencode plugin process — its server half (`src/`, `test/`) and
its TUI half (`tui/src/`), plus one new driver under `test/e2e/`. No boundary
moves; every part named here already exists in this repository. opencode itself
is outside the boundary and is treated as given: what it publishes, and when.

Evidence base: `src/`, `tui/src/` and `test/e2e/` as they stand at HEAD. Every
finding below carries the line it was read from.

Fixed by the session, not derived here: a subagent that polls is never reaped by
either watchdog window, and the observed run — a subagent polling for a file in
repeated `bash` waits — ran on unreaped and held its primary's quiesce open
until the whole run was killed.

---

## 1. What the code says today

**The wide window is a ceiling over one CALL, and the sweep re-derives it from
whatever call is in flight right now.** `src/watchdog.js:172`:

```js
      const last = limit.since ?? entry.lastActivityAt ?? entry.spawnedAt
```

and `since` comes from `watchdogLimit` (`src/watchdog.js:338-349`), which reads
the oldest call *currently* in flight:

```js
  const oldest = oldestToolCall(entry)
  if (oldest) {
    return { ms: toolCallMs, setting: "maxSubagentToolCallMs", kind: "tool-call",
             tool: oldest.tool, since: oldest.startedAt }
```

The map that feeds it is emptied on every `tool.execute.after`
(`recordToolCallFinished`, `src/hooks.js:2909-2916`) and refilled on the next
`tool.execute.before` (`src/hooks.js:2634-2636`). So `since` moves forward with
every call the subagent starts. A subagent making back-to-back short calls
therefore restarts its own ceiling at every call, and no finite
`maxSubagentToolCallMs` ever expires against it.

**The silence window cannot catch it either.** Two bumps make sure of that:
every event for a tracked session bumps the stamp
(`src/hooks.js:1719`, `if (e) e.lastActivityAt = Date.now()`), and the start of
every tool call bumps it again (`src/hooks.js:2635`). A polling subagent is
never silent for 90 s — it is emitting parts the whole time.

**The doctrine the code states for itself is exactly what is broken.**
`src/watchdog.js:318-320`:

```
// `since` is what makes the wide window a ceiling rather than a renewable
// lease.
```

It is a ceiling *within* one call and a renewable lease *across* calls. The
comment's own reason for taking the oldest call rather than the newest
(`src/registry.js:277-278`, "a ceiling counted from the newest call would be
pushed out by every further call the subagent starts, i.e. never fire") is the
same failure one level up: the entry has no clock that a further call cannot
push out.

**The defect was already written down once, in the module next door.**
`src/childwait.js:89-92`:

```
// A child's legal lifetime is not one window, though: each tool call and each
// event restarts the clock the window is measured against, so consecutive long
// calls can carry a healthy child past any fixed multiple. The number alone
// therefore cannot separate "stuck" from "slow", and the timer does not try to:
```

The child-waiter answered it by re-arming instead of expiring
(`src/childwait.js:214-222`) — which means a parent blocked on a polling child
re-arms forever too, because the re-arm's condition is "the child is still a
tracked entry", and a polling child is a tracked entry for the life of the
process. The unboundedness is therefore not one entry's: it propagates to the
parent's `spawn` tool call.

**What the unbounded entry costs while it stands:** one of `maxSubagents`
concurrency slots (`isActiveEntry`, `LIFECYCLE_RUNNING`, `src/registry.js:2084`),
the primary's quiesce in an endless cycle — bounded there, but only by
abandoning the cycle (`src/endless.js:457`,
`return abandon("quiesce", \`still busy after ${quiesceTimeoutMs}ms\`)`) — and,
in the nested case, the parent's blocked tool call.

**What the sweep already has to hang a third window on.** The descriptor
discipline: `watchdogLimit` returns `{ ms, setting, kind, tool?, since? }` and
the descriptor travels into the log, the wake notice and the nested outcome
(`src/watchdog.js:326-329`, `timeoutSubagent` at `:370-497`). A third kind costs
no new plumbing. The reap path already rescues what the run produced before
deleting the session (`secureSubagentState`, `src/watchdog.js:447-455`).

**What a per-run stamp cannot be taken from.** `spawnedAt` is set once
(`src/registry.js:2085`) and is deliberately not moved by a reuse
(`src/registry.js:688`, "What deliberately does NOT move: `spawnedAt`, so the
age column keeps telling the truth about how long the session has existed").

**The runtime notice channel a gentler step would use.** `contextLimitNotice`
(`src/hooks.js:1060`) is called per LLM turn from the message transform
(`src/hooks.js:878`) and its block is appended as a carrier message at the end
of the per-request array (`tailNoticeCarrier`, `src/hooks.js:797`, used at
`:893`). Its three bands split at `CTX_NEAR_BUDGET = 0.7` and
`CTX_STOP_RESERVE = 0.9` (`src/hooks.js:326`, `:337`). None of that text is in
the prompt contract fixture — `grep -c "PLAN YOUR HANDOVER\|WRAP UP NOW"
test/fixtures/prompt-contract.json` answers `0` — so a new runtime band needs no
`npm run pin:contract`.

**The numbers already in the tree.** `DEFAULT_MAX_SUBAGENT_AGE_MS = 90000`
(`src/settings.js:152`), `DEFAULT_MAX_SUBAGENT_TOOL_CALL_MS = 660000`
(`src/settings.js:167`, chosen as opencode's 600 000 ms bash ceiling plus a
minute), `CHILD_WAITER_TIMEOUT_FACTOR = 4` (`src/childwait.js:97`),
`ORPHAN_SWEEP_WATCHDOG_FACTOR = 8` (`src/teardown.js:798`),
`MAX_SUBAGENT_COMPACTIONS = 3` (`src/compaction.js:81`),
`DEFAULT_ENDLESS_QUIESCE_TIMEOUT_MS = 600000` (`src/settings.js:302`).

---

## 2. Working or spinning — what the plugin can actually observe

The plugin sees, per subagent: every opencode event for the session
(`src/hooks.js:1716-1721`), the start and end of every tool call with its tool
name (`src/hooks.js:2636`, `:2913`), the session's token count behind a 3 s
cache (`CTX_TTL_MS`, `src/registry.js:1487`; read in `contextLimitNotice`), the
last-activity phrase from the snapshot, and its own bookkeeping (runs, nested
spawns, messages, asks).

From that, four candidate signals and what each is worth:

| signal | what it proves | where it fails |
| --- | --- | --- |
| a call is in flight and old | the subagent is *inside* something | already covered by `maxSubagentToolCallMs` |
| no event at all | the session is dead or hung | already covered by `maxSubagentAgeMs`; a poller is never silent |
| token growth per minute | the session is accumulating *something* | a poll loop grows too, just slowly; a thinking-heavy step grows fast and is healthy. No threshold separates them |
| the same tool with the same arguments, N times in a row, nothing else between | no new instruction has reached the tool layer | a legitimate `npm test` loop between edits repeats identically; a poller that varies its command (`sleep 20`, `sleep 25`) escapes it entirely |

**The honest statement: the plugin cannot tell work from spin.** The only thing
it can see is *what the subagent did*, never *whether it got anywhere*. A
subagent waiting in a loop for a file that a build will write in four minutes
and one waiting for a file nobody will ever write emit byte-identical event
streams. The distinction is not weakly observable; it is not observable at all,
and every mechanism that claims it is is a heuristic with false positives on
both sides.

What *is* decidable is the question the watchdog has always asked: **has this
entry a finite bound that nothing it does can renew?** Today the answer is no,
and that is the defect — not "we cannot detect polling".

One consequence for the shape: since the plugin cannot judge, it must not
punish. The mechanism has to be a *ceiling* (a statement about resources the
orchestrator budgeted), and the ceiling has to be announced to the subagent
before it fires, so that the one party that does know whether the wait is
productive — the model, and behind it the orchestrator — can act on it.

A second consequence, about the "uninterrupted stretch" the briefing asks about:
**there is no observable end of a stretch.** The gaps between calls are model
generation time, and generation emits events, so the gap is not silence
(`src/hooks.js:1719`). Any gap that *is* silence longer than `maxSubagentAgeMs`
is already fatal under the existing window. So a cumulative in-tool ceiling
"over one uninterrupted run of tool calls", followed through, has no boundary
short of the run itself — it *is* a run ceiling, and pretending otherwise would
only add a gap threshold no event justifies.

---

## 3. The shapes

### A — cumulative in-flight time, summed over the run

Accumulate `now - startedAt` into `entry.toolMsTotal` on every
`recordToolCallFinished` and reap past a total.

Costs: it bounds the wrong quantity. A poller whose waiting happens inside
`bash sleep` accumulates fast; one whose waiting happens in generation (re-reading
its own history, re-planning) accumulates almost nothing and stays unbounded, so
the defect survives in half its forms. The figure is also unexplainable in a
sidebar row — "the subagent has run 40 minutes but only 9 of them counted".
Forecloses nothing, demands a new accumulator on a hot path.

### B — a per-run wall-clock ceiling (`maxSubagentRunMs`)

One stamp per run, one comparison in the sweep, one descriptor kind. Bounds
every shape of run: polling, thinking, one endless call, a mixture.

Costs: it is blind. Legitimate long work is cut at exactly the same number as a
spin, so the number has to be generous and the firing has to be preceded by a
warning and followed by a state rescue — both of which the plugin already has
paths for. Demands: one setting, one stamp, one band text, one sidebar row.
Forecloses nothing — it composes with a later heuristic rather than blocking it.

### C — a repetition detector

Hash tool name + arguments per call; count consecutive identical calls with
nothing else between; reap or deny past N.

Costs: it claims the judgement §2 says cannot be made. False positive on the
legitimate `build → test → build` loop, false negative on any poller whose
command varies by one digit, and it invites evasion by the very agent it is
aimed at. It needs argument material in registry state and in logs, which is a
new class of content in `src/log.js` output. Demands the most and delivers a
bound that an adversarial-by-accident model walks around.
Forecloses: nothing technically, but shipping it as *the* reap criterion would
make the honest bound (B) look redundant and it would not get built.

### D — nothing new; lean on the existing reliefs

The subagent's context budget locks its tools down eventually
(`contextLimitNotice` lockdown), and the endless cycle abandons at its quiesce
timeout (`src/endless.js:457`).

Costs: the lockdown arrives only when tokens accumulate, and a poll loop whose
every result is "no such file" adds tens of tokens per turn — hours at a 100 000
budget. The quiesce abandon protects the *cycle*, not the slot or the parent's
blocked call, and it does so by giving up work. This is the state that was
observed failing. Rejected.

### Recommendation

**B, with the ladder from §5, and C explicitly deferred** (§11 names the
observation that would justify building it).

B wins because it is the only one of the four that restores the invariant the
watchdog is built on — every entry has a finite bound nothing it does can renew
— without claiming a judgement the plugin cannot make. A is B with a worse
denominator. C is a heuristic dressed as a bound. D is the status quo.

---

## 4. The value: where it comes from and what it is

### The setting

A new flat key, an env override, and a per-type map — the shape
`maxResultTokens` / `resultTokens` and `compaction` / `agentCompaction` already
have (`src/settings.js:790-818`):

| | |
| --- | --- |
| flat key | `maxSubagentRunMs` in `~/.config/opencode/agent-intercom.json` |
| env | `OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_RUN_MS` |
| per type | `agentRunMs: { "<agent>": N }` |
| resolver | `runCeilingFor(agent)` — own entry, else flat key, else env, else default |
| `0` | no run ceiling for that type |
| read | live on every sweep tick, like the other two windows; no latch, no restart |

**Why a new setting and not a derivation from the existing two.** A derived
value (`k × maxSubagentToolCallMs`) ties a *lifetime* to a *per-call* number,
and the two have opposite reasons to move: a user raises the per-call window to
admit one long build, and would silently get `k` times the lifetime with it.
`0` also has to mean different things on the two keys — it already does on the
existing pair (`src/settings.js:152-168`) — and a derived value cannot be
switched off on its own. The whole defect is that the existing numbers cannot
express a lifetime; expressing it as a multiple of one of them repeats the
confusion.

**Why a per-type map as well as a flat key.** The plausible legitimate lifetime
is a property of the role, not of the process: a `researcher` that is still
running after half an hour is a different fact from a `coder` that is. The map
costs one `Object.hasOwn` in the resolver and nothing else, and every other
per-type ceiling in this plugin already has one.

### The default

`DEFAULT_MAX_SUBAGENT_RUN_MS = 2_640_000` (44 minutes).

The derivation, not a round guess:

- **Floor.** The ceiling must clear the widest stretch the rest of the plugin
  already calls healthy. One maximal opencode `bash` call is 600 000 ms and the
  working window clears it at 660 000 ms (`src/settings.js:167`). A run of four
  such calls in a row — a fetch, a build, a test suite, a second build — is
  ordinary work, not a pathology.
- **The project's own figure for "how long may a healthy subagent plausibly
  live".** It already exists: `CHILD_WAITER_TIMEOUT_FACTOR = 4` over the wider
  window (`src/childwait.js:97` and its comment at `:83-87`, "4x — 44 minutes at
  the 660 s default … longer than any single window the watchdog would let a
  child live under, and shorter than a session the user has given up on").
  4 × 660 000 = 2 640 000.
- **Why coinciding with that figure is right and not merely convenient.** The
  child-waiter's ceiling is the moment the *parent* stops believing in the
  child. Setting the child's own run ceiling to the same number makes the two
  agree by construction: the child is reaped at about the moment the parent's
  rescue would fire, and the reap settles the waiter with a real outcome instead
  of the re-arm loop that runs forever today (`src/childwait.js:214-222`).
- **Ceiling on the ceiling.** It must stay under the orphan sweep's age bound,
  or a live subagent would fall into another instance's kill range: that bound
  is `8 × max(90 000, 660 000) = 5 280 000` (`src/teardown.js:798`, `:906-909`).
  2 640 000 is half of it. Note the direction: a run ceiling only ever makes
  lives *shorter*, so the sweep's premise ("nothing alive is ever this old") is
  strengthened, never weakened, and `sweepOrphanedSubagentSessions` needs no
  change.
- **What it is deliberately not anchored on.** `endlessQuiesceTimeoutMs`
  (600 000, `src/settings.js:302`). A run ceiling short enough to protect a
  cycle's quiesce would have to be under 10 minutes, which is barely one maximal
  `bash` call, and the cycle is already bounded — it abandons rather than hangs
  (`src/endless.js:457`).

The number is a judgement, and it is a wide one on purpose: it is a backstop
against unboundedness, not a schedule. Whoever wants a schedule sets
`agentRunMs` per role.

---

## 5. What happens when it fires

Three steps, of which only the last is a reap.

### Step 1 — the wrap-up band, at `RUN_WRAP_UP = 0.75` of the ceiling

A new band out of the same per-turn path as the context bands
(`contextLimitNotice`, `src/hooks.js:1060`, carried by `tailNoticeCarrier` at
`:893`). Nothing is denied, nothing is refused, no tool is touched. The block
says: how long this run has been going, how long is left before the run ceiling
cuts it off, and the two moves the subagent actually has —

1. hand back now with a `Blocked:` line naming *what it is waiting for*, so the
   orchestrator can re-dispatch it (or `reuse` the held session) once that thing
   exists;
2. `ask(...)` the caller whether to keep waiting, where one answer decides it.

Counted in `entry.runWarnings` for the log, alongside `contextPlanNotices` /
`contextWarnings` / `stopInjections` (`src/registry.js:2119-2131`). Re-fires on
every crossing turn, like the context bands, since the block rides on the
per-request copy of the message array.

**Why 0.75.** At the default it leaves 660 000 ms — exactly one working window —
for the handover, which is the same guarantee the reserve band gives on the
context axis (room to write while the tools still work). The guarantee is a
property of the default, not of the constant: a user who raises
`maxSubagentToolCallMs` past a quarter of the run ceiling loses it, and the
sidebar note line says so (§7).

**Why a warning and not a denial.** §2: the plugin cannot judge. A denial band
on a clock would put a healthy long run into lockdown for the crime of taking
time, and the lockdown's justification on the context axis — the tokens really
are gone — has no analogue here. Time is not a resource the reply consumes.

### Step 2 — nothing

Deliberately no third band between 0.75 and the ceiling. Two escalating texts
are what the context axis needed because there the tools *change* under the
subagent; here nothing changes until the end, and a second nag buys the
orchestrator nothing it did not get at 0.75.

### Step 3 — the reap, at the ceiling

The existing path, unchanged: `timeoutSubagent` (`src/watchdog.js:370`) — settle
any open `ask`, cooperative abort, one last read, `secureSubagentState` to a
result file under the subagent's own `work/`, wake notice, teardown, slot freed.
The only new thing is the descriptor:

```js
  { ms: runMs, setting: "maxSubagentRunMs", kind: "run", since: entry.runStartedAt }
```

so the log line, the wake notice (`timeoutNotice`, `src/notices.js:417`) and the
nested outcome all name the window that fired and its value — the rule
`src/watchdog.js:326-329` already states.

The wake notice's wording is what makes the reap useful rather than merely
tidy: it must say that the subagent was cut off **on its run ceiling**, not that
it went silent, because the orchestrator's next move differs. The detail line
becomes `ran for N ms (maxSubagentRunMs M ms)` in place of the `no sign of
life for …` phrasing, which is false on this path.

---

## 6. Interactions to settle

| with | rule | reason |
| --- | --- | --- |
| `maxSubagentAgeMs = 0` | the run ceiling does not fire either | the run check lives inside the running branch, after `if (maxAge <= 0) continue` (`src/watchdog.js:131`). A user who took out the dead-man's switch has asked for runs no clock cuts off — the doctrine `src/childwait.js:99-105` states |
| a tool call in flight | no exemption: the run ceiling fires over it | an exemption bounded by the subagent's own behaviour is the defect being fixed. The rescue read happens after the abort, so a cut call still hands its session's text over |
| a compaction in flight (`entry.compactingSince`) | the reap is deferred while `now - compactingSince <= workingWindowMs(settings)` | reaping inside the relief the plugin itself started throws work away for nothing. Bounded: at most `MAX_SUBAGENT_COMPACTIONS = 3` compactions, each capped by the working window |
| blocked on a live watchdogged child | the child-wait exemption keeps precedence over the run check | the alternative — checking the run ceiling first — reaps a parent that is waiting on a legitimately working child and cascades a DELETE over that child (`src/watchdog.js:140-147`), destroying work to enforce a clock. With the exemption first, the parent is still bounded by composition: every child now has its own run ceiling, and the nested quota is not refilled by a reuse (`src/registry.js:689`), so a nesting parent lives at most `(1 + maxNestedSpawns) × ceiling` |
| the child-waiter's re-arm | no change needed | the re-arm's condition is "the child is still a tracked entry"; the run ceiling is what finally makes that condition false, which turns today's endless re-arm into a terminating one |
| `reuse` | the clock is per RUN: a new field `entry.runStartedAt`, seeded in `createEntry` and re-seeded in `reviveRetainedEntryLocked`, carried in `previous` for `restoreRetainedEntryLocked` | `spawnedAt` deliberately does not move (`src/registry.js:688`) and a reuse is a new task, exactly as `lastActivityAt`, `toolCalls` and the mid-run counters are reset there (`src/registry.js:670-683`) |
| `ask` / `answerWaitMs` | `askWaitMs` (`src/agentmsg.js:80`) clamps against `min(workingWindowMs, remaining run budget − one sweep tick)` | "a clamp measured against a different window than the one that fires is not a clamp" (`src/settings.js:826-831`). Without this the plugin offers a five-minute wait it will itself cut off, on the very path step 1 points the subagent at |
| the orphan sweep | unchanged | the run ceiling only shortens lives; `ORPHAN_SWEEP_WATCHDOG_FACTOR × max(windows)` stays an upper bound over everything alive |
| solo mode | not registered, nothing to bound | no subagent exists |
| `list` | the running row gains nothing | the age column already shows the run's wall clock (`src/tools.js:364`), and it is now the figure the ceiling is measured against for a first run |

---

## 7. The sidebar

A third row in the Subagents block, directly under `in tool (min)`
(`tui/src/tui.tsx:2381-2412`):

```
run (min)      [-]  44  [+]
```

Stepped in whole minutes by the same `holdRepeat` pair and the same
`SUBAGENT_TOOL_CALL_STEP_MS` unit (60 000), `0` rendered as `off`, value rounded
up so a sub-minute setting never reads as `off`. Live, no restart note: the
sweep reads the settings file on every tick.

One note line under the row, in the register of the compaction row's note
(`tui/src/compaction-row.ts`), rendering only what cannot take effect:

- `shorter than the in-tool window — one long call is cut off` when
  `0 < maxSubagentRunMs <= maxSubagentToolCallMs`;
- `no room left for a handover` when
  `maxSubagentRunMs × 0.25 < maxSubagentToolCallMs` and the row is not off;
- `the inactivity watchdog is off — no run ceiling either` when
  `maxSubagentAgeMs === 0`.

`DEFAULTS` in `tui/src/settings-file.ts` carries the new key, which
`test/settings-defaults-parity.test.js` then pins against `src/settings.js`.

---

## 8. Modules touched

| file | change |
| --- | --- |
| `src/settings.js` | `DEFAULT_MAX_SUBAGENT_RUN_MS`, the env + file read with the `Number.isInteger && >= 0` discipline, `agentRunMs` map read like `resultTokens`, `runCeilingFor(agent)`, `runWrapUpAt(agent)` helper |
| `src/registry.js` | `entry.runStartedAt` in `createEntry`; re-seed + `previous` in `reviveRetainedEntryLocked` / `restoreRetainedEntryLocked`; `entry.runWarnings` counter |
| `src/watchdog.js` | the run check in the running branch after the child-wait exemption and the compaction deferral; the `"run"` descriptor |
| `src/notices.js` | `timeoutNotice` wording for `kind === "run"` |
| `src/prompts.js` | the wrap-up band text |
| `src/hooks.js` | the band's crossing check beside `contextLimitNotice` in the transform |
| `src/agentmsg.js` | the `askWaitMs` clamp against the remaining run budget |
| `tui/src/settings-file.ts`, `tui/src/tui.tsx` | the row, the step, the note line, `DEFAULTS` |
| `test/`, `test/e2e/` | unit tests per step, `run-ceiling-task.sh`, `run-all.sh` wiring |

---

## 9. How it is proven

### Unit (`node --test`, per step)

- `watchdogLimit` answers `kind: "run"` for an entry past its ceiling with
  nothing in flight, and still `"tool-call"` for one inside a call that has not
  reached the run ceiling.
- The sweep reaps an entry whose `runStartedAt` is past the ceiling although
  `lastActivityAt` is now and a fresh call is in flight — the regression, in one
  test.
- The sweep does *not* reap it while `compactingSince` is inside the working
  window, and does *not* reap a parent exempted by
  `isWaitingOnWatchdoggedChild`.
- `runCeilingFor`: own entry > flat > env > default; `0` is a real value.
- `reviveRetainedEntryLocked` re-seeds `runStartedAt` and restores it.
- `askWaitMs` never exceeds the remaining run budget.
- Defaults parity between `src/settings.js` and `tui/src/settings-file.ts`.

### End to end: `test/e2e/run-ceiling-task.sh`

Its own isolated configuration and its own server on `RUN_CEILING_PORT`
(default 4612), like `ask-expiry-task.sh` and `context-bands-task.sh`, because
it needs settings of its own in the `agent-intercom.json` the server was started
with (`test/e2e/run-all.sh:39-46`). Request logging on through
`OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1` +
`OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE` (`src/reqlog.js:9-11`,
`test/e2e/context-bands-task.sh:432`), which is how an injected band is asserted
— it never reaches the session.

**Phase 1 — the poller (settings: `maxSubagentRunMs` 240 000,
`maxSubagentToolCallMs` 600 000, `maxSubagentAgeMs` 90 000).** The subagent is
told to wait for a file that is never created, checking with short `bash` calls.
Asserted:

- `neither-old` — from the subagent's own session parts: the longest single tool
  call is under `maxSubagentToolCallMs` and the longest gap between calls is
  under `maxSubagentAgeMs`, so neither existing window could have fired. This is
  the pin on the defect, and it is computed from opencode's own
  `state.time.start/end`, not from anything the plugin reports;
- `warned` — the wrap-up band appears in the request log on a turn at or after
  0.75 of the ceiling, and the tool call of that same turn still executed
  (nothing denied);
- `reaped` — the primary's transcript carries the timeout wake notice naming
  `maxSubagentRunMs` and the elapsed figure; plugin text, not model text;
- `rescued` — that notice carries what the subagent had produced, and a result
  file exists under the project's `work/`;
- `slot` — a `list` afterwards shows no running subagent;
- `model-pin` — every captured turn answered on `E2E_MODEL`, the suite's
  standing criterion.

**Phase 2 — the control, legitimate long work is not cut (same server,
`maxSubagentRunMs` 240 000).** One subagent, one `bash` call that sleeps 120 s —
well past the silence window, well inside the run ceiling. Asserted: it finishes
normally, no timeout notice reaches the primary, and no wrap-up band appears in
the request log. Without this phase the driver would pass on a plugin that reaps
everything.

**Phase 3 — the ladder ends without a kill.** `maxSubagentRunMs` 240 000 again,
the poller task again, but the subagent is a role that reads the band. Asserted:
its final reply begins `Blocked:` and names what it was waiting for, and the
reap never fired. If the model ignores the band the phase records
`NOT ASSERTED` rather than failing — the pattern `between-steps-task.sh` uses
for a criterion that depends on the model's cooperation (`test/e2e/between-steps-task.sh:44-56`).

Wired into `run-all.sh` in the group of self-hosting drivers that start and stop
their own server, after `context-bands-task.sh`.

---

## 10. Steps, in order

Each step leaves the tree building (`npm run check`) and the unit suite green
(`npm test`), and each can be handed out on its own.

1. **Settings.** `DEFAULT_MAX_SUBAGENT_RUN_MS`, env + file read, `agentRunMs`,
   `runCeilingFor`. No behaviour change; tests for the resolver and the parity
   test. *Depends on: nothing.*
2. **The per-run stamp.** `entry.runStartedAt` + `entry.runWarnings` in
   `createEntry`, `reviveRetainedEntryLocked`, `restoreRetainedEntryLocked`.
   Still no behaviour change. *Depends on: nothing (parallel to 1).*
3. **The reap.** The `"run"` descriptor in `watchdogLimit`, the sweep ordering
   (after the child-wait exemption, with the compaction deferral), the notice
   wording. This is the step that closes the defect. *Depends on: 1, 2.*
4. **The wrap-up band.** The text in `src/prompts.js`, the crossing in the
   transform, `runWarnings`. *Depends on: 1, 2 — and it is worth having after 3
   rather than before, so the reap is never shipped without its warning being
   the next commit.*
5. **The `ask` clamp.** `askWaitMs` against the remaining run budget.
   *Depends on: 1, 2.*
6. **The sidebar row + note line + `DEFAULTS`.** *Depends on: 1.*
7. **`test/e2e/run-ceiling-task.sh` + `run-all.sh` wiring.** *Depends on: 3, 4,
   6 — phase 2 needs the band, and the suite's model audit needs the row's key
   in the isolated config.*
8. **Documentation.** `specs/subagent-run-ceiling.md` as the current-design
   file, the `README.md` sentence, and the `CLAUDE.md` paragraph (owned by the
   mainagent, not by this concept).

---

## 11. Assumptions

| assumed | what must hold | what would show it wrong |
| --- | --- | --- |
| opencode publishes nothing between a tool call's announcement and its result, so the plugin's in-flight map is its only knowledge of "working" | stated by the code itself (`src/registry.js:246-252`) and relied on by the existing window | an opencode version that emits a progress event during a call; the silence window would then start firing on healthy calls and this whole area needs re-reading |
| a polling subagent's inter-call gaps stay under `maxSubagentAgeMs` | observed in the live case; generation emits events (`src/hooks.js:1719`) | a poller that is reaped by the silence window after all — then the defect is narrower than described and the run ceiling is only the backstop |
| 44 minutes is longer than the legitimate runs this project gives subagents | the roles' work is bounded by their context budgets long before that on any token-producing path | a `coder` or `deployer` run that is cut at 44 minutes while genuinely working; the fix is `agentRunMs` for that role, and a repeated occurrence is the signal that the default is wrong |
| the run-ceiling band is worth a turn's tokens | the same judgement the three context bands already embody | a measurable share of runs ending because the band pushed a subagent into a premature `Blocked:` — visible as `runWarnings > 0` on runs that then reported nothing useful |
| the repetition detector (option C) is not needed | the run ceiling plus the band bound the damage of a spin to one ceiling per run | spins that recur across re-dispatches — the orchestrator re-spawning a poller that is reaped, three or four times over. That pattern is what would justify C, and it is visible in the `maxSubagentRunMs` reap count per session |

---

## 12. Left open

- **Whether the ceiling should also cover the primary.** The primary has no
  entry, no watchdog and its own reliefs (handoff, endless, compaction). A
  primary that polls is a different failure with a different owner, and it is
  not designed here.
- **Whether `runCeilingFor` should get a built-in per-type table** the way
  `contextBudgetFor` has `DEFAULT_AGENT_CONTEXT` (`src/settings.js:123`). One
  flat default is proposed because no per-role evidence exists yet; the table is
  the natural second version once reap counts per role have been seen.
