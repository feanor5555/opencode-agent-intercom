# Nested delegation — a subagent may spawn a researcher of its own

A subagent of the right role may delegate one piece of its task to a `researcher`. The
call blocks, the child's reply becomes the tool result, and the subagent run carries
what the delegation cost against the parent's own quota.

The mechanism that makes this safe — the wait state, the lifecycle exemption, the
quota counter — is built and tested. The depth bound is structural: the only legal
target is the one role that is itself `spawn: deny`, so a nested child cannot have
children. Boundary: the plugin at `~/opencode-agent-intercom/src/`. The TUI is
out of scope; this is a server-side feature.

---

## 1. Who may spawn, and who may not

Every subagent carries `SUBAGENT_NO_DELEGATION = { task: "deny", abort: "deny", list: "deny" }`
(`src/agents.js:131-133`). The `spawn` entry is the only one that varies per role:

- `NO_SPAWN = { spawn: "deny" }` (`src/agents.js:147-149`) is added to `researcher`
  (`src/agents.js:236-243`), `designer` (`src/agents.js:251-255`) and `gitter`
  (`src/agents.js:257-263`).
- The five reading-roles — `planner` (`src/agents.js:200-208`), `coder`
  (`src/agents.js:210-215`), `debugger` (`src/agents.js:217-223`), `reviewer`
  (`src/agents.js:225-231`) and `documenter` (`src/agents.js:233-238`) — do NOT carry
  `NO_SPAWN`. Their permission map ends at `SUBAGENT_NO_DELEGATION` + `NO_WEB_ACCESS`,
  so `spawn` is left enabled.

`mayDelegate(agent)` (`src/agents.js:165-169`) is the single source of truth for "may
this role delegate": `Boolean(def) && def.mode === "subagent" && def.permission?.spawn !== "deny"`.
A project that overrides a role's whole `permission` map moves the runtime gate —
`checkSpawnPermission` (`src/hooks.js:185-205`) reads the resolved config — without
moving this set, the same limitation the outline and TODO role sets already carry
(`src/hooks.js:70-73`).

`NESTED_SPAWN_TARGETS` (`src/agents.js:204-211`) maps each spawning role to the agent
types a nested spawn of its may name. The five non-web roles — `planner`, `coder`,
`debugger`, `reviewer`, `documenter` — share `WEB_SEARCH_TARGETS = ["researcher"]`,
because the web search and fetching the role itself has no tool for lives there. The
`researcher` alone maps to `["grounder"]`, the second, independent search path
(Google Search grounding) its own tools do not give it. Every other role maps to
nothing — `designer`, `gitter` and `grounder` carry `NO_SPAWN` and answer the same
empty set from the table. The accessor is `nestedSpawnTargets(agent)`
(`src/agents.js:218-220`), which returns the role's set frozen and never `null`.

The spawn gate (`src/tools.js:201-252`) enforces it and the delegating roles' limits
block (`src/hooks.js:710-749`) sizes against the one target that role names. The
graph terminates structurally, with no counter and no walk of the session tree: the
chains it admits are finite and acyclic, at longest caller → researcher →
grounder, because `grounder` is a key of nothing and is itself denied `spawn`. Depth
is bounded at two levels by construction: a target that cannot spawn can never
have children, and `researcher` is the only role whose target is itself denied
`spawn`.

## 2. The call blocks; the result becomes the tool result

The spawn path detects a nested caller by the presence of a registry entry — every
primary is entry-less, so the test is `const nested = Boolean(callerEntry)`
(`src/tools.js:313-314`). On `nested: true`, three refusal checks run before any
session is created, and any of them returns the refusal as the tool result so the
caller carries on:

- `nestedSpawnRefusal` (`src/tools.js:152-204`) — three checks, in order:
  1. `await permissionGuard.checkSpawnPermission(callerEntry.agent)` — denies a role
     that does not delegate (`src/tools.js:157-169`). The text is the same one a
     caller received while no subagent could spawn at all, so a non-delegating role
     sees no change.
  2. `!nestedSpawnTargets(callerEntry.agent).includes(args.agent)` — one entry
     of the caller's own set, in a role that has no target there an empty set
     (`src/tools.js:223-232`). A refusal names the caller's own allowed set rather
     than throwing, because a throw is what small models retry into a loop.
  3. `extractTaskId(args.prompt)` — a `T<n>:` prefix is rejected (`src/tools.js:185-203`),
     because the nested run is preparation for the caller's task and the child's
     `DONE: T<n>` would otherwise tick a TODO the orchestrator is still tracking
     against the caller.
- `nestedQuotaDecision(toolCtx.sessionID, getSettings().maxNestedSpawns)`
  (`src/tools.js:461-479`) — the per-run quota, admitted on the same synchronous read
  that charges it (`chargeNestedSpawn`, `src/registry.js:295-300`) so two spawn calls
  in the same turn cannot both pass on the same figure. `0` is the escape hatch and
  the refusal text says so (`src/tools.js:471-477`).

On a pass, `childResult = registerChildWaiter(sessionID, toolCtx.sessionID)`
(`src/tools.js:525`) — the child waiter is the parent's block. The spawn slot is
released before the wait (`src/tools.js:597-602`) so the slot is owned by the child's
registry entry from there on; holding the reservation through the child's whole run
would count it twice against the cap the orchestrator is shown.

The handler `await`s the result (`src/tools.js:618-621`) and the child's ending IS the
tool result:

```
const outcome = await childResult
const nestedTotals = chargeNestedRun(toolCtx.sessionID, outcome.ctxTokens)
return {
  output: nestedSpawnOutput(outcome, entry.handle, args.agent),
  metadata: { handle, sessionID, agent, nested: true, status: outcome.status },
}
```

(`src/tools.js:623-635`). `nestedSpawnOutput` (`src/tools.js:210-249`) renders every
ending — `completed`, `error`, `aborted`, `timeout`, `expired`, `ended`, `abandoned`
— because the caller asked a question inside a tool call and has to be told either
the answer or why there is none.

A parent blocked inside its `spawn` tool call never goes idle: the session falling
quiet around a tool call that has not returned is not the one-shot reply the idle
path exists to deliver (`src/hooks.js:917-938`). The hold is built; the live run
never enters it. Pinned by unit tests only — see §6.

## 3. The per-run quota

`DEFAULT_MAX_NESTED_SPAWNS = 2` (`src/settings.js:129`); env `OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS`,
file key `maxNestedSpawns` (`src/settings.js:285,352-353`). `0` refuses every nested
spawn — the escape hatch — and `nestedQuotaDecision.disabled` is true rather than
`refused` so the refusal text can say so (`src/registry.js:279-289`). A primary
caller has no quota (`src/registry.js:281`): `entryForSession` returns `undefined`,
the decision is `{ used: 0, limit, disabled: false, refused: false }`, and no
quota is charged.

Two counters on the registry entry (`src/registry.js:1103-1118`):

- `nestedSpawns: 0` — children admitted; charged in `chargeNestedSpawn`
  (`src/registry.js:295-300`), checked against the quota in the spawn gate.
- `nestedRuns: 0`, `nestedTokens: 0` — children whose ending came back, plus the sum
  of what those children burned in their own sessions; summed by `chargeNestedRun`
  (`src/registry.js:319-326`) the moment the waiter resolves. Separate counters on
  purpose: a model that loops on failing spawns is still bounded (the quota), and a
  spawn that never got as far as being prompted must not appear as a run in the
  bill.

Both counters are per run — a fresh subagent starts at 0 and nothing ever has to
reset them.

## 4. The waiter in `src/childwait.js`

The mechanism is one record per waited child, keyed by the CHILD's session id (the id
every ending path already has in hand) and carrying the parent's id (the direction
every "does this session have live children?" question asks in). One record per child
keeps the promise and the bookkeeping it guards impossible to desynchronise — one
settle closes both.

The seven exports of `src/childwait.js`:

- `CHILD_OUTCOMES` (`src/childwait.js:39-46`) — the seven statuses, frozen, every
  value one a parent can act on.
- `CHILD_WAITER_TIMEOUT_FACTOR = 4` (`src/childwait.js:57-64`) and
  `childWaiterTimeoutMs(maxAgeMs)` (`src/childwait.js:68-72`) — the waiter's own
  ceiling, as a multiple of `maxSubagentAgeMs`. `maxSubagentAgeMs = 0` disables the
  inactivity watchdog and disables this ceiling with it; the two are one decision.
- `registerChildWaiter(childSessionID, parentSessionID, { timeoutMs })`
  (`src/childwait.js:88-152`) — registers and returns the promise the parent blocks
  on. Resolves, never rejects; `record.settle` is the only place the promise is
  resolved.
- `settleChildWaiter(childSessionID, outcome)` (`src/childwait.js:159-181`) — every
  ending path calls this unconditionally; the return value is the answer to "was
  this child being waited on?", which decides whether the result still needs to go
  to the parent as a wake notice.
- `hasChildWaiter(childSessionID)` (`src/childwait.js:184-186`).
- `liveChildSessionIDs(parentSessionID)` (`src/childwait.js:192-202`) — linear scan
  over the map; a parent has at most one live child under the blocking shape, the
  map holds one record per waited child across the whole process, single digits at
  the very most.
- `hasLiveChildren(parentSessionID)` (`src/childwait.js:207-213`) and
  `waitingParentOf(childSessionID)` (`src/childwait.js:218-219`).

Five sites consult the waiter or the live-children predicate, exactly the five the
module's header promises:

| site | what it consults | what it does |
|---|---|---|
| `src/hooks.js:929` (`onSessionIdle`) | `hasLiveChildren(sessionID)` | An idle parent with live children holds; no premature (empty) result to the grandparent, no free slot, no cascading `DELETE` over the live child. When the child settles the tool call returns, the session speaks again, and a second idle finds no live children and runs the normal path. |
| `src/tools.js:678-684` (`abortHandler`) | `settleChildWaiter(entry.sessionID, { status: "aborted", … })` | A `subagent.abort` settles the waiter explicitly — this handler ends a child WITHOUT going through `teardownSubagent`, so leaving the waiter alone would leave a blocked caller blocked until the waiter's own ceiling fired. |
| `src/teardown.js:88` (`endLiveChildrenOf`) | `liveChildSessionIDs(sessionID)` | Before a parent's `DELETE`, walk the live children and end each first. The recursion through `teardownSubagent` is bounded by `seen` (`src/teardown.js:84-86`): depth is structurally one, but a `parentID` cycle from a reparent race must not spin here. |
| `src/watchdog.js:116` (`isWaitingOnWatchdoggedChild`) | `liveChildSessionIDs(sessionID)` | The watchdog exemption. A parent blocked on a tracked child — one the same watchdog will reap if it hangs — is itself exempt from the inactivity sweep. The exemption is bounded to tracked children on purpose; an exemption that also covered an untracked child would be one nothing could ever lift. |
| `src/hooks.js:975-991` (`onSessionIdle`, completion) | `settleChildWaiter(sessionID, { status: "completed", result, ctxTokens })` | The only ending path that has a result rather than just a cause. `teardownSubagent`'s later settle attempt is then a no-op. |

A primary has no registry entry, but its `spawn` tool call never enters the blocking
path — `callerEntry` is `undefined` for a primary caller (`src/tools.js:301-304`),
the `nested` flag is `false`, and the spawn returns a wake-notice shape instead. A
primary with a live child is not a state the waiter recognises; a subagent with a
live child is.

## 5. The reduced limits block

A delegating role gets one of two subagent guides (`src/hooks.js:336-340`):

- `SUBAGENT_NO_SPAWN_GUIDE` (`src/prompts.js:63-67`) — for a role that does not
  delegate, with `maxNestedSpawns = 0` switched off installation-wide, or
  carrying `NO_SPAWN` in its map.
- `SUBAGENT_DELEGATION_GUIDE` (`src/prompts.js:74-92`) — for the five delegating
  roles when nesting is on. The block states the one target ("researcher and
  nothing else"), the one reason (web material the role itself has no tools for),
  that the call BLOCKS and the answer IS the tool result, that there is no wake and
  no second chance, and that the prompt carries NO `T<n>:` prefix.

Exactly one of the two is appended to a subagent's guide, never neither
(`src/hooks.js:339-340`): the spawn rule is not in `SUBAGENT_GUIDE_CORE`
(`src/prompts.js:52-62`) because it differs per role, so leaving both out would leave
a subagent with nothing said about spawning at all.

The quota figure is not in `SUBAGENT_DELEGATION_GUIDE` — it is a runtime setting that
also counts down within a run. The static limits block is
`formatDelegationLimitsNotice` (`src/hooks.js:852-875`), appended only when the
role may delegate and the installation has not switched nesting off:

```
⤷ agent-intercom: limits on the work you delegate.
Your own context budget: <own> — the ceiling this whole run is measured against, the
  researcher's returned text included.
Context budget of what you may spawn: researcher <budget> (−<fixed> fixed → <headroom>).
Size your spawn prompt against that budget: keep it at or under <warn%> of it; over
  <refuse%> the spawn is REFUSED and no subagent starts.
```

The remaining quota is a separate per-turn notice, built by `nestedQuotaNotice`
(`src/hooks.js:890-897`) and appended to the last user message by
`createTransformMessages` (`src/hooks.js:523-534`):

```
⤷ agent-intercom: nested spawns left this run: <left> of <quota.limit>. The quota does not reset.
```

The two package shares — `PACKAGE_WARN_SHARE` and `PACKAGE_REFUSE_SHARE` — apply to
a nested spawn the same way they apply to the orchestrator's:
`packageSizeVerdict` sizes against the TARGET type's budget, whoever the caller is.
`fixedOverheadFor(target, …)` (`src/hooks.js:908-922`) is the researcher's fixed
overhead, estimated with the same chars/4 estimator the spawn gate uses, so the
headroom in the limits block and the figure the gate reports are one method. The
condition is `delegatesNested(entry.agent)` (`src/hooks.js:825-827`); with
`maxNestedSpawns = 0` every nested spawn is refused before a session is created, so
a role that may delegate still cannot — it is told it does not delegate, which is
what is true of it, and neither block is paid for.

## 6. The `⤷ nested:` line

When a subagent finishes, its completion notice carries the cost of what its
delegation paid. The line is built by `nestedRunsNotice(nested)` (`src/notices.js:88-90`)
and rendered below the run-size verdict:

```
⤷ nested: <runs> run<s>, ~<tokens> tokens (not counted in the figure above).
```

Absent otherwise, which is every run of a role that does not delegate. It sits BELOW
`runSizeNotice` and outside its figure on purpose: `runSizeNotice` measures the
parent's own run against the parent's own budget, and folding a child's internal
spend into that figure would make a well-scoped parent read as oversized. The figure
here is the one thing that number cannot show — what the delegation cost on top — so
the orchestrator can see it and stop paying for it where it is not earning its keep.

The numbers come from the parent's registry entry as `{ runs, tokens }` carried on
the wake snapshot (`src/hooks.js:970-973`); `tokens` is the sum of what the children
burned in their own sessions, which an ending without a snapshot does not report.

---

## 7. Live-run bounds

`work/s7-live-nesting-durchstich.md` ran the feature end to end against a real
`opencode serve` 1.18.25 in `~/testopencode`, model `xai/grok-4.6`. The
capture directory is `work/s7-nested-live-captures/`; the driver is
`test/e2e/nested-task.sh`; the asserted criteria are 13/13 passed, exit 0. Two
properties the design guarantees are bounded by what that run shows.

**The caller-gate refusal text is unreachable from a live model.** The schema strip
removes `spawn` from a denied role's schema before the model can call it. A
`designer`'s 61-line transcript holds no part with `tool=spawn`, its reply is the
`NO SPAWN TOOL` sentinel, and the server reports no session under it. Layer 1, the
schema strip, is the primary defense (`src/agents.js:126-130`); layers 2 and 3
(`src/hooks.js checkToolPermission`, the caller gate) are never entered from a live
denied role. The text `nestedSpawnRefusal` produces — `"You are a subagent — you
cannot spawn other agents…"` (`src/tools.js:163-169`) — is therefore not reachable
from a live model and only guards a strip bypass (a project that overrides a
permission map to remove the deny, or a future schema-strip regression). The unit
tests in `test/nested-spawn.test.js` call `spawnHandler` directly and pin the string,
which is exactly the surface the bypass would land on.

**The idle hold does not arise on this path.** A caller blocked inside its `spawn`
tool call has no reason to emit `session.idle`, so `idle held: subagent is waiting
on a live child` (`src/hooks.js:929`) does not occur once in the live slice. The hold
is built into `onSessionIdle` and is exercised by the unit suite only — it is belt
to the blocking shape's braces. If the blocking shape ever changed (e.g. an
asynchronous spawn that returns a handle and wakes the parent on completion), this
hold would become load-bearing and would need its own live evidence.

## 8. Out of scope

- The TUI is unchanged. The sidebar's `nested: { runs, tokens }` field
  (`src/hooks.js:970-973`) is read by the server's notice only; no row carries it.
- The wake notice text the primary sees on a normal (non-blocking) subagent
  completion is unchanged. The `⤷ nested:` line is added inside the per-run
  verdict; nothing on the orchestrator-side completion message changes shape.
- Cross-primary nesting is not designed. A primary that calls `spawn` is non-nested
  by the `callerEntry` test (`src/tools.js:313-314`); its spawn returns a wake-notice
  shape exactly as today. The depth bound is one level at the structural limit
  (every value of `NESTED_SPAWN_TARGETS` either carries `NO_SPAWN` or maps to
  nothing); going wider is not on offer.
