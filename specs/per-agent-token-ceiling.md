# Per-agent-type token ceiling

The subagent context budget is a value **per agent type**. There is no single
user-facing ceiling governing all subagents any more. Every type carries its own
number; a type nobody configured falls back to a built-in per-type default, not
to a user-editable global.

Boundary: the `opencode-agent-intercom` plugin — `src/` (server half, plain JS)
and `tui/src/` (TUI half, TS, separate npm package, no import across the two).

---

## 1. What the code does today

Read out of the source, each claim with its line:

- The context budget is **per agent type**. The file key `agentContext` maps an
  agent name to its ceiling in whole tokens and is resolved by
  `contextBudgetFor(agent)` (`src/settings.js:801`); the legacy flat key
  `maxContext` and the env var `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT` are the
  value for every type without an own entry (`src/settings.js:6-21`,
  `src/settings.js:804`); the built-in per-type default table is
  `DEFAULT_AGENT_CONTEXT` (`src/settings.js:123-133`) and an unknown name
  falls back to `DEFAULT_MAX_CONTEXT = 100000` (`src/settings.js:116`). Whole
  tokens, settings cached for `TTL_MS = 2000` (`src/settings.js:400`, `:530`).
  `0` is a real value at every level and disables the budget for that type.
- The legacy flat key is parsed (`src/settings.js:592-595`) and recorded with
  the level that produced it as `maxContextSource`
  (`src/settings.js:533-534`, `:594`), because "the user set 100000" and "nobody set
  anything" pick different budgets for a type that has a built-in default.
- **Three enforcement points on the running subagent and its orchestrator.** A
  tree-wide grep for `contextBudgetFor` across `src/` finds further readers: the
  spawn package gate (`src/tools.js:144`), the reuse and retention gates
  (`src/tools.js:1205`, `src/hooks.js:2125`), the `message` refusal
  (`src/midrun.js:164`), a delegating subagent's limits block
  (`src/hooks.js:1583`, `:1590`) and the wake notices (`src/notices.js:103`, `:350`).
  1. `const maxContext = contextBudgetFor(entry.agent)` (`src/hooks.js:1111`)
     at the head of `contextLimitNotice(client, entry)` (`src/hooks.js:1110`).
     `0` disables (`src/hooks.js:1112`). The `ctxTokens == null` or
     pre-band guard is `entry.ctxTokens < maxContext * CTX_NEAR_BUDGET`
     (`src/hooks.js:1141`). The reserve-band open is
     `entry.ctxTokens < maxContext * CTX_STOP_RESERVE` (`src/hooks.js:1157`).
     The lockdown open is `entry.ctxTokens < maxContext` (`src/hooks.js:1193`).
     The constants are `CTX_NEAR_BUDGET = 0.7` and `CTX_STOP_RESERVE = 0.9`
     (`src/hooks.js:338,349`).
  2. `const maxContext = contextBudgetFor(entry.agent)` (`src/hooks.js:2838`)
     at the head of the tool-call guard. The hard-deny condition is
     `maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext`
     (`src/hooks.js:2839`). `MID_RUN_MESSAGING_TOOLS` is exempted
     (`src/hooks.js:2859-2868`).
  3. The orchestrator-only `{{limits}}` block. The per-type row in
     `formatLimitsNotice` is built by iterating the spawnable roles and
     resolving each through `contextBudgetFor` (`src/hooks.js:1453,1455`); the
     block feeds the orchestrator prompt only
     (`src/promptsfile.js:21,362,409`).
- `contextLimitNotice` is **three bands, not two**: plan, reserve, lockdown.
  Split by `CTX_NEAR_BUDGET` and `CTX_STOP_RESERVE` (`src/hooks.js:1072-1084`).
  Plan band (`>= CTX_NEAR_BUDGET`, `< CTX_STOP_RESERVE`): denies nothing,
  demands nothing, names the room left and the reserve threshold in tokens,
  adds `resultCeilingPlan` (`src/prompts.js:387`). Counted in
  `entry.contextPlanNotices` (`src/hooks.js:1158`). Reserve band
  (`>= CTX_STOP_RESERVE`, `< budget`): tools still work, demands the `Done:`
  / `Blocked:` summary NOW while both the tools and the room remain, adds
  `resultCeilingDemand` (`src/prompts.js:417`). Counted in
  `entry.contextWarnings` (`src/hooks.js:1194`). Lockdown (`>= budget`):
  `guardToolExecute` is denying every work tool, the block escalates over
  successive LLM turns and notifies the parent at `BUDGET_NOTIFY_AFTER = 3`
  (`src/hooks.js:362`); counted in `entry.stopInjections` (`src/hooks.js:1249`).
  Every band re-fires on each crossing turn — the block rides on the
  per-request copy of the message array and is never written back to the
  session (`src/hooks.js:1101-1109`).
- **Compaction instead of lockdown, when switched on for the type.** The
  crossing buys a `client.session.summarize` instead of the lockdown, up to
  `MAX_SUBAGENT_COMPACTIONS`; `startSubagentCompaction` (`src/compaction.js:210`,
  called at `src/hooks.js:1232`) takes the decision and owns the latch. False means the crossing is the
  lockdown's after all — switch off, cap spent, or a question open. The
  reserve band is untouched either way.
- The subagent's notice rides in a **carrier message appended at the END of
  the per-request array** (`isNoticeCarrier` / `tailNoticeCarrier`,
  `src/hooks.js:821,842`), not on the last user message — which in a subagent
  session is message 0. The primary's placement is unchanged: its notice
  hangs off its own last user message (`src/hooks.js:938-943`).
- Both enforcement points already hold the registry `entry`:
  `contextLimitNotice(client, entry)` (`src/hooks.js:1110`), and the guard
  runs after `permissionGuard.checkToolPermission` (`src/hooks.js:2826-2836`).
  `entry.agent` is in hand at both, for free.
- The type is on the entry: `upsertSession(sessionID, { agent: args.agent, ... })`
  (`src/tools.js:835-853`), stored by `createEntry(sessionID, agent || "subagent", ...)`
  (`src/registry.js:1076-1078`), re-keyed by `upgradeProvisionalAgent`
  (`src/registry.js:1107-1114`), whose first guard is
  `if (!agent || agent === "subagent" || entry.agent !== "subagent") return`
  (`src/registry.js:1108`).
- Per-agent config already exists in its own files and is the pattern this
  design follows: `export type LlmParams = Record<string, Record<string, number>>`
  (`tui/src/llm-params-file.ts:26`) with `export function resolveForAgent(agent)`
  (`src/llmparams.js:73`), `export type LlmModels = Record<string, ModelEntry>`
  (`tui/src/llm-models-file.ts:86`), and the same shape for `agentContext`
  itself through `tui/src/settings-file.ts`. All three are edited in the TUI
  through **one agent cycler plus one row per value**
  (`tui/src/tui.tsx:2603-2612`), with `★` marking an own value against an
  inherited one (`tui/src/tui.tsx:2734-2736`) and `[reset current agent]`
  (`tui/src/tui.tsx:2866-2871`).
- The TUI already fetches the live agent list: `const res = await api.client.app.agents({})`
  (`tui/src/tui.tsx:670`), whose records are typed
  `mode: "subagent" | "primary" | "all"` (`@opencode-ai/sdk` `types.gen.d.ts:1399-1402`).
  Its own hardcoded list is `export const AGENT_NAMES = [...]`, ten names
  (`tui/src/agent-roles.ts:19-30`).
- Roles the plugin itself installs: `export const AGENTS = { orchestrator, planner,
  coder, debugger, reviewer, documenter, researcher, grounder, designer, gitter }`
  (`src/agents.js:355-472`), merged non-destructively by `installAgents`
  (`src/agents.js:735-824`).

## 2. Target state

### 2.1 Settings shape

New file key in `~/.config/opencode/agent-intercom.json`, next to `maxSubagents`:

```json
{ "agentContext": { "coder": 60000, "researcher": 90000, "gitter": 0 } }
```

`Record<agentName, wholeTokens>`. A key is kept only when
`Number.isInteger(v) && v >= 0`; anything else is dropped silently, the
discipline `forumBangs` already uses (`src/settings.js:676-684`). A value that
is not a plain object (array, string, `null`) leaves the key unset entirely. An
agent absent from the map is absent — nothing is materialised on read
(`tui/src/llm-params-file.ts:55-67` is the precedent).

`maxContext` becomes **legacy-only**: still parsed (`src/settings.js:592-595`
stays), no longer the ceiling, no longer editable in the TUI. It is the
migration seed — see 2.3. A separate key rather than a `number | object` union
on `maxContext`, because migration then reduces to a presence test
(`agentContext` there = migrated) instead of a shape test in every reader,
validator and writer.

Rejected alternative: a third JSON file `agent-context.json` via
`createJsonObjectFile` (`tui/src/json-object-file.ts:33`). It would inherit the
per-agent read-modify-write machinery unchanged, which is the pull. Against it:
a third store, a third cache, a third test seam and a third parity surface for
one integer per agent, while the value is an intercom governance limit that
belongs beside `maxSubagents` and `endless*`. It cannot go into
`llm-params.json` at all: that hook forwards every key it does not recognise
into `output.options`, i.e. into the provider request body
(`src/llmparams.js:114-116`), so a `maxContext` key there would be sent to the
model.

**Env var: `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT` stays and its meaning narrows.**
It is no longer "the ceiling"; it is "the value for every type that has no own
one", i.e. it displaces the built-in default table and is displaced by any
`agentContext` entry. It stays because it is the only lever a headless or CI run
has, and removing it silently changes the ceiling of every existing deployment
that sets it. No per-type env var is introduced — a `Record` does not belong in
an environment string; per-type values live in the file.

### 2.2 Built-in per-type defaults

In `src/settings.js`, exported (`src/settings.js:116`, `:123-133`); the TUI
mirrors both (`tui/src/settings-file.ts:175`, `tui/src/agent-roles.ts:80-90`)
and `test/settings-defaults-parity.test.js` pins the two halves against each
other and the table's keys against `SPAWNABLE_ROLES`:

```js
export const DEFAULT_MAX_CONTEXT = 100000   // unknown agent name, legacy flat key fallback
export const DEFAULT_AGENT_CONTEXT = {
  planner: 100000, coder: 100000, debugger: 100000, reviewer: 100000,
  documenter: 100000, researcher: 100000, grounder: 100000, designer: 100000,
  gitter: 100000,
}
```

Every spawnable type defaults to 100000 tokens. `DEFAULT_MAX_CONTEXT` is the
fallback for a name not in the table and for the legacy flat `maxContext`
key. `orchestrator` gets no entry: the budget is subagent-only
(`src/hooks.js:923` calls `contextLimitNotice` in the subagent branch
alone); the primary is governed by `primaryContextThreshold()`
(`src/settings.js:1094-1097`).

### 2.3 Migration of an existing file

Read-time, no write by the server half:

- File has `agentContext` → it wins per type.
- File has only the flat `maxContext: N` → `N` is the value for **every** type
  that has no `agentContext` entry. The user's configured number keeps governing
  every subagent, exactly as before, indefinitely and with no write.
- The **TUI performs the one-shot migration at the moment the user first edits a
  ceiling**: the writer materialises `agentContext` for every agent the cycler
  knows, from the values then in effect (own > flat/env > default), applies the
  step to the selected one, and deletes the flat `maxContext` key. The frozen
  map reproduces what was in effect, so nothing loosens or tightens; and the
  write happens in the half that already owns writing this file
  (`stepPerAgentCeiling`, `tui/src/settings-file.ts:699-730`).

Alternative, cheaper and duller: never write, keep the flat key as a permanent
seed. It costs nothing to build but leaves a file in which the effective ceiling
of a type is spread over two keys forever, and leaves the TUI unable to show a
`★` truthfully. The freeze wins; the flat-seed reading is the fallback while
step 4 is not yet built, and is what a user who never opens the TUI keeps.

### 2.4 Resolution — one function

```js
export function contextBudgetFor(agent) // -> whole tokens, 0 = disabled
```
in `src/settings.js`, over the same 2 s-cached `getSettings()` object. Order:

1. `agentContext[agent]` — the type's own value.
2. flat `maxContext` from the **file** (legacy seed), if present.
3. env `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT`, if set.
4. `DEFAULT_AGENT_CONTEXT[agent]`.
5. `DEFAULT_MAX_CONTEXT` (100000).

Rules:

- **No own value** → the chain continues; there is no user-editable global to
  land on, only the built-in table.
- **`0`** at any level means *disabled for that type* and is a real value, not
  "unset": a `0` at level 1 beats a non-zero default, a `0` at level 2/3
  disables every unconfigured type. Both enforcement points already treat
  `<= 0` as off (`src/hooks.js:1112,2839`), so the semantics carry over unchanged.
- **Type not yet known.** The entry is provisional `"subagent"`
  (`src/registry.js:1077,1108`) until `spawn` upgrades it, and the upgrade runs
  *after* `await promptSession(...)` (`src/tools.js:785` then `:835-853`), which
  is `client.session.promptAsync` (`src/client.js:367-407`) — it returns once the
  run is queued, so a first LLM turn can reach the hook with `entry.agent ===
  "subagent"`. In that window `"subagent"` is simply a name not in the table and
  resolves to `DEFAULT_MAX_CONTEXT` (level 5) — unless the user has put an
  explicit `"subagent"` entry in `agentContext`, which is then honoured and is
  the documented way to steer the window. It is harmless in practice: the budget
  only bites at `ctxTokens >= budget`, and a session that has not had its first
  assistant step has `ctxTokens == null` (`src/hooks.js:1141`).
- Therefore: **the budget is resolved per call from `entry.agent`, never cached
  on the entry.** The value corrects itself on the first call after the upgrade.

### 2.5 Enforcement points

Both change, identically and minimally:

- `src/hooks.js:1111` → `const maxContext = contextBudgetFor(entry.agent)`.
  Everything below it (`:1112`, `:1117`, `:1141`, `:1157`, `:1193`) already reads the
  local and is untouched; the injected text keeps printing the number that
  actually applied.
- `src/hooks.js:2838` → the same substitution. `entry` is in scope.

No other server change: `denialLoopNotice` (`src/notices.js:607-616`) carries no
budget, and `recordPrimaryContext` (`src/hooks.js:470`) is a different setting.

### 2.6 The `{{limits}}` block

`formatLimitsNotice()` (`src/hooks.js:1436-1488`) lists the budget per spawnable
type, with each entry carrying the fixed overhead that type's spawns pay
before the orchestrator's own words and the headroom left over; `0` is shown
as `off`. The full block, with the built-in defaults, one `gitter: 0` entry in
`agentContext`, and illustrative fixed-overhead figures (they depend on the
project's `PROJECT.md`, `AGENTS.md` and snapshot):

```
📐 agent-intercom: current limits — maxSubagents = 1.
Context budget per agent: planner 100k (−10k fixed → 90k) · coder 100k (−12k
fixed → 88k) · debugger 100k (−12k fixed → 88k) · reviewer 100k (−10k fixed →
90k) · documenter 100k (−10k fixed → 90k) · researcher 100k (−12k fixed → 88k)
· grounder 100k (−8k fixed → 92k) · designer 100k (−8k fixed → 92k) · gitter off.
Per entry: the budget, the fixed overhead every spawn of that type carries
before your own words (subagent guides, PROJECT.md, the project snapshot the
plugin prepends, AGENTS.md where that type keeps it), and the headroom left of
the budget for your prompt text and the subagent's own work.
Use the budget — the first number of the agent you are spawning — in the
right-sized-chunks rule of the orchestration protocol above.
```

(The `showAgentcom` tail — "Subagent results and handoff messages are hidden
from the user's screen…" — is appended only while that setting is off.)

The list is built from `SPAWNABLE_ROLES` (`src/hooks.js:1453`; the `mode: "subagent"`
roles of `AGENTS`, `src/agents.js:499-503`) mapped through `contextBudgetFor` — the
plugin's own roles, which are the ones the orchestrator prompt tells it to spawn
(`src/agents.js:49`). Cost: the block grows from one line to three, ~40 tokens
per orchestrator turn.

Rejected: printing a min–max range. Cheaper, but useless — the orchestrator
sizes a chunk for a *named* role, and a range tells it nothing about that role.

`src/promptsfile.js:21,362` document the placeholder as "current maxSubagents +
per-agent context budgets".

### 2.7 TUI

**The per-agent ceiling sits behind an agent cycler that walks the full
role list (`AGENT_NAMES`, orchestrator included), in the LLM params
section, directly after the `effort` row and before `[reset current
agent]`, with the Subagents section carrying no agent cycler**
(`tui/src/tui.tsx:2603-2612`, `:2705-2739`):

```
  agent          [<]  coder        [>]
  max Token(k)   [-]   60          [+] ★
```

Reasoning: it is the pattern the panel already runs twice, for LLM params and
for the per-agent model (`tui/src/tui.tsx:2603-2673`) — same cycler, same
`holdRepeat` steppers, same `★` for "this agent's own value, not the inherited
one", same read-modify-write store. It costs one extra row regardless of how
many agent types exist, and it stands exactly where the old global row stood, so
the user who reaches for the ceiling finds it without being told. `[-]` at the
type's own value stepping below zero **drops the entry** so the inherited
default shows again, the behaviour `stepLlmParam` already implements
(`tui/src/llm-params-file.ts:148-149`).

The cycler walks `AGENT_NAMES` (`tui/src/agent-roles.ts:19-30`, `cycleLlmAgent` at
`tui/src/tui.tsx:776-780`), the plugin's own roles with `orchestrator` included; a
project's own agents get no row.

The displayed value is the **effective** ceiling (own > flat/env > built-in
default), so a type with no entry reads `60`, never `0`; `0` renders as `off`,
as `maxSubagents` renders `unlimited` (`tui/src/tui.tsx:2313`).

Cost of this recommendation: a second cycler index signal, a nested-map member
on the `Settings` interface (`tui/src/settings-file.ts:117-142`) so the
`SETTING_VALIDATORS` mapped type still forces a validator
(`tui/src/settings-file.ts:341-365`), an `agentContext`-aware writer beside
`stepSetting` (which is scalar-only, `tui/src/settings-file.ts:674-680`), the
migration freeze, and a mirror of `DEFAULT_AGENT_CONTEXT`.

Weighed and rejected:

- **Global only in the TUI, per-type in the settings file.** Now untenable:
  there is no global left, so the sidebar would offer no way to set a ceiling at
  all, and the file key has no in-product discovery path — a user would have to
  read the README to change a limit they can see biting on screen.
- **One row per agent type.** Nine rows today, unbounded with project agents;
  it buries the three sibling limits and breaks the fixed sidebar layout the
  column widths assume (`tui/src/tui.tsx:176-186`).
- **Effective ceiling on the running subagent's row instead of the settings
  block.** Not instead — **in addition**, and cheap: the row already renders
  `· ${formatTokens(entry.ctxTokens)} ctx` (`tui/src/tui.tsx:2176-2179`), so it
  becomes `· 12k/60k ctx`. That is where the user notices the ceiling biting.
  It cannot replace the editor: a row exists only while that subagent runs, and
  it is read-only. Last step, droppable.

### 2.8 Agent types known at runtime

- Server: `AGENTS` (`src/agents.js:355-472`) — ten roles — merged into
  opencode's resolved config by `installAgents` (`src/agents.js:735-824`), where
  a project may add its own or override one. The `spawn` tool's gate reads
  `SPAWNABLE_ROLES` (`src/agents.js:499-503`), the nine `mode: "subagent"` roles
  minus `orchestrator` — the closed spawnable set is this plugin's own
  roles, nothing else. `contextBudgetFor` keeps its unknown-name fallback of
  2.2 for any read path that is not the spawn gate (e.g. a per-type editor
  iterating types the project added), and nothing is materialised on read.
- TUI: the live merged list from `api.client.app.agents({})`
  (`tui/src/tui.tsx:670`), each record carrying `name` and `mode`
  (SDK `types.gen.d.ts:1399-1402`). So yes — a per-type editor can list them,
  including project-defined agents, without a hardcoded table.

---

## 3. Build order

Each step leaves the tree building and `npm run check` / `npm test` green.

1. **`src/settings.js`** — `DEFAULT_AGENT_CONTEXT`, the `agentContext` file key
   with its validator, `contextBudgetFor(agent)`. Header comment
   (`src/settings.js:6-21`) updated. Tests in `test/settings.test.js`: own
   value wins; flat seed; env; per-type default; unknown name; `0` per type;
   `0` as seed; malformed map ignored. Depends on nothing. Nothing calls the new
   function yet, so behaviour is unchanged.
2. **`src/hooks.js` enforcement** — the two substitutions of 2.5. Depends on 1.
   Behaviour change lands here.
3. **`src/hooks.js` `formatLimitsNotice` + `src/promptsfile.js` text** — 2.6.
   Depends on 1.
4. **`tui/src/settings-file.ts`** — `agentContext` on `Settings`, its validator,
   `effectiveAgentContext(settings, agent)`, `stepAgentContext(agent, delta)`
   with the freeze migration of 2.3, `DEFAULT_AGENT_CONTEXT` mirror. Extend
   `test/settings-defaults-parity.test.js` to pin the table on both sides and
   `test/tui-settings-write.test.js` for the freeze, the entry drop at zero, and
   an unrelated key surviving the write. Depends on 1 (parity).
5. **`tui/src/tui.tsx`** — the cycler + ceiling rows of 2.7, agent list from the
   existing `app.agents` fetch. Depends on 4.
6. **`tui/src/tui.tsx` subagent row** — `ctx/ceiling`. Depends on 4 and 5.
   Droppable.
7. **Docs** — `README.md`, `CLAUDE.md` version bump. Depends on 1-6.

Steps 2 and 3 are independent of each other; 4 may run in parallel with 2/3.

---

## 4. Assumptions

- **A1 — the provisional window is reachable.** Taken as given because
  `promptAsync` (`src/client.js:381`) returns before the run finishes while
  `upsertSession` with the agent name runs after it (`src/tools.js:785,835`).
  Holds if opencode queues the prompt asynchronously. Wrong if the hook never
  observes `entry.agent === "subagent"` — a one-line log at the head of
  `contextLimitNotice` would show it. Costs nothing either way: the fallback of
  2.4 is correct in both cases.
- **A2 — `app.agents()` returns project-defined agents, not only built-ins.**
  Taken from its use as the source of resolved per-agent defaults
  (`tui/src/tui.tsx:668-710`). Wrong if a project agent is missing from the
  cycler; the hardcoded `LLM_AGENTS` fallback keeps the panel usable then.
- **A3 — the default table's numbers.** They encode a judgement about how much
  context each role needs, not a measurement. Wrong if a role routinely trips
  its ceiling before finishing — visible as `denialLoopNotice`
  (`src/notices.js:607`) firing for one role repeatedly. They are user-editable
  per type, so being wrong is cheap.

## 5. Open

- Whether the ceiling should also be settable **per running instance** (this
  `coder#3`, not every coder) is not decided here; the entry-level plumbing
  (`entry.ctxTokens`, `entry.sessionID`) would carry it, and `contextBudgetFor`
  would gain an entry argument in front of its type argument.
- Whether `maxPrimaryContext` / `endlessContext` should join the per-type scheme
  for multiple primaries lies outside this change.
