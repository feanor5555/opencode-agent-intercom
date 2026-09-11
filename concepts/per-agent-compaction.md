# Concept: compaction switchable per agent, off by default

Scope: the one opencode plugin process — its server half (`src/`, `test/`) and
its TUI half (`tui/src/`). No boundary moves; every part named here already
exists in this repository. The one thing outside the boundary is opencode
itself, whose compaction surface is fixed and is treated as given.

Evidence base: `src/`, `tui/src/` and `test/` as they stand at HEAD; the
installed `@opencode-ai/sdk` / `@opencode-ai/plugin` 1.18.23 declarations under
`node_modules/`; the opencode 1.18.30 binary findings in
`work/code-explorer-opencode-binary-compaction.md`,
`work/code-explorer-compaction-api.md` and `work/researcher-opencode-compaction.md`;
the sidebar-row account in `work/code-explorer-tui-rows.md`.

Fixed by the user, not derived here: compaction must be **off in general** —
it happens today in orchestrator mode and should not — and **on/off must be
settable per agent from the TUI sidebar**.

---

## 1. What the code says today

**The plugin switches compaction off only in solo mode.** `src/agents.js:844`
is the gate and `:857` the write:

```js
  if (!soloModeActive()) return
  …
  config.compaction = { ...compaction, auto: false }
```

Called from the `config` hook at `src/index.js:177-181`, alongside
`installAgents` and `applyModelChoices`. In orchestrator mode nothing is
written, so opencode's own `compaction.auto` default (`true`) governs every
session of the process — the primary and every subagent session the plugin
creates.

**opencode's switch is global and has no per-agent form.** The agent entry
schema carries no compaction key at all (`work/code-explorer-opencode-binary-compaction.md`
§2, binary line 305337), the decision predicate reads the one global key
(`if(e.cfg.compaction?.auto===!1)return!1`, binary line 302388), and the
compaction path is session-scoped with no parent/child guard. Upstream issue
#16375 is the open request for per-agent control. `agent.compaction.disable`
is not a substitute: the compaction runner dereferences the fetched agent
without a guard, so disabling that hidden agent turns a compaction into a
throw (`src/agents.js:829-836` records this, and the researcher note confirms
it against v1.18.30 source).

**No hook can veto a compaction.** `experimental.session.compacting` receives
`{ sessionID }` only and can shape the prompt, not stop the run;
`experimental.compaction.autocontinue` carries the agent name but only skips
the synthetic continue turn (`work/code-explorer-compaction-api.md` §3).

**The config snapshot is latched at instance bootstrap.** `Config.get()` is
re-read per step but from a state built once at bootstrap; an external edit of
`opencode.json` is not picked up (`work/code-explorer-compaction-api.md` §1).
So anything the plugin wants to express through `config.compaction` must be
written in the `config` hook and cannot change while the instance runs.

**One session can be compacted on demand.** `POST /session/{id}/summarize`,
SDK `client.session.summarize`, body `{ providerID, modelID }`, path `{ id }`
(`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2175-2190`; the
installed 1.18.23 types give the 200 response as `boolean`, not `Session`).

**The session record carries no agent name** (`types.gen.d.ts:468-491`), but
the plugin does not need it to: `recordSessionAgent` / `sessionAgentName`
(`src/registry.js:1246-1257`) hold the mapping already, every subagent entry
carries `entry.agent`, and `UserMessage.agent` is on the message record
(`types.gen.d.ts:53`).

**A compaction turn is indistinguishable from a subagent's result today.**
`finalResult` (`src/client.js:674-686`) walks back to the newest assistant
message with usable text; `usableText` (`:655-662`) filters only synthetic
parts and tool scaffolding. `AssistantMessage.summary?: boolean`
(`types.gen.d.ts:115`) — the flag opencode's own step-finish check reads
(`!a.assistantMessage.summary`, binary line 302388) — is read nowhere in
`src/`. A subagent session that compacts mid-run can therefore hand its
compaction summary to the orchestrator as its one-shot result. That is a
latent defect of the state today, not of anything proposed here.

**The two context reliefs the plugin owns.** For the primary, one resolution
point decides the armed threshold — `primaryContextThreshold`
(`src/settings.js:806-809`), with `endlessContext` displacing
`maxPrimaryContext` while endless mode is in effect — and the crossing
schedules an idle-gated handoff or an endless cycle (`src/hooks.js:426-470`).
For a subagent, `contextBudgetFor(entry.agent)` bounds the run: measured in
`contextLimitNotice` (`src/hooks.js:864-866`), enforced as a hard tool-call
lockdown at `src/hooks.js:2317`.

**Two mechanisms would mistake a compaction for something else.** The idle
handler treats a quiet subagent session as finished and delivers its result
(`src/hooks.js:1540-1600`, with the one existing exception at `:1578` —
`hasLiveChildren`). The watchdog puts an entry with no tool call in flight on
the 90 s silence window (`src/watchdog.js:320-335`), and deliberately refuses
to read `entry.status === "busy"` as work.

---

## 2. What "compaction per agent" can honestly mean

opencode compacts per **session** on one **global** switch. Three states can
be described, and only two of them are reachable through that switch alone:

| wanted | reachable through `compaction.auto` alone |
| --- | --- |
| all agents off | yes — write `auto:false` |
| all agents on | yes — write nothing |
| mixed | **no** — either the off-agents still compact, or the on-agents never do |

There is no veto hook and no per-agent key, so a mixed state is only honest if
the plugin takes the on-side over itself: global `auto:false`, and the plugin
compacts the sessions of an "on" agent with `client.session.summarize`. The
question the concept has to settle is therefore whether plugin-driven
compaction is worth its cost, or whether the row should only ever be able to
switch compaction off.

---

## 3. The three ways to build it

### Option A — flat switch only, no per-agent row

Write `compaction.auto:false` unconditionally; one sidebar row, on/off, for the
whole process.

- Costs: smallest change in the repository — one moved write, one boolean, one
  row.
- Forecloses: the user's second requirement. A user who wants the primary
  compacted and the subagents not has no way to say so.
- Demands of the builder: nothing beyond the existing boolean-row pattern
  (`show agentcom`, `tui/src/tui.tsx:2380-2388`).

### Option B — per-agent map, global derived, no driver

Keep the per-agent map, but derive the one global write from it: `auto:false`
unless every listed role is on. Mixed states resolve to `auto:false`.

- Costs: small — settings, the derived write, the row.
- Forecloses: a true mixed state. An agent switched **on** while any other is
  off is not compacted, so the row says something that is not in effect. It
  would have to render that ("not in effect — another agent is off"), and the
  row would need a restart note, because the derived write only reaches
  opencode at bootstrap (§1).
- Demands: honest rendering of an inert value, and a user who understands that
  the per-agent row is really an all-or-nothing switch with extra steps.

### Option C — global off unconditionally, the plugin drives the "on" side (recommended)

`compaction.auto:false` is written in every mode, always. An agent whose row is
**on** is compacted by the plugin itself, through `client.session.summarize`,
at the context threshold that agent already has.

- Costs: the largest of the three — a driver module, a latch on subagent
  entries, a third watchdog case, a guard in `finalResult`. Estimated at ~250
  lines of `src/` plus tests, in the patterns the repository already uses
  (`hasLiveChildren` for the idle gate, the `tool-call` case for the watchdog
  window, `scheduleHandoffIfNeeded` / `maybeRunPendingHandoff` for the
  idle-gated execution).
- Forecloses: nothing. opencode's native behaviour stays available in
  substance — a `summarize` call runs opencode's own compaction agent, only
  triggered by the plugin and at the plugin's threshold instead of at
  `contextLimit - reserved`.
- Demands: that the builder keeps the compaction in-flight state visible to the
  idle handler and the watchdog. Both are single, well-marked places.

**Recommendation: Option C.** It wins on three grounds:

1. It is the only one in which the per-agent row means the same thing for
   every agent and is never inert.
2. The global write becomes **unconditional and constant**, which removes the
   bootstrap-latch problem entirely: nothing the row writes has to reach
   opencode's config, so the row is live and needs no restart note — unlike
   `mode` (`tui/src/tui.tsx:2127-2134`). Option B cannot have this.
3. The one piece of work it forces — teaching the result path to skip a
   summary message — is a fix the code needs anyway (§1, last evidence point).

---

## 4. Settings shape

`~/.config/opencode/agent-intercom.json`, following the
`maxResultTokens` / `resultTokens` discipline (`src/settings.js:410-411`,
`:484-500`, `:667-669`):

```json
{ "compaction": false,
  "agentCompaction": { "orchestrator": true, "coder": false } }
```

- **`compaction`** — flat boolean, what every agent without an entry of its
  own inherits. Read like the other two booleans: a real boolean or nothing
  (`typeof raw?.endlessMode === "boolean"`, `src/settings.js:521`).
- **`agentCompaction`** — per-type map, read with the discipline of
  `agentContext` / `reuseContext` / `resultTokens`: a plain object only; a key
  survives only as `name !== "" && typeof value === "boolean"`; one bad entry
  costs that entry and not the map; nothing is materialised.
- **Env**: `OPENCODE_AGENT_INTERCOM_COMPACTION`, read by the existing `envBool`
  (`src/settings.js:307-313`), `"1"`/`"0"`, anything else falls through.
- **Default**: `export const DEFAULT_COMPACTION = false` — exported for the
  parity `test/settings-defaults-parity.test.js` enforces against the TUI's own
  copy.
- **Resolver**: `compactionEnabledFor(agent)` — two levels, like
  `resultCeilingFor`: the type's own `agentCompaction` entry, else the flat
  value (file > env > `DEFAULT_COMPACTION`). No source flag: there is no
  built-in per-type table and no legacy key, so there is nothing to
  disambiguate.
- **Not latched.** Unlike `agentMode` (`src/settings.js:740`) this key governs
  no tool surface and no prompt, so it is read live on every crossing, through
  the normal 2 s cache plus the agentcom watch's invalidation.

The name `compaction` is the plugin's own key in the plugin's own file; it is
not opencode's `compaction` object and never written into one.

---

## 5. Where the global write belongs

New module **`src/compaction.js`**, exporting `applyCompactionPolicy(config)`:

- Writes `config.compaction = { ...existing, auto: false }`, preserving every
  neighbouring key (`preserve_recent_tokens`, `reserved`, `prune`,
  `tail_turns`), exactly as `src/agents.js:853-857` does today.
- Runs in **both** agent modes, unconditionally. It does not read
  `agentCompaction`: the on-side is the plugin's own driver, so the global
  value never depends on any per-agent value, which is what keeps the row live
  (§3, point 2).
- The plugin wins over a project that set `compaction.auto:true` in its own
  `opencode.json`, on the same ground the solo-mode write already claims
  (`src/agents.js:838-840`): the value is now a user-facing sidebar setting,
  and a project file that contradicted it would make the row lie.
- Called from the `config` hook in `src/index.js`, after `installAgents` and
  before `applyModelChoices`, in its own `try`/`catch` like its neighbours.

`suppressBuiltinAgentTurns` (`src/agents.js:842-858`) keeps the `title` /
`summary` writes and loses the compaction write together with the paragraph of
its comment block that explains it; its solo-mode gate at `:844` stays. The
reason for the split: `title`/`summary` are a solo-mode concern (no second
agent may take a turn), compaction is now a setting of its own that holds in
every mode. `BUILTIN_AUTO_AGENTS` (`:812`) keeps all three names — it is a
statement about opencode, not about who writes what.

The user's core wish is delivered by this step alone.

---

## 6. The driver: what the plugin does for an agent that stays on

`src/compaction.js` also owns `compactSession(client, { sessionID, agent })`:

1. Resolve the model. Take `providerID` / `modelID` from the session's newest
   assistant message (`types.gen.d.ts:107-108`) via the snapshot the caller
   already holds; fall back to the agent's pin in `llm-models.json`
   (`modelFor`, `src/llmmodel.js:87-97`). A session with no assistant message
   has nothing to compact and is skipped.
2. Call `client.session.summarize({ path: { id }, body: { providerID, modelID } })`
   through the same `attempt` wrapper every other client call uses
   (`src/client.js`), with a timeout, never throwing outward.
3. Log the crossing with the agent, the threshold and the context figure.

### 6.1 The primary

At the threshold branch (`src/hooks.js:426-470`) the armed relief becomes a
three-way resolution rather than two, in one place:

- endless mode in effect → the endless cycle, unchanged. **Endless wins over
  compaction**: it is a whole mode the user armed explicitly, its threshold
  already displaces `maxPrimaryContext`, and its cycle replaces the session
  rather than shrinking it.
- else, `compactionEnabledFor(primaryAgent)` true → schedule a compaction.
- else → the plain handoff, unchanged.

The compaction is **idle-gated** exactly as the handoff is, for the reason
already recorded at `src/hooks.js:393-405`: the transform hook fires while the
triggering turn is running, and compacting mid-turn would cut the turn being
answered. So: `scheduleCompactionIfNeeded(sessionID, threshold)` sets a pending
flag (with the same newly-set semantics that make the toast fire once), and
`maybeRunPendingCompaction` executes on the primary's next `session.idle`,
under an in-progress latch so a second crossing cannot start a second
compaction. Its toast mirrors the handoff toast.

The primary agent name comes from the existing identification chain
(`resolvePrimaryAgent`, `src/hooks.js`), which is what the row's
`orchestrator` entry addresses.

### 6.2 A subagent

The crossing point is the one that already exists: `contextLimitNotice`
(`src/hooks.js:864-866`) has the fresh figure and `entry.agent`. When
`contextBudgetFor(entry.agent) > 0` and the entry is over it:

- compaction **off** for that type → today's behaviour: the escalating wrap-up
  notice and the tool-call lockdown at `src/hooks.js:2317`.
- compaction **on** → compact once instead, then let the run continue. The
  lockdown applies again at the next crossing, so the budget is never lifted,
  only re-armed against a smaller session.
- Hard cap `MAX_SUBAGENT_COMPACTIONS = 3` per entry. A compaction that frees
  nothing must not become a loop; past the cap the lockdown takes over exactly
  as with the switch off.

Three collisions, each resolved where it lives:

1. **The idle handler** (`src/hooks.js:1556-1600`) would read the quiet session
   after the compaction turn as the one-shot reply. A latch
   `entry.compactingSince` set before the call and cleared after gates it, in
   the shape of the existing `hasLiveChildren` gate at `:1578` — return `null`,
   latch nothing, leave `dispatched` untouched, so the real completion idle
   still runs the normal path.
2. **The watchdog** (`src/watchdog.js:320-335`) would reap the entry on the 90 s
   silence window while the compaction runs. `watchdogLimit` gets a third case
   — `kind: "compaction"`, measured against `maxSubagentToolCallMs` counted
   from `entry.compactingSince` — ahead of the silence case and behind the
   tool-call case. Same reasoning as the tool-call case: it is work, and the
   window is a ceiling counted from the start, not a renewable lease.
3. **The result** would be the compaction summary. `finalResult`
   (`src/client.js:674-686`) skips assistant messages carrying
   `info.summary === true`. This is step 3 of the build order and stands on its
   own: it is the fix for the defect described in §1 and is needed whether or
   not any agent is ever switched on.

---

## 7. The TUI row

**Placement**: the LLM params body, per-agent, directly under `result Token`
and above `[reset current agent]` (`tui/src/tui.tsx:2589-2617`). It belongs
there and not in the Subagents block because that block holds the flat limits
over all subagents, while this value is per role and the `agent` cycler
(`:2407-2416`, over `AGENT_NAMES`, `tui/src/agent-roles.ts:19-30`) is the one
control that selects a role — including `orchestrator`, which is the row's most
important entry.

**Per-agent only.** The flat `compaction` key exists in the file as what an
untouched agent inherits and is editable by hand or env, like
`maxResultTokens`, which no row steps (`tui/src/settings-file.ts:195-201`).

**Shape**: label `compaction`, one cell `[on] ` / `[off]` in the `show agentcom`
shape (`tui/src/tui.tsx:2380-2388`) — `success` when on, `textMuted` when off —
plus the ★ the neighbouring rows use when the value is the agent's own entry
rather than inherited (`effectiveCompaction(settings, agent)` returning
`{ value, source }`, mirroring `effectiveResultTokens`,
`tui/src/settings-file.ts:425-433`). Wrapped in `alsoDisarmAgentMode` like
every other clickable row.

**No restart note.** The row is live: the global write never depends on it
(§5), and the driver reads the settings file on every crossing. This is the
concrete payoff of the unconditional write and must be stated in the row's
comment so a later change does not silently make the row a lie.

**Two note lines**, rendered under the row in the `endless mode` note shape
(`endlessRowNote`, `tui/src/endless-pause-file.ts`):

- on, but nothing will ever fire it — `orchestrator` with `maxPrimaryContext`
  at 0 and endless mode off, or a subagent role whose `agentContext` budget is
  0: *"no threshold armed — compaction never fires"*.
- on for `orchestrator` while endless mode is in effect: *"endless mode owns
  the primary threshold"*.
- off, and no other relief armed — `orchestrator` with `maxPrimaryContext` at 0
  and endless off: *"no context relief armed — the session will overflow"*.
  This is the `ContextOverflowError` case of §8 made visible.

All three are computed from values the panel already reads out of the same
file, so the notes need no new state.

**Writer**: `toggleAgentCompaction(agent)` in `tui/src/settings-file.ts`,
read-modify-write against the file like every other writer. It deliberately
does **not** copy `stepPerAgentCeiling`'s freeze-and-drop-the-flat-key
migration (`:537-565`): a step is relative to the current value, so the
ceilings must freeze what each type has in effect, while a toggle is absolute.
The rule instead: write the flipped value as the agent's own entry, and where
the flipped value equals the inherited one, **delete** the entry so the ★ goes
and the flat key keeps its meaning. `pruneSettings` gains `agentCompaction` in
its per-map normalisation loop (`:449-455`) with a boolean validator.

---

## 8. Interaction with what the plugin already does for context

- **Per-agent context budget.** Unchanged as the subagent's bound. With
  compaction on it becomes the trigger for a compaction instead of the trigger
  for the lockdown, up to the cap; the lockdown is never removed.
- **Endless mode.** Unchanged and superior: its threshold displaces
  `maxPrimaryContext` (`src/settings.js:806-809`) and, by §6.1, displaces
  compaction with it. A paused endless session falls back to the plain
  branch, where compaction may now own the threshold.
- **Primary handoff.** Unchanged machinery; with compaction on for the primary
  it is simply not the relief chosen at that crossing. Nothing else about the
  handoff — doc summaries, todo write, reparenting — is touched.
- **`maxPrimaryContext: 0` with compaction off** yields a `ContextOverflowError`
  rather than a compaction, because opencode's halt path only attempts a
  compaction when `auto !== false` (`work/code-explorer-opencode-binary-compaction.md`
  §3). Today this is documented as a solo-mode consequence
  (`README.md:590`); from this change it holds in orchestrator mode too. It is
  not guarded in code — a guard would mean overriding the user's own 0 — it is
  made visible by the third row note in §7 and documented.
- **Subagent watchdog.** One new case in `watchdogLimit` (§6.2). No change to
  the silence or tool-call windows, and no change to the sidebar rows that step
  them.
- **Retention and reuse.** A compacted session simply reports a lower
  `ctxTokens`, which the reuse gate reads as it reads any other figure. No
  change.
- **The user's own `/compact` command** is untouched: the setting governs
  automatic compaction, not a compaction the user asks for.

---

## 9. Target state and the step order

Target: `compaction.auto` is false in every opencode instance this plugin loads
into; each of the ten installed roles carries an on/off value resolved
file-per-type > file-flat > env > `false`; the sidebar edits it per role, live;
an agent switched on is compacted by the plugin at the threshold that agent
already has, without disturbing the one-shot result contract, the watchdog or
endless mode.

Seven steps. Each leaves the tree building and `npm run check` / `npm test`
green, and each can be handed out on its own.

1. **Settings.** `DEFAULT_COMPACTION`, the `compaction` and `agentCompaction`
   keys, the env var, `compactionEnabledFor`; the TUI's parity side —
   `Settings` fields, `readSettings`, `effectiveCompaction`, the default
   constant. No behaviour change. Depends on nothing.
2. **Global write.** `src/compaction.js` with `applyCompactionPolicy`, wired in
   `src/index.js`; the compaction write removed from `suppressBuiltinAgentTurns`.
   *After this step the user's core wish is met.* Depends on 1 only for the
   module's home, not for its content.
3. **Result integrity.** `finalResult` skips `info.summary === true`. Standalone
   defect fix. Depends on nothing; required by 4 and 5.
4. **Primary driver.** `compactSession`; the three-way relief resolution at
   `src/hooks.js:426-470`; the schedule/execute pair and the in-progress latch;
   the toast. Depends on 1, 2, 3.
5. **Subagent driver.** The crossing in `contextLimitNotice`; the
   `entry.compactingSince` latch; the idle gate; the `watchdogLimit` case; the
   cap. Depends on 4 (it reuses `compactSession`).
6. **TUI row.** `toggleAgentCompaction`, `pruneSettings` entry, the row, the
   three notes. Must come **after** 4 and 5: the row must never offer an `on`
   the plugin cannot honour. Depends on 1, 4, 5.
7. **Documentation.** README, project `CLAUDE.md`, `todos.md`. Depends on 6.

---

## 10. Documentation and tests

**Documentation**

- `README.md`: a block in *What this gives you* on compaction being off by
  default and settable per agent; the `compaction` row in *The TUI sidebar*
  beside `result Token`; `"compaction"` and `"agentCompaction"` in the
  configuration section's settings-file list (`README.md:754-762`); a row for
  `OPENCODE_AGENT_INTERCOM_COMPACTION` in the env-var table; the
  `ContextOverflowError` sentence generalised from solo mode to any agent with
  compaction off and no relief armed (`README.md:590`, `:795`); a line under
  *Limitations* stating that opencode's switch is global and the on-side is the
  plugin's own `summarize`.
- Project `CLAUDE.md`: the compaction paragraph — default off, the two keys,
  the env var, the per-agent row, the driver's two trigger points, and the
  fact that the write is unconditional in both modes; the solo-mode sentence
  loses its `compaction.auto` clause.
- `todos.md`: pending points only.

**Tests**

- `test/settings.test.js` — resolution order of `compactionEnabledFor`; a bad
  map value drops that entry only; a non-object map leaves the map empty; env
  `"1"`/`"0"`/garbage.
- `test/settings-defaults-parity.test.js` — `DEFAULT_COMPACTION` against the
  TUI's copy; `agentCompaction` present in both shapes.
- New `test/compaction-policy.test.js` — `applyCompactionPolicy` writes
  `auto:false` in both modes, preserves neighbouring `compaction` keys,
  overrides a project `auto:true`, and is idempotent.
- `test/solo-no-second-agent.test.js` — updated: `suppressBuiltinAgentTurns`
  no longer writes `compaction`, and the `config` hook still ends with
  `auto:false` in solo mode.
- `test/result-recovery.test.js` (or the closest existing result test) — a
  session whose newest assistant message carries `summary: true` yields the
  preceding real reply.
- New `test/compaction-driver.test.js` — the three-way primary relief
  (endless > compaction > handoff), the idle gating, the single-flight latch;
  the subagent crossing with the switch on and off, and the cap.
- `test/watchdog-activity.test.js` — the `compaction` window case and its
  precedence against the two existing ones.
- `test/tui-settings-write.test.js` — `toggleAgentCompaction`: entry created,
  entry deleted when it matches the inherited value, external edits survive,
  no other key touched, `pruneSettings` drops a non-boolean entry.
- `test/tui-sidebar-sections.test.js` — the row's position in the LLM params
  body and that it reads `props.llmAgent()`.
- New `test/tui-compaction-row.test.js` — cell states and the three note lines.

---

## 11. Assumptions

1. **`AssistantMessage.summary === true` marks a compaction message in the
   running binary.** Grounded in the SDK type (`types.gen.d.ts:115`) and the
   binary's own `!a.assistantMessage.summary` check. Would be false if the flag
   were set only on the user-side summary record; the observation that shows it
   wrong is a compacted session whose summary is still returned by the guarded
   `finalResult`.
2. **`POST /session/{id}/summarize` still exists and still compacts
   synchronously in 1.18.30.** The installed SDK is 1.18.23 against a 1.18.30
   binary. Falsified by a 404 or a 400 on the first call; the driver logs the
   status and the crossing falls back to today's behaviour (lockdown /
   handoff), so a wrong assumption degrades rather than breaks.
3. **The `config` hook's write reaches opencode's bootstrap snapshot before any
   session runs.** Already relied upon by the solo-mode write and by
   `applyModelChoices`. Falsified by a session compacting despite the row being
   off.
4. **A compaction of a subagent session leaves the run continuable** — the
   model answers the pending turn afterwards rather than stopping. Falsified by
   subagents that fall silent after their first compaction; the observation is
   an entry reaped by the watchdog immediately after `compactingSince` clears.
5. **The primary's agent name resolves to `orchestrator` for the row to
   address.** Held by the existing identification chain; falsified by a project
   renaming its default agent, in which case the flat `compaction` key is what
   governs that primary.

---

## 12. Open points

1. **Upstream.** Whether to file or comment on opencode issue #16375 asking for
   a per-agent compaction key, which would let the driver in §6 be retired.
   That is a change outside this project and is the user's to make.

No other point here needs a decision that is not this concept's to take.
