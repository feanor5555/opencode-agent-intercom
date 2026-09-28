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

- Context size of any session is `latestContextTokens` (`src/context-figure.js`), summing
  `input + output + reasoning + cache.read + cache.write` of the newest assistant message
  with `tokens.output > 0` — the selection rule opencode's own surfaces use, to the letter.
  The module is the one shared computation: the server side reaches it through
  `fetchSnapshot` (`src/client.js:793`), one `session.messages` call capped at
  `SNAPSHOT_TIMEOUT_MS = 5000` (`src/client.js:721`), and the sidebar
  (`tui/src/tui.tsx`) imports it directly for the `<k> ctx` line, so panel row and
  threshold cannot disagree. The returned sum is the exact figure opencode's own TUI
  shows for a session, so every threshold tested against it — `endlessContext` /
  `maxPrimaryContext`, a subagent's context budget — crosses at the moment the user's
  context display says it has; a threshold that fires early on a reasoning-heavy model is
  raised, not the measure cut. Two exclusions stand, both on the SELECTION, not the sum: a
  step still in flight has emitted no output yet and is walked past — a thinking model can
  carry reasoning there with `output` still zero, and that partial describes no completed
  turn — and the walk stops at a compaction message (`info.summary === true`) and answers
  "no figure". The compaction stop is the one place the figure deliberately diverges from
  opencode's display: between a compaction and the next real turn, opencode's surfaces keep
  showing the summary turn's pre-compaction figure while this answers no-figure, because the
  summary's own input is the history the compaction just removed and reporting it would
  present a freshly compacted session as exactly as full as it was before.
- On every primary turn the system-transform hook refreshes that measurement, TTL-guarded:
  `if (shouldRefreshPrimary(sessionID)) { const snap = await fetchSnapshot(...);
  recordPrimaryContext(sessionID, snap?.ctxTokens) }` (`src/hooks.js:468-470`). The store is
  `primaryCtx` (`src/state.js:140`), the TTL `CTX_TTL_MS = 3000` (`src/registry.js:1510`).
- The threshold comparison is a pure predicate, `shouldTriggerPrimaryHandoff(sessionID,
  maxPrimaryContext)` (`src/registry.js:1542`), true when the cached count is `>=` the
  threshold and the threshold is a positive finite number.
- The trigger is **two-phase and idle-gated**: the transform hook only marks
  (`scheduleEndlessIfNeeded` / `scheduleHandoffIfNeeded`, `src/hooks.js:536-626`,
  `src/registry.js:1748`, `src/registry.js:1584`), because "starting the handoff here would
  delete the old session mid-turn, so the triggering user message would never be answered"
  (`src/hooks.js:488-492`); the `session.idle` event executes it
  (`src/hooks.js:1823-1851` -> `maybeRunPendingHandoff`, `src/handoffwiring.js:129`,
  `maybeRunPendingEndless`, `src/handoffwiring.js:540`). The claims
  (`claimPendingHandoff`, `src/registry.js:1607`; `claimPendingEndless`,
  `src/registry.js:1784`) are synchronous, so duplicate idle events cannot start two
  handoffs or two endless cycles.
- The handoff sequence itself is `performPrimaryHandoff` (`src/handoff.js:139`), numbered
  steps 0 to 10 (`src/handoff.js:23-90`): open a delivery drain, drop the retained subagents,
  create the new session, ask the old primary for doc summaries, reparent in-flight subagents,
  abort the old primary's doc-summary turn where that step gave up on it, write a summary
  file, send the kickoff and switch the TUI to the new session, flush the drain, **archive**
  (not delete) the old session, forget it. The
  archive-not-delete rule is load-bearing: "opencode's session delete cascades
  recursively over child sessions" (`src/handoff.js:419-425`, `src/client.js:550-552`).
- The three session operations it needs already exist and are already used against a
  live opencode: `createChildSession` (`src/client.js:308`) with `parentID` **omitted**
  so the new orchestrator is a root session (`src/handoffwiring.js:189-205`),
  `promptSession` (`src/client.js:367`), `archiveSession` (`src/client.js:704`, a `PATCH`
  with `time: { archived }`, "source- and live-verified" on opencode 1.17.15,
  `src/client.js:697-703`).

**So a plugin can end its primary session and open a new one with a starting prompt. That
is not an open question in this repository — it is running code.** What is open is stated
in section 4.3.

### 1.2 How the plugin knows a subagent is running, and when the last one has finished

- Every spawned subagent is a registry entry keyed by handle, with a reverse map by
  session id (`src/state.js:11-34`, `createEntry` at `src/registry.js:2153`). Entries are
  created by `spawn` and by the `session.created` event (`src/hooks.js:1817-1818`,
  `onSessionCreated` at `src/hooks.js:1915`).
- The count is `countActiveSubagents` (`src/registry.js:879`): every registry entry that
  holds a slot — `isActiveEntry`, not aborted and on lifecycle `running`
  (`src/registry.js:481-485`) — **plus** `pendingSpawns.count`, the reservation counter for
  spawns that have passed the cap check but not yet reached `upsertSession`
  (`src/state.js:45-60`). The comment at `src/registry.js:869-878` states the count is **global across every primary in the
  process**, and the `primaryID` argument is ignored.
- On `session.idle` the wake path takes the entry inside one `registryMutex.runExclusive`
  critical section, latching `e.dispatched = true` and then either removing it or, where
  retention admits it, marking it retained (`src/hooks.js:1965-2097`, `retainEntryLocked` at
  `src/registry.js:649`). Either way the finished subagent leaves the count: a removed entry
  is gone from the registry, and a retained one fails `isActiveEntry`.
- The error path (`onSessionError`, `src/hooks.js:2468-2619`) and the inactivity watchdog
  both end in `teardownSubagent` (`src/teardown.js:424-580`), which also removes the
  entry. The watchdog's silence window, for a subagent with nothing in flight, is
  `maxSubagentAgeMs`, default 90 000 ms (`src/settings.js:138-152`); the watchdog is armed
  once per process from the event-handler factory (`src/hooks.js:1800-1801`,
  `ensureWatchdogStarted` at `src/watchdog.js:70`).
- `inFlightSubagentsFor(parentID)` (`src/registry.js:1249`) is the per-primary read the
  handoff uses, filtering `!dispatched`.

**So "no subagent is running" has an exact expression already: `countActiveSubagents() === 0`
read under `registryMutex`.** It is process-wide rather than per-primary. Section 3.3
keeps that and says why.

### 1.3 The orchestrator cannot write the todo file itself

- `PRIMARY_TOOLS` is `spawn`, `abort`, `list`, `message` and `reuse` (`src/hooks.js:173-192`)
  and the guard throws for anything else from a primary session: "this is an orchestrator
  session — it delegates work, it does not run `${input.tool}` itself"
  (`src/hooks.js:2981-2991`).
- The todo tools are `TODO_TOOLS = new Set(["todos_open", "todo_done", "todo_add",
  "todo_edit"])` (`src/hooks.js:303`), restricted to `TODO_AGENTS` — planner, coder,
  debugger, reviewer, documenter, designer (`src/hooks.js:304-306`) — and denied to every
  other subagent (`src/hooks.js:2803`). The orchestrator is in neither set.
- The plugin's own todo-file layer is `src/todofile.js`: `findTodoFile` (`src/todofile.js:192`)
  accepts `todo.md` / `todos.md` in any casing, gives a regular canonical `TODO.md`
  precedence, and otherwise treats several matches as a hard error
  (`TodoFileMissingError`, kinds `missing` / `multiple` / `not-a-file`,
  `src/todofile.js:86-102`); `addTask` (`src/todofile.js:518`) appends `- T<n>: <title>`
  with an optional `  accept:` line and creates the canonical `TODO.md` when the directory
  has none (`ensureTodoFile`, `src/todofile.js:478`); `listOpen` (`src/todofile.js:416`)
  parses the file; every read and write goes through an `O_NOFOLLOW` descriptor confirmed
  by `fstat` to be a regular file (`src/todofile.js:205-251`).
- The plugin already writes that file on its own initiative: the wake path calls
  `autoMarkTask` -> `removeTask` when a subagent's reply carries `DONE: T<n>` on its first
  or last non-empty line (`src/hooks.js:2179`, `src/hooks.js:2704`).

**So telling the orchestrator "write todos.md" cannot work as stated: the orchestrator has
no tool that writes files.** Therefore a subagent writes it — a single wind-down `planner`
started through a one-time permit — and the plugin's job is to permit exactly one such
subagent and to verify the result it leaves on disk. Section 3.4 turns this constraint into
the design's strongest part.

### 1.4 How the old primary is asked for a final statement, and how the answer is confirmed

`requestDocSummaries` (`src/handoff.js:669`) is the existing pattern for "get one more
answer out of the session that is about to be replaced", and its discipline is the product
of a live-verified bug (`src/handoff.js:640-657`):

1. snapshot the current final result **before** sending the prompt (without the baseline
   the first poll returns the previous answer as if it were the reply),
2. send the prompt non-blocking through `promptSession`,
3. poll `fetchSnapshot(...).result` until it has **changed from the baseline** *and* matches
   a shape check (`looksLikeDocSummariesReply`, `src/handoff.js:632`); a changed-but-foreign
   reply becomes the new baseline and the poll continues,
4. time out after `DOC_SUMMARIES_TIMEOUT_MS = 120_000` at `DOC_SUMMARIES_POLL_MS = 500`
   (`src/handoff.js:625-626`) and throw, so the caller can fall back.

The reply is then normalised defensively — `validateDocSummaries`
(`src/handoff.js:735-765`) re-emits the recognised sections in canonical order and falls
back to a placeholder block for any missing one; `capChars` bounds each section at
`DOC_SUMMARY_MAX_CHARS = 400` characters (`src/handoff.js:616`, `src/handoff.js:760`).

### 1.5 Settings, and how the sidebar writes them

- `getSettings()` (`src/settings.js:528`) resolves **file > env > default**, cached for
  `TTL_MS = 2000` (`src/settings.js:400`), from `~/.config/opencode/agent-intercom.json`.
  Every key is validated individually and an invalid value silently leaves the resolved
  default standing (`src/settings.js:587-747`). The boolean key `endlessMode` is
  validated by `typeof raw?.endlessMode === "boolean"` (`src/settings.js:694-696`); every
  numeric key goes through `Number.isInteger(raw?.x) && raw.x >= 0`.
- The sidebar's store writes through a read-modify-write: `applySetting` reads
  `file.readRaw()`, computes the next value from **that** read, merges and writes
  (`tui/src/settings-file.ts:634-646`). Keys the panel does not know stay untouched,
  and "a key absent from the file stays absent: its env-or-default resolution is
  displayed, never written back" (`tui/src/settings-file.ts:77-78`).
- `createJsonObjectFile` (`tui/src/json-object-file.ts:33`) is the shared disk half: an
  absent file reads as `{}` so the first write creates it, an unreadable or unparsable one
  **throws** so the caller refuses to write over content it could not read.
- The sidebar's `Settings` (`tui/src/settings-file.ts:117-142`) carry `endlessMode` and
  `endlessContext` beside the subagent cap, the context, watchdog, retention, reuse and
  result limits, and the agentcom and compaction switches. `isLimit`
  (`tui/src/settings-file.ts:306`) accepts whole numbers >= 0 and `isFlag`
  (`tui/src/settings-file.ts:311`) real booleans; `SETTING_VALIDATORS`
  (`tui/src/settings-file.ts:341-365`) is a mapped type over every key of `Settings` the file
  carries, pairing each key with its own check, so a key added to the panel cannot be left
  without one. `mergeSetting` (`tui/src/settings-file.ts:623`) drops from the write only the
  keys failing THEIR OWN validator (`pruneSettings`, `tui/src/settings-file.ts:588-619`) —
  stepping a limit cannot delete the boolean.
- Row shapes in the panel: the per-agent-type numeric limits sit in the LLM params
  section under a shared agent cycler with `[-] value [+]` and `holdRepeat`
  (`tui/src/tui.tsx:2603-2814`); the endless-mode toggle and its threshold row sit in the
  Subagents section: the `endless mode` row is a single cell — `[on] ` in `success`,
  `[off]` in `textMuted`, `[restarting]` or `[paused]` in `warning` — and the
  `endless (k)` row beneath it a `[-] value [+]` stepper in thousands
  (`tui/src/tui.tsx:2502-2537`). Fixed column widths keep the buttons from
  shifting (`tui/src/tui.tsx:174-186`).
- The panel re-reads the file on a 30 s timer and whenever a file-backed section is opened
  (`refreshFileState`, `tui/src/tui.tsx:635-654`, `tui/src/tui.tsx:713-716`).
- `test/settings-defaults-parity.test.js` imports both sides and fails on a divergence of
  the shared defaults (`src/settings.js:112-378`).

### 1.6 What the sidebar can do that the server-side plugin cannot

The sidebar plugin navigates the TUI's own view: `api.route.navigate("session", { sessionID
})` in `openSubagent` (`tui/src/tui.tsx:1379-1380`) and, when the session the user is
watching is about to be torn down, to its parent — or, where that is gone, further up the
chain and finally to the orchestrator — "otherwise the route points at a missing session and
the TUI falls back to the start page, losing the orchestrator chat" (`tui/src/tui.tsx:1641-1654`,
`escapeRoute` at `tui/src/tui.tsx:1087-1122`). It subscribes to `session.created`,
`session.updated`, `session.idle`, `session.deleted`, `session.error`, `session.status`,
`message.updated` (`tui/src/tui.tsx:1713-1721`).

The server-side plugin reaches into the TUI through `showToast`
(`client.tui.showToast`, `src/client.js:1375`), explicitly a no-op outside the TUI
(`src/client.js:1369`), and through `selectTuiSession` (`src/client.js:1303`), which
switches the TUI to a session (§4.3).

## 2. What is decided, and what it costs

### 2.1 Endless mode is the existing handoff with three additions, not a second mechanism

Recommended.

| shape | cost | what it forecloses | what it demands of the implementer |
|---|---|---|---|
| **endless mode drives the existing handoff** (recommended) | the handoff's ten steps gain two conditional ones; one new latch beside `pendingHandoffs` | nothing — the plain handoff keeps working with endless mode off | understanding `performPrimaryHandoff`'s failure discipline before touching it |
| a separate endless sequence beside the handoff | two code paths that both create sessions and retire primaries | — | re-implementing the delivery drain (`src/registry.js:1266-1351`), the redirect chain (`:1356`), the reparent (`:1214`) and the archive-not-delete rule; two of them can be open at once and the drain is keyed by session id, so they would collide |
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

`maxPrimaryContext` defaults to 80 000 (`src/settings.js:137`); the user asks for 250 000.
Both cannot be armed on the same session — the lower one always fires first and the endless
threshold would never be reached.

| how the two thresholds coexist | cost | what it forecloses | what it demands |
|---|---|---|---|
| **`endlessContext`, a separate key; while `endlessMode` is on it is the only primary threshold in effect** (recommended) | one settings key, one branch in the transform hook | nothing | the branch must be in one place — the resolution function of §3.2, not scattered |
| reuse `maxPrimaryContext` and let the sidebar switch its value | no new key | the user's plain-handoff threshold: turning endless mode off would leave 250 000 behind | a write to a numeric key on a boolean toggle — the panel would silently rewrite a limit the user set by hand |
| arm both, endless mode wins on the *tie* | no new branch | — | arithmetically inert: at 80 000 the plain handoff fires and the primary is replaced, so the count never reaches 250 000 |

### 2.3 A wind-down subagent writes the todo file; the plugin permits exactly one and verifies it

Recommended — and it is what makes requirement "how the plugin knows the write actually
happened rather than assuming it" answerable at all.

| who writes the todo file | cost | what it forecloses | what it demands |
|---|---|---|---|
| **the orchestrator spawns one wind-down `planner` through a one-time permit; that subagent rewrites the todo file with the todo tools; the plugin verifies the file it left** (recommended) | one permitted spawn after the wind-down claim, and a full-file verification | nothing | the single-use permit of §3.3, the composed child prompt, the settlement gate and the V1–V7 confirmation of §3.4 |
| the orchestrator states the points in one plain-text turn; the plugin parses and calls `addTask` | a parse of a shaped reply | the file's own prose, links and structure | the parse is a lossy funnel — a title and a criterion, no links, no prose — and its read-back confirms only its own appended lines, never that the file as a whole is coherent |
| grant the orchestrator `todo_add` for the duration | a hole in `PRIMARY_TOOLS` | the invariant that a primary runs no tool but spawn/abort/list/message/reuse (`src/hooks.js:2981`) | a time-boxed exception in the guard, and the plugin still cannot tell a successful write from a hallucinated one without re-reading the file |

The spawn is *after* the wind-down claim, not before it — the permit admits exactly one
subagent, once, after the wait is over and every other spawn is refused (§3.3). And the wind-down `planner` not holding the orchestrator's context is answered
by the hand-over payload the plugin composes for it (§3.4): the orchestrator's saved state is
handed to the subagent, which owns the todo tools and writes the file itself. The plugin then
verifies the file on disk rather than trusting either party.

## 3. The design

### 3.1 The cycle

1. **Observe.** The primary's transform hook records `ctxTokens` as it does today
   (`src/hooks.js:468-470`). With endless mode on, `scheduleEndlessIfNeeded` compares against
   `endlessContext` and, when it is reached, sets the `pendingEndless` latch. Marking only —
   the same reason as the plain handoff (`src/hooks.js:488-497`).
2. **Keep working.** The latch restricts nothing. The orchestrator goes on spawning,
   aborting and reusing as usual, through the rest of its turn and through the wait below.
   From the latch until the wind-down claim (`hasEndlessCycle && !isEndlessWindingDown`), the
   primary's per-turn limits block (`formatLimitsNotice`, `src/hooks.js`) carries
   `ENDLESS_RESTART_PENDING_NOTICE`: a restart is pending, finish only the work already
   running, wait for the running subagents, then end the turn. The crossing turn carries it
   already; the release, the cancel of an unclaimed latch and the wind-down claim take it off.
   Solo mode arms no cycle and gets no such block.
3. **Quiesce and claim.** On the primary's `session.idle`, the endless path claims the latch
   and waits until none of the primary's subagents runs — those it started after the latch
   included — and the primary is idle. In the same synchronous step as that reading it claims
   the wind-down; from the claim on, `spawn` admits the wind-down permit alone (§3.3). The wait
   does not abandon while a subagent of the primary runs.
4. **Save**, in five sub-steps (§3.4): **prepare** — resolve the todo file, insert the machine
   section where it is absent, write it, and snapshot its content, hash and parse; **arm** the
   single-use wind-down permit; run the **wind-down** turn — ask the orchestrator to spawn the
   wind-down `planner` through the permit (the plugin spawns it itself if the orchestrator does
   not); **settle** — await the wind-down subagent's own ending, so the confirmation never runs
   against a still-writing child; **confirm** — V1–V7 over the file as a whole, restoring the
   snapshot on a rejection.
5. **Replace.** `performPrimaryHandoff` runs, with the endless kickoff instead of the
   doc-summary kickoff (§3.5).
6. **Work off.** The new session's first turn is the instruction to work the todo file off
   (§3.5). It runs normally: it spawns subagents, they tick tasks off through the existing
   `DONE: T<n>` path (`src/hooks.js:2176-2179`), its context grows, and step 1 applies to it.

Steps 3, 4 and 5 run **detached from the event handler**, as `maybeRunPendingHandoff` already
does (`src/hooks.js:1829-1837`), because the sequence can take minutes. The two-phase shape is
not only this codebase's own live-verified lesson (`src/hooks.js:488-497`): opencode's own
behaviour is that prompting, aborting or deleting the active session from inside one of its
own hooks is re-entrant and can hang or race, which is exactly what the mark-then-execute
split avoids.

### 3.2 Settings

The endless keys in `~/.config/opencode/agent-intercom.json`, resolved by `getSettings()` on
the existing file > env > default rule (`src/settings.js:528-757`):

| key | type | default | env var |
|---|---|---|---|
| `endlessMode` | boolean | `true` | `OPENCODE_AGENT_INTERCOM_ENDLESS_MODE` (`"1"`/`"0"`) |
| `endlessContext` | integer ≥ 0 | `250000` | `OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT` |
| `endlessQuiesceTimeoutMs` | integer ≥ 0 | `600000` | `OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS` |
| `endlessWindDownTimeoutMs` | integer ≥ 0 | `900000` | `OPENCODE_AGENT_INTERCOM_ENDLESS_WIND_DOWN_TIMEOUT_MS` |

`endlessQuiesceTimeoutMs` bounds only the part of the quiesce wait in which none of the
primary's subagents runs (§3.3). `endlessWindDownTimeoutMs` bounds the
wind-down turn and, minus one `DOC_SUMMARIES_POLL_MS`,
the child waiter that the settlement gate blocks on (§3.4). The sidebar does not show it — it
is an env/file-only tuning key, unlike `endlessContext` which has a row (§3.7).

`endlessMode` is one of the file's boolean keys, beside `showAgentcom`, `midRunMessaging` and
`compaction`, and is taken from the file only as a real boolean:
`if (typeof raw?.endlessMode === "boolean") resolved.endlessMode = raw.endlessMode`
(`src/settings.js:694-696`). Anything else — `"true"`, `1`, `null` — leaves the env-or-default
resolution standing, matching how every other key behaves on a bad value
(`src/settings.js:587-747`).

One resolution function owns the branch, so no caller has to know the rule
(`primaryContextThreshold`, `src/settings.js:1094-1097`, over `endlessModeInEffect`,
`:1078-1081`, which is false in solo mode and for a paused session):

```
primaryContextThreshold()  →  endlessModeInEffect ? endlessContext : maxPrimaryContext
```

`endlessContext: 0` disables the endless trigger the way `maxPrimaryContext: 0` disables the
plain one (`src/registry.js:1543-1545` returns false for a non-positive threshold), which means
"endless mode on, threshold 0" is a legal state that arms nothing. It is not an error and is
not corrected.

### 3.3 Quiesce, the wind-down claim, and the subagent that starts after the trigger

**Definition.** The primary is quiesced when, read inside one `registryMutex.runExclusive`
section (`quiescedNow`, `src/registry.js`), none of its own subagents is running
(`countActiveSubagentsFor(sessionID) === 0`), `pendingSpawns.count === 0`,
`pendingDeliveries.count === 0`, no handoff drain is open for it (`hasHandoffDrain`), and the
primary itself is not inside a turn (`endlessPrimaryBusy`). `pendingSpawns.count` covers a spawn
that has reserved its slot but not yet reached `upsertSession`; `pendingDeliveries.count` covers
a result whose entry has left the registry but whose wake notice is not yet posted.

**The active-subagent count is scoped to the endless primary.** `countActiveSubagentsFor`
counts only the registry entries whose `parentID` is the primary whose cycle is running. A
second orchestrator's subagents do not hold up this cycle. The spawn cap's own count remains
global — `countActiveSubagents` is untouched — so the per-cycle wait and the cap disagree on
purpose. The two counters stay process-wide because neither carries a parent to scope by; each
covers a one-round-trip window in which the primary's own work is not yet visible to a registry
scan. A nested run is covered transitively: a nested spawn blocks its caller, whose own entry
stays running for as long as its child does.

**The primary's turn.** `endlessPrimaryBusy` (`src/state.js`) holds the primaries that hold a
cycle and are inside a turn. It is set by `markEndlessPending` (the transform that marks runs
inside a turn), by the primary's transform on every step, by a `session.status` event other
than `idle`, and by `postParentNotice` **before** it posts a notice into the primary (the post
starts or feeds a turn, so the predicate cannot read the primary idle between the post and that
turn's busy event). It is cleared by the primary's `session.idle` — before the endless call on
that idle runs — and by a `session.status` `idle`, and it goes with `releaseEndless`,
`cancelPendingEndless` and `forgetPrimary`. A primary holding no cycle is not tracked.

**A subagent that starts after the trigger fired.** The orchestrator keeps its tools. Between
the latch and the claim it can call `spawn`, `abort` and `reuse` as usual, in the turn that
crossed the ceiling, in a turn a wake notice starts, and in a turn a user message starts. Every
subagent it starts is one more the quiesce waits for; the wait ends only when the count of the
primary's own subagents is zero, however they came about, and the primary is idle. The
restart-pending sentence in its limits block (step 2 of §3.1) asks it on every turn of that
window to let the running work drain rather than refill freed slots.

| how a post-trigger spawn is handled | cost | what it forecloses | what it demands |
|---|---|---|---|
| **allow spawns until the wind-down claim, wait for everything the primary runs, restrict to the one permitted wind-down spawn from the claim on** (recommended) | the restart waits as long as the orchestrator keeps delegating | nothing — the orchestrator answers its user and finishes its work normally | a primary-busy term in the quiesce predicate, and the claim taken in the same synchronous step as the quiesce reading |
| `spawn` refuses from the latch on | the orchestrator cannot delegate for the whole wait, which runs to minutes while its subagents finish and the wind-down child writes | the user's own messages in that window are answered by refusals | — |
| allow spawns and let them be reparented onto the new session | none | — | the new orchestrator receives results for work it never commissioned, in a session whose kickoff says "work off the todo file" |

**The wind-down claim.** Each quiesce poll calls `claimEndlessWindDown(sessionID)`, which reads
the predicate and, where it holds, adds the primary to `endlessWindingDown` inside the same mutex
section. No spawn, delivery or primary turn can be admitted between the reading and the claim:
a spawn from the primary happens inside a turn, which the busy term excludes, and a nested
spawn's caller is a running subagent, which the count excludes. From the claim until the cycle
ends (`releaseEndless`, `forgetPrimary`), `isEndlessWindingDown` holds and:

- `spawn` from the root primary is refused unless it is the permitted wind-down spawn below; the
  refusal without an armed permit says the hand-over has begun, that no further subagent starts
  in this session, and that the work it meant to delegate belongs in the hand-over it is asked
  for; with an armed, unconsumed permit it spells out the one allowed call;
- a nested caller gets a returned refusal it can act on — do what it can, name what it needs,
  open with `Blocked:`;
- `reuse` throws — the cycle drops every retained subagent right after the claim.

The gate asks about the caller's **root** primary (`rootPrimaryFor`), since the endless sets
hold primary ids only.

**The one permitted spawn.** After the wind-down claim the plugin arms a single-use permit for the
primary, a record in `src/registry.js` keyed by session id (`token`, `agent`, `consumed`,
`restores`, `childSessionID`, `settlement`). A spawn is admitted only when **all five** hold:
the cycle has claimed its wind-down (`endlessWindingDown`); the caller is the root
primary, not a nested subagent; `args.agent === "planner"`; the first non-empty line of
`args.prompt` is exactly `INTERCOM-WIND-DOWN <token>`, the token being per-cycle random and
appearing nowhere but the wind-down prompt sent to that one primary; and the permit is
unconsumed. Consumption happens **in the same synchronous block as the test**, before any
`await` — the TOCTOU discipline `reservePendingTaskId` already follows (`src/tools.js:608-633`).

The consume is a reservation, not a burn: everything that can still fail — `createChildSession`
returning no id, `promptSession` throwing — sits after the synchronous consume, so those two
branches, and only those two, put the permit back (`restoreEndlessWindDown`, same token,
`childSessionID: null`), **capped at one restore**. A second failure leaves it consumed and the
cycle goes to the *consumed but no child* failure, so the window cannot reopen indefinitely.

What keeps the exception from becoming a general reopening:

- single use, consumed atomically at admission; a second spawn in the same turn finds it
  consumed and throws; a refusal never consumes it, and its text spells out the one allowed
  spawn so a wrong attempt self-corrects instead of exhausting the window;
- one agent type and one token, both chosen by the plugin;
- **the plugin composes the child's prompt; the orchestrator supplies a payload, not
  instructions.** `args.prompt` is never passed through. The plugin builds its own instruction
  block, then a `## HAND-OVER FROM THE PREVIOUS ORCHESTRATOR` heading carrying the orchestrator's
  text with the `INTERCOM-WIND-DOWN <token>` line stripped, capped at `WIND_DOWN_PAYLOAD_MAX_CHARS`
  (32 000), then the contract. Without this the permit would hand the orchestrator one arbitrary
  file-writing `planner` run whose task it chooses — a widening §2.3 never decided on;
- armed at exactly one call site, between the wind-down claim and the wind-down turn — never
  before the claim; disarmed in a `finally` on every exit of `runEndlessCycle`, and by
  `forgetPrimary`;
- the wind-down subagent is itself under the wind-down restriction, so its own nested spawns
  still take the nested refusal; the exception does not propagate downward;
- `reuse` throws from the claim on — its targets are retained subagents, which the cycle drops
  right after the claim.

The admitted spawn is exempted from five gates, each for a stated reason: the multi-task bundle
guard (the briefing names every open task id by design), the package-size refusal (the payload
bound moves to `WIND_DOWN_PAYLOAD_MAX_CHARS`), the duplicate-task-id reservation (the prompt
carries no single id), the global spawn cap (quiesce is scoped to this primary), and retention
(the cycle drops every retained session anyway).

**The bound.** Quiesce is polled at `ENDLESS_QUIESCE_POLL_MS` (500 ms). While a subagent of
the primary runs, the wait does not abandon, however long it takes: every poll that counts one
running (`countActive`) re-arms the deadline at `now + endlessQuiesceTimeoutMs`. A stuck subagent
is reaped by the subagent watchdog — the silence window `maxSubagentAgeMs`, the tool-call window
`maxSubagentToolCallMs` and the run ceiling `maxSubagentRunMs` — and a watchdog abort ends in the
same teardown that removes the registry entry; the orchestrator can also `abort` it. Where the
user has switched those windows off, a subagent that never ends holds the wait open, and the
orchestrator keeps working meanwhile.

What remains of the abandon is the wait in which **none** of the primary's subagents runs and
the quiesce still does not come: the primary stays inside a turn, or a process-wide spawn or
delivery window or a handoff drain stays open. Once `endlessQuiesceTimeoutMs` (default
600 000 ms) has passed since the last poll that saw a subagent running — or since the wait
began — the cycle abandons with `no subagent running, but not quiesced after <elapsed>ms`. It is
the backstop for a busy mark or a counter that no event clears. The cycle is then **abandoned,
not forced**: the latch is released, a toast fires, the cooldown of §3.6 applies, and the next
over-threshold turn re-schedules. Aborting a working subagent to make room for a context refresh
would destroy real work to save context.

### 3.4 Writing the todo file, and knowing that it happened

The save runs in five sub-steps — prepare, arm, wind-down, settle, confirm — and never
trusts either the orchestrator's words or the subagent's; the proof is the file on disk.

**Prepare, and the section anchor.** Before any turn is spent, the plugin resolves the todo
file (`findTodoFile`, `src/todofile.js:192`, creating the canonical `TODO.md` where the
directory has none), inserts its machine-owned section where the markers are absent, **writes
the file**, and snapshots: the resolved name, the raw content, its SHA-256, the section split,
and `parseTasks` over it. The section is `## Intercom tasks`, delimited by two HTML-comment
markers the plugin owns:

```
## Intercom tasks
<!-- intercom:begin -->
- T46: <title>
  accept: <criterion>
  link: specs/endless-mode.md §3.4
<!-- intercom: next-id T47 -->
<!-- intercom:end -->
```

The markers, not the heading, are the authority: a human may rename or translate the heading
without the plugin losing its section, and V4 below is defined on *outside the markers*. The
plugin, never the subagent, creates the section (`ensureSection(content)`, the same insertion
`addTask` uses on an unmarked file) so that the snapshot already carries it — had the subagent
created it, the new content's outside region would carry an added heading the snapshot lacks
and V4 would fail by construction on every project's first cycle. Where the markers are absent,
the anchor is: below a marker-less `## Intercom tasks` heading; else immediately after the
first heading of **level 2 or deeper** matching `/^#{2,6}\s+(open|pending|todo|todos)\b/i` — a
level-1 document title is skipped even when its text matches, because `# TODO` at the top names
the whole file, not a section within it; else at the end of the file. A human `## Open` section
is never adopted; its prose stays outside the markers, where V4 protects it line for line.

**Arm.** The single-use wind-down permit (§3.3) is armed for the primary.

**The wind-down turn.** A prompt beside `DOC_SUMMARY_PROMPT` asks the orchestrator to spawn one
`planner` with `INTERCOM-WIND-DOWN <token>` on the first line of the spawn prompt and its saved
state as the payload, and to end its turn with one of three closing lines drawn from context,
not from disk: `## WIND-DOWN DONE — <n> open`, `## WIND-DOWN DONE — no change`, or
`## WIND-DOWN DONE — nothing open`. The reply is obtained through the same
baseline/re-baseline/timeout discipline as `requestDocSummaries`, bounded by
`endlessWindDownTimeoutMs`, its shape check `looksLikeWindDownReply`. The shaped reply is the
signal the turn is over — not that the write finished. Where the orchestrator places no
permitted spawn (a model that could not manage the tool call at its ceiling), the permit is
found unconsumed, the plugin **disarms it synchronously** and then starts the wind-down subagent
itself, so a late permitted spawn cannot add a second writer against the same file.

**The composed child prompt.** `args.prompt` is never passed through. The plugin builds its own
instruction block, a `## HAND-OVER FROM THE PREVIOUS ORCHESTRATOR` heading carrying the
orchestrator's payload with the token line stripped and capped at `WIND_DOWN_PAYLOAD_MAX_CHARS`
(32 000), then the contract. The subagent is a `planner` and holds the todo tools; it rewrites
the file, confined between the two markers, and maintains the `<!-- intercom: next-id T<n> -->`
watermark so ids stay monotone.

**Settle — the gate.** The child's own ending, not the primary's text, proves the write
finished. The permitted (or fallback) spawn registers a child waiter with an explicit ceiling
`timeoutMs = endlessWindDownTimeoutMs − DOC_SUMMARIES_POLL_MS`, and `runEndlessCycle` awaits that
settlement before the confirmation runs. The blocking is a convenience, not a proof: a model that
writes `## WIND-DOWN DONE` and *then* calls `spawn` would satisfy the shape check while the child
is still rewriting the file, and `writeAt` (`src/todofile.js:232`) is `O_TRUNC` + `writeFileSync`,
so a concurrent read can see a truncated file. Where the waiter reports `status: "expired"` — the
child never settled — the plugin **ends the child itself** (abort + teardown, which settles the
waiter) and abandons; nothing may leave a writer running into the next cycle's snapshot.

**Confirm — V1–V7 over the whole file.** After the child has settled the plugin re-resolves and
re-reads, and **all** of these must hold or the cycle abandons without replacing the session:

| # | predicate | on failure |
|---|---|---|
| V1 | `findTodoFile` resolves to exactly one regular file, same name as the snapshot | abandon (`multiple` / `not-a-file` / renamed) — no file to restore to |
| V2 | the child's outcome is `completed` | accepted anyway when V3–V5 all hold |
| V3 | the content hash differs from the snapshot, **or** the reply carries `## WIND-DOWN DONE — no change` | the bounded re-ask below, or restore, abandon |
| V4 | exactly one `begin` and one `end` marker in order, and `outsideLines(new)` equals `expectedOutside` | restore, abandon |
| V5 | `parseTasks` yields ≥ 1 task, every id unique, every title non-empty | restore, abandon (except the explicit-empty case) |
| V6 | a snapshot id's title differs from the new title | log the id, old title and new title; continue — the wind-down may refresh stale work |
| V7 | the reply's stated open-task count equals the parse's | log the mismatch; the parse wins, no abandon |

V6 is diagnostic only. For every existing id whose normalised title changes, the plugin logs
that id together with the snapshot's old title and the new title, then continues with the V3–V5
verified rewrite. A wind-down is expected to refresh a carried-over title when earlier work has
made it stale.

**The bounded re-ask.** A byte-equal file beside a reply claiming a plain open-task count is a
claim the disk does not show, but a model that simply stopped editing reads identically to one
that had nothing to drop, so the first attempt earns ONE re-ask before the verdict stands: the
cycle logs `endless: wind-down rewrite byte-equal — re-asking the primary once` and runs a
second wind-down attempt — arm, turn, settle, re-read, verify — on a fresh token (the
registry's arm overwrites a spent permit). The second attempt's result feeds the same checks:
fresh content completes normally; a byte-equal second file whose reply says
`## WIND-DOWN DONE — no change` is accepted (V3 holds on its no-change branch); a re-ask
answering `nothing open` with a zero-task parse goes to the explicit-empty stop of §3.6, not to
the accept path. Anything else restores the snapshot and abandons at `confirm` with `wind-down
rewrite rejected (V3)`, the rejected bytes filed by `writeRejectedWindDown`
(`src/endless.js:254`) into the result directory beside the restore.

**V4, as an algorithm over lines.** A removal shifts every byte after it, so "byte-identical"
cannot be literal. `markedRange` is the inclusive line range between the single `begin` and
`end` markers; `outsideLines` is the content minus that range; `blockRange(task)` is a task's
header line, its contiguous indented run, and at most one following blank line; `expectedOutside`
is `outsideLines(snapshot)` minus `blockRange(t)` for every task the widened parser found outside
the markers in the snapshot. V4 holds iff the new content carries exactly one `begin` and one
`end` marker in order and `outsideLines(new)` equals `expectedOutside` as a sequence of strings.
The one licensed outside-change is therefore exactly the migration: whole task blocks the parser
recognised in the snapshot leaving the outside region. The set is computed by the plugin from its
own snapshot, never asserted by the subagent.

**A rejected rewrite is undone.** Prepare holds the exact snapshot bytes; a failure of V1, V3, V4,
V5 means the file on disk is a rewrite the plugin refuses to stand behind, so before
abandoning it files the rejected bytes (`writeRejectedWindDown`, whose path the log line names),
writes the snapshot back and logs `endless: wind-down rewrite rejected — the todo file was
restored`. Where the restore itself throws, the error toast names the path and the failed
predicate. V1's renamed / `multiple` / `not-a-file` case is the exception: there is no resolved
file to write back to. A V6 title change is logged with its id and old/new titles but is not a
rejection.

**Two shapes, one writer.** The widened `TASK_LINE_RE` (`/^(\s*)[-*]\s+(T\d+)\s*(?::|—|–|-)?\s+(.*)$/`)
is a *reading* instrument only — `listOpen`, `nextFreeId`'s scan, the drift count, the snapshot
parse. `removeTask` and `editTask` act only on canonical `- T<n>: ` lines **inside** the markers,
because `autoMarkTask` fires on `DONE: T<n>` from *any* subagent reply all session long, with V4
nowhere near it; a naive widening would let `DONE: T1` delete a human `- T1 — …` bullet and its
indented run. A `DONE: T<n>` that resolves only to a legacy line outside the markers returns the
`{ kind: "unmigrated", id }` outcome — finished, but left in place until the next wind-down
migrates it.

**Confirmation — the part that is not assumed.** The plugin knows three things by observation:
that the file resolved to one regular file (V1), that the file as a whole changed and still parses
(V3, V5), and that nothing outside the machine section moved (V4). The confirmed open-id count goes
into the log line and the kickoff. The invariant — no replacement without a confirmed save — is
preserved by V1–V5 as a set; V6 and V7 add observations without rejecting an otherwise
verified rewrite.

**Failure.** Any abandon — quiesce timeout, prepare throw, a fallback that could not start a child,
a child that never settled, a rejected rewrite — leaves the session **not** replaced: replacing it
after failing to save its state is precisely the data loss endless mode exists to prevent. Latch
released, wind-down restriction lifted, permit disarmed, error toast, and the cooldown of §3.6
applies.

The explicit-empty case — `parseTasks` yields zero tasks **and** the reply carries
`## WIND-DOWN DONE — nothing open` — is not a failure and is handled in §3.6.

### 3.5 The replacement, and what the new session is told

`performPrimaryHandoff` (`src/handoff.js:139`) runs unchanged in structure. Two of its
injected dependencies differ in an endless cycle:

- `promptOldPrimaryForDocSummaries` is **not** called a second time. The wind-down turn of
  §3.4 has already happened and the doc summaries would be a third long turn on a session at
  its ceiling. The endless path passes a dependency that returns the already-obtained
  wind-down reply as the `docSummariesText`, so the new orchestrator reads the real files
  itself, which it can, because it has the context to.
- The kickoff message (`src/handoff.js:353-358`) places the endless block before the
  handoff summary. On this path the predecessor's last-user goal is omitted from the summary:
  the todo file already decomposes it, and leaving the imperative in place would give the
  successor a spent competing instruction:

  ```
  ## Endless mode — work off the todo file

  The previous orchestrator session reached its context ceiling. A wind-down subagent
  has updated <todo file name> with everything that is still open; the fresh session
  continues from it.

  <todo file name> as it stands now:

  <the file's own text, verbatim>

  Your job for this session: work that todo file off, top to bottom. The first task
  is the next one to do. Spawn one subagent per task with the task id on the first
  line of the spawn prompt. A task is finished when its subagent reports
  `DONE: T<n>` — the plugin removes it from the file itself. Do not re-plan the list;
  start with the first task.
  ```

  **The kickoff carries the file's own text, not a re-rendered listing.** A primary holds
  `spawn` / `abort` / `list` / `message` / `reuse` and nothing else (`PRIMARY_TOOLS`,
  `src/hooks.js:173`),
  so the successor cannot open the todo file. Naming the file alone would hand it a session
  with nothing concrete in it. So the kickoff carries the confirmed file's own text verbatim
  (`endlessKickoffBlock`, `src/endless.js`), bounded by `KICKOFF_TODO_MAX_CHARS` (16 000) and
  cut at a block boundary (`cutTodoText`) so no task's indented run is split. Where the text
  was truncated, or none could be read, the block instead tells the successor to have a
  subagent read the file in full before planning past what is shown — the one way into the
  file a primary has.

Everything else stands: the drain buffers notices from the moment the sequence starts
(`src/handoff.js:166`), reparent happens before the kickoff is composed (`:264`), the old
session is archived and not deleted (`:419-428`), and the failure discipline reverts anything
before the kickoff and proceeds past it (`:359-388`, `:390-431`).

**The view follows.** Immediately after the kickoff is sent — step 6, before the drain flush
— the plugin switches the TUI to the new session (§4.3). Order matters: switching before the
kickoff would show the user an empty session, and switching after the archive would leave a
window in which the displayed session is already retired.

`promptSession` marks the kickoff as plugin-generated via `intercomTextPart`
(`src/client.js:387`, `src/pluginmsg.js`), so the *next* cycle's `lastUserGoal` scan skips it
(`src/handoff.js:844-851`) — without that, each cycle would adopt the previous cycle's kickoff as
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

The pause travels out of process to the sidebar under
`~/.cache/opencode-agent-intercom/endless-pauses.json`
(`publishEndlessPause`, `src/endlesspause.js`), mirrored by the three writers
of the in-process pause map (`pauseEndless`, `clearEndlessPause`, `forgetPrimary`,
all in `src/registry.js`). The sidebar reads it (`tui/src/endless-pause-file.ts`,
rendered in `tui/src/tui.tsx`); the in-process map stays the sole authority and
nothing reads the file back into a decision. An entry whose writer pid is gone
is dropped on read and pruned on the next write.

1. **Nothing left to do.** When the confirmation's parse yields zero tasks *and* the wind-down
   reply carries `## WIND-DOWN DONE — nothing open`, the cycle stops before the replacement:
   latch released, wind-down restriction lifted, the primary paused, success toast "endless mode: no open
   points left — paused for this session". A restart into an empty todo file would produce a
   session with nothing to do, which would idle, be woken by nothing, and sit at the start of a
   fresh context forever.
2. **No progress.** The plugin records, at the end of each cycle, the set of open task **ids**
   the cycle LEFT in the todo file, and compares it against the set the next cycle FINDS there
   before its own write. A cycle counts as stalled only when not one of the ids the previous
   cycle handed over has left the file; what the cycle added does not enter the verdict, so a
   cycle that finished one task and discovered five is progress and a cycle that finished nothing
   is a stall whatever it saved. Ids rather than titles: the watermark (§3.4) makes ids monotone
   so a removed task's id is never handed out again, and the titles are now authored by the
   wind-down subagent, so a merely rephrased list would read as progress that did not happen. If
   two consecutive cycles are stalled, endless mode pauses itself with a warning toast naming the
   open-task count. This bound fires AFTER the replacement, so the pause goes on the NEW primary —
   pausing the session just retired would bound nothing. This is the bound against the failure the
   whole mode invites: an orchestrator that saves the same points every 250 000 tokens and never
   finishes one.
3. **A cycle ceiling.** `endlessMaxCycles`, default 10, counted per opencode process across
   the redirect chain — `handoffGeneration(sessionID)` (`src/registry.js:1372`) already derives
   the generation number from `handoffRedirects`, so the ceiling needs no new state. At the
   ceiling endless mode pauses itself with a toast. Ten cycles at 250 000 tokens is a
   very long session; a user who wants more turns it back on.
4. **A cooldown after a failed cycle.** A cycle that abandoned (quiesce timeout, save
   failure, handoff failure) sets a cooldown of 5 minutes on that primary during which
   `scheduleEndlessIfNeeded` returns false. Without it, a primary already over the threshold
   re-schedules on its next turn and retries continuously — the same hot-loop
   `releaseHandoff` avoids by not restoring the pending flag (`src/registry.js:1616-1625`).
5. **The switch.** Turning the sidebar row off drops a latch that has not been claimed yet
   on the primary's next turn after the settings read picks the change
   up (`cancelPendingEndless`, `src/registry.js`). A cycle already claimed by the idle handler —
   from the quiesce wait on — is not touched: prepare writes the todo file and the permit is
   live from arm, so a claimed cycle runs through to the replacement, a self-stop or an abandon
   rather than stopping mid-flight, and the sidebar row reads `[restarting]` until it has
   (§3.7). The switch-off takes effect from the next schedule.

None of these five stops writes the settings file, deletes a session, aborts a subagent or
removes a task.

### 3.7 The sidebar row

In the Subagents block, beneath `run (min)` and its note line and above the TUI settings
section, the `endless mode` row and the threshold row beneath it (`tui/src/tui.tsx`):

```
  endless mode   [on]
  endless (k)    [-] 250 [+]
```

while a cycle is pending or running for the current session:

```
  endless mode   [restarting]
     waiting for subagents (2 running)
  endless (k)    [-] 250 [+]
```

or, while endless mode has paused itself for the current session:

```
  endless mode   [paused]
     no open points left
  endless (k)    [-] 250 [+]
```

The row state is one computation, `endlessRowState` (`tui/src/endless-pause-file.ts`), fed
with the switch, the published pause, the agent mode from the settings file and the published
cycle, and resolved in this order:

1. `solo` — the file's `agentMode` is `"solo"`; no cycle runs in that process. The cell
   reads `[off]`, the note line reads `solo mode runs no cycle`, and the row does not react
   to a click (`endlessRowLive`).
2. `restarting` — a cycle is published for this session. It outranks the switch: a switch-off
   does not stop a cycle that has already been claimed (§3.6, item 5), so `[off]` would name
   the setting and not the loop.
3. `off` — the switch is off. It outranks a pause left standing, because the user's
   switch-off is the younger statement and is what the plugin's mode-off branch uses to clear
   the pause on the primary's next turn.
4. `paused` — the switch is on and a pause is published for this session.
5. `on` — otherwise.

The cell text is `"[restarting]"`, `"[paused]"`, `"[on] "` or `"[off]"` (`endlessRowCell`),
coloured `theme.warning` for `restarting` and `paused`, `theme.success` for `on` and
`theme.textMuted` otherwise. `onMouseDown` toggles the boolean in the settings file in every
state but `solo`, so switching off and on again clears a pause.

The note line under the row comes from `endlessRowNote`, cut to the panel width beside the
indent every note line uses; it is not rendered where it is empty (`on`, `off`, and a
`restarting` or `paused` with nothing to name). Under `[paused]` it is the head of the
published sentence at `" — "` (`pauseCause`); a sentence without that separator is shown
whole. Under `[restarting]` it names the step the cycle is in (`cycleStepText`):

| published step | note line | entered |
|---|---|---|
| `turn` | `waiting for the turn to end` | the latch is set (`markEndlessPending`), until the primary's turn ends and the idle handler claims the cycle |
| `quiesce` | `waiting for subagents (N running)`, or `waiting for subagents` where no count above 0 is published | the claim (`claimPendingEndless`), then on every quiesce poll with the count of the primary's own subagents still running — the whole wait, those spawned during it and the primary's own turn included |
| `wind-down` | `saving open points` | the wind-down claim, from the prepare step through the wind-down turn, its child's settle and a re-ask |
| `successor` | `starting fresh session` | the rewrite has passed its checks; the confirmation and the replacement run |

The cycle travels out of process under `~/.cache/opencode-agent-intercom/endless-cycles.json`
(`src/endlesscycle.js`), keyed by the primary session the cycle replaces:

```
{ "ses_x": { "step": "quiesce", "running": 2, "at": 1757280000000, "pid": 4711 } }
```

`step` is one of `turn`, `quiesce`, `wind-down`, `successor`; `running` is written for
`quiesce` alone; `at` is when the step was entered and does not move while the step stays;
`pid` is the writing process. The latches `pendingEndless` and `endlessInProgress`
(`src/registry.js`) stay the authority and nothing reads the file back into a decision. The
entry is set in `markEndlessPending` (`turn`) and `claimPendingEndless` (`quiesce`), moved by
the cycle's `onStep` reports (`runEndlessCycle`, `src/endless.js`, wired to `noteEndlessStep`
in `src/handoffwiring.js`), and `noteEndlessStep` publishes nothing for a session that holds
neither latch or that opencode has deleted. A report whose step and count already stand costs
no write, so only a changed running count reaches the disk during quiesce. Writes are atomic
through a sibling temp file, every failure is logged and swallowed, and a reporter that throws
never touches the cycle.

The entry is taken off — and the row leaves `[restarting]` — where a latch is released:

- `forgetPrimary`, when the successor has taken over and the old primary is dropped;
- `releaseEndless`, when the cycle abandons (the row falls back to `on`) or stops itself — a
  cycle ceiling, or nothing left to do — which also publishes the pause (`paused`);
- `cancelPendingEndless`, when the switch is turned off before the cycle was claimed;
- `forgetEndlessStep`, from `onSessionDeleted` (`src/hooks.js`), when opencode deletes the
  primary while its cycle is pending or running.

An entry whose writer pid is gone is ignored on read, by the plugin and by the panel alike,
and pruned on the plugin's next write; several opencode instances share the file, each owning
its own keys. The panel reads it in `tui/src/endless-cycle-file.ts` on every refresh pass —
event-driven and at the latest every 5 s — and on `refreshFileState`, and looks the cycle up
under the panel's orchestrator session first and its route session second
(`cycleForSession`), the same lookup the pause uses. An absent, unreadable or malformed file
reads as no cycle running. The `compaction` row counts `restarting` as endless mode being on.

The threshold row follows the numeric shape with `holdRepeat` and a step of 10 000 tokens,
displayed in thousands — from 250 to 500 in 25 taps, or a hold.

Persistence goes through `settings-file.ts` on its existing read-modify-write
(`tui/src/settings-file.ts:634-646`) with three changes:

- `Settings` gains `endlessMode: boolean` and `endlessContext: number`, and
  `resolveSettings` resolves both on the file > env > default rule the numeric ones use
  (`:394-492`).
- Each key is checked against its OWN validator: `SETTING_VALIDATORS`
  (`tui/src/settings-file.ts:341-365`) maps every key of `Settings` the file carries to
  `isLimit` for a limit, `isFlag` for a boolean such as `endlessMode`, or a per-entry filter
  for a per-type map, and `mergeSetting` (`:623`) drops only the keys that fail
  their own check. So stepping a limit cannot delete the boolean and toggling the boolean
  cannot delete a limit. `LimitKey` (`:159-166`) is the narrower list the `[-]`/`[+]` rows step —
  `endlessContext` is in it, `endlessMode` is not.
- The boolean has its own writers beside `stepSetting`: `toggleEndlessMode()`
  (`tui/src/settings-file.ts:800`), which the panel row calls (`tui/src/tui.tsx:515-517`),
  and `setEndlessMode(value)` (`tui/src/settings-file.ts:792`). The toggle flips the value
  the file holds at that moment rather than writing the panel's copy, so a switch thrown
  outside the panel by hand is toggled from rather than overwritten.
- A key absent from the file stays absent (`tui/src/settings-file.ts:77-78`): toggling writes `endlessMode` because
  the user asked for it; stepping the threshold writes `endlessContext` for the same reason.
  Neither write materialises the other, and neither touches `maxSubagents`, `maxContext`,
  `searxngUrl`, `exaApiKey` or `forumBangs`.

The panel's own copy is refreshed by `refreshFileState` (`tui/src/tui.tsx:635-644`), which
gains both signals, so a change made by hand appears within 30 seconds or immediately on
opening the section.

`test/settings-defaults-parity.test.js` covers the shared defaults, so
`DEFAULT_ENDLESS_CONTEXT = 250000` and `DEFAULT_ENDLESS_MODE = true` are exported from both
`src/settings.js` and `tui/src/settings-file.ts`.

### 3.8 Logging

One line per cycle transition, on the existing `log` helper (`src/log.js`):

```
endless: scheduled {"sessionID":"<id>","ctx":<n>,"threshold":<n>}
endless: quiesced after <ms>ms, activeAtStart=<n> {"sessionID":"<id>"}
endless: wind-down rewrite byte-equal — re-asking the primary once {"sessionID":"<id>"}
endless: wind-down confirmed <n> open task(s) [T<a>,T<b>,…] file=<name> {"sessionID":"<id>"}
endless: cycle <k>/<max> complete, new session <id>, open tasks <before>→<after> completed=<n>
endless: wind-down rewrite rejected — the todo file was restored {"sessionID":"<id>","failed":"V<k>","rejectedContentPath":"<path>"}
endless: abandoned at <stage> — <reason> {"sessionID":"<id>"}
```

The `completed=<n>` field is what §3.6's no-progress bound reads — the number of the previous
cycle's open tasks that had left the file by the time this cycle read it, `-` on the first
cycle of a run, which has nothing to compare against. `open tasks <before>→<after>` carries the
counts alongside it. The bound is a property of every run rather than of someone remembering to
look.

## 4. The restart: how the session is replaced and the view follows

### 4.1 Settled, from this repository

A plugin **can** end its own primary session and open a new one with a starting prompt, and
it does so today: `client.session.create` without a `parentID` (`src/client.js:313`,
`src/handoffwiring.js:189-205`), `client.session.promptAsync` with an `agent`
(`src/client.js:381-389`), `client.session.update` with `time.archived` to retire the old one
(`src/client.js:704-716`). No external script is needed for the session change.

### 4.2 Settled, about which half does what

The server-side plugin reaches into the TUI through `client.tui.showToast`
(`src/client.js:1372`) and, for the view switch of §4.3, through `selectTuiSession`
(`src/client.js:1303`). Inside the sidebar plugin, `api.route.navigate("session", {
sessionID })` changes what the user is looking at (`tui/src/tui.tsx:1380`, `:1120`).

### 4.3 The view switch: settled — `/tui/select-session`

After a handoff the server-side plugin has replaced the primary, but nothing in the plugin
makes the interactive TUI *show* the new session; the existing handoff leaves that
unaddressed. Under endless mode the gap matters more, because a cycle repeats and a user left
on an archived session sees an orchestrator that has stopped answering.

The opencode server exposes a route for exactly this: **`POST /tui/select-session` with
`{ sessionID }`**, and the v2 SDK surfaces it as `client.tui.selectSession`. Checked against
opencode `1.18.25`; this plugin depends on `@opencode-ai/plugin: "^1.18.23"`
(`package.json:59`), so it resolves on that line. There is no atomic restart or replace
primitive — create, prompt, select, then retire the old session is the sequence, which is the
sequence §3.1 already runs.

**How the call is made.** `selectTuiSession(client, sessionID)` in `src/client.js`, beside
`showToast` (`:1372`) and written to the same best-effort discipline — a failure is logged and
swallowed, never thrown into the handoff (`selectTuiSession`, `:1303`). It calls
`client.tui.selectSession` where the resolved client carries it, then posts
`/tui/select-session` through the client's own low-level transport, and last posts to
`serverUrl + "/tui/select-session"` with a bare `fetch`. The
fallback is not speculative: the generated typed client is known to lag the server here, and
this codebase already relies on exactly that gap in `archiveSession` — "the pinned SDK types
the update body with `title` only, but the opencode 1.17.15 server's UpdatePayload schema
accepts `time: { archived: … }` and returns 200 (source- and live-verified). The generated
hey-api client serialises the body verbatim, so the extra field passes through at runtime
despite the narrower type" (`src/client.js:699-703`). The plugin factory receives `serverUrl`
in its context object, so the direct post needs no configuration.

Two rejected alternatives, both of which this route makes unnecessary:

- **Title match in the sidebar.** A successor inherits the predecessor's own title unchanged,
  so its title carries no handoff marker that the sidebar could match. A title is also user
  controlled and can be reproduced by hand, so it cannot identify a successor reliably.
- **A handoff-pointer file polled by the sidebar.** Explicit contract, but a fourth shared
  file and up to 30 s of latency on the existing timer (`tui/src/tui.tsx:713-716`).

Both put the switch in the half that does not know when the handoff finished. The route puts
it in the half that does, in the same function that sent the kickoff, and it also fixes the
plain handoff — which has the same gap — without the sidebar changing at all.

Related, and deliberately not used: `POST /session/{id}/summarize` (`{ providerID, modelID,
auto? }`) compacts a session in place. §2.1 says why that is not this feature.

## 5. Assumptions, and what would show them wrong

- **`ctxTokens` tracks the primary's real context at 250 000 tokens.** The measurement is
  the sum opencode's own TUI displays — reasoning tokens included, over the newest
  assistant message with `tokens.output > 0` (`src/context-figure.js`) — so the threshold
  fires when the user's context display says it does. Wrong if a cycle
  triggers far from where the session's own token display sits — read off the
  `endless: scheduled … ctx=` line against what opencode shows. It is also model-dependent:
  a provider that does not report `cache.read`/`cache.write` yields a smaller sum, and
  endless mode would fire late or never.
- **A session at its context ceiling can still emit ONE correct tool call.** The wind-down turn
  (`WIND_DOWN_PROMPT`, `src/handoff.js:553`) asks for a single `spawn` that carries the
  hand-over and, after it returns, one shaped closing line; the todo file's content never
  has to come out of that session as prose (§2.3). Unmeasured at the ceiling, which is why
  the plugin-composed child prompt and the fallback `startWindDownSubagent` stand in the
  main path rather than as options. Wrong
  when the log shows repeated `spawn refused: wind-down permit` lines followed by the window
  expiring; the wind-down turn is then failing to produce even one call, and the fallback is
  the normal path rather than the exception.
- **The orchestrator eventually goes idle with nothing running.** The restart waits for a
  moment in which none of the primary's subagents runs and the primary is between turns. An
  orchestrator that keeps delegating — or a user who keeps writing to it — defers the restart
  for as long as it does so, and its context grows past `endlessContext` meanwhile. The sidebar
  row reads `[restarting]` with `waiting for subagents (N running)` for that whole span (§3.7).
  Wrong if the log shows `endless: scheduled` for a primary with no `endless: quiesced` line
  following while its context keeps climbing — the restart would then need a bound on the wait
  that stops new work, which this design does not have.
- **The primary-busy mark is cleared by an event.** Every setter of `endlessPrimaryBusy` is
  followed by the primary's `session.idle` or `session.status` `idle`. Wrong if a cycle abandons
  with `no subagent running, but not quiesced after <elapsed>ms` for a primary whose last turn
  ended long before — a busy mark no event cleared.
- **A child waiter with a primary as parent behaves.** `src/childwait.js:20-22` states it is
  supported, and the wind-down spawn is the one production path that does it
  (`src/tools.js:761-772`); every other waiter is a nested spawn's (`src/tools.js:758-759`). Wrong if the settlement never resolves although the child ended, or the
  primary is reaped mid-wait; observable as the cycle's end-the-child last resort firing on a
  run whose child finished normally.
- **No second orchestrator primary shares the endless primary's directory.** The spawn-cap
  exemption is deliberate — quiesce is scoped to one primary — and it establishes that
  another primary's subagents run *during* the rewrite. Where such a subagent reports
  `DONE: T<n>` against the same file, its `removeTask` → `writeAt` (`O_TRUNC` + write, not
  atomic, `src/todofile.js:232-251`) collides with the wind-down child's rewrite and one of
  the two writes is lost. An in-process write lock would not close it: the wind-down child
  writes through opencode's own `write`/`edit` tools, outside `src/todofile.js` entirely. So
  it is named, not closed. Wrong when a V4 failure names lines nobody edited, or when a task
  reappears after a `DONE:` removed it.
- **Widening the parser reclaims the existing entries rather than inventing new ones.** A
  human prose bullet beginning `- T1 through T8 are done` parses as a task under the widened
  read regex, and V4's licensed removal set is computed from that same parse, so such a line
  may be migrated into the machine section. It is bounded — the line moves, it is not
  deleted. Wrong if a cycle's first open-task count after the trigger reports tasks that are
  not tasks: check the `open tasks <before>` figure of the first cycle against the file by
  eye, once.
- **A `planner` given the whole hand-over writes a file a successor can work off.** This is
  the mode's premise and is unmeasured. Wrong when the successor's first spawns restate the
  kickoff rather than the file, and mechanically when the no-progress bound of §3.6.2 fires
  two cycles running.
- **Ten cycles is a ceiling nobody hits by accident.** Unmeasured. Wrong when the ceiling
  toast appears in a session the user considered healthy; the number is a constant and cheap
  to raise.
- **`client.tui.selectSession` or the raw `/tui/select-session` post reaches the running
  TUI.** Read from opencode `1.18.25`; the resolved plugin dependency is `^1.18.23`
  (`package.json:59`), and the typed client is known to lag the server on at least one other
  route (`src/client.js:699-703`). Wrong when a cycle completes, the new session answers, and
  the TUI still displays the archived one — the live check of §7 (g) is exactly this
  observation. It degrades to the behaviour of today's handoff, which is a presentation
  failure, not a data one.
- **Archiving keeps the old sessions readable.** The handoff archives rather than deletes
  (`src/handoff.js:419-428`), so every cycle leaves one archived session behind. Wrong if a
  long endless run makes the session list unusable — at which point the ceiling of §3.6.3 is
  the lever, not a delete.

## 6. Open, and outside this boundary

- Whether an endless cycle should also carry the `PROJECT.md` / `ARCHITECTURE.md` summaries
  the plain handoff obtains. §3.5 drops them to avoid a third long turn on an exhausted
  session; whether the new orchestrator's first act should instead be reading those files is a
  prompt question for `ORCHESTRATION_GUIDE` (`src/prompts.js`), not a structural one.
- The interaction between endless mode and a project that overrides `default_agent`: the
  handoff resolves the new primary's name through `handoffAgentName(client, sessionID,
  directory)` (`src/handoffwiring.js:98`), which takes the agent opencode recorded for the
  old primary's session, falls back to `defaultAgentName(directory)`, and confirms any
  name other than this plugin's own role against the resolved agent list before
  using it. Endless mode inherits that resolution unchanged.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `getSettings()`: no file → `endlessMode: true`, `endlessContext: 250000`; file with
  `"endlessMode": true` → true; `"endlessMode": "true"`, `1`, `null` → true, no throw;
  `endlessContext` non-integer / negative → the default; `endlessWindDownTimeoutMs` non-integer
  / negative → the default; the env vars resolve when the file is silent and lose to the file
  when it is not.
- `primaryContextThreshold()`: endless off → `maxPrimaryContext`; endless on →
  `endlessContext`; endless on with `endlessContext: 0` → arms nothing
  (`shouldTriggerPrimaryHandoff` false).
- The endless latch: set once per crossing, not re-set while set, not set while a cycle is in
  progress, released by every abandon path — mirroring `test/handoff-trigger.test.js`'s
  coverage of `scheduleHandoffIfNeeded`.
- Quiesce: zero entries and zero `pendingSpawns.count` → quiesced; one entry → not; zero
  entries with `pendingSpawns.count === 1` → **not** quiesced; an entry that is `dispatched`
  but still in the registry → not quiesced; an aborted entry → quiesced.
- Quiesce and the primary's turn: a primary holding a cycle is busy from the mark until its
  idle; a `session.status` busy event and a parent notice mark it busy again; the wind-down claim
  is refused while it is busy or while any of its subagents runs, and taken once neither holds.
- After the latch (`test/endless-spawn-after-latch.test.js`): `spawn` and `abort` are accepted
  with the latch set and during the quiesce wait; a subagent spawned after the latch holds the
  wind-down claim until it is done and the wake turn it starts has ended; from the claim on, a
  spawn without the permit is refused and takes no slot, a nested caller gets the actionable
  refusal and `reuse` throws; the release lifts the restriction.
- The restart-pending notice (`test/endless-wiring.test.js`): absent before the latch; present
  on the crossing turn and on every further turn while the latch is pending and while the
  executing cycle has not claimed its wind-down; absent from the claim on, after
  `releaseEndless`, after `cancelPendingEndless` and in solo mode.
- The wind-down permit (`src/registry.js`): `createWindDownToken` is 16 hex characters and
  never repeats; `armEndlessWindDown` builds the record the cycle waits on and refuses to arm
  without a token; `consumeEndlessWindDown` is single-use — the second call is refused, and a
  wrong token, a wrong agent or an absent permit are each refused and none of them consumes;
  `restoreEndlessWindDown` gives the permit back exactly once; `noteEndlessWindDownChild`
  records the child and the settlement the cycle gates on; disarm and `forgetPrimary` each drop
  the permit; the wind-down child is never retained.
- The permitted spawn (`src/tools.js`): a winding-down cycle without a permit refuses every
  spawn; an armed permit refuses a wrong call by naming the one that is
  allowed; the conforming spawn is admitted once and the second one is refused; the plugin
  composes the child's prompt around the hand-over rather than passing `args.prompt`; a create
  failure gives the permit back and invites one repeat; a prompt failure gives the permit back,
  settles the waiter and leaves no child; a nested caller never reaches the permit.
- The widened parse (`src/todofile.js`): `parseTasks` reads the em-dash lines already standing
  in real files; a cross-reference without a gap after the id is not a task; a task owns its
  whole indented block. `splitSections` accepts one begin and one end marker in that order, or
  no section at all.
- The section insert (`src/todofile.js`): `ensureSection` on a file with no markers appends the
  heading and the fence at its end; it anchors below a human open heading without adopting it; a
  level-1 title that matches `open|pending|todo|todos` is skipped for the anchor; with only a
  matching level-1 title the section goes at the end of the file; a marker-less
  `## Intercom tasks` heading is treated as human text; an empty file gets the section and
  nothing else. `addTask` inserts between the markers, never at the end of the file.
- The id watermark (`src/todofile.js`): `usedIdsFrom` counts every bullet line carrying a
  T-token, not only parsed tasks; the `<!-- intercom: next-id -->` watermark keeps an id from
  being handed out again after its task is removed; `nextFreeId` falls back to max+1 over the
  widened scan where no watermark stands, and a hand-written id above the watermark still cannot
  be collided with.
- The `unmigrated` outcome (`src/todofile.js`): `removeTask` answers `unmigrated` — not delete —
  for a legacy line outside the markers, and likewise for an id inside the markers but not in the
  canonical shape; a file with no fence at all has nothing a writer may touch; a canonical
  removal deletes the whole indented block, so a link line never outlives its task. The wake-hook
  leaves a legacy line outside the markers standing and says so.
- The confirmation `verifyWindDown(snapshot, fresh, { splitSections, parseTasks })`: V1–V7 as
  §3.4 states them — V1 one regular file of the snapshot's name, V2 the child settled, V3 the
  content changed or the reply said no-change, V4 the outside-lines algorithm licensing only the
  machine section and migrated task blocks to move, V5 at least one task with unique ids and
  non-empty titles, V6 logs every changed title on an existing id with its old and new text,
  V7 the reply count against the parse; a failure of V1/V3/V4/V5 abandons at `confirm` and —
  except V1, which has no resolved file to restore to — restores the snapshot first; the explicit
  `## WIND-DOWN DONE — nothing open` plus a zero-task parse is the accepted empty case.
- The kickoff: `cutTodoText` returns the file's raw text untouched under the cap and a
  `truncated` marker with a trimmed body past `KICKOFF_TODO_MAX_CHARS`; `endlessKickoffBlock`
  carries the todo file's name and its raw text (and the truncation notice when set); it is sent
  through `promptSession`, so it carries the plugin-generated marker and `lastUserGoal` skips it.
- The bounds: the subagent's explicit `## WIND-DOWN DONE — nothing open` with a zero-task parse
  → no handoff, the primary paused; two consecutive cycles whose open **ids** do not fall (none
  of the previous cycle's ids cleared) → the new primary paused; the cycle counter at
  `endlessMaxCycles` → paused; a failed cycle → the cooldown suppresses the next schedule and
  lifts after it.
- Quiesce bound (`test/endless-cycle.test.js`): with a subagent of the primary running for
  twenty windows the cycle does not abandon and completes once it is gone; a subagent spawned
  during the wait holds the claim until it is gone too, and the wind-down turn runs only after
  the claim; after the last subagent the primary gets `endlessQuiesceTimeoutMs` to go idle; with
  none running and no quiesce, the cycle abandons after that window of virtual time, the latch is
  released, the cooldown is armed and no session was created. A stale `endlessQuiesceExtensionMs`
  key or env var resolves to nothing and raises no error (`test/endless-settings.test.js`).
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

- **(a) the post-latch spawn and the permit.** A spawn after the trigger is admitted and its
  completion notice precedes `endless: quiesced`; the conforming wind-down spawn is admitted
  once, and a second one is refused — read off the `spawned`, the completion and the admit lines
  in the log.
- **(b) the quiesce.** The wind-down spawn happens only after the in-flight subagent's
  completion notice was delivered — read off the ordering of `endless: quiesced` against the
  wake line.
- **(c) the rewrite.** The todo file on disk carries the updated list, the lines outside the
  machine section are unchanged except for migrated task blocks, and no id was reused — ids
  matching the `endless: wind-down confirmed …` line, and no second todo file in the directory.
- **(d) the replacement.** A new orchestrator session exists, the old one is archived and not
  deleted, and the new session's first message is the endless kickoff carrying the todo file's
  text with exactly the open ids from (c).
- **(e) the work-off.** The new orchestrator spawns a subagent for the first task and the
  `DONE: T<n>` path removes it from the file — i.e. the cycle's output is consumable by the
  machinery that already exists.
- **(f) the view switch.** After the kickoff, the TUI is displaying the new session without
  anyone clicking — a screenshot of the rendered session view whose header names the new
  session, taken after (d).
- **(g) the sidebar.** A screenshot of the rendered sidebar showing the `endless` row on, the
  threshold row, and the toggle taking effect in the file.
