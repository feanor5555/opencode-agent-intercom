# Nested delegation — a subagent may spawn a child of its own

## 1. What this promises, and to whom

A subagent of the right role may hand one piece of its task to a child subagent. Two
parties are promised something, and the whole design is what keeps both promises.

**To the delegating subagent.** `spawn(<target>, prompt)` is a question with exactly one
answer. The call blocks; when it returns, its output is either the child's reply or a
plain statement of why there is none. It does not throw into the model's face, it does
not return a handle to poll, and it does not leave the caller waiting on something that
has gone away. While it waits, the caller keeps the one-shot leaf life every other part
of this plugin is written against: it does not go idle mid-call, it is not reaped for the
silence its child's work creates, and its session is not deleted out from under the
child.

**To the orchestrator.** Nothing changes shape. It sees one subagent, gets one wake
notice, and is told on that notice what the delegation cost on top of the run it is
paying for. It is never woken by a grandchild and never has to know one existed.

Boundary: the plugin's server side (`src/`). The TUI is out of scope.

**Names used here**, one per mechanism and no synonyms:

- **`nestedSpawnRefusal`** — the three role checks a nested spawn passes before anything
  is reserved or created.
- **the spawn handler** — the `spawn` tool's handler, which runs every gate and owns the
  block.
- **the package gate** — the work-package size verdict and its token estimator.
- **the schema strip** — the removal of a denied tool from a role's schema, so the model
  never sees it.

## 2. Who may delegate, and to whom

**Two gates, and which wins.** The runtime authority is `checkSpawnPermission`
(`src/config.js`): fail-closed, resolving the live config's `agent.<role>.permission.spawn`
first, then this plugin's own role definition with opencode's semantics (an explicit
`deny` denies, an absent key allows), then denying a role neither side defines. The
prompt side asks `mayDelegate` (`src/agents.js:228-231`), which reads the static role map
only. Where the two disagree the runtime wins and the prompt is wrong — see O1.

**The grant is the absence of a deny.** `NO_SPAWN = { spawn: "deny" }`
(`src/agents.js:183-185`) is carried by `grounder`, `designer` and `gitter`. The five
repository-reading roles — `planner`, `coder`, `debugger`, `reviewer`, `documenter` — and
`researcher` do not carry it, and that absence is the whole grant: the schema strip
leaves the tool in their schema and `checkSpawnPermission` resolves the same map at run
time.

**The target table decides who they may name.** `NESTED_SPAWN_TARGETS`
(`src/agents.js:204-211`) maps the five non-web roles to `researcher` — web search and
fetching is the one thing they have no tool for — and `researcher` to `grounder`, the
second, independent search path its own tools do not give it. Every other role answers
the empty set, so the table and the permission maps say the same thing from two
directions.

**Depth is bounded at two nested levels by construction.** The five non-web roles reach
`researcher`, which may itself spawn — that is the second level; `researcher` reaches
`grounder`, which is a key of nothing in the table and carries `NO_SPAWN`, so there is no
third. No counter and no walk of the session tree is needed: the graph is finite and
acyclic, and the longest chain is caller → researcher → grounder.

**Defence in depth, in the order it is met.** The schema strip is the primary defence: a
role denied `spawn` never sees the tool. Behind it stands the runtime tool guard, and
behind that `nestedSpawnRefusal`'s first check, which repeats the denial in the wording a
caller received while no subagent could spawn at all — so a non-delegating role sees no
change whatever. §8 bounds what a live run can show of those three.

## 3. What a nested `spawn` returns

The spawn handler classifies its caller by the presence of a registry entry: every
primary is entry-less, so a caller that has one is a subagent and its spawn is a nested
one. A primary's spawn takes the ordinary non-blocking path and returns a wake-notice
shape, exactly as it always did.

A nested `spawn` produces one of three result classes.

**(i) A returned refusal.** Nothing was created; the caller carries on with the rest of
its task. The nested-specific sources are the three `nestedSpawnRefusal` checks — the
role may not delegate; the named target is not one the caller's own set contains (a role
the table does not know answers the empty set, so every target is refused); the prompt
carries a `T<n>:` prefix, which is refused because the child's `DONE: T<n>` would tick a
TODO entry the orchestrator is still tracking against the caller — plus the per-run quota
and the endless-mode freeze. The gates every spawn passes apply too: the agent-type gate,
the task-permission gate and the package gate. Refusals are returned and never thrown: a
throw is what small models retry into a loop. Each names what IS available and tells the
caller to do the rest itself and to open its final reply with `Blocked:` where the
missing material stops the task.

The endless freeze is worth naming separately, because its answer differs by caller. From
the moment an endless cycle latches until it ends, no new subagent starts: a run that
spawns as fast as its subagents finish would never let the cycle reach quiesce, and a
subagent started now would be reparented onto a session that has no memory of asking for
it. The question is asked of the caller's ROOT primary, because the latch holds primary
session ids only and a nested caller asking about its own id would be told "not frozen"
and spawn straight through. A primary gets the throw the endless-mode contract names — end
your turn, the work belongs in your open points. A nested caller gets a returned refusal
instead: it has no open points, will not be asked for any, and cannot end its turn in the
sense meant, so it is told that this delegation will not start and to finish from what it
has.

**(ii) A rendered ending.** The child's outcome, as text the caller can act on. Every
ending renders — `completed`, `error`, `aborted`, `timeout`, `expired`, `ended`,
`abandoned` — because the caller asked a question inside a tool call and has to be told
either the answer or why there is none, or it sits on an empty result it cannot read. A
`completed` ending carries the reply and what the child burned getting there. A
non-`completed` ending that still carries text — today only `timeout`, whose text the
watchdog rescues off the session before deleting it — renders that text framed as a
fragment of an unfinished run: the cause sentence in front, "this is not the answer you
asked for" behind, so a half-run cannot be read as a finished reply. Without text the
wording is the bare "You have no result from it" plus the same carry-on instruction.

A child that was created but never prompted is one of these: the waiter is settled
`error`, the orphaned session and any provisional entry are torn down, and the caller
gets the `error` ending naming the failure. The spawn was charged against the quota
(charged on admission — see §4) and no run is booked, because a delegation that never ran
cost the orchestrator nothing.

**(iii) A thrown failure**, which the tool wrapper surfaces as `spawn failed: <text>`. No
nested path produces one today, and none should: this class is what remains if an
unforeseen throw escapes the handler. It is the only result class this design does not
shape, so a nested path found producing it is a defect, not a variant.

What the caller is expected to do: with a refusal, carry on and name what is missing;
with `completed`, work from the reply — it cannot be asked again; with any other ending,
do what it can itself and open its final reply with `Blocked:` where the missing material
stops the task. Each rendering says so in its own words, so the contract does not depend
on the caller having read this document.

## 4. What bounds it

**The cap and the quota bound different things, and nothing bounds them together.**

- `maxSubagents` (default 1) bounds what one PRIMARY may have running, globally across
  every primary in the process. It does not gate a nested spawn at all:
  `spawnCapDecision` (`src/registry.js:734-742`) refuses only when the caller is not
  nested, because a nested caller already holds the slot it would be told to wait for.
- `maxNestedSpawns` (default 2) bounds what one SUBAGENT RUN may start. Per run, never
  reset, and read off the caller's own registry entry.
- Together they admit three concurrent live opencode sessions per orchestrator slot at
  the shipped defaults: the primary's subagent, its `researcher`, and that researcher's
  `grounder`. The chain is serial and two levels deep, so three is the worst case. The
  cap figure the orchestrator is shown counts none of the nested ones. That is deliberate
  under the assumption in O2.

**The two counters and why they are two.** `nestedSpawns` counts spawns ADMITTED: the
decision and the charge sit in one synchronous block with no await between them, so two
spawn calls in the same turn cannot both pass on the same figure, and a model looping on
failing spawns is still bounded. `nestedRuns` and `nestedTokens` count children whose
ending actually came back, plus what those children burned inside their own sessions —
that is the bill, and a spawn that never got as far as being prompted must not appear in
it. Both live on the entry, which lives exactly as long as the one-shot run, so nothing
ever has to reset them.

**`maxNestedSpawns = 0` is the escape hatch.** Every nested spawn is refused before a
session exists, and the refusal says the feature is switched off rather than reporting a
count the caller could wait out. A role that could delegate is then told it does not
delegate — which is what is true of it — and neither the delegation guide nor the limits
block is paid for.

**The package gate sizes against the target.** A nested spawn is measured against the
TARGET type's context budget, with the same warn and refuse shares the orchestrator's
spawns use, whoever the caller is.

**The slot is handed back before the block.** The spawn handler releases its reservation
the moment it is about to wait; from there the slot is owned by the child's registry
entry. Holding the reservation through the child's whole run would count the child twice
— in the reservation counter, and in the quiesce predicate an endless cycle waits on,
which would then never reach zero.

**Endless quiesce covers a nested chain transitively.** The predicate counts a primary's
own subagents, and a blocked caller's entry stays active for as long as its child runs,
so no walk of the tree and no live-children read is needed there.

## 5. The wait state

**The contract.** One record per waited child, keyed by the CHILD's session id — the id
every ending path already has in hand — and carrying the parent's id, the direction every
"does this session have live children?" question asks in. Keying on the child also keeps
the record and the promise it guards impossible to desynchronise: one settle closes both.
The record is registered after the child's session id exists and BEFORE the child is
prompted, and at no later point: a child cannot end before it is prompted, so that window
is closed, while a registration after the prompt can lose the race to the child's own
idle path and leave the handler blocking on something already gone. The promise RESOLVES
on every path and never rejects — an ending is a result the parent has to report, not an
exception in its own tool call — and is resolved in exactly one place. A double
registration for the same child throws: it cannot happen from a correct spawn path, so it
is a bug, and handing two callers one answer would be worse than failing. Every function
in the module is synchronous and takes no lock, so it can be called from inside the
registry mutex without nesting a non-re-entrant FIFO.

**Three reads, three duties.**

*Is this session blocked on a child?* — the idle hold. A session falling quiet around a
tool call that has not returned is not the one-shot reply the idle path exists to
deliver. Taking it would post a premature, empty result to the grandparent, free a slot
that is not free, and delete a session whose DELETE then cascades over the very child it
is waiting for. The entry is held, not latched: when the child settles, the tool call
returns, the session speaks again, and the second idle finds no live children and runs
the normal path.

*Which children may still be running?* — the teardown ordering. opencode's DELETE
cascades recursively over child sessions, so a child still streaming its final reply has
its rows wiped mid-write. Every path that deletes a session therefore ends its children
first: a cooperative abort, then the ordinary teardown, which recurses into that child's
own children. The recursion is bounded by a `seen` set — the target graph already bounds
the depth, but a `parentID` cycle from a reparent race must not spin. The shared teardown
carries the ordering for every path that goes through it; the abort tool, which ends a
subagent without going through it, carries the same ordering itself.

*Is this parent's silence its child's work?* — the watchdog exemption. A blocked parent
emits no events at all: every event of the run belongs to the child's session, so the
parent's own clock stands still for as long as the child works. The sweep does not merely
skip such a parent, it moves its `lastActivityAt` forward on every tick, and that is the
half that matters at the handover: the moment the tool result lands, the parent starts an
LLM call that may not emit for a few seconds, and a timestamp from before the whole child
run would have the next sweep reap it instantly. The exemption is bounded to children
that are themselves tracked registry entries, so a parent can be held open no longer than
its child can, and a waiter left behind by a child that has vanished frees the parent to
be reaped normally. A working, non-waiting subagent is deliberately NOT bumped: it has no
second clock behind it, and bumping would push its ceiling out on every tick.

**Every ending settles the waiter**, and the settle's return value answers "was anyone
blocked on this?", which is what decides whether the ending still has to be reported
somewhere else:

- the child went idle with a reply — `completed`, the only ending that carries a result
  rather than just a cause. The reply is capped for the child's own type first, because
  that is where the text crosses into another agent's context;
- the shared teardown — settled FIRST, before any network I/O: a blocked session must not
  stay blocked while a notice is posted or a session deleted. The outcome is whatever the
  calling path names (`timeout` from the watchdog, `ended` from a parent-first teardown)
  and `ended` where it names none;
- the abort tool — `aborted`, settled by the handler itself because it ends a subagent
  outside the shared teardown, and a caller would otherwise stay blocked until the rescue
  ceiling fired;
- the spawn handler, for a child created but never prompted — `error`. It is not a
  blocked caller being freed here: this handler IS the caller. The settle exists so the
  caller does not look like a session with a live child for the rest of its run, with its
  idle held, its silence excused and its teardown waiting on a child that was never
  prompted;
- the process-state reset — `abandoned`, so a leftover promise cannot hang and its rescue
  timer cannot fire into the next run.

**A nested child's ending is never also posted into its parent's session.** The notice
door drops any parent notice whose addressee is itself a tracked subagent: the same
ending would reach it twice, once as the tool result it asked for and once as a message
it cannot act on while blocked and pays context for afterwards.

**The rescue ceiling.** It exists for one case: no ending path fires at all — an event the
plugin never sees, a session that vanished server-side — where the parent's tool call
would otherwise hang for the life of the opencode process. It is not a second watchdog.
The watchdog is what ends a hung child, and its ending settles this waiter.

Its value is `CHILD_WAITER_TIMEOUT_FACTOR = 4` times the wider of the two watchdog
windows, `max(maxSubagentAgeMs, maxSubagentToolCallMs)` — 44 minutes at the defaults. The
base has to be the wider one: a ceiling built on the 90 s silence window alone fires at 6
minutes and would hand the parent `expired` for a child legally inside a 660 s tool call
that no sweep has touched.

The number alone cannot separate "stuck" from "slow", and the design does not ask it to.
The wide window is measured from the in-flight call's own start and is not renewed by
events arriving during it (`watchdogLimit`, `src/watchdog.js:320-335`), so a single call
is bounded — but each new call starts a new window, and a healthy child making
consecutive long calls outlives any fixed multiple. So when the timer fires it ASKS
instead of deciding: is the child still a tracked registry entry? If it is, the watchdog
still owns it, there is nothing to rescue, and the timer re-arms for another period. The
expiry that remains is exactly the case the ceiling was built for — no entry, so no
watchdog clock, so no ending path.

The two zero settings mean different things and are read differently.
`maxSubagentAgeMs = 0` lifts the ceiling altogether: it switches the inactivity watchdog
off, a user who has taken out the dead-man's switch has asked for runs no clock cuts
off, and such a child's entry is never reaped so the re-arm could never expire it anyway.
`maxSubagentToolCallMs = 0` does NOT lift it: that 0 says "no ceiling while a subagent
works", which the re-arm already honours, and returning 0 here would drop the rescue for
the one case it exists for. A settings object carrying no tool-call window at all is read
as "no window wider than the silence one" — absent is not the statement an explicit 0
makes — which is the same reading the bootstrap orphan sweep takes. The settings are read
directly rather than through `watchdogLimit`, because the watchdog imports this module
and the dependency cannot run both ways.

**Who owns the child after each ending.**

- `completed`, `error`, `aborted`, `timeout`, `ended` — the child is already gone or on
  its way out through the path that produced the ending. The record is dropped with the
  settle.
- `expired` — the ceiling frees the PARENT, not the child. The record is therefore not
  dropped: it is marked DETACHED and stays in the map. It no longer answers "is this
  parent blocked?", because the parent's tool call has returned and its next idle is
  genuine and must be taken; it still answers "which children may still be running?", so
  the parent's own teardown aborts and ends that child before its DELETE could cascade
  over it. The child is not watchdogged — having no tracked entry is what let the ceiling
  fire — so no exemption is granted for it and nothing is held open that could not be
  lifted. If the child's own ending ever does arrive it finds a settled record, drops it,
  and is reported as an ordinary ending; the reply it carries reaches nobody (O3). If
  nothing ever arrives, the parent's teardown ends the session, and one that outlives the
  process is collected by the bootstrap orphan sweep at the next plugin load.
- `abandoned` — nothing owns the child. The process-state reset is a test and reload
  facility; a live opencode process does not reach it.

**A nested child is never retained.** Its rows would be wiped mid-life by its parent's own
recursive DELETE, because the child-first sweep reads its children from the waiter map
and a finished child has no waiter left. The parent having a registry entry is the
plugin's definition of "the parent is a subagent", and that is the condition retention
refuses on.

**Two exported reads have no production caller** — "is this child being waited on?" and
"who is waiting on this child?". They are the module's inspection surface, exercised by
the tests, and are not part of the runtime design.

## 6. What a delegating role is told

Exactly one block is appended to a subagent's guide, never neither: the no-spawn guide,
or the delegation guide that names that role's own target. The spawn rule is not in the
shared subagent core because it differs per role, so leaving both out would leave a
subagent with nothing said about spawning at all. The block is keyed on the role's target
set, so a role added to the target table with `researcher` as its target gets the block
every such role already has, and only a role pointed somewhere else needs one of its own.

The delegation guide states, for both variants: the one target and that it is the only
one; the one thing delegation is for, which is what the role cannot do itself (web
material for the five repository-reading roles, the Google Search path for the
`researcher`); that this is not the normal working mode; that the call BLOCKS, that the
reply IS the result of the call, and that there is no wake and no second chance, so a
whole question goes at once; that the prompt carries no `T<n>:` prefix, because the child
prepares material for the caller's task and does not take one over; and that past the
quota the role finishes from what it has and opens its final reply with `Blocked:` where
the missing material stops the task.

Beside it stands the limits block, built only for a role that may delegate with nesting
switched on. It carries three things and no more — the orchestrator's own block also
carries the subagent cap, every spawnable type's budget and the chatter setting, none of
which a subagent can act on:

- the role's own context budget, the ceiling its whole run is measured against, the
  returned text of what it spawns included;
- for each target the role may name: that target's context budget, the fixed overhead
  every spawn of it pays before the caller's own words, and the headroom left of the
  budget. A target with no budget set is named as such rather than given a number;
- the two package shares, at which the package gate warns and refuses.

The target list comes from the same table the spawn handler enforces, so the block a
`researcher` sees names the `grounder` and not the `researcher`. The overhead is
estimated with the same estimator the package gate uses, so the headroom shown and the
figure the gate reports are one method. The wording belongs to the builder of the block,
not to this document.

The one figure that moves within a run — how much of the quota is left — rides on the
last user message rather than the system prompt, where it would invalidate the stable
prompt element once per nested spawn. It is rendered for a non-aborted caller that the
delegation block was built for, so the figure reaches exactly the roles that were told
they have a quota, and no others.

## 7. What the delegation costs, and where that is said

A subagent's completion notice carries a `⤷ nested:` line: how many nested runs ended and
what they burned inside their own sessions. It sits BELOW the run-size verdict and
outside its figure on purpose. The run-size figure measures the parent's own run against
the parent's own budget, and folding a child's internal spend into it would make a
well-scoped parent read as oversized; this line is the one thing that figure cannot show
— what the delegation cost on top — so the orchestrator can see it and stop paying for it
where it is not earning its keep. Where no child reported a token count, the line says so
rather than implying the run was free. It is absent for a run with no nested runs, which
is every run of a role that does not delegate.

The figures come off the parent's registry entry and are read inside the same critical
section as the rest of the wake snapshot, because the entry is gone by the time the
notice is composed.

## 8. What a live run bounds, and what pins it

Two statements in this design cannot be settled by unit tests alone. Both are carried by
the tracked end-to-end driver `test/e2e/nested-task.sh`, so they are checkable from a
clone.

**A denied role never reaches the caller gate.** The schema strip removes `spawn` from a
denied role's schema before the model can call it. The driver's criterion *"denied — a
`<role>` spawned no session of its own"* reads the server's own child list, so the proof
is the absence of a session rather than the model's account of itself; the criterion
*"denied — the refusal is one of the three layers the concept names, with its own text"*
records WHICH layer fired instead of asserting a particular one, since all three are
legitimate. The consequence for the design: `nestedSpawnRefusal`'s permission text is not
reachable from a live model and guards a strip bypass — a project that overrides a
permission map to remove the deny, or a future schema-strip regression. The unit suite
calls the spawn handler directly and pins that string, which is exactly the surface such
a bypass would land on.

**The idle hold is not entered on the happy path.** A caller blocked inside its `spawn`
call has no reason to emit `session.idle`, so the hold's log line does not occur in a
healthy run; the driver counts it and records the count rather than asserting it,
because an absent line means the blocking shape held on its own and not that the hold is
broken. The hold is not therefore dispensable. It is the only guard on the paths where a
waiter and its tool call come apart, and there are three: an expiry that frees the parent
while the child's record stays detached (§5), the process-state reset, and any future
non-blocking spawn shape. "Unit tests only" is a statement about coverage, not about
necessity.

The same driver also pins the blocking shape itself — the caller blocks, the child's
answer comes back as the result of the caller's own call, the caller's transcript holds no
completion notice at all, both sessions are gone afterwards and no cascade error appears —
plus the wrong-target refusal, the `⤷ nested:` line for the one nested run, and that a
nested run ticks no TODO entry.

## 9. Open points

**O1 — the prompt gate and the runtime gate can disagree, and nothing reconciles them.**
`mayDelegate` reads the static role map; `checkSpawnPermission` reads the resolved config
and is the authority (§2). A project that adds `spawn: "deny"` to `coder` leaves
`mayDelegate("coder")` true, so that coder is given the delegation guide, the limits
block and a fresh quota line on every turn while every spawn it makes is refused — paid
prompt tokens for an instruction the runtime denies, plus the refusal round-trips this
design works elsewhere to avoid. No owner in the source today. The shape a fix would
take: the prompt-side predicate resolves the config gate once per run and falls back to
the no-spawn guide, with no limits block and no quota line, wherever it denies — so the
prompt can never promise what the gate refuses. Owner would be `delegatesNested`
(`src/hooks.js`).

**O2 — assumption: `maxSubagents` is the orchestrator's serialisation of its own
attention, not a resource or rate bound on the process.** The cap exemption in §4 is
right only under that reading. It would be shown wrong by a `maxSubagents` set to protect
a provider rate limit or the host machine, in which case a nested chain breaches the very
bound it was set for, three sessions deep, without the orchestrator's cap figure showing
it. Nothing in the settings distinguishes the two readings.

**O3 — a detached child's reply reaches nobody.** After `expired` the parent has its
outcome and is running again, so the child's own completion settles nothing; the notice
door then drops the notice because the addressee is still a tracked subagent (§5). Where
the parent has already ended, the parent's teardown ended the child without a notice by
design. So work a detached child did finish is discarded in every case. Whether that is
right is a decision this design has not taken: the alternative is routing such a reply to
the root primary as an unasked-for notice, which costs the orchestrator context for
material it did not request and arrives with no task to attach it to.

## 10. Out of scope

- The TUI is unchanged. The nested figures ride on the wake snapshot and are read by the
  server-side notice only; no row carries them.
- The orchestrator-side wake notice keeps its shape. The `⤷ nested:` line is added inside
  the per-run verdict; nothing else about the completion message changes.
- Cross-primary nesting is not designed. A primary's `spawn` is non-nested by the
  registry-entry test and returns the wake-notice shape.
- Nothing wider than two nested levels is on offer. A third would need a target set for
  `grounder` and a depth counter, and the design has neither.
- Retention of a nested child is refused, not deferred (§5).
