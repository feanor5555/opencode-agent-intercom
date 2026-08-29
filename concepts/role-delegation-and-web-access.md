# Role delegation and web access

Design for two rules on the plugin's roles:

- **Rule 1 — web access is concentrated.** A role does not search the web itself; it obtains
  the result through the `researcher` role. The researcher searches and fetches itself and is
  never told to delegate that.
- **Rule 2 — a subagent may delegate.** For token-heavy preparatory work a subagent may spawn a
  subagent of its own. What a role must do itself by its nature it still does itself.

Scope: the program at `/home/user/opencode-agent-intercom` — `src/agents.js`, `src/tools.js`,
`src/hooks.js` and the modules they reach into. No boundary question is open; everything here is
inside the plugin.

---

## 1. State of the code, with the lines behind it

### 1.1 Web tools today

The plugin registers `web_search` and `forum_search` as its own tools for **every** agent
(`src/tools.js:681-682`, `...(isWebsearchEnabled() ? { web_search: createWebsearchTool() } : {})`),
gated only by each role's `permission` map. opencode's own `webfetch` and `websearch` are built-ins
and are likewise available unless denied.

Per role, as `src/agents.js` stands:

| Role | Web denies in its `permission` map | Line |
|---|---|---|
| `orchestrator` | `webfetch`, `websearch`, `web_search`, `forum_search` | `:145` |
| `planner` | none — `{ ...SUBAGENT_NO_DELEGATION, bash: "deny" }` | `:156` |
| `coder` | none — `{ ...SUBAGENT_NO_DELEGATION }` | `:163` |
| `debugger` | none — `{ ...SUBAGENT_NO_DELEGATION, edit, write }` | `:170` |
| `reviewer` | none — `{ ...SUBAGENT_NO_DELEGATION, bash: "deny" }` | `:177` |
| `documenter` | none — `{ ...SUBAGENT_NO_DELEGATION, bash: "deny" }` | `:184` |
| `researcher` | none (correctly) | `:191-197` |
| `designer` | `websearch` only | `:204` |
| `gitter` | `webfetch`, `websearch`, `web_search`, `forum_search` | `:213-214` |

Two findings the briefing did not name:

- **`reviewer` also holds all four web tools.** Its map is
  `permission: { ...SUBAGENT_NO_DELEGATION, bash: "deny" }` (`src/agents.js:177`) — no web entry at
  all. It belongs in the same list as planner/coder/debugger/documenter.
- **`designer` is half-done in both directions.** `websearch: "deny"` (`src/agents.js:204`) leaves
  `web_search`, `forum_search` and `webfetch` open, and its own description advertises the gap:
  `"Can research visual references on the web."` (`src/agents.js:202`).

Two role prompts instruct the model to search:

- `src/agents.js:54` — planner: `"Before any library or framework choice, search current stable
  versions and compatibility with web_search and use only URLs the search returned."`
- `src/agents.js:72` — debugger: `"For cryptic errors search with web_search; for runtime errors in
  a web page use the pw CLI from bash …"`

The researcher prompt is already exactly what rule 1 wants and needs no delegation clause:
`"You do web research — searches via the \`web_search\` and \`forum_search\` tools, fetches via
\`webfetch\`; never curl/wget, never recall URLs from memory."` (`src/agents.js:96`).

Enforcement is two-layered and both layers read the same map: the schema strip
(`Permission.disabled`, described at `src/agents.js:6-8`) hides a denied tool from the LLM, and
`checkToolPermission` re-denies it at runtime (`src/config.js:147-160`), called from the tool guard
(`src/hooks.js:1108-1119`). So a deny entry is the whole lever; no new code is needed for rule 1.

### 1.2 Delegation today

```js
const SUBAGENT_NO_DELEGATION = {
  spawn: "deny", task: "deny", abort: "deny", list: "deny",
}
```
(`src/agents.js:131-133`), spread into all eight subagent roles.

Three independent layers keep a subagent from spawning:

1. the schema strip above, which the comment at `src/agents.js:126-130` calls "the primary defense"
   because "a tool that stays in the schema but gets thrown by the guard drives small models into a
   denial loop";
2. the caller-gate at the top of `spawnHandler` — `if (entryForSession(toolCtx.sessionID))` returns
   the refusal `"You are a subagent — you cannot spawn other agents…"` (`src/tools.js:200-208`);
3. the unconditional native-`task` deny for any tracked subagent (`src/hooks.js:1078-1085`).

`permission.task = "deny"` carries a second, unrelated meaning: it is the signal that hides
opencode's blocking native `task` tool from the schema, and `checkTaskPermission` deliberately
ignores the bare-string form so that the orchestrator's own `task: "deny"` does not disable `spawn`
(`src/config.js:143-146`, `:166-179`). Only the **object** form of `permission.task` is honoured as
a spawn allowlist (`resolveTaskDecision`, `src/config.js:176-179`).

The prompt layer states the same rule twice: `"You cannot spawn agents. If the task needs another
agent, name it and what it should do in your final reply…"` (`src/prompts.js:51`), and for the
debugger `"you do not fix it and you do not spawn anyone"` (`src/agents.js:69`).

---

## 2. The decisive question: does the wake machinery survive a nested spawn?

**Verdict: no. As it stands, a nested spawn breaks the plugin in five distinct places, three of
them destructive.** The machinery is built on the premise that a subagent is a leaf. Rule 2 is
still buildable — the breaks are local and each has a small fix — but not by lifting the deny
alone.

Walked through as the briefing asks: a `planner` subagent P spawns a `researcher` child C and waits
for it, while the orchestrator O waits for P.

### Break 1 — P is torn down the moment it stops talking (fatal, silent)

If the nested spawn keeps the plugin's non-blocking shape, P ends its turn to wait. opencode emits
`session.idle` for P. `onSessionIdle` has no notion of "waiting for a child": it finds P's registry
entry, latches `dispatched`, removes it, posts P's (empty, premature) result to O and tears P down
(`src/hooks.js:810-893`). P's whole reason for existing — the child's answer — never reaches it.

There is no state on a registry entry that could hold this open. The entry's fields are enumerated
in `createEntry` (`src/registry.js:908-968`) and none of them expresses "has live children"; the
one-shot lifecycle is stated as an invariant at `src/state.js:15-20`: *"each entry lives from
`spawn` until the subagent goes idle (= completed its single reply)"*.

### Break 2 — tearing P down cascade-deletes C mid-write (fatal, destructive)

`teardownSubagent` calls `deleteSession` on the finished subagent (`src/teardown.js:92`). The
precondition on that call is written into the code:

> `// NEVER use this on a session that may still have LIVE children: opencode's DELETE cascades
> recursively over child sessions (source-verified + live on 1.17.15), and if a reparented subagent
> is still streaming its final reply, the cascade wipes its rows mid-write → FOREIGN KEY constraint
> failed, session.error instead of session.idle … Subagent teardown is safe here (subagents have no
> children)`
> — `src/client.js:141-148`

Nesting falsifies the parenthesis. The same hazard already forced the primary handoff to *archive*
rather than delete (`src/handoff.js:309-317`, `src/client.js:159-171`). Every teardown path is
affected: idle (`src/hooks.js:884-889`), error (`src/hooks.js:949-958`), watchdog
(`src/watchdog.js:118-122`) and the orchestrator's own `abort` (`src/tools.js:494`).

### Break 3 — the inactivity watchdog kills whichever of P and C is merely waiting (fatal)

`sweepWatchdog` times out any entry whose `lastActivityAt` is older than `maxSubagentAgeMs`, default
**90 s** (`src/settings.js:104`, `src/watchdog.js:65-86`). `lastActivityAt` is bumped only by events
carrying P's *own* session id (`src/hooks.js:731-735`). While P waits — blocked in a tool call or
idle — every event belongs to C's session. A child run longer than 90 s therefore times out its own
parent, which then cascades into break 2.

### Break 4 — the concurrency cap deadlocks at its default (fatal in the blocking shape)

`DEFAULT_MAX_SUBAGENTS = 1` (`src/settings.js:73`), and `countActiveSubagents` counts **every**
entry in the process, not per primary (`src/registry.js:186-193`). P occupies the only slot; P's
nested spawn hits `active >= maxSubagents` and is refused with *"Wait for one to finish — you are
woken automatically"* (`src/tools.js:345-356`) — advice P cannot follow, because the thing it is
waiting for is itself. Under a blocking nested spawn this is a hard deadlock until the watchdog
fires.

### Break 5 — the endless-mode spawn freeze does not reach a subagent (correctness)

The freeze is checked as `isEndlessFrozen(toolCtx.sessionID)` (`src/tools.js:222`), and
`isEndlessFrozen` looks the id up in `pendingEndless` / `endlessInProgress`
(`src/registry.js:822-824`) — sets that only ever hold **primary** session ids
(`src/state.js:110-125`). A subagent's session id is never in them, so a subagent would keep
spawning through a freeze whose whole purpose is to let the cycle reach quiesce
(`src/tools.js:209-229`).

### What does survive nesting unchanged

Worth stating, because it bounds the work:

- **`isQuiesced` / the cap counter.** Both are process-wide (`src/registry.js:186-193`,
  `:863-870`), so a grandchild is counted automatically. An endless cycle already waits for it.
- **`reparentSubagents`.** It rewrites only entries whose `parentID === fromID`
  (`src/registry.js:384-399`). A grandchild points at P, not at O, and is correctly left alone.
- **`abort` ownership.** `entry.parentID !== toolCtx.sessionID → unknown` (`src/tools.js:473`)
  already scopes an abort to the caller's own children, whoever the caller is.
- **`list` ownership.** Same filter (`src/tools.js:515-518`).
- **The delivery router.** `routeParentNotice` resolves redirects and drains
  (`src/registry.js:569-577`); for a subagent parent both are empty, so it degrades to a direct
  post.
- **The tool guard's classification.** It tests `entryForSession` **before** the primary branch
  (`src/hooks.js:1063-1155`), so marking a spawning subagent's session as "primary" would not
  accidentally subject it to `PRIMARY_TOOLS`.
- **The TUI sidebar.** It discovers children by walking `session.children` from any parentID it sees
  on a `session.created` event (`tui/src/tui.tsx:849`, `:875-890`), so a grandchild appears without
  a change on that side.

### The smallest change that carries nesting

Bounding the depth to one level is **not** by itself a fix — every one of breaks 1-5 occurs at
depth 1. What actually carries it is making the nested spawn **blocking**, so that P never goes idle
while C runs; the depth bound then falls out for free (§4.2). See §3 for the option comparison.

---

## 3. Options for the nesting mechanism

### Option A — blocking nested spawn (recommended)

The `spawn` tool call made by a subagent does not return until its child has finished; the child's
result is the tool result. Implemented with a waiter map `childSessionID → { resolve }` in
`state.js`, resolved from the child's completion, error and timeout paths.

- **Cost.** One new map plus a resolution branch in `onSessionIdle` and `teardownSubagent`; the five
  fixes in §4.3. Roughly 120-180 lines across `state.js`, `registry.js`, `tools.js`, `hooks.js`,
  `teardown.js`, `watchdog.js`.
- **Forecloses.** A subagent cannot run two children in parallel except through parallel tool calls
  in one turn, and cannot do other work while a child runs. Acceptable: the rule's use case is
  *preparatory* work whose result the parent then needs.
- **Demands of the builder.** Every path that ends a child must resolve the waiter, or the parent's
  tool call hangs until the watchdog reaps the child. A belt-and-braces timeout on the waiter
  itself, derived from `maxSubagentAgeMs`, is mandatory.
- **Why it wins.** It is the only option under which the one-shot lifecycle invariant
  (`src/state.js:15-20`) stays literally true — P's session simply never goes idle with a live
  child — so break 1 disappears rather than being papered over, and break 2 becomes ordinary
  (the child is torn down strictly before the parent finishes). Cap, budget, watchdog and TUI all
  keep working on machinery the plugin already owns.

### Option B — non-blocking nested spawn (full async recursion)

P ends its turn and is woken by a notice the way O is.

- **Cost.** A `waitingForChildren` counter on the entry, an idle-hold in `onSessionIdle`, a wake
  path that re-prompts a subagent, a child-first teardown ordering, an abort cascade, a watchdog
  exemption with its own liveness rule, and a second delivery target class in the router.
- **Forecloses.** Nothing the plugin does today, but it turns the one-shot lifecycle into a
  multi-turn one for any role that may delegate, which every downstream assumption
  (`src/state.js:15-20`, the budget's `stopInjections` reasoning at `src/hooks.js:399-406`, the
  handoff's `inFlightSubagentsFor` contract) is written against.
- **Demands.** The largest test surface of the three; the interaction with an endless cycle
  (a subagent held open across a primary replacement) is new behaviour with no precedent in the
  codebase.
- **Rejected** as disproportionate to "summarise this documentation for me".

### Option C — reuse opencode's native `task` for nesting

Drop `task: "deny"` for the delegating roles and relax the hard deny at `src/hooks.js:1078`.

- **Cost.** Almost no plugin code.
- **Forecloses.** Everything the plugin owns: a `task` child is not in the registry, so it is
  invisible to the cap (`src/registry.js:186`), to the per-agent context budget
  (`src/hooks.js:1120-1148`), to the watchdog, to quiesce and to the completion notice. It also
  loses the schema-hide meaning of the bare-string `task: "deny"` (`src/config.js:143-146`),
  re-exposing a blocking tool to small models.
- **Demands.** A second, parallel accounting story for nested runs.
- **Rejected**: it buys the feature by leaving the plugin's guarantees at the door.

---

## 4. The design

### 4.1 Web tools per role (rule 1)

**Recommendation: only `researcher` keeps web tools. Every other role loses all four, by explicit
deny entry.**

Add to `src/agents.js` a constant beside `SUBAGENT_NO_DELEGATION`:

```js
const NO_WEB_ACCESS = {
  webfetch: "deny", websearch: "deny", web_search: "deny", forum_search: "deny",
}
```

Exact resulting deny entries per role:

| Role | New entries | Rationale |
|---|---|---|
| `planner` | `webfetch`, `websearch`, `web_search`, `forum_search` | version and compatibility checks now come from a `researcher` |
| `coder` | all four | — |
| `debugger` | all four | error-message lookups now come from a `researcher` |
| `reviewer` | all four | closes the gap found at `src/agents.js:177` |
| `documenter` | all four | — |
| `designer` | `webfetch`, `web_search`, `forum_search` (`websearch` already at `:204`) | closes the half-done state |
| `gitter` | none new — already complete at `:213-214` | — |
| `orchestrator` | none new — already complete at `:145` | — |
| `researcher` | **none — keeps all four** | it must search itself |

Alternative considered and rejected: leave `webfetch` with the reading roles so a role can open a
URL the user named. It costs nothing to build and is a real convenience, but it forecloses the rule:
a role that may fetch will fetch search-result URLs it got second-hand, and the concentration is
gone. The researcher's own prompt already covers "fetch a named URL".

**Prompt changes required by the deny entries**

- `PLANNER_PROMPT`, `src/agents.js:54` — replace the `web_search` sentence with: before any library
  or framework choice, obtain the current stable versions and their compatibility **from a
  `researcher`** (`spawn`, see §4.2); do not search yourself, and use only the URLs that researcher
  returned.
- `DEBUGGER_PROMPT`, `src/agents.js:72` — replace the first clause with: for a cryptic error obtain
  the lookup from a `researcher`; keep the `pw` CLI sentence unchanged.
- `DESIGNER` description, `src/agents.js:202` — delete `"Can research visual references on the
  web."`; a visual-reference lookup is a `researcher` spawn or is passed in by the orchestrator.
- `RESEARCHER_PROMPT`, `src/agents.js:94-103` — **unchanged in substance**, plus one sentence making
  the carve-out explicit: you search and fetch yourself and never delegate the searching; you cannot
  spawn.
- Roles that lose the tools and may **not** spawn (`designer`, `gitter`) get one sentence: web
  material is requested from the orchestrator in the final reply, never fetched.
- `README.md:180-181, 255-257` — the tool table's "Subagents" column becomes "`researcher` only",
  and the role table's Notes column carries the new denies.

**Second-order effects to carry along**

- The over-budget STOP notice names `web_search` and `webfetch` in its "do NOT try" list
  (`src/hooks.js:566`). Harmless for a role that no longer has them; leave it.
- `test/plugin.test.js:410` asserts the orchestrator's deny set and `:2019-2023` the `outline`
  denies. A new test pins the web denies per role, in the shape of the existing
  `"every subagent role denies spawn and task in its permission map"` test (`:546-558`).

### 4.2 Which roles gain `spawn` (rule 2)

**Recommendation: `planner`, `coder`, `debugger`, `reviewer`, `documenter` gain `spawn` — and
nothing else. `abort`, `list` and `task` stay denied for every subagent. `researcher`, `designer`
and `gitter` keep the full denial.**

`SUBAGENT_NO_DELEGATION` splits into two constants:

```js
// Every subagent: never the blocking native task tool, never abort, never list.
const SUBAGENT_NO_DELEGATION = { task: "deny", abort: "deny", list: "deny" }
// Roles that may not delegate at all.
const NO_SPAWN = { spawn: "deny" }
```

Delegating roles get `{ ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS, … }`; the other three get
`{ ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN, … }`.

- **`abort` stays denied.** Abort is user-only throughout this plugin (`src/tools.js:621`,
  `src/hooks.js:574-576`, `src/notices.js:152-154`) and a subagent has no user to ask. A hung child
  is the watchdog's job (`src/watchdog.js:65-86`), which is exactly the fallback that also unblocks
  the waiting parent (§4.3).
- **`list` stays denied.** Under option A there is nothing to list: the call blocks, so the parent
  has at most the one child it is waiting for. Keeping it out of the schema keeps the small-model
  surface minimal, which is the stated reason the strip exists at all (`src/agents.js:126-130`).
- **`task` stays denied** on every role, so opencode's blocking native task tool stays hidden and
  `src/config.js:143-146` keeps its meaning.
- **`researcher` never spawns.** This is the rule's own carve-out — it must search itself — and it
  is also the structural depth bound below.

**The target allowlist and the depth bound**

A subagent may spawn **`researcher` only**. Enforced in `spawnHandler`, keyed on the caller being a
subagent, beside the existing agent-type gate (`src/tools.js:243-258`) and phrased in the same shape
(a returned refusal that names what is available, not a throw).

This bounds the depth at exactly one level **structurally, with no counter and no session-tree
walk**: the only legal target is itself denied `spawn`, so a grandchild can never have children.
That is the cheapest possible form of the "bound the depth to one level" option the briefing raises,
and it is what makes option A's fixes finite (a teardown has to consider one generation of children,
never a tree).

Alternative considered: a `depth` field on the registry entry, incremented from the parent's entry
at `upsertSession` (`src/registry.js:250-266`) and refused above 1. It costs one field and one check
and permits any target — but it buys generality nobody asked for and turns every teardown into a
recursive walk. Rejected; the field can be added later if a second nestable target ever appears.

Do **not** use `permission.task`'s object form as the allowlist: an object value would stop
opencode's schema strip from hiding the native `task` tool for that role (`src/config.js:143-146`),
re-exposing a blocking tool to exactly the small models the strip protects.

**Prompt changes**

- `SUBAGENT_GUIDE_CORE`, `src/prompts.js:51` — the sentence `"You cannot spawn agents…"` is
  currently injected into **every** subagent (`src/hooks.js:309`). It splits in two: the existing
  text for non-delegating roles, and for delegating ones a `SUBAGENT_DELEGATION_GUIDE` block stating
  what `spawn` is for, the single legal target, the per-run quota (§4.3), and that the child's
  result arrives as the tool result rather than as a wake.
- `DEBUGGER_PROMPT`, `src/agents.js:69` — `"you do not spawn anyone"` must go; the debugger is a
  delegating role.
- The injection point in `hooks.js` picks the block by role, the way `OUTLINE_DISABLED_AGENTS`
  already picks the outline block (`src/hooks.js:101`, `:310-312`).

### 4.3 Keeping delegation from becoming the normal working mode

Three layers, weakest to strongest. **Recommendation: all three; the runtime quota is the one that
actually binds.**

1. **Prompt (necessary, not sufficient).** The delegation block states the trigger explicitly:
   spawn only for work that would cost more of your own context than its answer is worth —
   summarising a long document, a broad search. Never for work you can do with `read`, `grep` or
   `outline`. Never to hand off your own deliverable.
2. **Budget (already built, no code).** The child's result lands in the parent's context as a tool
   result, so it counts against the parent's own per-agent budget
   (`contextBudgetFor`, `src/settings.js:372-378`), and a parent over budget has every tool denied
   and is locked to a text handover (`src/hooks.js:1120-1148`). A role that delegates habitually
   runs itself out of budget and reports early. This is the economic brake and it needs nothing new.
3. **Runtime guard (the hard limit).** A per-run quota, default **2 nested spawns per subagent
   run**, held as `nestedSpawns` on the parent's registry entry (a new field in `createEntry`,
   `src/registry.js:908-968`) and checked in `spawnHandler` before the cap check. The refusal names
   the count and tells the parent to do the work itself or report what it still needs. Runtime, not
   prompt, because the failure mode is a small model looping — the same reason the back-to-back
   `list` denial exists (`src/hooks.js:1177-1182`).

A settings key `maxNestedSpawns` resolves file > env > default the way every other knob does
(`src/settings.js:236-344`); `0` disables nesting entirely and is the escape hatch for a user who
does not want it. It joins the defaults-parity pair pinned by
`test/settings-defaults-parity.test.js`.

Not recommended: making delegation cost a slot of `maxSubagents`. It reads like a brake but is the
deadlock of break 4 — see §4.4.

### 4.4 What the limits block and the run-size accounting must show

**The cap.** Rule: **the cap gates spawns from a primary only; a nested spawn is admitted
unconditionally but is still counted.** `countActiveSubagents` stays exactly as it is
(`src/registry.js:186-193`), so a grandchild raises the number the orchestrator sees, raises
`isQuiesced`'s count (`src/registry.js:863-870`) and delays an endless cycle correctly. Only the
*check* at `src/tools.js:345-356` is skipped for a nested caller. Without this split, the default
`maxSubagents = 1` (`src/settings.js:73`) makes every nested spawn a deadlock. The nested run stays
bounded by the per-run quota of §4.3 and by the one-level depth bound of §4.2.

**The limits block.** `formatLimitsNotice` is built only for primaries today —
`if (!isSubagent) { … limits = formatLimitsNotice(…) }` (`src/hooks.js:199-271`), and
`guideParts` pushes it only on the primary branch (`src/hooks.js:315-319`). A delegating subagent
therefore has no idea what a `researcher` costs or what the package rule is. It must get a reduced
block carrying: its own context budget, the `researcher` budget with its fixed overhead and headroom
(`fixedOverheadFor`, `src/hooks.js:665-670`), the two package shares
(`PACKAGE_WARN_SHARE` / `PACKAGE_REFUSE_SHARE`, `src/settings.js:352-353`), and its remaining nested
quota. The primary's block is unchanged.

**The subagent snapshot.** `transformMessages` gives a subagent the over-budget notice and a primary
the active-subagent snapshot, never both (`src/hooks.js:398-409`). Under option A a waiting parent is
blocked inside a tool call and has no LLM turn in which to read a snapshot, so **no change is needed
here** — a deliberate non-change, and a point to re-open if option B is ever taken.

**Run-size accounting.** Today the completion notice reports the finished run against its own type's
budget and names the package the orchestrator sent
(`runSizeNotice`, `src/notices.js:76-101`; `packageTokens` carried from the spawn gate,
`src/tools.js:390-399`). A nested run is invisible in that figure: the parent's `ctxTokens` include
the child's *returned text* but not what the child burned internally. Two additions:

1. A `nestedTokens` accumulator on the parent's entry, summed from each child's `ctxTokens` at the
   moment the waiter is resolved.
2. `completionNotice` (`src/notices.js:45-63`) gains one line when `nestedTokens > 0`:
   `"⤷ nested: N runs, ~X tokens (not counted in the figure above)"`. The verdict tone of
   `runSizeNotice` keeps measuring the parent's own run against the parent's own budget — mixing the
   two would make a well-scoped parent look oversized — but the orchestrator sees the true cost of
   the delegation and can stop paying for it.
3. The spawn gate itself needs no change: `packageSizeVerdict` already sizes against the *target*
   type's budget (`src/tools.js:93-95`, `contextBudgetFor(agent)`), which is correct for a nested
   spawn as it stands.

**Nested spawns carry no task id.** The `T<n>` prefix drives the TODO.md auto-tick
(`extractTaskId`, `src/tools.js:57-62`; `autoMarkTask`, `src/hooks.js:1008-1033`) and the duplicate
guard is scoped per caller session (`activeTaskIdsFor`, `src/registry.js:272-280`). A nested spawn is
preparation, not a task, and must be refused if it carries a prefix — otherwise a child ticks a task
the orchestrator is still tracking against its parent.

---

## 5. Target state and the step sequence

Each step leaves the tree building (`npm run check`) and its tests green (`npm test`), and can be
handed out on its own.

**S1 — web denies and the prompts they force (rule 1, complete).**
`NO_WEB_ACCESS` added; entries applied to planner, coder, debugger, reviewer, documenter, designer;
prompts at `src/agents.js:54`, `:72`, `:202` rewritten to name the `researcher` route in prose (no
`spawn` mention yet — that arrives in S6); researcher prompt gains its "never delegate the
searching" sentence; README rows updated; a test pins the per-role web denies.
*Depends on: nothing.* Ships rule 1 whole and is independently useful.

**S2 — split the delegation constants, no behaviour change.**
`SUBAGENT_NO_DELEGATION` → `SUBAGENT_NO_DELEGATION` + `NO_SPAWN`, with `NO_SPAWN` spread into all
eight roles so the resulting maps are byte-identical to today. The existing test at
`test/plugin.test.js:546-558` must still pass unmodified.
*Depends on: nothing.* Pure refactor, isolates the risky step.

**S3 — the child-waiter mechanism (option A), still unreachable.**
`pendingChildResults` map in `state.js`; resolution wired into `onSessionIdle`
(`src/hooks.js:849-892`) and `teardownSubagent` (`src/teardown.js:69-102`) so completion, error and
watchdog timeout all resolve exactly one waiter; a waiter timeout derived from `maxSubagentAgeMs`.
Unit-testable end to end with a mock client and no role change.
*Depends on: S2.*

**S4 — the five nesting fixes, still unreachable.**
(a) child-first teardown: before `deleteSession` on any entry, abort and delete its live children
(`src/client.js:141-148`, `src/teardown.js:92`, `src/tools.js:494`);
(b) watchdog exemption for an entry with a live child, valid only while that child is itself
watchdogged (`src/watchdog.js:65-86`);
(c) the cap check skipped for a nested caller, the counter untouched (`src/tools.js:345-356`);
(d) `isEndlessFrozen` consulted for the caller's **root** primary via a new `rootPrimaryFor`
walking `entry.parentID` (`src/tools.js:222`, `src/registry.js`);
(e) `forgetPrimary`-equivalent cleanup so a spawning subagent's session does not leak into
`primarySessions` (`src/registry.js:36-38`, `:54-79`).
*Depends on: S3.* Each sub-point has its own test; none is reachable from a role yet.

**S5 — the spawn gate for a subagent caller.**
Replace the blanket refusal at `src/tools.js:200-208` with: subagent caller → require the caller's
role to allow `spawn`, require the target to be `researcher`, require no `T<n>` prefix, require the
nested quota; then take the blocking path. Non-delegating roles keep the exact refusal text they
have today.
*Depends on: S4.* This is the step where nesting becomes reachable — but only for a role whose map
still says `spawn: "deny"`, so nothing changes in practice yet.

**S6 — grant `spawn`, prompts, limits block, accounting.**
`NO_SPAWN` dropped from planner/coder/debugger/reviewer/documenter; `SUBAGENT_DELEGATION_GUIDE`
written and injected per role (`src/hooks.js:306-319`); `src/agents.js:69` corrected; the reduced
limits block for delegating subagents; `nestedTokens` and the notice line
(`src/notices.js:45-63`); `maxNestedSpawns` in settings plus its parity entry.
*Depends on: S5.* This is the first commit at which behaviour visibly changes.

**S7 — live verification.**
One e2e run under `test/e2e/` (`test/e2e/README.md`): orchestrator → planner → researcher, asserting
that the planner's tool result carries the researcher's answer, that both sessions are gone
afterwards, that TODO.md is untouched by the nested run, and that the orchestrator's completion
notice carries the `⤷ nested:` line. Plus the negative run: a planner attempting a second-level
nest, and a designer attempting any spawn.
*Depends on: S6.*

---

## 6. Assumptions

Each is something taken as given that could not be read anywhere in this tree.

1. **opencode does not time out a long-running plugin tool call.** Option A blocks the parent's
   `spawn` call for the child's whole run. `guard` (`src/tools.js:134-143`) has no timeout of its
   own and the SDK wrappers set one only on `session.messages`
   (`SNAPSHOT_TIMEOUT_MS`, `src/client.js:187`).
   *Holds if:* opencode's tool executor imposes no wall-clock limit on a plugin tool.
   *Falsified by:* a nested run longer than the limit coming back as a tool error while the child's
   session finishes normally. *Fallback if false:* cap the waiter below that limit and return a
   "child still running, its result will not reach you" refusal — degrading to today's behaviour.
2. **A session blocked in a tool call emits no events of its own.** This is what makes break 3 real
   and fix S4(b) necessary. Read from `src/hooks.js:731-735`, which bumps `lastActivityAt` only from
   `props.sessionID ?? props.info.id`.
   *Falsified by:* the debug log showing the parent's `lastActivityAt` advancing during a >90 s
   child run. Then S4(b) is redundant but harmless.
3. **`Permission.disabled` strips a plugin-registered tool by name exactly as it strips a built-in.**
   The whole of rule 1 and the per-role `spawn` grant rest on it. Asserted by the module header
   (`src/agents.js:6-8`) and by the shipped `designer.websearch` / `gitter.web_search` denies, but
   the strip itself lives in opencode.
   *Falsified by:* a denied role still seeing `web_search` in its schema; the runtime re-check
   (`src/config.js:147-160`) would still deny the call, at the cost of the denial-loop risk the
   header warns about.
4. **The DELETE cascade is recursive over the whole subtree, not one generation.** Taken from
   `src/client.js:141-148` and `src/handoff.js:309-317`. S4(a) is written to be correct either way
   (it deletes children before parents), so nothing rests on the depth.
5. **A `researcher` child is a satisfactory substitute for in-role search for every role that loses
   it.** No measurement exists in this tree either way. *Falsified by:* delegating roles reporting
   "blocked, need a lookup" at a materially higher rate after S1. The observation is available from
   the completion notices without new instrumentation.
