# Concept: a repaired prompt file clears its finding in the same session

Scope: the server half of `opencode-agent-intercom` (`src/`, `test/`,
`README.md`). No service boundary is touched — everything here runs inside the
one opencode plugin process, in the modules that already own the scan
(`src/promptsfile.js`), the finding register (`src/overrides.js`) and the two
hooks that deliver it (`src/hooks.js`).

Evidence base: this plugin's `src/` and `test/` as they stand, and the installed
opencode 1.18.25 source at `/tmp/opencode-source` (`git log -1` →
`cb7d8b2 release: v1.18.25`).

---

## 1. What is on disk today

### 1.1 The scan runs once per directory per process

`src/hooks.js:312`, inside `transformSystem`, is the only caller:

    if (primaryScope) scanPromptFiles(primaryScope)

`scanPromptFiles` gates itself on a claim it does not own,
`src/promptsfile.js:181-182`:

    export function scanPromptFiles(directory) {
      if (!claimPromptFileScan(directory)) return

The claim is a process-wide `Set` in the register, `src/overrides.js:340-341`
and `src/overrides.js:355-359`:

    // Directories whose prompt files have already been scanned in this process.
    const scannedDirectories = new Set()

    export function claimPromptFileScan(directory) {
      if (!nonEmptyString(directory) || scannedDirectories.has(directory)) return false
      scannedDirectories.add(directory)
      return true
    }

Its own comment names both the reason and the price, `src/overrides.js:346-354`:

    // The scan is eager and once — nine stats at the first primary transform of a
    // directory — for two reasons. Per-request probing would put fs work on the hot
    // path of every LLM call, and the finding set has to be COMPLETE before the
    // first block is rendered: the block lives in the stable system-prompt element
    // and its text must not move between the turns of a session.
    //
    // The cost of "once" is that a file the user repairs mid-session keeps its
    // finding until the next process — which is the same trade the stable element
    // demands.

The loop itself, `src/promptsfile.js:183-200`, reads each of the nine roles
through the mtime-cached loader, splits header from body, classifies, and writes
a finding:

      if (recordPromptFileOverride({ agent, missing, detail, file: filePath, directory })) {
        log("override: stale prompt file", { agent, missing, file: filePath, directory })
      }

### 1.2 The register only ever grows

`record` in `src/overrides.js:89-107` writes under
`` `${kind}\0${directory}\0${agent}` `` and returns whether the register
**changed**:

      const before = findings.get(key)
      if (before && sameFinding(before, finding)) return false
      findings.set(key, finding)
      return true

`sameFinding` (`src/overrides.js:109-118`) compares `file`, `detail`, `fields`
and `missing` element by element. There is **no removal path**: nothing in
`src/overrides.js` deletes a key except the test seam `resetOverrides`
(`src/overrides.js:364-368`), which clears the whole register. So even if a
second scan ran, a finding for a file that has since been repaired would survive
it.

### 1.3 The finding block is built fresh per call, from that register

`overrideBlock` (`src/overrides.js:189-203`) is a pure function of the selected
finding set — it is not memoised anywhere:

    export function overrideBlock(directory) {
      const selected = arguments.length ? overrideFindings(directory) : overrideFindings()
      if (selected.length === 0) return ""

`overrideFindings` sorts by kind then agent then directory
(`src/overrides.js:157-162`), deliberately not by insertion order
(`src/overrides.js:47-51`). The transform calls it on every LLM call,
`src/hooks.js:337-346`:

    let overrideNotice = ""
    if (primaryScope) {
      overrideNotice = overrideBlock(primaryScope)

and lands it in the system prompt on both paths — appended after the user's
template on the custom path, `src/hooks.js:380`:

    output.system.push(result + overrideNotice)

and inside the assembled stable element on the auto path, `src/hooks.js:398-404`:

      guideParts.push(overrideNotice)
      ...
      const stable =
        slices.role +
        (keepAgentsMd ? slices.agentsMd : "") +
        guideParts.join("")

So the block's bytes are stable today only because the register is frozen after
the first primary transform, not because anything caches the text.

### 1.4 The scan is stale, but the prompt itself is not

`loadCustomPrompt` (`src/promptsfile.js:109-135`) stats on every call and
re-reads when the mtime moved:

      const entry = cache.get(filePath)
      if (entry && entry.mtimeMs === stat.mtimeMs) return entry.content

That is the asymmetry at the heart of the defect. A user who repairs
`.opencode/agent-intercom/coder.md` mid-session has the repaired text in force
on the next LLM call that uses it — while the plugin keeps telling the
orchestrator, in the orchestrator's own system prompt, that the file "predates
the current prompt contract" until the next opencode process. The plugin's
report contradicts the plugin's own behaviour.

The companion TUI makes this reachable by a button: `tui/src/tui.tsx:588` calls
`utimesSync(p, now, now)` over the nine files and toasts
`prompts cache busted (…) — next LLM call reloads` (`tui/src/tui.tsx:601`). The
loader honours that touch; the finding does not.

### 1.5 Detector A is a different case and needs no cure

The agent-entry detector writes at `src/agents.js:483`, from the `config` hook.
opencode folds `.opencode/agent/<name>.md` into `config.agent` while resolving
the config and calls the plugin `config` hook once, at instance bootstrap
(`/tmp/opencode-source/packages/opencode/src/plugin/index.ts:152` and `:247`;
the same bootstrap-only property is recorded for the model pin in
`learnings.md`, "That hook runs once at instance bootstrap"). A mid-session edit
to a project agent file therefore does not take effect in the running instance
either — detector A's finding stays true for the life of the process **by
construction**. Only detector B can be wrong about the present, so only
detector B is in scope here.

---

## 2. What byte-stability actually protects

### 2.1 The mechanism

opencode joins everything it assembled into `system[0]` before the hook fires
and maps each surviving array element to its own system message
(`/tmp/opencode-source/packages/opencode/src/session/llm/request.ts:100-112`).
The cache markers are then set in `applyCaching`,
`/tmp/opencode-source/packages/opencode/src/provider/transform.ts:358-360`:

    function applyCaching(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
      const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
      const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

with per-provider option shapes for anthropic, openrouter, bedrock,
openaiCompatible, copilot and alibaba
(`/tmp/opencode-source/packages/opencode/src/provider/transform.ts:361-380`).
The plugin's two-element split therefore puts a breakpoint on the stable mass
`[0]` and one on the `<env>` block `[1]`, and the per-turn blocks ride a
synthetic text part on the last user message instead
(`src/hooks.js:470-503`), which lands past the last breakpoint.

### 2.2 What breaks without it

A change to element `[0]` is a prefix change. Everything behind it — element
`[1]`, the tool definitions and the entire message history — misses with it on
that call. Two costs, one per deployment kind:

- **Hosted provider with prompt caching.** One call is billed at full input
  price instead of the cached rate, and the new prefix is written to the cache.
  Bounded to that call.
- **Local llama.cpp, which is what this project is built for** (README: "Built
  for local LLMs in the 3–40 B range"). The server's KV prefix reuse is
  positional: a changed prefix forces a full prompt-processing pass over the
  whole context. At the default primary ceiling
  (`OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT`, 80 000 tokens) that is a
  visible pause on a 9 B model before the first token of the answer.

Both are **per event, not per turn**: the next call re-establishes the prefix.
The thing byte-stability buys is therefore not "never move element `[0]`" but
"never move it for a reason the user did not cause".

### 2.3 Element `[0]` already moves on a user edit today

This is the decisive precedent, and it is written in the source. `limits` sits
inside the same stable element and is rebuilt per turn from the live settings
file, `src/hooks.js:202-206`:

    // Build the runtime parts once — both the auto-assembled path and the
    // custom-template path need them. Only blocks that hold their text
    // across the turns of a session belong here; `limits` qualifies because
    // it re-reads the settings file, whose content moves on a user edit and
    // not otherwise.

and `formatLimitsNotice` (`src/hooks.js:731-733`) reads `getSettings()`, whose
cache has a 2 s TTL (`src/settings.js:169` `const TTL_MS = 2000`) and whose file
the TUI writes live. Stepping `max subagents` in the sidebar moves element `[0]`
on the next turn, and that is accepted design, stated at `src/hooks.js:711-712`:
"The user can change them at runtime via the settings file, so they are injected
fresh per turn."

A repaired prompt file is the same class of event: a deliberate user edit, at
human frequency, that changes what is true. The rule element `[0]` actually
obeys is *idempotent per turn and only moved by a user action* — not *frozen for
the process*.

One further point on the custom path: when the file repaired is the primary's
own `orchestrator.md`, the template **is** element `[0]`
(`src/hooks.js:363-381`), so the edit already invalidates the prefix on the next
call. Dropping the finding line in the same call costs nothing at all for that
one of the nine files.

---

## 3. What a cure has to satisfy

1. A repaired file's finding is gone from the block within the session, without
   a restart.
2. The block's text never moves **inside** a turn — a multi-step tool loop must
   not re-read its own prefix per step. This is the same rule
   `snapshotForTurn` obeys for the per-turn part (`src/hooks.js:431-442`).
3. No fs work is added to the per-LLM-call path.
4. The prompt never carries two contradictory statements about one file.
5. Findings stay scoped per project directory (`src/overrides.js:18-21`), and
   detector A is untouched.

---

## 4. The candidate cures

### Option 0 — leave it, keep documenting it

The status quo. README already carries it twice, as a limitation
(`README.md:650-654`) and in the silencing instructions (`README.md:388-390`).

- **Costs**: the user is told, in the orchestrator's own system prompt, something
  false about a file they just fixed, until they restart. Under `hideChatter`
  the orchestrator is the only channel to the user, so the false line is the
  whole report.
- **Forecloses**: nothing.
- **Demands**: nothing.

### Option 1 — rescan on the transform (the "rescan trigger on edit" as named)

Drop the claim; run the nine-file classification inside `transformSystem` on
every primary call, or on a `file.edited` event.

- **Mechanism, transform variant**: `src/hooks.js:312` calls an unclaimed
  `scanPromptFiles`; the register updates; `overrideBlock` at
  `src/hooks.js:339` renders the new set.
- **Mechanism, event variant**: `createEventHandler` (`src/hooks.js:882-936`)
  adds a `file.edited` case. This one does not work, and the source says why.
  `file.edited` is published only by opencode's own tools —
  `/tmp/opencode-source/packages/opencode/src/tool/edit.ts:115` and `:159`,
  `tool/write.ts:68`, `tool/apply_patch.ts:256`. A user saving the file in their
  editor publishes nothing: `file.watcher.updated`
  (`/tmp/opencode-source/packages/schema/src/filesystem-watcher.ts:6-12`) has no
  publisher anywhere in `packages/opencode/src` in 1.18.25 — only consumers in
  `packages/app`. And the repair path this plugin itself prescribes is an
  editor or `npx opencode-agent-intercom-init-prompts`, never an opencode edit
  tool: the orchestrator is tool-gated to `spawn`/`abort`/`list`, and the block
  tells it "nothing here is yours to change: do not edit or delete these files,
  and do not spawn a subagent to do it" (`src/overrides.js:199-201`). The event
  variant would cover approximately none of the real repairs.
- **Costs**: nine `statSync` calls on the hot path of every LLM call, including
  every step of a tool loop — requirement 3 broken; and the block can change
  **between two steps of one turn**, moving the prefix of the loop's own
  history — requirement 2 broken.
- **Forecloses**: nothing structurally, but it puts fs work where the module
  comment at `src/overrides.js:346-348` says it must not go.
- **Demands of the builder**: a removal path in the register (§1.2), plus a
  per-turn or TTL gate to buy requirement 2 back — at which point this is
  Option 3 with a worse trigger.

### Option 2 — seal the block, re-issue changes on the per-turn message part

Render the block once per project scope, cache the text, and never move it
again; deliver every later change (a finding cleared, a new finding) as a line
on the synthetic text part `transformMessages` already appends to the last user
message (`src/hooks.js:483-502`).

- **Mechanism**: a `sealedBlock` map keyed by directory in `overrides.js`;
  `overrideBlock` returns the sealed text; a new `overrideDelta(directory)`
  feeds `transformMessages`, which already re-renders per turn behind the last
  breakpoint and so costs nothing in cache terms.
- **Costs**: requirement 4 is broken by construction. For the rest of the
  session the system prompt says "coder: the prompt file predates the current
  prompt contract" while the turn part says it does not. This project's target
  is a 3–40 B local model; handing it two contradictory statements about one
  file and expecting it to prefer the later one is the failure mode the whole
  README is written against. It also needs acknowledgement bookkeeping the
  register does not have today (who has been told what, once).
- **Forecloses**: the block as a single source of truth. Any future finding kind
  inherits the split.
- **Demands of the builder**: a fourth outlet, a seal keyed correctly across
  handoffs (a fresh orchestrator session in the same directory must not inherit
  a seal whose text no longer matches the register), and delta rendering that
  stays readable when three files clear at once.

### Option 3 — idle-gated re-scan with a replacing register write (recommended)

Move the re-scan off the LLM path entirely, onto the primary's `session.idle`
event, and give the register a write that **replaces** one directory's
prompt-file finding set with a fresh classification.

- **Mechanism**: `createEventHandler`'s existing `session.idle` case
  (`src/hooks.js:906`) gains one call. Idle means the turn has ended, so the
  register can only change **between** turns; the transform keeps doing exactly
  what it does today — read the register and render. The first eager scan at
  `src/hooks.js:312` stays as it is, so the finding set is still complete before
  the first block is rendered.
- **Costs**: nine `statSync` calls per primary idle, off the LLM path; content
  is re-read only for files whose mtime moved, because the scan goes through the
  same mtime-cached loader (`src/promptsfile.js:180`, "costs one stat per role
  on a directory whose files are already loaded"). Element `[0]` moves on the
  first turn after a repair — once per repair event, never otherwise, because
  `record`/`sameFinding` (`src/overrides.js:104`) already suppress an unchanged
  finding and `overrideBlock` is a pure function of the set.
- **Forecloses**: nothing. The claim mechanism stays for the eager first scan;
  the register gains one operation it lacks and detector A does not use.
- **Demands of the builder**: the removal path in the register, and the
  discipline that the idle handler must never throw into the event stream
  (already the house rule — `createEventHandler` wraps everything in
  `try/catch`, `src/hooks.js:932-934`).

### The comparison that decides it

| | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| clears within the session | no | yes | yes | yes |
| fs work per LLM call | none | 9 stats | none | none |
| block can move mid-turn | no | yes | no | no |
| prompt can contradict itself | yes (against the file) | no | yes (against itself) | no |
| new outlets | 0 | 0 | 1 | 0 |
| element `[0]` moves | never | per edit, possibly mid-turn | never | once per repair event, at a turn boundary |

---

## 5. Recommendation

**Option 3.** It is the only candidate that satisfies all five requirements, and
it wins on the argument the trade-off was originally stated in: byte-stability
was never a promise that element `[0]` is frozen for the process — `limits` in
the same element is rebuilt per turn from a file the user edits at runtime
(`src/hooks.js:202-206`, `src/hooks.js:711-712`). What the element must not do
is move for a reason the user did not cause, or move inside a turn. An
idle-gated re-scan moves it exactly once per repair, at a turn boundary, for an
edit the user made deliberately — the same contract the settings file already
has. Option 1 buys the same clearance by breaking the two properties that
matter; Option 2 keeps the bytes at the price of lying to a small model in its
own system prompt.

---

## 6. Target state

### 6.1 `src/overrides.js` — the register gains a replacing write

    // Replaces this project's prompt-file findings with `next`, the result of one
    // full re-classification of that directory. Findings of other kinds and other
    // directories are untouched. Returns true when the set changed — a finding
    // appeared, changed, or was dropped because its file is now clean.
    export function replacePromptFileFindings(directory, next)

`next` is an array of the same shape `recordPromptFileOverride` takes
(`{ agent, missing, detail, file }`; `directory` comes from the argument).
Implementation: compute the key set of `next`; delete every existing
`KIND_PROMPT_FILE` key for this directory that is not in it; `record` each
entry of `next`; return `deletedAny || anyRecordReturnedTrue`.

`recordPromptFileOverride` stays as it is — the eager first scan keeps using it,
and the two writes are then honestly different operations: "I found this" and
"this is now the whole truth about this directory".

`resetOverrides` needs no change; it already clears the map.

### 6.2 `src/promptsfile.js` — one classifier, two entry points

Split the body of today's `scanPromptFiles` into a private
`classifyDirectory(directory)` that returns the finding list and logs nothing,
and two exported entry points over it:

- `scanPromptFiles(directory)` — unchanged behaviour and unchanged signature:
  claim-gated, records each finding, logs `override: stale prompt file` per new
  finding. Still called from `src/hooks.js:312`.
- `rescanPromptFiles(directory)` — no claim; calls `classifyDirectory` and hands
  the result to `replacePromptFileFindings`; logs once, and only when the set
  changed, e.g. `log("override: prompt files rescanned", { directory, stale: n })`.
  Returns the boolean so the caller can log or stay silent.

The per-file `try/catch` that protects the other eight roles from one unreadable
file (`src/promptsfile.js:196-199`) belongs to `classifyDirectory`, so both
entry points inherit it. One caveat this forces into the open: a file that
becomes unreadable mid-session yields no finding for that role, so a rescan
would silently drop a finding that was real. `classifyDirectory` therefore
reports per role one of three outcomes — clean, stale-with-detail, or unreadable
— and `rescanPromptFiles` **keeps** the existing finding for an unreadable role
rather than dropping it.

### 6.3 `src/hooks.js` — one call in the idle branch

Inside the existing `case "session.idle":` (`src/hooks.js:906`), before or after
the handoff latches (order is irrelevant — the calls do not interact), and gated
on the session being a primary with a known project scope:

    // Detector B stays true within the session: the prompt files are re-judged
    // between turns, never during one, so the finding block moves its bytes only
    // where the user actually changed a file.
    rescanPromptFilesForPrimary(props?.sessionID)

with the gate reading the scope the transform already holds for that primary —
`isPrimary(sessionID)` (`src/registry.js:85-87`) and the directory recorded by
`rememberPrimaryDirectory` (`src/registry.js:773-779`, backed by
`primaryDirectory` in `src/state.js:122`). A subagent idle, or a primary whose
first transform has not resolved a directory yet, does nothing.

`registry.js` needs a read-only accessor for the held directory
(`primaryDirectoryOf(sessionID)`) — `rememberPrimaryDirectory` must not be
called from the event path, because it would write a scope from the wrong side.

### 6.4 What deliberately does not change

- **The eager first scan.** It still runs at the first primary transform, so the
  finding set is complete before the first block is rendered.
- **The transform.** It keeps reading the register and rendering; no fs, no new
  branch.
- **The toast.** `overrideToastText` stays one-shot per scope
  (`src/overrides.js:209-220`). A finding that appears mid-session reaches the
  user through the block; spending a second toast on it is a product decision,
  not this one (see §9).
- **Detector A.** Untouched, for the reason in §1.5.
- **The block's wording.** A cleared finding removes its line; when the last one
  goes, `overrideBlock` returns `""` and both delivery paths already append the
  empty string harmlessly (`src/hooks.js:380`, `src/hooks.js:398`).

### 6.5 Behaviour when several files are repaired in one session

The re-scan is a whole-directory replace, so the unit of change is the turn
boundary, not the file:

- Three files repaired in one editor save burst, before the next idle → one
  re-scan, three lines dropped, **one** move of element `[0]`.
- Three files repaired one per turn → three moves, each on the turn after its
  repair. That is the honest floor: three user actions, three changes of what is
  true.
- A repair plus a fresh breakage in the same window → one move, the block
  showing the new set. `record` returns true for a changed `missing` list, so a
  file that traded one stale element for another is reported as changed and not
  as unchanged.
- No repair at all → nine stats per idle, `replacePromptFileFindings` returns
  false, the block renders byte-identically, and nothing anywhere moves.

---

## 7. Steps, in order

Each step leaves the tree building and `npm run check` / `npm test` green, so
they can be handed out one at a time.

**Step 1 — the register operation.** Add `replacePromptFileFindings` to
`src/overrides.js` and extend `test/override-register.test.js`: a replace that
drops a finding, a replace that keeps another kind and another directory
untouched, a replace with an identical set returning `false`, and a replace with
an empty array clearing the directory. No caller yet.
*Depends on: nothing.*

**Step 2 — the classifier split.** Refactor `src/promptsfile.js` into
`classifyDirectory` + `scanPromptFiles` + `rescanPromptFiles`, with the
three-outcome per-role result of §6.2. `scanPromptFiles` keeps its signature and
its behaviour, so `test/prompt-file-staleness.test.js` must pass unchanged —
that is the regression gate for this step. Add tests for `rescanPromptFiles`
against a directory whose file was repaired, whose file was newly broken, and
whose file became unreadable.
*Depends on: step 1 (`rescanPromptFiles` writes through it).*

**Step 3 — the accessor.** Add `primaryDirectoryOf(sessionID)` to
`src/registry.js` as a pure read of `primaryDirectory`, with the comment saying
why the event path must not use `rememberPrimaryDirectory`.
*Depends on: nothing; can run in parallel with steps 1–2.*

**Step 4 — the wiring.** Call the re-scan from the `session.idle` case in
`createEventHandler`, gated on `isPrimary` + `primaryDirectoryOf`. Test through
the plugin surface, the way `test/prompt-file-staleness.test.js` already drives
it: primary transform → block carries the finding → repair the file on disk →
fire `session.idle` for that primary → next transform → block no longer carries
it, and the rest of element `[0]` is byte-identical to before apart from that
line.
*Depends on: steps 2 and 3.*

**Step 5 — the stability pins.** Two tests that state the guarantee in the
negative, because they are what stops a later change from quietly taking it
away: (a) two turns with no idle in between render `system[0]` byte-identically
even with a stale file present — the existing test at
`test/prompt-file-staleness.test.js` ("the block holds its bytes across the
turns of a session") already covers this and must keep passing unchanged; (b) an
idle with **no** file change renders `system[0]` byte-identically on the next
turn.
*Depends on: step 4.*

**Step 6 — the documentation.** Remove the limitation from `README.md:650-654`,
rewrite the last sentence of the silencing instructions at `README.md:388-390`
("Either way the finding clears on the next opencode process — the scan is once
per directory per process …"), rewrite the same claim at `README.md:367-369`
("The block lives in the cached stable element and its text does not move
between turns of a session, so a finding clears only on a restart …") to say
what now holds: the block moves only between turns, and only where a file
changed. Correct the now-false paragraph at `src/overrides.js:352-354` and the
scan comment at `src/promptsfile.js:174-180`.
*Depends on: step 4. `learnings.md` is not touched — it records findings about
running under opencode, not this design.*

---

## 8. Assumptions

**A1 — `session.idle` fires for a primary at the end of every turn.**
*Would have to hold*: the event reaches the plugin's `event` hook for the
primary's session id. *Grounds*: `src/hooks.js:906-920` already gates the whole
orchestrator handoff on it, and the comment at `src/hooks.js:230-246` records
that the idle-gating was live-verified. *Falsifier*: a repaired file whose
finding does not clear although the session went idle — visible as a missing
`override: prompt files rescanned` line in
`~/.cache/opencode-agent-intercom/debug.log`.

**A2 — an element `[0]` change costs one call, not a persistent loss.**
*Would have to hold*: the provider re-establishes the prefix on the following
call. *Grounds*: `applyCaching` runs per request and re-marks the first two
system messages
(`/tmp/opencode-source/packages/opencode/src/provider/transform.ts:358-360`).
*Falsifier*: `OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1` showing cached-token
counts staying at zero for more than the single call after the block changed.

**A3 — the cost figures in §2.2 are estimates, not measurements.** No
measurement was run for this design. *Would have to hold*: a full
prompt-processing pass at the primary's context size is a visible but bounded
pause on the local target hardware. *Falsifier*: a measured re-processing time
that makes a once-per-repair pause unacceptable — in which case the answer is
not Option 2 but narrowing the re-scan to the files that currently carry a
finding, which costs at most one stat in the common case.

**A4 — no opencode event announces a user's editor save.** *Grounds*:
`file.edited` is published only from `tool/edit.ts:115`, `tool/edit.ts:159`,
`tool/write.ts:68` and `tool/apply_patch.ts:256`; `file.watcher.updated` is
defined in `packages/schema/src/filesystem-watcher.ts` and has no publisher in
`packages/opencode/src` in 1.18.25. *Falsifier*: a
`unknown event type (logging once per process)` line naming
`file.watcher.updated` in the debug log (`src/hooks.js:929`) — that would make a
cheaper, edit-precise trigger available and would turn the nine stats per idle
into zero.

**A5 — the plugin instance's event stream is scoped to its own directory.**
*Grounds*:
`/tmp/opencode-source/packages/opencode/src/plugin/index.ts:256`
(`if (event.location?.directory !== ctx.directory) return Effect.void`).
*Consequence*: the idle gate never has to defend against another project's
events; the per-directory scope of the re-scan comes from the primary's held
directory in any case. *Falsifier*: a re-scan logged for a directory the
instance was not loaded with.

---

## 9. Open questions, designed around

**Q1 — should a cleared finding be announced?** Today the block simply loses its
line and the orchestrator, which was told to report the finding "once", is never
told it is resolved. Announcing it (a line on the per-turn part, or an info
toast) is a product decision about what the user should hear, not an
architectural one. The design is silent-clear, and the place an announcement
would attach is named: the boolean `rescanPromptFiles` already returns is the
trigger, and `transformMessages` (`src/hooks.js:470-503`) is the outlet that
costs no cache. Nothing in §6 has to change to add it later.

**Q2 — should the one-shot toast latch reset when the finding set changes?**
`toastedScopes` (`src/overrides.js:42`) spends one toast per project per
process. With a live re-scan a finding can now appear after that toast was
spent, and the user would learn of it only through the orchestrator's answer.
Left as it stands, because the toast is a pointer to the block and the block is
the substance; the alternative — re-toast on every set change — trades a
guaranteed-quiet outlet for one that can repeat. Reversible in one line if the
answer turns out to be the other way.

**Q3 — which side owns "the file was repaired" as a concept?** Nothing in the
plugin distinguishes a repair from any other edit; the register only knows
finding sets. If a future feature needs the distinction (a repair count, a
changelog of contract migrations), it belongs in the register beside
`replacePromptFileFindings`, which is the only place that sees both the old and
the new set. Noted so it is not re-derived later.
