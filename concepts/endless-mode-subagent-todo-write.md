# Concept: the wind-down subagent writes the todo file

Boundary: the `opencode-agent-intercom` plugin under `/home/wu/opencode-agent-intercom`.
Nothing outside `src/`, `specs/`, `test/` is designed here. The material read for this
concept is `specs/endless-mode.md`, `src/endless.js`, `src/handoff.js`,
`src/handoffwiring.js`, `src/todofile.js`, `src/openpoints.js`, `src/tools.js`,
`src/hooks.js`, `src/agents.js`, `src/childwait.js`, `src/registry.js`, `src/notices.js`,
`src/settings.js`, `src/state.js`, `src/client.js`, plus
`work/code-explorer-endless-implementation.md`, `work/reader-endless-mode-spec.md` and
`work/diagnostician-endless-stall.md`.

---

## 1. What the code does today, with the line behind each statement

**The plugin writes the todo file; the orchestrator only speaks.** The cycle asks the old
primary for a shaped plain-text turn, parses it, and appends one task per point:

- `src/handoff.js:455-469` — `OPEN_POINTS_PROMPT`: *"emit ONE final plain-text reply
  listing EVERY point that is still open … Use EXACTLY this shape … `## OPEN POINTS` …
  Draw them from your context ONLY — do NOT read files from disk and do NOT spawn
  anything."*
- `src/endless.js:327` — `const points = parseOpenPoints(openPointsText)`; a reply without
  the heading yields `null` and `src/endless.js:329` abandons the cycle.
- `src/endless.js:369` — `const { id } = addTask(point)`, once per point, deduped on
  `normaliseTitle` (`src/endless.js:359`).
- `src/endless.js:385-389` — the confirmation: `const present = new Set(openTasks.map((t)
  => t.id))` / `const missing = ids.filter((id) => !present.has(id))` / abandon on
  `"${missing.join(",")} missing from the todo file after the write"`.

**Spawning is frozen for the whole cycle.** `src/tools.js:402`:
`if (isEndlessFrozen(rootPrimaryFor(toolCtx.sessionID))) {` — a primary caller gets the
throw at `src/tools.js:413-417` (*"No new subagent will start. End your turn now — the work
you would delegate belongs in your open points"*), a nested caller the refusal string at
`src/tools.js:406-411`. `reuse` throws the same way at `src/tools.js:902-908`. The freeze
covers both latch phases: `src/registry.js:1519-1520`,
`return pendingEndless.has(sessionID) || endlessInProgress.has(sessionID)`.

`specs/endless-mode.md:56-57` states the reason the freeze must exist at all: *"Between the
latch and quiesce the orchestrator is still answering its turn and can call `spawn`. Left
alone, an orchestrator that spawns as fast as its subagents finish never quiesces."*

**The orchestrator holds four tools and no file access.** `src/hooks.js:140-147` —
`const PRIMARY_TOOLS = new Set(["spawn", "abort", "list", "reuse"])`; the role's own
permission map denies the rest (`src/agents.js:301-304`: `read: "deny", edit: "deny",
bash: "deny" … glob: "deny", grep: "deny", todos_open: "deny", todo_done: "deny",
todo_add: "deny", todo_edit: "deny"`).

**The successor is handed the task list inline.** `src/endless.js:140-168`
(`endlessKickoffBlock`) renders the read-back through `formatOpenTasks`
(`src/endless.js:104-120`) because, per the comment at `src/endless.js:128-131`, *"A primary
holds spawn / abort / list / reuse and nothing else (PRIMARY_TOOLS, src/hooks.js), so the
successor cannot open the todo file."*

**A subagent's `DONE:` marker deletes lines all session long, outside any cycle.**
`src/hooks.js:2021` — `const MARKER_RE = /^\s*DONE:\s*(T\d+)\s*$/i` — drives
`removeTask(directory, taskId)` at `src/hooks.js:2050`, from the completion path at
`src/hooks.js:1602`, in every project and with no snapshot and no verification anywhere
near it. Its outcome is rendered for the orchestrator by `taskOutcomeLine`
(`src/notices.js:35-66`).

**Three defects the live run exposed** (`work/diagnostician-endless-stall.md`):

1. `src/todofile.js:95` — `const TASK_LINE_RE = /^(\s*)- (T\d+):\s*(.*)$/` does not match
   the task lines actually in the file in use (`- T45 — docs catch-up: …`, em-dash instead
   of colon). `listOpen` therefore returned `[]` on a file full of tasks, and
   `nextFreeIdFrom` (`src/todofile.js:233-241`) restarted at `T1` on a file already using
   T1–T8 and T45. The consequence is on record three times over as
   `"task T45 not found in todos.md"` (diagnosis lines 96-98).
2. `src/todofile.js:288-289` — `const sep = content === "" || content.endsWith("\n") ? ""
   : "\n"` / `writeAt(directory, target, content + sep + block)`: the append is
   heading-blind, so the three saved points landed under the human `## Not now` section
   while `## Open` still read `None.`
3. The confirmation of `src/endless.js:385-389` reported `confirmed=3` on that file. It is
   tautological: it re-reads the three lines the plugin itself has just appended, in the one
   shape the parser does match, and says nothing about the file as a whole.
   The read-back is therefore weaker in practice than the spec claims at
   `specs/endless-mode.md:118-123`.

Out of this boundary and owned by a separate run: the visible failure of that run was
`selectTuiSession` (`src/client.js:875-907`), whose direct post *"carries no authorization
header"* (`src/client.js:868-871`) and which failed to connect, so the TUI stayed on the
predecessor and a healthy cycle looked like a stall. Nothing in this concept changes
`src/client.js`, and no step of §8 touches it.

---

## 2. What the owner's restatement overturns

| the restatement | what it contradicts |
|---|---|
| a subagent updates the todo file | `src/endless.js:369` `addTask(point)` and the whole `parseOpenPoints` path; `specs/endless-mode.md:214-222` §2.3, which rejects exactly this option |
| exactly one spawn is allowed, after all running subagents have finished | `src/tools.js:402-418`, an unconditional freeze; `specs/endless-mode.md:61`, which makes the unconditional refusal the recommended row |
| the file must let the successor carry on at the point the predecessor stopped, by content or by link | the two-line `- T<n>:` / `accept:` shape carries a title and a criterion and nothing else (`src/todofile.js:8-21`) |
| the successor gets the file's content automatically | the successor gets a *rendering of the plugin's parse* (`formatOpenTasks`, `src/endless.js:104-120`), not the file |

---

## 3. The decisions

### 3.1 Who starts the wind-down subagent

| shape | cost | what it forecloses | what it demands |
|---|---|---|---|
| **the orchestrator spawns it under a single-use permit; the plugin spawns it itself only if the permit expires unused** (recommended) | a permit record in the registry, one branch in `spawnHandler`, one shared start helper | nothing — the fallback keeps the mode alive on a model that cannot place the call | a token the plugin generates and the model must echo, and an atomic single-use consume |
| the orchestrator alone spawns it | no fallback code | the cycle on a weak model: a session at its ceiling that fails to emit one correct tool call abandons every cycle, five minutes of cooldown apart | trusting a tool call where `specs/endless-mode.md:224-226` argues text is the only reliable output at the ceiling |
| the plugin alone spawns it, freeze untouched | simplest; no permit at all | the owner's stated flow — the orchestrator never starts the subagent | still one plain-text turn out of the primary to get the content |

Recommended: the first. It is the owner's flow on the normal path, and the third row is not
discarded but demoted to the failure path, where both entry points converge on one helper
(`startWindDownSubagent`) and on one confirmation. The deciding argument is that the two
paths differ only in *who calls the helper*: the briefing text, the agent type, the standing
instruction block, the waiter and the verification are identical, so the fallback costs one
call site rather than a second mechanism. Because the fallback is not optional — between a
cut-over without it and a model that places no tool call lies an abandon on every cycle — it
is built in the same step as the cut-over (§8, S5).

**The role is `planner`.** It is the only role that already holds everything the job needs
and nothing it does not: `read`, `write`, `edit`, `glob`, `grep`, and
`todos_open`/`todo_add`/`todo_edit`/`todo_done` (`src/agents.js:307-313`, whose permission
map denies only `SUBAGENT_NO_DELEGATION`, `NO_WEB_ACCESS` and `bash`), and its role prompt
already owns the todo file (`src/agents.js:66-71`, `TODO_TOOLS_BLOCK`). `coder` would bring
`bash`; a new tenth role would duplicate `planner` for one call site.

### 3.2 How the plugin recognises the one permitted spawn

A permit is a record in `src/registry.js`, keyed by primary session id:

```
{
  token: "<16 hex chars>",
  agent: "planner",
  consumed: false,
  restores: 0,            // how often a consume was given back; capped at 1
  childSessionID: null,   // set at admission, once the child session exists
  settlement: null,       // the child waiter's promise — the cycle's gate
}
```

Six functions beside the existing endless state: `armEndlessWindDown(primaryID, {token,
agent})`, `endlessWindDownPermit(primaryID)`, `consumeEndlessWindDown(primaryID, {token,
agent})`, `restoreEndlessWindDown(primaryID)`, `noteEndlessWindDownChild(primaryID,
{childSessionID, settlement})`, `disarmEndlessWindDown(primaryID)`.

Admission requires **all five** of:

1. `endlessInProgress.has(root)` — a permit is never armed in the `pendingEndless` phase, so
   the window cannot open before the cycle is claimed;
2. the caller *is* the root primary (`toolCtx.sessionID === rootPrimaryFor(toolCtx.sessionID)`),
   so `nested === true` never reaches the branch;
3. `args.agent === "planner"`;
4. the first non-empty line of `args.prompt` is exactly `INTERCOM-WIND-DOWN <token>`, the
   token being per-cycle random and appearing nowhere but in the wind-down prompt the plugin
   sent to that one primary;
5. the permit is unconsumed, and consumption happens **in the same synchronous block as the
   test**, before any `await` — the discipline `reservePendingTaskId` already follows for the
   identical reason at `src/tools.js:503-529` (*"a bare check … would leave a TOCTOU window:
   two spawn() calls in the same turn carrying the same task-id both pass"*).

**The consume is a reservation, not a burn.** Everything that can still fail sits *after*
the synchronous consume: `createChildSession` returning no session id
(`src/tools.js:611-620`) and `promptSession` throwing (`src/tools.js:646-660`). A transient
5xx on either would otherwise burn the single permit — the orchestrator reads *"Failed to
create subagent session"*, has no second call, and the fallback of §5 does not fire because
its condition is an unconsumed permit, so the cycle sits out the whole window before
abandoning. So the permit follows `reservePendingTaskId` / `releasePendingTaskId`
(`src/registry.js:851`, released in the single `finally` at `src/tools.js:783`) in both
directions:

- `consumeEndlessWindDown` marks `consumed: true` synchronously at admission;
- `restoreEndlessWindDown` puts it back — same token, `childSessionID: null`,
  `restores += 1` — in exactly the two branches that end before the child was prompted:
  the create failure and the prompt-throw cleanup;
- the restore is capped at `restores < 1`. A second failure leaves the permit consumed and
  the cycle goes to the failure table's *consumed but no child* row, so the loop cannot
  reopen the window indefinitely;
- the refusal text returned on those two branches names the repeat explicitly: *"the
  wind-down spawn did not start (<reason>). You may repeat that one call ONCE, unchanged."*

Once `createChildSession` has returned a session id, the permit records it and the waiter's
promise through `noteEndlessWindDownChild`. That record, not the primary's text, is what the
cycle waits on (below).

What keeps the exception from becoming a general reopening:

- single use, consumed atomically at admission; a second spawn in the same turn finds
  `consumed: true` and throws; a restore is possible once and only from the two branches
  that never prompted a child;
- one agent type and one token, both chosen by the plugin;
- **the plugin composes the child's prompt; the orchestrator supplies a payload, not
  instructions.** `args.prompt` is not passed through. The plugin builds
  `WIND_DOWN_SUBAGENT_PROMPT` = its own instruction block, then a fixed
  `## HAND-OVER FROM THE PREVIOUS ORCHESTRATOR` heading carrying the orchestrator's text
  with the `INTERCOM-WIND-DOWN <token>` line stripped and the whole payload capped at
  `WIND_DOWN_PAYLOAD_MAX_CHARS` (32 000 — the bound §3.2's package-size exemption already
  needs), then `WIND_DOWN_SUBAGENT_CONTRACT`. Without this the permit would hand the
  orchestrator one arbitrary file-writing `planner` run whose task it chooses, in the
  session's own directory — a widening §2.3 never decided on;
- armed at exactly one call site, between the quiesce wait and the wind-down turn — never
  before quiesce, so §3.3's argument that a fast-spawning orchestrator can never avoid
  quiescing stands untouched;
- disarmed in a `finally` on every exit of `runEndlessCycle`, and by `forgetPrimary`, which
  already clears the endless flags at `src/registry.js:126-130`;
- the refused throw, while a permit is armed, is *replaced* by a text that spells out the one
  spawn that is allowed, so a wrong attempt self-corrects instead of exhausting the window;
  a refusal never consumes the permit;
- `reuse` keeps its unconditional throw (`src/tools.js:902-908`): its targets are retained
  subagents, which step 2b of the cycle has already dropped (`src/endless.js:281-289`);
- the wind-down subagent is itself under the freeze, so its own nested spawns still take the
  nested refusal at `src/tools.js:406-411`. The exception does not propagate downward.

**The permitted spawn blocks, and the child's settlement — not the primary's text — is the
gate.** `src/tools.js:634` registers a child waiter for nested spawns only:
`if (nested) childResult = registerChildWaiter(sessionID, toolCtx.sessionID)`. The wind-down
path registers one too (`if (nested || windDown)`), which `src/childwait.js:22-24` explicitly
permits: *"the parent of a waited child may be a primary as well as a subagent, and a primary
has no registry entry at all."*

The blocking is a convenience, not a proof. What `requestDocSummaries` polls is
`fetchSnapshot(...).result` = `finalResult(messages)` (`src/client.js:663-671`), which joins
the text parts of the **newest assistant message** — and the text a model emits *before* its
tool call sits in that same assistant message. A model that writes `## WIND-DOWN DONE` and
then calls `spawn` would satisfy `looksLikeWindDownReply` while the child is still rewriting
the file, and `confirm` would then read a file mid-rewrite (`writeAt`,
`src/todofile.js:170-188`, is `O_TRUNC` + `writeFileSync`, so a concurrent read can see a
truncated file) or an unchanged one. So:

> The shaped reply is the signal that the turn is over. The proof that the write finished is
> the child's own ending: the permit's `childSessionID` is gone from the registry **and** its
> `settlement` promise has resolved. `runEndlessCycle` awaits that settlement before V1 runs,
> on both the normal and the timed-out path.

**The child's own ceiling is set explicitly, inside the turn window.**
`registerChildWaiter` already takes it — `src/childwait.js:153`,
`registerChildWaiter(childSessionID, parentSessionID, { timeoutMs } = {})`, documented at
`src/childwait.js:146-147` as *"`timeoutMs` overrides the derived ceiling (0 disables it)"*.
The derived ceiling is unusable here: `childWaiterTimeoutMs()` is
`CHILD_WAITER_TIMEOUT_FACTOR (4)` × `max(maxSubagentAgeMs, maxSubagentToolCallMs)` = 4 ×
660 000 = **2 640 000 ms** at the defaults, three times the turn window. The wind-down path
therefore passes

```
timeoutMs = endlessWindDownTimeoutMs − DOC_SUMMARY_POLL_MS
```

so the waiter's own expiry lands strictly before the turn window closes.

One residue stays and is named rather than papered over: the ceiling **re-arms** while the
child is still a tracked registry entry (`src/childwait.js:200-215`), so an explicit
`timeoutMs` bounds only a child the watchdog no longer owns. A tracked child is bounded
instead by the watchdog (`maxSubagentAgeMs` / `maxSubagentToolCallMs`), whose teardown
settles the waiter — except where the user has switched the silence watchdog off (the
sidebar's `0` / `off`), in which case nothing bounds it. The cycle therefore carries its own
last resort: when the settlement has not arrived by `endlessWindDownTimeoutMs` counted from
the spawn, the plugin **ends the wind-down child itself** (the ordinary abort + teardown
path, which settles the waiter) and only then abandons. Nothing may leave a writer running
into the next cycle's snapshot.

Five gates the admitted spawn is exempted from, each for a stated reason:

| gate | line | why exempt |
|---|---|---|
| multi-task bundle guard | `src/tools.js:472-482` | the briefing names every open task id by design; the guard exists against a coder batch |
| package-size refusal | `src/tools.js:492-500` | the briefing is the whole hand-over; a refusal here would abandon the cycle over its length. The bound moves to `WIND_DOWN_PAYLOAD_MAX_CHARS`, applied by the plugin when it composes the child prompt |
| duplicate-task-id reservation | `src/tools.js:503-529` | the prompt carries no single task id to reserve |
| global spawn cap | `src/tools.js:579-588` | quiesce is scoped to this primary (`countActiveSubagentsFor`, `specs/endless-mode.md:45-47`); another orchestrator's subagents must not block the wind-down. §9 names what that admits |
| retention | `src/hooks.js:1564` area | the cycle drops every retained session anyway (`src/endless.js:281-289`) |

### 3.3 What remains of the verification

The plugin no longer assigns ids, so id-matching goes. What replaces it is strictly
stronger, because it reads the file as a whole rather than the lines the plugin itself
appended — which is exactly the tautology §1 point 3 exposed.

Before the spawn the plugin has already **created and written** the marked section where it
was absent (§3.4.3, §4 step 4), then snapshots: the resolved target (`findTodoFile`,
`src/todofile.js:130-141`), the raw content, its SHA-256, the section split, and
`parseTasks` over it. After the child has settled (§3.2) it re-resolves and re-reads, and
**all** of these must hold or the cycle abandons without replacing the session:

| # | predicate | on failure |
|---|---|---|
| V1 | `findTodoFile` resolves to exactly one regular file, same name as the snapshot | abandon (`multiple` / `not-a-file` / renamed) |
| V2 | the child's outcome is `completed` (`src/childwait.js:52-58` enumerates the others) | abandon unless V3–V6 all hold anyway |
| V3 | the content hash differs from the snapshot, **or** the reply carries `## WIND-DOWN DONE — no change` | abandon |
| V4 | the marked region is intact and everything outside it matches `expectedOutside`, per the algorithm below | restore the snapshot, then abandon |
| V5 | `parseTasks` over the new content yields ≥ 1 task, every id unique, every title non-empty | restore the snapshot, then abandon, except the explicit-empty case below |
| V6 | no id present in the snapshot has been re-bound to a different title | restore the snapshot, then abandon |
| V7 | the reply's stated open-task count equals the parse's | log the mismatch; the parse wins, no abandon — an observation beats an assertion |

**V4, stated as an algorithm over lines.** A removal shifts every byte after it, so
"byte-identical" cannot be literal, and the migration §3.4.3 promises moves more than the
header lines the parser matches. Define:

```
markedRange(content)   the line range from the single `<!-- intercom:begin -->` line to the
                       single `<!-- intercom:end -->` line, inclusive
outsideLines(content)  content.split("\n") minus markedRange(content)
blockRange(task)       the task's header line, the contiguous indented run under it, and at
                       most ONE immediately following blank line
expectedOutside        outsideLines(snapshot) minus blockRange(t) for every task t the
                       widened parser found in outsideLines(snapshot)
```

V4 holds iff **both**: the new content carries exactly one `begin` and one `end` marker, in
that order (a subagent that deleted, duplicated or reordered them fails here); and
`outsideLines(new)` equals `expectedOutside` as a sequence of strings. Anything else — an
edited legacy line, a reflowed human paragraph, a removed blank line elsewhere, an added
heading — fails. The one licensed outside-change is therefore exactly the migration: whole
task blocks the parser recognised in the snapshot leave the outside region. The set is
computed by the plugin from its own snapshot, never asserted by the subagent.

The explicit-empty case: `parseTasks` yields zero tasks **and** the reply carries
`## WIND-DOWN DONE — nothing open`. That is not a failure; it routes into the existing stop
of `src/endless.js:399-401` (*"no open points left — paused for this session"*) and the
session is not replaced, because a successor with an empty file *"would idle and be woken by
nothing"* (`specs/endless-mode.md:449-452`).

**A rejected rewrite is undone.** Prepare holds the exact snapshot bytes, and a failure of
V1, V3, V4, V5 or V6 means the file on disk is a rewrite the plugin refuses to stand behind
— a reformatted human section, a deleted heading, a half-written list. Before abandoning,
the plugin writes the snapshot back through `writeAt` and logs
`endless: wind-down rewrite rejected — the todo file was restored`. Where the restore itself
throws, the error toast names the path and the failed predicate, so the damage is at least
addressed to the user rather than silent. V1's `multiple` / `not-a-file` / renamed case is
the one exception: there is no resolved file to write back to, and the toast names the
snapshot path and the original name.

So: the parse survives and becomes the sole verification, moving from *"parse the model's
words into the tasks the plugin writes"* to *"parse the file the subagent wrote, as the
observation that the save happened"*. The invariant of `src/endless.js:31-33` — no
replacement without a confirmed save — is preserved by V1–V6 as a set.

### 3.4 The format, the section anchor and the id allocation

There is no free choice here: the `- T<n>:` shape is load-bearing beyond the endless cycle.
`src/hooks.js:2021` (`const MARKER_RE = /^\s*DONE:\s*(T\d+)\s*$/i`) drives
`removeTask(directory, taskId)` at `src/hooks.js:2050`, and the todo tools
`todo_add`/`todo_edit`/`todo_done` run all session long, not only at wind-down. A file
without machine-readable ids breaks the whole work-off loop, which is what the three
`"task T45 not found"` errors are.

Decided:

1. **One file per project directory**, resolved as today. Two files are not designed for:
   `findTodoFile`'s `statSync` fast path (`src/todofile.js:131-136`) silently gives
   `TODO.md` precedence over a differently-cased sibling, so a `TODO.md` + `todos.md` pair
   coexists by accident rather than by design, and splitting the hand-over across two files
   contradicts *"the information must either stand in the todo file or be linked from it"*.
2. **The parser widens; the writer narrows.** `TASK_LINE_RE` becomes
   `/^(\s*)[-*]\s+(T\d+)\s*(?::|—|–|-)?\s+(.*)$/` so the em-dash lines already in use are
   read as the tasks they are instead of being orphaned; every writer — `addTask`,
   `editTask`, the wind-down subagent — emits only the canonical `- T<n>: title` form, so
   drift heals within one cycle. Which read uses which shape is §3.4.7, and it is what keeps
   the widening from turning `DONE: T1` into a deletion of human prose.
3. **A machine-owned section, named and fenced.** The section is `## Intercom tasks`, and
   it is delimited by two HTML-comment markers the plugin writes and owns:

   ```
   ## Intercom tasks
   <!-- intercom:begin -->
   - T46: <title>
     accept: <criterion>
     link: specs/endless-mode.md §3.4
   <!-- intercom: next-id T47 -->
   <!-- intercom:end -->
   ```

   The markers, not the heading, are the authority. A heading can be renamed, translated or
   demoted by a human without the plugin losing its section, and the comparison of V4 is
   defined on *outside the markers* rather than on *outside a heading whose text a model
   may have touched*.

   **The plugin creates the section; the subagent never does.** Where the markers are
   absent, the plugin inserts the heading and the two markers — immediately after the first
   heading matching `/^#{1,6}\s+(open|pending|todo|todos)\b/i`, or at the end of the file
   where there is none — **and writes the file**, before it takes the snapshot (§4 step 4).
   This is not a detail of ordering. Every project's first cycle meets a file without
   markers, including this repository and `/home/wu/vantage/todos.md`; had the subagent
   created the region, the snapshot's outside region would be the whole file and the new
   content's outside region would carry an added heading the snapshot lacks, so V4 would
   fail by construction on the first cycle everywhere. The same insertion is what `addTask`
   calls when a `todo_add` meets an unmarked file, so there is one implementation
   (`ensureSection(content)`) and one result.

   **A name collision is not resolved by taking the section over.** The live file
   (`/home/wu/vantage/todos.md`) has a `## Open` section holding human prose —
   `None. Chat-develop-via-UI stays NONE (\`plan.md\` §17)` — and prose under a heading the
   plugin adopted would be inside the region the subagent may delete. So the plugin never
   adopts an existing section: it inserts its own `## Intercom tasks` heading with its
   markers *after* the human section, and the human prose stays outside the markers, where
   V4 protects it line for line. Only if a heading `## Intercom tasks` already exists **and**
   carries the two markers is it reused; a heading of that name without markers is treated
   as human text and the plugin inserts a fresh, marked section below it.

   **This repository's own `todos.md` is not migrated.** Its `## Pending` bullets stay
   exactly as they are, human text outside the markers; the plugin inserts its marked
   section beside them and reads zero open tasks here until something writes one. That is
   the owner's decision and it is the same rule as everywhere else — the plugin owns its
   region and nothing beyond it.

   The one cost on `/home/wu/vantage/todos.md`: it will carry both a human `## Open` and a
   machine `## Intercom tasks`, and the existing `- T45 — …` lines stay where they are, read
   by the widened parser and moved into the marked section by the first wind-down subagent
   that runs — the one outside-change V4 licenses, and the one shape §3.4.7 keeps the
   ordinary `DONE:` path away from.
4. **`addTask` no longer appends at end of file.** The behaviour the diagnosis found —
   `writeAt(directory, target, content + sep + block)` at `src/todofile.js:288-289`, which
   put three saved points under a human `## Not now` — is removed, not left standing beside
   the new path. Every writer reaches the same insertion point: `addTask` inserts before
   `<!-- intercom:end -->` (calling `ensureSection` first where the markers are absent),
   `todo_add` reaches it through `addTask`, and the wind-down subagent is confined between
   the same two markers. There is one region, one rule, and no second way into the file.
5. **Ids become monotone.** `addTask` and the wind-down contract maintain a watermark line
   `<!-- intercom: next-id T46 -->` as the last line of the machine section. `nextFreeId`
   reads it when present; where it is absent it falls back to `max + 1` over a **widened**
   scan (`/^\s*[-*]\s+T(\d+)\b/` over every line, not only over parsed tasks) and writes the
   watermark on the next append. This kills the id-reuse class the diagnosis found — the id
   of a removed task is never handed out again — at the cost of one HTML comment in a human
   file, and it is what lets the no-progress bound key on ids (§3.4.8).
6. **Links live in the task block.** `parseTasks` gains ownership of the whole contiguous
   indented run under a task header, not only the one `accept:` line, and `removeTask`
   deletes that whole run. Without this, a `link:` line survives its task as an orphan when
   `DONE: T<n>` fires. That is what makes *"or linked from it"* implementable: a task may
   carry `accept:`, `link:` and `note:` lines and stays one block.
7. **Two shapes, one writer: the widening never reaches the deleting path.** The widened
   regex is a *reading* instrument only. It is used where a read must not miss a task:
   `listOpen`, `nextFreeId`'s scan, the drift count, and the pre-spawn snapshot's parse.
   `removeTask` and `editTask` act only on lines in the canonical `- T<n>: ` shape **inside**
   the markers. The reason is `autoMarkTask` (`src/hooks.js:2031-2056`), which fires on the
   `DONE: T<n>` marker of *any* subagent reply, all session long, in every project, with the
   endless cycle nowhere near it and V4 not applying: after a naive widening, a reply
   `DONE: T1` against `/home/wu/vantage/todos.md` would delete the human prose bullet
   `- T1 — reverse Pfeile …` and everything indented under it. Silent deletion of human text
   on the ordinary work-off path is not a cost this design pays for a parser fix.

   A `DONE: T<n>` whose id resolves only to a legacy line outside the markers therefore
   returns a new outcome `{ kind: "unmigrated", id }`. It is not an error and not a
   `no-todo`: `taskOutcomeLine` (`src/notices.js:35-66`) gains a case that tells the
   orchestrator the task is finished but still stands in a legacy line outside the plugin's
   section, and that the next wind-down will migrate it. The line is left untouched until it
   does.
8. **The no-progress bound keys on ids.** `recordEndlessCycle` (`src/registry.js:1642-1653`)
   compares normalised task **titles** across cycles, and its stated reason is that
   *"`nextFreeIdFrom` (src/todofile.js) reuses the id of a removed task"*. §3.4.5 removes
   that reuse. Titles must not stay the key, because the subagent now authors them: a cycle
   that merely rephrases the same open work reports every previous title as gone, `completed
   > 0`, `stalledCycles = 0`, and the one bound against the failure the mode invites — an
   orchestrator that saves the same points every 250 000 tokens and never finishes one —
   stops firing. So the record becomes `lastOpenIds` (`src/state.js:218`, reset at
   `src/state.js:365`), `recordEndlessCycle(openIdsFound, openIdsLeft)`, and `completed`
   counts the previous cycle's open ids that are no longer in the file. An id disappears
   only when a task is removed, and the watermark guarantees it is never handed out again.

### 3.5 What the successor gets

Both, and the split is deliberate:

- **Inline, automatic:** the kickoff carries the todo file's own text verbatim, bounded by
  `KICKOFF_TODO_MAX_CHARS` (16 000, the same order as today's 40 × 400 bound at
  `src/endless.js:88-96`), cut at a task-block boundary rather than mid-line. This is the
  literal reading of *"must get the todo file's content automatically"*, and it is strictly
  more than today's `formatOpenTasks` rendering: it carries the prose, the links and the
  section structure the parse cannot represent.
- **By subagent, conditionally:** where the text was truncated, or the file could not be
  read at all, the kickoff's first instruction is a `planner` spawn that reads the file in
  full and reports the rest — the one route a primary has, and the shape
  `src/endless.js:153-155` already uses.

Carrying the content inline alone would lose whatever exceeds the cap; instructing a read
alone would make the successor's first turn depend on a round trip that can fail, leaving a
fresh session with nothing in it. `formatOpenTasks` is therefore dropped and replaced by a
raw-text carrier. `KICKOFF_TASKS_MAX` / `KICKOFF_TASK_FIELD_MAX_CHARS`
(`src/endless.js:88-96`) go with it — they are `OPEN_POINTS_MAX` / `OPEN_POINT_MAX_CHARS`
from `src/openpoints.js`, which is the dependency that keeps that module alive, so this
change and the module's deletion belong in one step (§8, S5).

---

## 4. The cycle, step by step

Steps 1–3 are unchanged (`src/endless.js:222-316`): claim the latch, apply the cycle
ceiling, drop retained subagents, wait for quiesce bounded by `endlessQuiesceTimeoutMs`.
The freeze is in force throughout, as today.

**4. Prepare.** In this order:

1. resolve the todo file, creating the canonical `TODO.md` where the directory has none
   (`ensureTodoFile`, `src/todofile.js:261-275`, now exported), so the subagent has a
   definite target and `missing` cannot be confused with *deleted* afterwards;
2. `ensureSection` — insert the `## Intercom tasks` heading and the two markers where they
   are absent, per §3.4.3, and **write the file**;
3. only then snapshot: content, SHA-256, section split, `parseTasks`;
4. count bullet lines carrying a `T<n>` token that the parse does not return — the drift
   figure — and generate the permit token.

`multiple` / `not-a-file`, and a throw out of `ensureTodoFile` or the section write, abandon
here, before a turn is spent.

**5. Arm.** `armEndlessWindDown(primaryID, { token, agent: "planner" })`. This is the only
call site.

**6. The wind-down turn.** `promptOldPrimaryFor(client, sessionID, agentName, { prompt:
WIND_DOWN_PROMPT(token, fileName, driftCount), looksLikeReply: looksLikeWindDownReply })`,
over the existing baseline/re-baseline/poll discipline of `requestDocSummaries`
(`src/handoff.js:424`), with a timeout of `endlessWindDownTimeoutMs` (new key, default
900 000 ms — the subagent reads files and rewrites the list, which is minutes, not the 120 s
a text turn takes). `WIND_DOWN_PROMPT` says, in substance:

> Every subagent has finished and no further work will be delegated. You may make exactly
> ONE more tool call: `spawn("planner", …)` whose prompt's FIRST line is
> `INTERCOM-WIND-DOWN <token>`. Everything after that line is handed to the subagent as your
> hand-over: what is finished, what is open, what was decided and not yet carried out, what
> a subagent reported back as unfinished, and the path of every artefact that carries detail
> you cannot restate. The subagent updates `<file>` — it deletes what is finished, adds what
> is newly open, and links the rest. The call will not return until it is done, and its
> result tells you what it wrote.
>
> When it returns, reply with exactly ONE of these three lines and nothing else:
>
> - `## WIND-DOWN DONE — <n> open` — the normal case; `<n>` is the number of open tasks the
>   subagent reports it left in the file;
> - `## WIND-DOWN DONE — no change` — the subagent reports the file already said everything
>   and it changed nothing;
> - `## WIND-DOWN DONE — nothing open` — the subagent reports nothing is open any more.

The three lines are what V7, V3 and the explicit-empty stop read, and the subagent's own
tool result is what tells the primary which one applies; an earlier draft asked for
`## WIND-DOWN DONE` *"and nothing else"*, which left V7 with nothing to read on every run
and turned a genuinely empty project into an abandon with a cooldown instead of the pause
`specs/endless-mode.md:449-452` reserves for it. `looksLikeWindDownReply` stays the loose
`/^##\s+WIND-DOWN DONE\b/m`, so a model that adds a suffix of its own still ends the turn.

**7. Settle.** The shaped reply (or the expiry of the turn window) ends step 6; it does not
end the wind-down. The plugin now awaits the permit's `settlement` — the child waiter's
promise, whose ceiling was set to `endlessWindDownTimeoutMs − DOC_SUMMARY_POLL_MS` at
registration — and additionally requires the child's registry entry to be gone. Where no
settlement arrives by `endlessWindDownTimeoutMs` counted from the spawn, the plugin ends the
child itself and abandons (§3.2, §5).

**8. Confirm.** V1–V7 of §3.3. A failure of V1, V3, V4, V5 or V6 restores the snapshot and
abandons; the session is not replaced.

**9. Nothing left to do.** The explicit-empty case stops and pauses, as today.

**10. Replace.** `performPrimaryHandoff` unchanged in structure, with the endless kickoff
block of §3.5 and `promptOldPrimaryForDocSummaries` still standing down
(`src/handoffwiring.js:463`). The wind-down reply fails `validateDocSummaries`' shape check
and its fallback block lands in the kickoff, exactly as today.

**11. Record.** `recordEndlessCycle(openIdsFound, openIdsLeft)` per §3.4.8, fed by the
before-parse of step 4 and the after-parse of step 8 — the same two snapshots the
no-progress bound already compares (`src/endless.js:432-436`).

---

## 5. Failure and abandon paths

Every abandon does what it does today (`src/endless.js:229-235`): release the latch, arm the
cooldown, log the stage, error toast, **primary not replaced** — plus, new,
`disarmEndlessWindDown` in a `finally` so no permit can outlive its cycle, and the snapshot
restore of §3.3 wherever the rejected state is a rewritten file.

| stage | trigger | outcome |
|---|---|---|
| `prepare` | `multiple` / `not-a-file`, `ensureTodoFile` throws, or the section write throws | abandon, no turn spent |
| `quiesce` | timeout at `endlessQuiesceTimeoutMs` | abandon (unchanged) |
| `wind-down` | the primary produced no shaped reply in the window **and** the permit is unconsumed | `disarmEndlessWindDown(primaryID)` **first, synchronously**, then the **fallback**: the plugin calls `startWindDownSubagent` itself with whatever final text the primary last produced, then goes to `settle`. The disarm is not cosmetic — an armed permit would stay admissible, and a slow primary whose `spawn` lands after the fallback started would put a second `planner` against the same file, concurrently, through a non-atomic `writeAt`, with last-writer-wins. After the disarm that spawn takes the ordinary refusal. Logged `endless: wind-down spawned by the plugin — the orchestrator made no permitted spawn` |
| `wind-down` | the permit was consumed but the child never started (`createChildSession` gave no id, or `promptSession` threw) | `restoreEndlessWindDown` gives the permit back once and the refusal text invites one repeat; a second such failure leaves it consumed and falls through to the row below |
| `wind-down` | **the turn window expired with the permit consumed and the child unsettled** | keep waiting for the settlement, bounded by the waiter ceiling of §3.2; on settlement go to `confirm`; if no settlement arrives by `endlessWindDownTimeoutMs` from the spawn, end the child (abort + teardown, which settles the waiter) and abandon. Never `confirm` against a running writer, and never abandon leaving one alive |
| `wind-down` | the permit was consumed and the child settled as errored, aborted, timed out or expired | run `confirm` anyway: accept if V1, V3–V6 hold (a subagent that wrote the file and then died still saved the state); abandon otherwise |
| `wind-down` | the fallback spawn also fails to start or its child fails, with the file unchanged | abandon |
| `confirm` | any of V1, V3, V4, V5, V6 fails | restore the snapshot (§3.3), then abandon |
| `handoff` | `performPrimaryHandoff` throws or yields no session | abandon (unchanged) |

The watchdog remains the inner bound on a hung wind-down subagent: it is an ordinary
subagent entry, so `maxSubagentAgeMs` / `maxSubagentToolCallMs` reap it and the teardown
settles the waiter, which unblocks the orchestrator's tool call well inside
`endlessWindDownTimeoutMs` — except where the user has switched the silence watchdog off, the
case the cycle's own end-the-child last resort covers.

---

## 6. What each source file has to change

**`src/todofile.js`** — the file that carries the format changes and no endless knowledge:
widen `TASK_LINE_RE` (`:95`) **for reads only**; give `parseTasks` (`:204-223`) ownership of
the whole contiguous indented block; narrow `removeTask` (`:334-345`) and `editTask`
(`:307-333`) to canonical lines inside the markers, deleting the whole block, and give them
the `unmigrated` answer of §3.4.7; add `ensureSection(content)` and replace the end-of-file
append in `addTask` (`:279-291`) with the marker-anchored insert of §3.4.3 and §3.4.4; add
`usedIdsFrom` + the `next-id` watermark behind `nextFreeId` (`:233-256`); export
`ensureTodoFile` (`:261`), `ensureSection` and a `splitSections(content)` used by V4. Header
comment (`:8-21`) restated for the widened read shape, the narrow write shape and the
section rule.

**`src/registry.js`** — the permit map and its six functions beside `pendingEndless` /
`endlessInProgress` (`:1461-1520`); clear it in `forgetPrimary` beside the endless flags
(`:126-130`); `recordEndlessCycle` (`:1642-1653`) re-keyed from titles to ids per §3.4.8,
comment and all.

**`src/state.js`** — `endlessProgress.lastOpenTitles` (`:203-218`) becomes `lastOpenIds`,
with the reset at `:365` and the comment following it.

**`src/tools.js`** — in `spawnHandler`, the freeze branch (`:402-418`) gains the admission
test and the synchronous consume, and a second refusal text for the armed case; the admitted
call is marked `windDown` and skips the five gates of §3.2 (`:472`, `:492`, `:503`, `:579`,
retention); the child prompt is **composed by the plugin** from its instruction block, the
capped hand-over payload and `WIND_DOWN_SUBAGENT_CONTRACT`, in the place the project
snapshot is already prepended (`:490-491`); `restoreEndlessWindDown` in the create-failure
branch (`:611-620`) and in the prompt-throw cleanup (`:646-660`); the waiter registration
widens to `if (nested || windDown)` with an explicit `{ timeoutMs }` (`:634`), and
`noteEndlessWindDownChild` records the child id and the promise. `reuseHandler` (`:898-908`)
unchanged.

**`src/hooks.js`** — one branch on the wind-down entry in the completion path
(`:1595-1620`): no `postParentNotice`, because the result already reached the primary as the
tool result and the session is being replaced. The suppression covers **both** delivery
routes: the ordinary one and the late-result route through `detachedParentOf`
(`src/childwait.js:250-262`), where a wind-down child whose waiter had expired would
otherwise post into a primary that is retired by then — such a late result is logged and
dropped. `autoMarkTask` (`:2031-2056`) gains the `unmigrated` outcome of §3.4.7.
`PRIMARY_TOOLS` (`:140`) unchanged — the constraint that the orchestrator cannot touch a
file is kept in both sessions.

**`src/notices.js`** — `taskOutcomeLine` (`:35-66`) gains the `unmigrated` case: the task is
done, the line stands outside the plugin's section and was not removed, the next wind-down
migrates it.

**`src/settings.js`** — `endlessWindDownTimeoutMs`, resolved the way the neighbouring
endless keys are (`:357-363` for env + default, `:464-466` for the file validator):
env `OPENCODE_AGENT_INTERCOM_ENDLESS_WIND_DOWN_TIMEOUT_MS`, validator
`Number.isInteger(raw.endlessWindDownTimeoutMs) && raw.endlessWindDownTimeoutMs >= 0`,
`DEFAULT_ENDLESS_WIND_DOWN_TIMEOUT_MS = 900000` beside
`DEFAULT_ENDLESS_QUIESCE_TIMEOUT_MS` (`:227`). Without the validator the key silently
resolves to nothing. It is **not** shown in the sidebar, exactly like
`endlessQuiesceTimeoutMs` (named in `tui/src/settings-file.ts:50` only as a key that passes
through untouched), so `test/settings-defaults-parity.test.js` — which pins `endlessMode`
and `endlessContext` alone (`:132-133`) — needs no change.

**`src/childwait.js`** — unchanged. `registerChildWaiter` already accepts
`{ timeoutMs }` (`:146-153`), which is what the wind-down path passes.

**`src/handoff.js`** — `OPEN_POINTS_PROMPT` (`:455-469`) and `looksLikeOpenPointsReply`
replaced by `WIND_DOWN_PROMPT(token, fileName, driftCount)` — carrying the three closing
lines of §4 step 6 — and `looksLikeWindDownReply` (`/^##\s+WIND-DOWN DONE\b/m`);
`requestDocSummaries` (`:424`) gains an injectable timeout so the two callers can differ.

**`src/endless.js`** — steps 4a–4d (`:318-395`) replaced by prepare / arm / wind-down turn /
settle / confirm; the dedupe (`:347-375`) and `addTask` drop out of the dependency list;
`formatOpenTasks` (`:104-120`) and `KICKOFF_TASKS_MAX` / `KICKOFF_TASK_FIELD_MAX_CHARS`
(`:88-96`) replaced by the raw-text carrier and `KICKOFF_TODO_MAX_CHARS`;
`endlessKickoffBlock` (`:140-168`) takes `{ todoFileName, todoFileText, truncated }`; the
id-keyed record call (`:432-436`); the header comment (`:27-33`) restated.

**`src/handoffwiring.js`** — the wiring of the new deps (`:412-474`): `ensureTodoFile`,
`ensureSection`, `readTodoFile`, hashing, the section split, arm/restore/note/disarm, the
tokened prompt, the longer timeout, the snapshot restore, and `startWindDownSubagent` for
the fallback; `recordCycle` (`:471`) now id-keyed.

**`src/openpoints.js`** — `parseOpenPoints`, `OPEN_POINTS_MAX` and `OPEN_POINT_MAX_CHARS`
have no remaining caller once §3.5's carrier lands; the module is deleted and `capChars`
(`:86-89`) moves to `src/format.js`.

**`src/agents.js`** — unchanged. The wind-down instruction travels in the composed child
prompt, not in the `planner` role prompt, so the role stays what it is.

**`src/client.js`** — untouched by this concept. The `selectTuiSession` defect
(`:868-871`, `:875-907`) has its own diagnosis and its own run.

**`test/`** — new: the permit (armed only in-progress, single use, wrong token / wrong agent
/ nested caller refused, restored once and only from the two pre-prompt failures, disarmed on
every exit and disarmed before the fallback); the widened `TASK_LINE_RE` against the real
em-dash lines; `removeTask` refusing a legacy line outside the markers and answering
`unmigrated`; `ensureSection` on a file with no markers, with a human `## Open`, and with a
marker-less `## Intercom tasks` heading; the section-anchored insert; the watermark id
allocation across a removal; V1–V7 each failing in isolation, each abandoning without
calling `performPrimaryHandoff`, and each restoring the snapshot; the settle gate (a shaped
reply while the child is unsettled does not reach `confirm`); the id-keyed no-progress
record; the kickoff carrying the file text and its truncation notice.

---

## 7. What `specs/endless-mode.md` has to say instead

- **§1.3** (`:85`) keeps its finding — the orchestrator cannot write the file — and gains
  the consequence: therefore a subagent does, and the plugin's job is to permit exactly one
  and to verify the result.
- **§2.3** (`:212-227`) is rewritten head to foot. Its recommended row becomes the third row
  of its own table (*"spawn a planner subagent to write it"*), and its stated objections are
  answered in the text: the spawn is *after* the quiesce gate, not before it, so §3.3's
  argument is untouched; and the planner not holding the orchestrator's context is what the
  hand-over payload supplies. The new losing rows are *the plugin parses and writes* (loses:
  the parse is a lossy funnel — a title and a criterion, no links, no prose, and its
  read-back confirms only its own appended lines) and *grant the orchestrator `todo_add`*
  (unchanged objection: it breaks `PRIMARY_TOOLS`).
- **§3.1** (`:230-252`) — step 4 splits into *prepare / arm / wind-down / settle / confirm*.
- **§3.2**'s settings table gains `endlessWindDownTimeoutMs` with its env var, default and
  the note that the sidebar does not show it.
- **§3.3** (`:281-322`) keeps its quiesce definition and its table verbatim; the recommended
  row gains the clause *"…except one permitted wind-down spawn after quiesce"* and a new
  paragraph carries §3.2 of this concept: the five admission conditions, the atomic consume
  and its single restore, the plugin-composed child prompt, the five exemptions and the
  containments.
- **§3.4** (`:324-374`) is replaced by §3.3 and §3.4 of this concept: the wind-down prompt
  with its three closing lines, the composed child prompt, the blocking waiter and the
  settlement gate, V1–V7 with V4 as an algorithm over lines, the snapshot restore, the
  section anchor, the id watermark and the two-shapes rule. The sentence *"the plugin
  therefore knows three things by observation rather than by trust"* (`:120-123`) survives
  with a different three: that the file resolved to one regular file, that the file as a
  whole changed and still parses, and that nothing outside the machine section moved.
- **§3.5** (`:376-441`) — the task listing is replaced by the file's own text; the paragraph
  at `:172-185` (*"The task listing carries the file's contents, not only its name"*) keeps
  its argument and changes its object.
- **§3.6.1** (`:449-455`) — the empty case is now the subagent's explicit
  `## WIND-DOWN DONE — nothing open` plus a zero-task parse, not an empty confirmed list.
- **§3.6.2** (`:468-479`) — the no-progress bound is re-keyed from normalised titles to open
  **ids**, and the stated reason for titles (*"`nextFreeIdFrom` … reuses the id of a removed
  task"*) is replaced by its opposite: the watermark makes ids monotone, and titles are now
  authored by the model, so a rephrased list would read as progress that did not happen.
- **§3.6.5** (`:490-492`) — the point of no return moves. It is no longer *"a cycle already
  past the save step"*: prepare itself writes (the section insert), and the permit is live
  from arm. Restated: turning the row off clears the latch and the freeze at the next
  settings read; a cycle that has **armed the permit** runs through to `confirm` or to an
  abandon, and the switch-off takes effect from the next schedule.
- **§5** — three assumptions drop (`addTask` degrading safely, the shaped-reply-at-ceiling
  assumption in its old form) and the five of §9 below take their place.
- **§7** — the unit list loses `parseOpenPoints` and the `addTask` save step and gains the
  permit, the widened parse, the section insert, the watermark, the `unmigrated` outcome and
  V1–V7. Live check (a) changes from *"the orchestrator's spawn after the trigger is
  refused"* to *"a non-conforming spawn after the trigger is refused, the conforming one is
  admitted once, and a second one is refused"*; (c) becomes *"the todo file on disk carries
  the updated list, the lines outside the machine section are unchanged except for migrated
  task blocks, and no id was reused"*.

---

## 8. Target state and the order it is built in

Target: one endless cycle in which the plugin owns and creates its section, permits exactly
one spawn after quiesce, waits for that child's own ending, verifies the file rather than its
own append, restores it when the verification refuses, and hands the successor that file's
text.

| step | content | depends on | build/test between |
|---|---|---|---|
| S1 | `todofile.js`: read-widened `TASK_LINE_RE`, block-owning `parseTasks`, narrowed `removeTask`/`editTask` with the `unmigrated` answer, `ensureSection`, section-anchored `addTask`, watermark ids, exported `ensureTodoFile`/`ensureSection`/`splitSections` | — | `npm test`. **Changes live behaviour on its own, and in the user's files**: `addTask` stops appending at end of file and writes a heading, two markers and a watermark into whatever todo file the project has, and the read/write split decides what `todo_done` deletes. It may not ship without the two-shapes rule of §3.4.7 — the widened regex alone would make `DONE: T1` delete human prose |
| S2 | `registry.js` + `state.js`: the permit state and its six functions, cleared by `forgetPrimary`; the no-progress record re-keyed to ids | — | `npm test`; nothing reads the permit yet |
| S3 | `tools.js` + `hooks.js` + `notices.js`: the admission branch, the consume/restore, the exemptions, the composed child prompt, the waiter with its explicit ceiling, the notice suppression on both routes, the `unmigrated` line | S1, S2 | `npm test`; unreachable in production because nothing arms a permit |
| S4 | `handoff.js`: `WIND_DOWN_PROMPT` with the three closing lines, `looksLikeWindDownReply`, injectable timeout; `settings.js`: `endlessWindDownTimeoutMs` | — | `npm test` |
| S5 | **the cut-over, one step:** `endless.js` + `handoffwiring.js` — prepare / arm / wind-down / settle / confirm, the snapshot restore, the fallback `startWindDownSubagent`, the kickoff carrying the file text, `openpoints.js` folded away | S1–S4 | `npm test`. The three cannot be separated: the kickoff carrier is what removes `endless.js`'s last dependency on `openpoints.js`, and the fallback is what keeps a model that places no tool call from abandoning every cycle. Irreversible, and must not be cut in half |
| S6 | `specs/endless-mode.md` rewritten per §7; `CLAUDE.md` / `README.md` where they name the mode | S5 | — |
| S7 | the live E2E of §7 (a)–(g) with `endlessContext` lowered, once | S6 | — |

Each step is one briefing. S1, S2 and S4 are independent of each other and can run in any
order or in parallel; S3 needs S1 and S2; S5 needs all four.

---

## 9. Assumptions, and what would show them wrong

- **A session at its context ceiling can still emit ONE correct tool call.**
  `specs/endless-mode.md:224-226` argues the opposite for text vs. tool calls, which is why
  the fallback is in S5 rather than optional. Wrong when the log shows repeated
  `spawn refused: wind-down permit` lines followed by the window expiring; the fallback is
  then the normal path, not the exception, and §3.1's third row should be adopted outright.
- **A child waiter with a primary as parent behaves.** `src/childwait.js:22-24` states it is
  supported, but no production path does it today — `src/tools.js:634` registers one only for
  nested spawns. Wrong if the settlement never resolves although the child ended, or the
  primary is reaped mid-wait; observable as the cycle's end-the-child last resort firing on
  a run whose child finished normally.
- **No second orchestrator primary shares the endless primary's directory.** The spawn-cap
  exemption of §3.2 is deliberate — quiesce is scoped to one primary — and it establishes
  that another primary's subagents run *during* the rewrite. Where such a subagent reports
  `DONE: T<n>` against the same file, its `removeTask` → `writeAt` (`O_TRUNC` + write, not
  atomic, `src/todofile.js:170-188`) collides with the wind-down child's rewrite and one of
  the two writes is lost. An in-process write lock would not close it: the wind-down child
  writes through opencode's own `write`/`edit` tools, outside `src/todofile.js` entirely. So
  it is named, not closed. Wrong when a V4 failure names lines nobody edited, or when a task
  reappears after a `DONE:` removed it.
- **Widening the parser reclaims the existing entries rather than inventing new ones.** A
  human prose bullet beginning `- T1 through T8 are done` parses as a task, and V4's
  licensed removal set is computed from that same parse, so such a line may be migrated into
  the machine section. It is bounded — the line moves, it is not deleted, and §3.4.7 keeps
  the ordinary `DONE:` path away from it. Wrong if a cycle's first `listOpen` after S1
  reports tasks that are not tasks: check the `open tasks <before>` figure of the first cycle
  against the file by eye, once.
- **A `planner` given the whole hand-over writes a file a successor can work off.** This is
  the mode's premise and is unmeasured. Wrong when the successor's first spawns restate the
  kickoff rather than the file, and mechanically when the no-progress bound
  (`src/endless.js:441-455`) fires two cycles running.

## 10. Open

- Confinement of the rewrite is **decided, not open**: the subagent may add, edit, reorder
  and delete only between the two `intercom` markers, everything outside them is verified
  against the pre-spawn snapshot by V4, and a rewrite that fails is undone. The two
  abilities this gives up — retiring a stale human section, and moving a point out of
  `## Not now` into the open work — are bounded and available to any ordinary run at any
  other time, while what the free shape risks is silent and unbounded at the worst moment
  for it.
- This repository's own `todos.md` is **decided, not open**: it is not migrated. Its
  `## Pending` bullets stay as they are and the plugin's marked section is inserted beside
  them (§3.4.3).
- Nothing else stands open in this concept. The `selectTuiSession` auth-header defect
  (`src/client.js:868-871`) is a separate matter with its own diagnosis and its own run, and
  no step here touches that file.
