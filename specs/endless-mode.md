# Concept: endless mode — a self-restarting orchestrator that works off its own TODO.md

Boundary: the plugin at `~/opencode-agent-intercom`, both halves — the
server-side plugin under `src/` and the sidebar plugin under `tui/`.

Endless mode is on by default and is also a switch in the sidebar. While it is on, the
orchestrator's context is
watched against a configurable ceiling (250 000 tokens by default). When the ceiling is
reached and every running subagent has finished, the orchestrator states its open points,
the plugin writes them into the project's todo file, the session is replaced by a fresh
orchestrator session, and that new session is started with the instruction to work the todo
file off. Then the same thing happens again.

## 1. What the code does today

### 1.1 The primary already measures its own context and already hands itself off

- Context size of any session is `latestContextTokens` (`src/client.js:283`), summing
  `input + output + cache.read + cache.write` of the newest assistant message that has a
  non-zero token sum. Reasoning tokens are excluded on purpose — the comment at
  `src/client.js:268-276` states that including them "made the orchestrator handoff
  (`maxPrimaryContext`) fire far too early, right after a reasoning-heavy turn". It is
  reached through `fetchSnapshot` (`src/client.js:230`), one `session.messages` call capped
  at `SNAPSHOT_TIMEOUT_MS = 5000` (`src/client.js:176`).
- On every primary turn the system-transform hook refreshes that measurement, TTL-guarded:
  `if (shouldRefreshPrimary(sessionID)) { const snap = await fetchSnapshot(...);
  recordPrimaryContext(sessionID, snap?.ctxTokens) }` (`src/hooks.js:167-169`). The store is
  `primaryCtx` (`src/state.js:90`), the TTL `CTX_TTL_MS = 3000` (`src/registry.js:614`).
- The threshold comparison is a pure predicate, `shouldTriggerPrimaryHandoff(sessionID,
  maxPrimaryContext)` (`src/registry.js:645`), true when the cached count is `>=` the
  threshold and the threshold is a positive finite number.
- The trigger is **two-phase and idle-gated**: the transform hook only marks
  (`scheduleEndlessIfNeeded` / `scheduleHandoffIfNeeded`, `src/hooks.js:196-225`,
  `src/registry.js:761`, `src/registry.js:675`), because "starting the handoff here would
  delete the old session mid-turn, so the triggering user message would never be answered"
  (`src/hooks.js:178-183`); the `session.idle` event executes it
  (`src/hooks.js:542-554` -> `maybeRunPendingHandoff`, `src/handoffwiring.js:80`,
  `maybeRunPendingEndless`, `src/handoffwiring.js:298`). The claims
  (`claimPendingHandoff`, `src/registry.js:698`; `claimPendingEndless`,
  `src/registry.js:785`) are synchronous, so duplicate idle events cannot start two
  handoffs or two endless cycles.
- The handoff sequence itself is `performPrimaryHandoff` (`src/handoff.js:121`), ten
  numbered steps: open a delivery drain, create the new session, ask the old primary for
  doc summaries, reparent in-flight subagents, write a summary file, send the kickoff,
  flush the drain, **archive** (not delete) the old session, forget it. The
  archive-not-delete rule is load-bearing: "opencode's session delete cascades
  recursively over child sessions" (`src/handoff.js:297-301`, `src/client.js:134-137`).
- The three session operations it needs already exist and are already used against a
  live opencode: `createChildSession` (`src/client.js:72`) with `parentID` **omitted**
  so the new orchestrator is a root session (`src/handoffwiring.js:110-125`),
  `promptSession` (`src/client.js:88`), `archiveSession` (`src/client.js:158`, a `PATCH`
  with `time: { archived }`, "source- and live-verified" on opencode 1.17.15,
  `src/client.js:144-152`).

**So a plugin can end its primary session and open a new one with a starting prompt. That
is not an open question in this repository — it is running code.** What is open is stated
in section 4.3.

### 1.2 How the plugin knows a subagent is running, and when the last one has finished

- Every spawned subagent is a registry entry keyed by handle, with a reverse map by
  session id (`src/state.js:18-26`, `createEntry` at `src/registry.js:904`). Entries are
  created by `spawn` and by the `session.created` event (`src/hooks.js:543`).
- The count is `countActiveSubagents` (`src/registry.js:186`): every non-aborted registry
  entry **plus** `pendingSpawns.count`, the reservation counter for spawns that have passed
  the cap check but not yet reached `upsertSession` (`src/state.js:40-50`). The comment at
  `src/registry.js:178-186` states the count is **global across every primary in the
  process**, and the `primaryID` argument is ignored.
- The lifecycle is one-shot: on `session.idle` the wake path removes the entry from the
  registry inside one `registryMutex.runExclusive` critical section, latching
  `e.dispatched = true` before removal (`src/hooks.js:597-660`). "Finished subagents are
  not in the registry at all" (`src/registry.js:184`).
- The error path (`onSessionError`, `src/hooks.js:660-740`) and the inactivity watchdog
  both end in `teardownSubagent` (`src/teardown.js:65-101`), which also removes the
  entry. The watchdog window is `maxSubagentAgeMs`, default 90 000 ms
  (`src/settings.js:50-57`), armed once per process from the event-handler factory
  (`src/hooks.js:519`).
- `inFlightSubagentsFor(parentID)` (`src/registry.js:415`) is the per-primary read the
  handoff uses, filtering `!dispatched`.

**So "no subagent is running" has an exact expression already: `countActiveSubagents() === 0`
read under `registryMutex`.** It is process-wide rather than per-primary. Section 3.3
keeps that and says why.

### 1.3 The orchestrator cannot write the todo file itself

- `PRIMARY_TOOLS = new Set(["spawn", "abort", "list"])` (`src/hooks.js:56-60`) and the
  guard throws for anything else from a primary session: "this is an orchestrator session
  — it delegates work, it does not run `${input.tool}` itself" (`src/hooks.js:947-960`).
- The todo tools are `TODO_TOOLS = new Set(["todos_open", "todo_done", "todo_add",
  "todo_edit"])` (`src/hooks.js:68`), restricted to `TODO_AGENTS` — planner, coder,
  debugger, reviewer, documenter, designer (`src/hooks.js:69-71`) — and denied to every
  other subagent (`src/hooks.js:874`). The orchestrator is in neither set.
- The plugin's own todo-file layer is `src/todofile.js`: `findTodoFile` (`src/todofile.js:130`)
  accepts `todo.md` / `todos.md` in any casing and treats several matches as a hard error
  (`TodoFileMissingError`, kinds `missing` / `multiple` / `not-a-file`,
  `src/todofile.js:62-77`); `addTask` (`src/todofile.js:279`) appends `- T<n>: <title>`
  with an optional `  accept:` line and creates the canonical `TODO.md` when the directory
  has none (`ensureTodoFile`, `src/todofile.js:261`); `listOpen` (`src/todofile.js:226`)
  parses the file; every read and write goes through an `O_NOFOLLOW` descriptor confirmed
  by `fstat` to be a regular file (`src/todofile.js:142-167`).
- The plugin already writes that file on its own initiative: the wake path calls
  `autoMarkTask` -> `removeTask` when a subagent's reply opens with `DONE: T<n>`
  (`src/hooks.js:663`, `src/hooks.js:738`).

**So telling the orchestrator "write todos.md" cannot work as stated: the orchestrator has
no tool that writes files.** Section 3.4 turns this constraint into the design's
strongest part.

### 1.4 How the old primary is asked for a final statement, and how the answer is confirmed

`requestDocSummaries` (`src/handoff.js:521`) is the existing pattern for "get one more
answer out of the session that is about to be replaced", and its discipline is the product
of a live-verified bug (`src/handoff.js:466-484`):

1. snapshot the current final result **before** sending the prompt (without the baseline
   the first poll returns the previous answer as if it were the reply),
2. send the prompt non-blocking through `promptSession`,
3. poll `fetchSnapshot(...).result` until it has **changed from the baseline** *and* matches
   a shape check (`looksLikeDocSummariesReply`, `src/handoff.js:488`); a changed-but-foreign
   reply becomes the new baseline and the poll continues,
4. time out after `DOC_SUMMARIES_TIMEOUT_MS = 120_000` at `DOC_SUMMARIES_POLL_MS = 500`
   (`src/handoff.js:484-485`) and throw, so the caller can fall back.

The reply is then normalised defensively — `validateDocSummaries`
(`src/handoff.js:605-657`) re-emits the recognised sections in canonical order and falls
back to a placeholder block for any missing one; `capChars` bounds each section at
`DOC_SUMMARY_MAX_CHARS = 400` characters (`src/handoff.js:486`, `src/handoff.js:691`).

### 1.5 Settings, and how the sidebar writes them

- `getSettings()` (`src/settings.js:165`) resolves **file > env > default**, cached for
  `TTL_MS = 2000` (`src/settings.js:91`), from `~/.config/opencode/agent-intercom.json`.
  Every key is validated individually and an invalid value silently leaves the resolved
  default standing (`src/settings.js:192-235`). The boolean key `endlessMode` is
  validated by `typeof raw?.endlessMode === "boolean"` (`src/settings.js:225-227`); every
  numeric key goes through `Number.isInteger(raw?.x) && raw.x >= 0`.
- The sidebar's store writes through a read-modify-write: `applySetting` reads
  `file.readRaw()`, computes the next value from **that** read, merges and writes
  (`tui/src/settings-file.ts:117-127`). Keys the panel does not know stay untouched,
  and "a key absent from the file stays absent: its env-or-default resolution is
  displayed, never written back" (`tui/src/settings-file.ts:5-22`).
- `createJsonObjectFile` (`tui/src/json-object-file.ts:33`) is the shared disk half: an
  absent file reads as `{}` so the first write creates it, an unreadable or unparsable one
  **throws** so the caller refuses to write over content it could not read.
- The sidebar's `Settings` are `maxSubagents`, `maxContext`, `endlessMode` and
  `endlessContext` (`tui/src/settings-file.ts:24-29`). `isLimit` (`tui/src/settings-file.ts:50`)
  accepts whole numbers >= 0 and `isFlag` (`tui/src/settings-file.ts:53`) real booleans;
  `SETTING_VALIDATORS` (`tui/src/settings-file.ts:56-61`) is a mapped type over `Settings`
  pairing each key with its own check, so a key added to the panel cannot be left without
  one. `mergeSetting` (`tui/src/settings-file.ts:117`) drops from the write only the keys
  failing THEIR OWN validator — stepping a limit cannot delete the boolean.
- Row shapes in the panel: the two numeric limits sit under the Subagents section with
  `[-] value [+]` and `holdRepeat` (`tui/src/tui.tsx:1263-1279`); the two boolean toggles
  sit under TUI settings as a single `[on] ` / `[off]` cell coloured `success` or
  `textMuted` (`tui/src/tui.tsx:1282-1300`). Fixed column widths keep the buttons from
  shifting (`tui/src/tui.tsx:102-118`).
- The panel re-reads the file on a 30 s timer and whenever a file-backed section is opened
  (`refreshFileState`, `tui/src/tui.tsx:339-358`, `tui/src/tui.tsx:362-365`).
- `test/settings-defaults-parity.test.js` imports both sides and fails on a divergence of
  the shared defaults (`src/settings.js:78-80`).

### 1.6 What the sidebar can do that the server-side plugin cannot

The sidebar plugin navigates the TUI's own view: `api.route.navigate("session", { sessionID
})` in `openSubagent` (`tui/src/tui.tsx:727-728`) and, when the session the user is
watching is about to be deleted, back to its parent — "otherwise the route points at a
now-missing session and the TUI falls back to the start page, losing the orchestrator chat"
(`tui/src/tui.tsx:860-867`). It subscribes to `session.created`, `session.updated`,
`session.idle`, `session.error`, `session.status`, `message.updated`
(`tui/src/tui.tsx:880-887`).

The server-side plugin's only reach into the TUI is `showToast`
(`client.tui.showToast`, `src/client.js:375`), and it is explicitly a no-op outside the TUI
(`src/client.js:374`).

## 2. What is decided, and what it costs

### 2.1 Endless mode is the existing handoff with three additions, not a second mechanism

Recommended.

| shape | cost | what it forecloses | what it demands of the implementer |
|---|---|---|---|
| **endless mode drives the existing handoff** (recommended) | the handoff's ten steps gain two conditional ones; one new latch beside `pendingHandoffs` | nothing — the plain handoff keeps working with endless mode off | understanding `performPrimaryHandoff`'s failure discipline before touching it |
| a separate endless sequence beside the handoff | two code paths that both create sessions and retire primaries | — | re-implementing the delivery drain (`src/registry.js:439-487`), the redirect chain (`:492`), the reparent (`:350`) and the archive-not-delete rule; two of them can be open at once and the drain is keyed by session id, so they would collide |
| endless mode runs *after* a normal handoff completes | none in the handoff | — | two session replacements per cycle, the second one starting from a session that is one turn old |
| compact the session in place via `POST /session/{id}/summarize` instead of replacing it | none — one call | the fresh context the mode exists for: summarize compacts the *same* session, so the accumulated history, its tool residue and its wrong turns are carried forward as a summary rather than dropped | — |

The deciding argument is in the code: everything the user's description needs — end the
session, open a new one, give it a starting prompt — is what steps 2, 6 and 8 of
`performPrimaryHandoff` already do, and the parts that are easy to get wrong (a notice
delivered into a dying session, a subagent whose wake goes to the archived parent, a delete
that cascades over live children) are exactly the parts the drain, the redirect and the
archive already solve, each with a live-verified failure written next to it. A second
mechanism would have to be *given* those properties.

### 2.2 The threshold is its own key, and it displaces `maxPrimaryContext` while endless mode is on

`maxPrimaryContext` defaults to 80 000 (`src/settings.js:44`); the user asks for 250 000.
Both cannot be armed on the same session — the lower one always fires first and the endless
threshold would never be reached.

| how the two thresholds coexist | cost | what it forecloses | what it demands |
|---|---|---|---|
| **`endlessContext`, a separate key; while `endlessMode` is on it is the only primary threshold in effect** (recommended) | one settings key, one branch in the transform hook | nothing | the branch must be in one place — the resolution function of §3.2, not scattered |
| reuse `maxPrimaryContext` and let the sidebar switch its value | no new key | the user's plain-handoff threshold: turning endless mode off would leave 250 000 behind | a write to a numeric key on a boolean toggle — the panel would silently rewrite a limit the user set by hand |
| arm both, endless mode wins on the *tie* | no new branch | — | arithmetically inert: at 80 000 the plain handoff fires and the primary is replaced, so the count never reaches 250 000 |

### 2.3 The plugin writes the todo file; the orchestrator only states the points

Recommended — and it is what makes requirement "how the plugin knows the write actually
happened rather than assuming it" answerable at all.

| who writes the todo file | cost | what it forecloses | what it demands |
|---|---|---|---|
| **the orchestrator states the points in one plain-text turn; the plugin parses and calls `addTask`** (recommended) | a parse of a shaped reply | nothing | a prompt with a strict shape, a defensive parser, and the re-read confirmation of §3.4 |
| grant the orchestrator `todo_add` for the duration | a hole in `PRIMARY_TOOLS` | the invariant that a primary runs no tool but spawn/abort/list (`src/hooks.js:887`) | a time-boxed exception in the guard, and the plugin still cannot tell a successful write from a hallucinated one without re-reading the file |
| spawn a planner subagent to write it | none in the guard | — | a spawn *after* the quiesce gate closed, i.e. the one thing §3.3 forbids; and the planner does not hold the orchestrator's context, which is the whole content being saved |

The orchestrator's reply needs no tool call — it is text, which is the one thing a session at
250 000 tokens can still reliably produce. And after `addTask` the plugin holds the ids it
just assigned, so §3.4's confirmation is a re-read of the file it wrote, not a belief about
what a model did.

## 3. The design

### 3.1 The cycle

1. **Observe.** The primary's transform hook records `ctxTokens` as it does today
   (`src/hooks.js:162-165`). With endless mode on, `scheduleEndlessIfNeeded` compares against
   `endlessContext` and, when it is reached, sets the `pendingEndless` latch. Marking only —
   the same reason as the plain handoff (`src/hooks.js:167-172`).
2. **Freeze.** From the moment the latch is set, `spawn` refuses new subagents (§3.3).
3. **Quiesce.** On the primary's `session.idle`, the endless path claims the latch and waits
   until `countActiveSubagents() === 0`, bounded by `endlessQuiesceTimeoutMs` (§3.3).
4. **Save.** The plugin asks the orchestrator for its open points, parses the reply, calls
   `addTask` per point and re-reads the file to confirm (§3.4).
5. **Replace.** `performPrimaryHandoff` runs, with the endless kickoff instead of the
   doc-summary kickoff (§3.5).
6. **Work off.** The new session's first turn is the instruction to work the todo file off
   (§3.5). It runs normally: it spawns subagents, they tick tasks off through the existing
   `DONE: T<n>` path (`src/hooks.js:596`), its context grows, and step 1 applies to it.

Steps 3, 4 and 5 run **detached from the event handler**, as `maybeRunPendingHandoff` already
does (`src/hooks.js:508-510`), because the sequence can take minutes. The two-phase shape is
not only this codebase's own live-verified lesson (`src/hooks.js:167-172`): opencode's own
behaviour is that prompting, aborting or deleting the active session from inside one of its
own hooks is re-entrant and can hang or race, which is exactly what the mark-then-execute
split avoids.

### 3.2 Settings

Three new keys in `~/.config/opencode/agent-intercom.json`, resolved by `getSettings()` on
the existing file > env > default rule (`src/settings.js:101`):

| key | type | default | env var |
|---|---|---|---|
| `endlessMode` | boolean | `true` | `OPENCODE_AGENT_INTERCOM_ENDLESS_MODE` (`"1"`/`"0"`) |
| `endlessContext` | integer ≥ 0 | `250000` | `OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT` |
| `endlessQuiesceTimeoutMs` | integer ≥ 0 | `600000` | `OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS` |

`endlessMode` is the first boolean key in that file, so `getSettings()` gains one validator
beside the integer ones: `if (typeof raw?.endlessMode === "boolean") resolved.endlessMode =
raw.endlessMode`. Anything else — `"true"`, `1`, `null` — leaves the resolved value standing,
matching how every other key already behaves on a bad value (`src/settings.js:117-149`).

One resolution function owns the branch, so no caller has to know the rule:

```
primaryContextThreshold()  →  endlessMode ? endlessContext : maxPrimaryContext
```

`endlessContext: 0` disables the endless trigger the way `maxPrimaryContext: 0` disables the
plain one (`src/registry.js:616-618` returns false for a non-positive threshold), which means
"endless mode on, threshold 0" is a legal state that arms nothing. It is not an error and is
not corrected.

### 3.3 Quiesce, and the subagent that starts after the trigger

**Definition.** The primary is quiesced when, read inside one `registryMutex.runExclusive`
section, `countActiveSubagents() === 0` and no handoff drain is open
(`hasHandoffDrain`, `src/registry.js:545`). The count includes `pendingSpawns.count`
(`src/registry.js:175`), so a spawn that has reserved its slot but not yet reached
`upsertSession` counts as running — the reservation window is exactly the window in which a
naive registry scan would report zero.

**The active-subagent count is scoped to the endless primary.** `isQuiesced`
(`src/registry.js:1540`) counts only the registry entries whose `parentID` is the primary
whose cycle is running, via `countActiveSubagentsFor(sessionID)` (`src/registry.js:629`). A
second orchestrator's subagents do not hold up this cycle. The spawn cap's own count remains
global — `countActiveSubagents` is untouched — so the per-cycle wait and the cap disagree on
purpose. The two remaining terms in `isQuiesced`, `pendingSpawns.count` and
`pendingDeliveries.count` (`src/registry.js:1543-1544`), stay process-wide because neither
carries a parent to scope by; each covers a one-round-trip window in which the primary's own
work is not yet visible to a registry scan.

**A subagent that starts after the trigger fired.** Between the latch and quiesce the
orchestrator is still answering its turn and can call `spawn`. Left alone, an orchestrator
that spawns as fast as its subagents finish never quiesces.

| how a post-trigger spawn is handled | cost | what it forecloses | what it demands |
|---|---|---|---|
| **`spawn` refuses while the latch is set, with a message telling the orchestrator to close out** (recommended) | the orchestrator loses the ability to start work in its last turn | nothing that survives the replacement anyway — a subagent spawned now would be reparented onto a session that has no memory of asking for it | one check at the top of the `spawn` handler and a refusal text |
| allow spawns, wait for whatever is running | none | — | an unbounded wait; the timeout of the next row becomes the normal case rather than the exception |
| allow spawns and let them be reparented onto the new session | none | — | the new orchestrator receives results for work it never commissioned, in a session whose kickoff says "work off the todo file" |

The refusal reuses the shape of the existing primary-side refusals (`src/hooks.js:894`): a
thrown error whose text tells the model what to do instead — here, that endless mode is
saving state, that no new subagent will start, and that it should end its turn.

**The bound.** Quiesce is waited for at `DOC_SUMMARIES_POLL_MS`-scale cadence up to
`endlessQuiesceTimeoutMs` (default 600 000 ms). It is not the only bound: the inactivity
watchdog aborts any subagent silent for `maxSubagentAgeMs`, default 90 000 ms
(`src/settings.js:45-51`), and a watchdog abort ends in the same teardown that removes the
registry entry. So a *hung* subagent resolves itself in ~90 s; the ten-minute timeout is for
a subagent that is genuinely working. On timeout the cycle is **abandoned, not forced**: the
latch is released, the spawn freeze lifts, a warning toast fires, and the next over-threshold
turn re-schedules. Aborting a working subagent to make room for a context refresh would
destroy real work to save context.

### 3.4 Writing the todo file, and knowing that it happened

**The prompt.** A constant beside `DOC_SUMMARY_PROMPT` (`src/handoff.js:356`), asking for one
plain-text reply, no tool calls, in a fixed line shape:

```
## OPEN POINTS

- <one open point, imperative, max ~120 characters>
  accept: <one line naming what would show it is done>
- <the next one>
  accept: <…>
```

with the instruction to list every point that is still open — what was being worked on, what
was decided and not yet carried out, what a subagent reported back as unfinished — drawn
from context only, no reading from disk, and to emit `## OPEN POINTS` followed by nothing
else when there is genuinely nothing open. The two-line shape is the todo file's own
(`src/todofile.js:9-19`), so the parse is a direct mapping onto `addTask({ title, accept })`.

**Getting the reply.** `requestDocSummaries` (`src/handoff.js:424`) with a different shape
check — its baseline/re-baseline/timeout discipline is exactly what this needs and it is
already injectable (`fetchResult`, `sendPrompt`, `sleep`, `now` all come in as arguments).
The shape check is `/^##\s+OPEN POINTS\s*$/m`. Timeout as for the summaries, 120 000 ms.

**Parsing.** A pure function `parseOpenPoints(rawText)` in its own module: take the text
after the `## OPEN POINTS` heading, read each `- ` line as a title and an immediately
following indented `accept:` line as its criterion, trim, drop empty titles, cap each title
at 200 and each criterion at 200 characters, and cap the list at 40 points. A reply with the
heading and no points parses to `[]` — a legal answer, not a failure.

**Writing.** For each point, `addTask(directory, { title, accept })` (`src/todofile.js:279`),
which assigns the next free id and creates the canonical `TODO.md` if the directory has none
(`:261`). The directory is the session's own, resolved by `getSessionDirectory`
(`src/client.js:106`) — the same source the handoff uses (`src/handoffwiring.js:70`), not the
factory closure, for the reason stated at `src/registry.js:706-710`.

**Confirmation — the part that is not assumed.** After the writes, `listOpen(directory)`
(`src/todofile.js:226`) is read back and every id `addTask` returned must be present in it.
The plugin therefore knows three things by observation rather than by trust: that the file
resolved to exactly one regular todo file (anything else threw `TodoFileMissingError` with a
`kind`, `:67`), that the append reached the disk, and that the parse produced the tasks it
meant to. The confirmed count goes into the log line and into the kickoff.

**Failure.** Any of — the poll times out, the reply carries no heading, the parse yields
nothing where the reply was non-empty, `findTodoFile` throws `multiple` or `not-a-file`, the
read-back misses an id — abandons the cycle. The session is **not** replaced: replacing it
after failing to save its open points is precisely the data loss endless mode exists to
prevent. Latch released, freeze lifted, error toast, and the cooldown of §3.6 applies.

An empty point list is not a failure and is handled in §3.6.

### 3.5 The replacement, and what the new session is told

`performPrimaryHandoff` (`src/handoff.js:107`) runs unchanged in structure. Two of its
injected dependencies differ in an endless cycle:

- `promptOldPrimaryForDocSummaries` is **not** called a second time. The open-points turn of
  §3.4 has already happened and the doc summaries would be a third long turn on a session at
  its ceiling. The endless path passes a dependency that returns the already-obtained
  open-points text, so `validateDocSummaries`' fallback block (`src/handoff.js:469`) is what
  lands in the kickoff's document section — the new orchestrator reads the real files itself,
  which it can, because it has the context to.
- The kickoff message (`src/handoff.js:229-231`) places the endless block before the
  handoff summary. On this path the predecessor's last-user goal is omitted from the summary:
  the open points already decompose it, and leaving the imperative in place would give the
  successor a spent competing instruction:

  ```
  ## Endless mode — work off the todo file

  The previous orchestrator session reached its context ceiling. Its open points
  were saved to <todo file name> as <n> task(s): T<a>, T<b>, …

  The tasks standing in <todo file name> right now:

  - T<a>: <title>
    accept: <criterion>
  - T<b>: <title>

  Your job for this session: work that todo file off, top to bottom. The first task
  is the next one to do. Spawn one subagent per task with the task id on the first
  line of the spawn prompt. A task is finished when its subagent reports
  `DONE: T<n>` — the plugin removes it from the file itself. Do not re-add the
  tasks; do not re-plan the list; start with the first one.
  ```

  The ids are the ones §3.4 confirmed, so the message states nothing it did not verify.

  **The task listing carries the file's contents, not only its name.** A primary holds
  `spawn` / `abort` / `list` / `reuse` and nothing else (`PRIMARY_TOOLS`, `src/hooks.js:129`),
  so the successor cannot open the todo file. Naming the file alone would hand a cycle whose
  every point was deduped away (§3.4) a session with nothing concrete in it. The listing is
  the §3.4 read-back itself — the same list that confirmed the ids, never a second read that
  could disagree with it — rendered in the todo file's own two-line shape and in the file's
  own order, so the ids in the kickoff are the ids that go on the first line of each spawn
  prompt. It is bounded by `KICKOFF_TASKS_MAX` and `KICKOFF_TASK_FIELD_MAX_CHARS`
  (`src/endless.js`), which are `OPEN_POINTS_MAX` (40) and `OPEN_POINT_MAX_CHARS` (200) — the
  ceilings the saving half of the same hand-over already applies, so the round trip is
  symmetric and the block stays at roughly 40 × 400 characters instead of the size of an
  unbounded todo file. Tasks past the cap are announced by count rather than dropped
  silently, and a file from which no open task could be read is stated as such with the one
  way out the primary has: have a subagent list it.

Everything else stands: the drain buffers notices from the moment the sequence starts
(`src/handoff.js:134`), reparent happens before the kickoff is composed (`:197`), the old
session is archived and not deleted (`:285`), and the failure discipline reverts anything
before the kickoff and proceeds past it (`:232-261`, `:263-270`).

**The view follows.** Immediately after the kickoff is sent — step 6, before the drain flush
— the plugin switches the TUI to the new session (§4.3). Order matters: switching before the
kickoff would show the user an empty session, and switching after the archive would leave a
window in which the displayed session is already retired.

`promptSession` marks the kickoff as plugin-generated via `intercomTextPart`
(`src/client.js:88`, `src/pluginmsg.js`), so the *next* cycle's `lastUserGoal` scan skips it
(`src/handoff.js:610`) — without that, each cycle would adopt the previous cycle's kickoff as
the user's goal.

### 3.6 What stops it

Endless mode is a loop, so it needs bounds that do not depend on anyone watching it.

A stop the mode decides for itself never writes the settings file. `endlessMode` is on by
default and is the user's own switch; persisting `false` on the first self-stop would disable
that default for good. What a self-stop leaves behind is a runtime pause on ONE primary
session (`pauseEndless`, `src/registry.js`): `scheduleEndlessIfNeeded` refuses to arm a paused
primary, so the still-over-threshold session cannot re-arm on its next idle, and the pause
dies with that session (`forgetPrimary`), so the orchestrator that takes over has the mode
available again. While it holds, the session is treated as one with the mode off for the
threshold alone: `primaryContextThreshold({ endlessPaused })` resolves `maxPrimaryContext`
and the plain handoff arms and runs on it, so a paused primary is still relieved of its
context — a self-stop ends the loop, not the session's ability to be replaced. Nothing else
about the pause changes: the settings file stays untouched, and only a switch-off in the
sidebar clears the pause (`clearEndlessPause` runs in the mode-off branch alone), so a paused
primary cannot re-enter the cycle through the branch that relieves it. It is told its state in
its per-turn limits block. Only the sidebar's toggle writes `endlessMode`.

1. **Nothing left to do.** When §3.4's confirmed point list is empty *and* `listOpen` reports
   no open task, the cycle stops before the replacement: latch released, freeze lifted, the
   primary paused, success toast "endless mode: no open points left — paused for this
   session". A restart into an empty todo
   file would produce a session with nothing to do, which would idle, be woken by nothing, and
   sit at the start of a fresh context forever.
2. **No progress.** The plugin records, at the end of each cycle, the set of normalised open
   task titles the cycle LEFT in the todo file, and compares it against the set the next cycle
   FINDS there before its own write. A cycle counts as stalled only when not one of the titles
   the previous cycle handed over has left the file; what the cycle added does not enter the
   verdict, so a cycle that finished one task and discovered five is progress and a cycle that
   finished nothing is a stall whatever it saved. Titles rather than ids, because
   `nextFreeIdFrom` (`src/todofile.js`) reuses the id of a removed task. If two consecutive
   cycles are stalled, endless mode pauses itself with a warning toast naming the open-task
   count. This bound fires AFTER the replacement, so the pause goes
   on the NEW primary — pausing the session just retired would bound nothing. This is the bound against the failure the whole
   mode invites: an orchestrator that saves the same points every 250 000 tokens and never
   finishes one.
3. **A cycle ceiling.** `endlessMaxCycles`, default 10, counted per opencode process across
   the redirect chain — `handoffGeneration(sessionID)` (`src/registry.js:508`) already derives
   the generation number from `handoffRedirects`, so the ceiling needs no new state. At the
   ceiling endless mode pauses itself with a toast. Ten cycles at 250 000 tokens is a
   very long session; a user who wants more turns it back on.
4. **A cooldown after a failed cycle.** A cycle that abandoned (quiesce timeout, save
   failure, handoff failure) sets a cooldown of 5 minutes on that primary during which
   `scheduleEndlessIfNeeded` returns false. Without it, a primary already over the threshold
   re-schedules on its next turn and retries continuously — the same hot-loop
   `releaseHandoff` avoids by not restoring the pending flag (`src/registry.js:677-682`).
5. **The switch.** Turning the sidebar row off clears the latch and the freeze at the next
   settings read (TTL 2 000 ms, `src/settings.js:68`). A cycle already past the save step
   completes — it has written to the todo file and must not leave the primary half-replaced.

None of these five stops writes the settings file, deletes a session, aborts a subagent or
removes a task.

### 3.7 The sidebar row

Under the **Subagents** section, beneath `max Token(k)` — that is where the two limits the
mode interacts with already sit (`tui/src/tui.tsx:1236-1255`):

```
  endless        [off]
  endless (k)    [-] 250 [+]
```

The toggle cell follows the `thinking` / `tool details` shape exactly: one text cell,
`"[on] "` / `"[off]"`, coloured `theme.success` when on and `theme.textMuted` when off,
`onMouseDown` toggling (`tui/src/tui.tsx:1274-1291`). The threshold row follows the numeric
shape with `holdRepeat` and a step of 10 000 tokens, displayed in thousands like
`max Token(k)` (`:1251`) — from 250 to 500 in 25 taps, or a hold.

Persistence goes through `settings-file.ts` on its existing read-modify-write
(`tui/src/settings-file.ts:92-105`) with three changes:

- `Settings` gains `endlessMode: boolean` and `endlessContext: number`, and
  `resolveSettings` resolves both on the file > env > default rule the numeric ones use
  (`:54-62`).
- Each key is checked against its OWN validator: `SETTING_VALIDATORS`
  (`tui/src/settings-file.ts:57-62`) maps every member of `Settings` to `isLimit` or, for
  `endlessMode` alone, `isFlag`, and `mergeSetting` (`:110`) drops only the keys that fail
  their own check. So stepping a limit cannot delete the boolean and toggling the boolean
  cannot delete a limit. `LimitKey` (`:33`) is the narrower list the `[-]`/`[+]` rows step —
  `endlessContext` is in it, `endlessMode` is not.
- The boolean has its own writers beside `stepSetting`: `toggleEndlessMode()` (`:167`), which
  the panel row calls (`tui/src/tui.tsx:336`), and `setEndlessMode(value)` (`:159`). The
  toggle flips the value the file holds at that moment rather than writing the panel's copy,
  so a switch thrown outside the panel — by hand, or by the plugin's own bounds writing
  `endlessMode` back to false — is toggled from rather than overwritten.
- A key absent from the file stays absent (`:13-15`): toggling writes `endlessMode` because
  the user asked for it; stepping the threshold writes `endlessContext` for the same reason.
  Neither write materialises the other, and neither touches `maxSubagents`, `maxContext`,
  `searxngUrl`, `exaApiKey` or `forumBangs`.

The panel's own copy is refreshed by `refreshFileState` (`:339-346`), which gains both
signals, so a change made by hand or by the plugin's own switch-off (§3.6) appears within
30 seconds or immediately on opening the section.

`test/settings-defaults-parity.test.js` covers the shared defaults, so
`DEFAULT_ENDLESS_CONTEXT = 250000` and `DEFAULT_ENDLESS_MODE = true` are exported from both
`src/settings.js` and `tui/src/settings-file.ts`.

### 3.8 Logging

One line per cycle transition, on the existing `log` helper (`src/log.js`):

```
endless: scheduled sessionID=<id> ctx=<n> threshold=<n>
endless: quiesced after <ms>ms, activeAtStart=<n>
endless: saved <n> point(s) as T<a>,T<b>,… confirmed=<n> file=<name>
endless: cycle <k>/<max> complete, new session <id>, open tasks <before>→<after> completed=<n>
endless: abandoned at <stage> — <reason>
```

The `completed=<n>` field is what §3.6's no-progress bound reads — the number of the previous
cycle's open tasks that had left the file by the time this cycle read it, `-` on the first
cycle of a run, which has nothing to compare against. `open tasks <before>→<after>` carries the
counts alongside it. The bound is a property of every run rather than of someone remembering to
look.

## 4. The restart: how the session is replaced and the view follows

### 4.1 Settled, from this repository

A plugin **can** end its own primary session and open a new one with a starting prompt, and
it does so today: `client.session.create` without a `parentID` (`src/client.js:73`,
`src/handoffwiring.js:110-125`), `client.session.promptAsync` with an `agent`
(`src/client.js:85-90`), `client.session.update` with `time.archived` to retire the old one
(`src/client.js:160-171`). No external script is needed for the session change.

### 4.2 Settled, about which half does what

The server-side plugin's only documented reach into the TUI is `client.tui.showToast`
(`src/client.js:295`). The **sidebar** plugin, and only it, changes what the user is looking
at: `api.route.navigate("session", { sessionID })` (`tui/src/tui.tsx:709`, `:846`).

### 4.3 The view switch: settled — `/tui/select-session`

After a handoff the server-side plugin has replaced the primary, but nothing in the plugin
makes the interactive TUI *show* the new session; the existing handoff leaves that
unaddressed. Under endless mode the gap matters more, because a cycle repeats and a user left
on an archived session sees an orchestrator that has stopped answering.

The opencode server exposes a route for exactly this: **`POST /tui/select-session` with
`{ sessionID }`**, and the v2 SDK surfaces it as `client.tui.selectSession`. Checked against
opencode `1.18.25`; this plugin depends on `@opencode-ai/plugin: "^1.18.23"`
(`package.json:58`), so it resolves on that line. There is no atomic restart or replace
primitive — create, prompt, select, then retire the old session is the sequence, which is the
sequence §3.1 already runs.

**How the call is made.** `selectTuiSession(client, sessionID)` in `src/client.js`, beside
`showToast` (`:295`) and written to the same best-effort discipline — a failure is logged and
swallowed, never thrown into the handoff. It calls `client.tui.selectSession` where the
resolved client carries it, and otherwise posts to `serverUrl + "/tui/select-session"`. The
fallback is not speculative: the generated typed client is known to lag the server here, and
this codebase already relies on exactly that gap in `archiveSession` — "the pinned SDK types
the update body with `title` only, but the opencode 1.17.15 server's UpdatePayload schema
accepts `time: { archived: … }` and returns 200 (source- and live-verified). The generated
hey-api client serialises the body verbatim, so the extra field passes through at runtime
despite the narrower type" (`src/client.js:155-159`). The plugin factory receives `serverUrl`
in its context object, so the direct post needs no configuration.

Two rejected alternatives, both of which this route makes unnecessary:

- **Title match in the sidebar.** The sidebar receives `session.created`
  (`tui/src/tui.tsx:861`) and could navigate when the new session's title matches the handoff
  shape `orchestrator#<n> (handoff from <old id>)` (`src/handoffwiring.js:123`). Costs a
  string contract between two separately versioned npm packages, and a title a user could
  reproduce by hand.
- **A handoff-pointer file polled by the sidebar.** Explicit contract, but a fourth shared
  file and up to 30 s of latency on the existing timer (`tui/src/tui.tsx:406-409`).

Both put the switch in the half that does not know when the handoff finished. The route puts
it in the half that does, in the same function that sent the kickoff, and it also fixes the
plain handoff — which has the same gap — without the sidebar changing at all.

Related, and deliberately not used: `POST /session/{id}/summarize` (`{ providerID, modelID,
auto? }`) compacts a session in place. §2.1 says why that is not this feature.

## 5. Assumptions, and what would show them wrong

- **`ctxTokens` tracks the primary's real context at 250 000 tokens.** The measurement is
  validated at the 80 000 scale by the existing handoff and excludes reasoning tokens
  deliberately (`src/client.js:271-276`). Wrong if a cycle triggers far from where the
  session's own token display sits — read off the `endless: scheduled … ctx=` line against
  what opencode shows. It is also model-dependent: a provider that does not report
  `cache.read`/`cache.write` yields a smaller sum, and endless mode would fire late or never.
- **A session at 250 000 tokens can still produce a shaped plain-text reply.** The
  doc-summaries path assumes the same at 80 000 and has a live-verified 42 s turn behind its
  timeout (`src/handoff.js:381-385`). Wrong when `endless: abandoned at save` lines cite a
  timeout repeatedly; the remedy is a lower `endlessContext`, not a longer timeout.
- **The orchestrator's open points are worth saving.** Unmeasured, and it is the mode's whole
  premise. Wrong when a cycle's saved points are vague restatements of the kickoff rather than
  work — visible in the todo file itself, and caught mechanically by the no-progress bound of
  §3.6.2.
- **The spawn freeze is short.** It holds from the latch to the end of the cycle. Wrong if
  the orchestrator's freeze-time refusals show up as repeated retries in the log rather than
  as an ended turn — that would mean the refusal text is not steering the model.
- **`addTask` against a project with an unusual todo file degrades safely.** `findTodoFile`
  distinguishes `missing` (greenfield, create) from `multiple` and `not-a-file` (a human has
  to sort it out) (`src/todofile.js:63-66`). Wrong if a cycle creates a second todo file in a
  project that already had one under a different name — which the `multiple` error exists to
  prevent and which §7 tests.
- **Ten cycles is a ceiling nobody hits by accident.** Unmeasured. Wrong when the ceiling
  toast appears in a session the user considered healthy; the number is a constant and cheap
  to raise.
- **`client.tui.selectSession` or the raw `/tui/select-session` post reaches the running
  TUI.** Read from opencode `1.18.25`; the resolved plugin dependency is `^1.18.23`
  (`package.json:58`), and the typed client is known to lag the server on at least one other
  route (`src/client.js:155-159`). Wrong when a cycle completes, the new session answers, and
  the TUI still displays the archived one — the live check of §7 (g) is exactly this
  observation. It degrades to the behaviour of today's handoff, which is a presentation
  failure, not a data one.
- **Archiving keeps the old sessions readable.** The handoff archives rather than deletes
  (`src/handoff.js:277-283`), so every cycle leaves one archived session behind. Wrong if a
  long endless run makes the session list unusable — at which point the ceiling of §3.6.3 is
  the lever, not a delete.

## 6. Open, and outside this boundary

- Whether an endless cycle should also carry the `PROJECT.md` / `ARCHITECTURE.md` summaries
  the plain handoff obtains. §3.5 drops them to avoid a third long turn on an exhausted
  session; whether the new orchestrator's first act should instead be reading those files is a
  prompt question for `ORCHESTRATION_GUIDE` (`src/prompts.js`), not a structural one.
- The interaction between endless mode and a project that overrides `default_agent`: the
  handoff resolves the new primary's name through `handoffAgentName(client)`
  (`src/handoffwiring.js:74`), which uses `defaultAgentName()` and confirms any
  name other than this plugin's own role against the resolved agent list before
  using it. Endless mode inherits that resolution unchanged.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `getSettings()`: no file → `endlessMode: true`, `endlessContext: 250000`; file with
  `"endlessMode": true` → true; `"endlessMode": "true"`, `1`, `null` → true, no throw;
  `endlessContext` non-integer / negative → the default; the env vars resolve when the file is
  silent and lose to the file when it is not.
- `primaryContextThreshold()`: endless off → `maxPrimaryContext`; endless on →
  `endlessContext`; endless on with `endlessContext: 0` → arms nothing
  (`shouldTriggerPrimaryHandoff` false).
- The endless latch: set once per crossing, not re-set while set, not set while a cycle is in
  progress, released by every abandon path — mirroring `test/handoff-trigger.test.js`'s
  coverage of `scheduleHandoffIfNeeded`.
- Quiesce: zero entries and zero `pendingSpawns.count` → quiesced; one entry → not; zero
  entries with `pendingSpawns.count === 1` → **not** quiesced; an entry that is `dispatched`
  but still in the registry → not quiesced; an aborted entry → quiesced.
- The spawn freeze: with the latch set, `spawn` throws and `countActiveSubagents()` does not
  change; with the latch cleared, `spawn` proceeds.
- `parseOpenPoints`: a well-formed reply yields title+accept pairs in order; a point with no
  `accept:` line yields a title and no criterion; the heading with no points yields `[]`;
  prose before the heading is ignored; an over-long title is capped; more than 40 points are
  cut to 40; a reply without the heading yields `null` (distinct from `[]`).
- The save step against a temp directory: greenfield → `TODO.md` created with the points;
  an existing `todos.md` → appended, no second file created; two todo files → the cycle
  abandons and neither is written; the read-back confirmation fails → the cycle abandons and
  `performPrimaryHandoff` is never called (assert on the injected fake).
- The kickoff: contains the confirmed ids and the confirmed count and no id `addTask` did not
  return; is sent through `promptSession`, so it carries the plugin-generated marker and
  `lastUserGoal` skips it.
- The bounds: an empty confirmed list with an empty todo file → no handoff, the settings file
  untouched and the primary paused; two consecutive cycles with a non-falling open-task count → the new primary
  paused; the cycle counter at `endlessMaxCycles` → paused; a failed cycle → the cooldown suppresses
  the next schedule and lifts after it.
- Quiesce timeout: with a permanently busy fake registry, the cycle abandons after
  `endlessQuiesceTimeoutMs` of virtual time, the latch is released, the freeze is lifted and
  no session was created.
- Sidebar store: `toggleEndlessMode()` writes only `endlessMode` and leaves `maxSubagents`,
  `maxContext`, `searxngUrl` and unknown keys byte-identical; a following
  `stepSetting("maxContext", 5000)` does **not** delete `endlessMode` (the per-key validators
  of §3.7); an unreadable file leaves the file untouched and returns the disk state; a file
  without `endlessMode` still reads `true` and the key stays absent until toggled.
- Defaults parity: `DEFAULT_ENDLESS_CONTEXT` and `DEFAULT_ENDLESS_MODE` agree across
  `src/settings.js` and `tui/src/settings-file.ts`.

Live, once — no series, no averaging. One endless cycle against a real
`opencode serve` with `endlessContext` lowered to a reachable value (5 000–10 000) and one
subagent deliberately in flight when the threshold is crossed:

- **(a) the freeze.** The orchestrator's `spawn` after the trigger is refused, and the
  refusal appears in the log with the latch set.
- **(b) the quiesce.** The save prompt is sent only after the in-flight subagent's completion
  notice was delivered — read off the ordering of `endless: quiesced` against the wake line.
- **(c) the save.** The todo file on disk carries the new tasks, with ids matching the
  `endless: saved …` line, and no second todo file exists in the directory.
- **(d) the replacement.** A new orchestrator session exists, the old one is archived and
  not deleted, and the new session's first message is the endless kickoff naming exactly the
  ids from (c).
- **(e) the work-off.** The new orchestrator spawns a subagent for the first task and the
  `DONE: T<n>` path removes it from the file — i.e. the cycle's output is consumable by the
  machinery that already exists.
- **(f) the view switch.** After the kickoff, the TUI is displaying the new session without
  anyone clicking — a screenshot of the rendered session view whose header names the new
  session, taken after (d).
- **(g) the sidebar.** A screenshot of the rendered sidebar showing the `endless` row on, the
  threshold row, and the toggle taking effect in the file.
