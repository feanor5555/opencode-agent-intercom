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

- One flat setting: `maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT)`
  (`src/settings.js:171`), overridden by the file key at `src/settings.js:192-194`
  (`Number.isInteger(raw?.maxContext) && raw.maxContext >= 0`), default
  `export const DEFAULT_MAX_CONTEXT = 40000` (`src/settings.js:49`), whole
  tokens, cached `TTL_MS = 2000` (`src/settings.js:92,168`).
- **Exactly three production readers**, confirmed by a tree-wide grep for
  `maxContext` across `src/`, `tui/src/`, `README.md`:
  1. `const maxContext = getSettings().maxContext` (`src/hooks.js:348`) — the
     escalating pre-call STOP injection; `0` disables (`src/hooks.js:349`),
     the near-budget cache bypass is `entry.ctxTokens > maxContext * CTX_NEAR_BUDGET`
     (`src/hooks.js:354`), the bite is `entry.ctxTokens < maxContext` (`src/hooks.js:370`).
  2. `const maxContext = getSettings().maxContext` (`src/hooks.js:910`) — the
     hard tool-call deny, `if (maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext)`
     (`src/hooks.js:911`).
  3. `const ctx = s.maxContext > 0 ? ... : "disabled"` (`src/hooks.js:462`) in
     `formatLimitsNotice()` (`src/hooks.js:460-468`), which feeds `{{limits}}`
     into the **orchestrator** prompt only — `limits = formatLimitsNotice()`
     sits in the non-subagent branch (`src/hooks.js:227`), consumed at
     `src/hooks.js:241,266` and declared at `src/promptsfile.js:21,174,214`.
  `denialLoopNotice` prints only `fmtTokens(entry.ctxTokens)`
  (`src/notices.js:123-133`) and needs no budget.
- Both enforcement points already hold the registry `entry`:
  `async function contextLimitNotice(client, entry)` (`src/hooks.js:347`), and
  the guard runs right after `permissionGuard.checkToolPermission(entry.agent, input.tool)`
  (`src/hooks.js:899`). So `entry.agent` is in hand at both, for free.
- The type is on the entry: `upsertSession(sessionID, { agent: args.agent, ... })`
  (`src/tools.js:276-282`), stored by `createEntry(sessionID, agent || "subagent", ...)`
  (`src/registry.js:261`), re-keyed by `upgradeProvisionalAgent`
  (`src/registry.js:281-288`), whose first guard is
  `if (!agent || agent === "subagent" || entry.agent !== "subagent") return`
  (`src/registry.js:282`).
- Per-agent config already exists twice, in its own file each time, and is the
  pattern this design follows: `export type LlmParams = Record<string, Record<string, number>>`
  (`tui/src/llm-params-file.ts:26`) with `export function resolveForAgent(agent)`
  (`src/llmparams.js:63`), and `export type LlmModels = Record<string, ModelRef>`
  (`tui/src/llm-models-file.ts:30`). Both are edited in the TUI through **one
  agent cycler plus one row per value** (`tui/src/tui.tsx:1354-1364`), with `★`
  marking an own value against an inherited one (`tui/src/tui.tsx:1394-1396`)
  and `[reset current agent]` (`tui/src/tui.tsx:1400-1405`).
- The TUI already fetches the live agent list: `const res = await api.client.app.agents({})`
  (`tui/src/tui.tsx:387`), whose records are typed
  `mode: "subagent" | "primary" | "all"` (`@opencode-ai/sdk` `types.gen.d.ts:1399-1402`).
  Its own hardcoded list is `const LLM_AGENTS = [...]`, nine names
  (`tui/src/tui.tsx:78-88`).
- Roles the plugin itself installs: `export const AGENTS = { orchestrator, planner,
  coder, debugger, reviewer, documenter, researcher, designer, gitter }`
  (`src/agents.js:138-217`), merged non-destructively by `installAgents`
  (`src/agents.js:229-244`).

---

## 2. Target state

### 2.1 Settings shape

New file key in `~/.config/opencode/agent-intercom.json`, next to `maxSubagents`:

```json
{ "agentContext": { "coder": 60000, "researcher": 90000, "gitter": 0 } }
```

`Record<agentName, wholeTokens>`. A key is kept only when
`Number.isInteger(v) && v >= 0`; anything else is dropped silently, the
discipline `forumBangs` already uses (`src/settings.js:207-215`). A value that
is not a plain object (array, string, `null`) leaves the key unset entirely. An
agent absent from the map is absent — nothing is materialised on read
(`tui/src/llm-params-file.ts:53-67` is the precedent).

`maxContext` becomes **legacy-only**: still parsed (`src/settings.js:192-194`
stays), no longer the ceiling, no longer editable in the TUI. It is the
migration seed — see 2.3. A separate key rather than a `number | object` union
on `maxContext`, because migration then reduces to a presence test
(`agentContext` there = migrated) instead of a shape test in every reader,
validator and writer.

Rejected alternative: a third JSON file `agent-context.json` via
`createJsonObjectFile` (`tui/src/json-object-file.ts:34`). It would inherit the
per-agent read-modify-write machinery unchanged, which is the pull. Against it:
a third store, a third cache, a third test seam and a third parity surface for
one integer per agent, while the value is an intercom governance limit that
belongs beside `maxSubagents` and `endless*`. It cannot go into
`llm-params.json` at all: that hook forwards every key it does not recognise
into `output.options`, i.e. into the provider request body
(`src/llmparams.js:87-92`), so a `maxContext` key there would be sent to the
model.

**Env var: `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT` stays and its meaning narrows.**
It is no longer "the ceiling"; it is "the value for every type that has no own
one", i.e. it displaces the built-in default table and is displaced by any
`agentContext` entry. It stays because it is the only lever a headless or CI run
has, and removing it silently changes the ceiling of every existing deployment
that sets it. No per-type env var is introduced — a `Record` does not belong in
an environment string; per-type values live in the file.

### 2.2 Built-in per-type defaults

In `src/settings.js`, exported (the TUI mirrors it and the parity test pins
both, as it already does for the two scalars — `src/settings.js:44-49`,
`test/settings-defaults-parity.test.js:81`):

```js
export const DEFAULT_AGENT_CONTEXT = {
  planner: 40000, coder: 60000, debugger: 60000, reviewer: 40000,
  documenter: 40000, researcher: 60000, designer: 30000, gitter: 30000,
}
export const DEFAULT_MAX_CONTEXT = 40000   // unknown agent name
```

`DEFAULT_MAX_CONTEXT` keeps its value and its name and becomes the fallback for
a name not in the table — so an agent the plugin does not define behaves exactly
as it does today. `orchestrator` gets no entry: the budget is subagent-only
(`src/hooks.js:163-164` calls `contextLimitNotice` in the `isSubagent` branch
alone); the primary is governed by `primaryContextThreshold()`
(`src/settings.js:283-286`).

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
  (`tui/src/settings-file.ts:110-135`).

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
5. `DEFAULT_MAX_CONTEXT` (40000).

Rules:

- **No own value** → the chain continues; there is no user-editable global to
  land on, only the built-in table.
- **`0`** at any level means *disabled for that type* and is a real value, not
  "unset": a `0` at level 1 beats a non-zero default, a `0` at level 2/3
  disables every unconfigured type. Both enforcement points already treat
  `<= 0` as off (`src/hooks.js:349,911`), so the semantics carry over unchanged.
- **Type not yet known.** The entry is provisional `"subagent"`
  (`src/registry.js:261,282`) until `spawn` upgrades it, and the upgrade runs
  *after* `await promptSession(...)` (`src/tools.js:264` then `:276-282`), which
  is `client.session.promptAsync` (`src/client.js:85-90`) — it returns once the
  run is queued, so a first LLM turn can reach the hook with `entry.agent ===
  "subagent"`. In that window `"subagent"` is simply a name not in the table and
  resolves to `DEFAULT_MAX_CONTEXT` (level 5) — unless the user has put an
  explicit `"subagent"` entry in `agentContext`, which is then honoured and is
  the documented way to steer the window. It is harmless in practice: the budget
  only bites at `ctxTokens >= budget`, and a session that has not had its first
  assistant step has `ctxTokens == null` (`src/hooks.js:370`).
- Therefore: **the budget is resolved per call from `entry.agent`, never cached
  on the entry.** The value corrects itself on the first call after the upgrade.

### 2.5 Enforcement points

Both change, identically and minimally:

- `src/hooks.js:348` → `const maxContext = contextBudgetFor(entry.agent)`.
  Everything below it (`:349`, `:354`, `:370`, `:383`, `:418`) already reads the
  local and is untouched; the injected text keeps printing the number that
  actually applied.
- `src/hooks.js:910` → the same substitution. `entry` is in scope.

No other server change: `denialLoopNotice` (`src/notices.js:123-133`) carries no
budget, and `recordPrimaryContext` (`src/hooks.js:170`) is a different setting.

### 2.6 The `{{limits}}` block

A single `maxContext = X` (`src/hooks.js:466`) is no longer the ceiling.
`formatLimitsNotice()` (`src/hooks.js:613-644`) lists the budget per spawnable
type, with each entry carrying the fixed overhead that type's spawns pay
before the orchestrator's own words and the headroom left over; `0` is shown
as `off`. The full block:

```
📐 agent-intercom: current limits — maxSubagents = 3.
Context budget per agent: planner 40k (−10k fixed → 30k) · coder 60k (−12k
fixed → 48k) · debugger 60k (−12k fixed → 48k) · reviewer 40k (−10k fixed →
30k) · documenter 40k (−10k fixed → 30k) · researcher 60k (−12k fixed → 48k)
· designer 30k (−8k fixed → 22k) · gitter off.
Per entry: the budget, the fixed overhead every spawn of that type carries
before your own words (subagent guides, PROJECT.md, the project snapshot the
plugin prepends, AGENTS.md where that type keeps it), and the headroom left of
the budget for your prompt text and the subagent's own work.
Use the budget — the first number of the agent you are spawning — in the
right-sized-chunks rule of the orchestration protocol above.
```

(The `hideChatter` tail — "Subagent results and handoff messages are hidden
from the user's screen…" — is appended only while that setting is on.)

The list is built from `Object.keys(AGENTS)` minus `orchestrator`
(`src/agents.js:138-217`) mapped through `contextBudgetFor` — the plugin's own
roles, which are the ones the orchestrator prompt tells it to spawn
(`src/agents.js:27`). Cost: the block grows from one line to three, ~40 tokens
per orchestrator turn.

Rejected: printing a min–max range. Cheaper, but useless — the orchestrator
sizes a chunk for a *named* role, and a range tells it nothing about that role.

`src/promptsfile.js:21,174` document the placeholder as "current maxSubagents /
maxContext" and are updated to match.

### 2.7 TUI

**Recommendation: replace the single `max Token(k)` row with a two-row block —
an agent cycler and the ceiling of the selected agent** — in place, in the
Subagents section (`tui/src/tui.tsx:1271-1280`):

```
  agent          [<]  coder        [>]
  max Token(k)   [-]   60          [+] ★
```

Reasoning: it is the pattern the panel already runs twice, for LLM params and
for the per-agent model (`tui/src/tui.tsx:1354-1396`) — same cycler, same
`holdRepeat` steppers, same `★` for "this agent's own value, not the inherited
one", same read-modify-write store. It costs one extra row regardless of how
many agent types exist, and it stands exactly where the old global row stood, so
the user who reaches for the ceiling finds it without being told. `[-]` at the
type's own value stepping below zero **drops the entry** so the inherited
default shows again, the behaviour `stepLlmParam` already implements
(`tui/src/llm-params-file.ts:140-142`).

The cycler list comes from the live fetch already in the file —
`api.client.app.agents({})` (`tui/src/tui.tsx:387`) filtered to
`mode !== "primary"` — falling back to `LLM_AGENTS` minus `orchestrator`
(`tui/src/tui.tsx:78-88`) until the first fetch lands. That way a project's own
agents are editable too, which a hardcoded list cannot do.

The displayed value is the **effective** ceiling (own > flat/env > built-in
default), so a type with no entry reads `60`, never `0`; `0` renders as `off`,
as `maxSubagents` renders `unlimited` (`tui/src/tui.tsx:1266`).

Cost of this recommendation: a second cycler index signal, a nested-map member
on the `Settings` interface (`tui/src/settings-file.ts:24-29`) so the
`SETTING_VALIDATORS` mapped type still forces a validator
(`tui/src/settings-file.ts:57-62`), an `agentContext`-aware writer beside
`stepSetting` (which is scalar-only, `tui/src/settings-file.ts:149-155`), the
migration freeze, and a mirror of `DEFAULT_AGENT_CONTEXT`.

Weighed and rejected:

- **Global only in the TUI, per-type in the settings file.** Now untenable:
  there is no global left, so the sidebar would offer no way to set a ceiling at
  all, and the file key has no in-product discovery path — a user would have to
  read the README to change a limit they can see biting on screen.
- **One row per agent type.** Nine rows today, unbounded with project agents;
  it buries the three sibling limits and breaks the fixed sidebar layout the
  column widths assume (`tui/src/tui.tsx:104-111`).
- **Effective ceiling on the running subagent's row instead of the settings
  block.** Not instead — **in addition**, and cheap: the row already renders
  `· ${formatTokens(entry.ctxTokens)} ctx` (`tui/src/tui.tsx:1195-1198`), so it
  becomes `· 12k/60k ctx`. That is where the user notices the ceiling biting.
  It cannot replace the editor: a row exists only while that subagent runs, and
  it is read-only. Last step, droppable.

### 2.8 Agent types known at runtime

- Server: `AGENTS` (`src/agents.js:138-217`) — nine roles — merged into
  opencode's resolved config by `installAgents` (`src/agents.js:229-244`), where
  a project may add its own or override one. The `spawn` tool takes any
  `args.agent` string (`src/tools.js:247,264,277`), so the real set is **open**
  — which is exactly why `contextBudgetFor` needs the unknown-name fallback of
  2.2 and why nothing is materialised on read.
- TUI: the live merged list from `api.client.app.agents({})`
  (`tui/src/tui.tsx:387`), each record carrying `name` and `mode`
  (SDK `types.gen.d.ts:1399-1402`). So yes — a per-type editor can list them,
  including project-defined agents, without a hardcoded table.

---

## 3. Build order

Each step leaves the tree building and `npm run check` / `npm test` green.

1. **`src/settings.js`** — `DEFAULT_AGENT_CONTEXT`, the `agentContext` file key
   with its validator, `contextBudgetFor(agent)`. Header comment
   (`src/settings.js:28-36`) updated. Tests in `test/settings.test.js`: own
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
  `promptAsync` (`src/client.js:86`) returns before the run finishes while
  `upsertSession` with the agent name runs after it (`src/tools.js:264,276`).
  Holds if opencode queues the prompt asynchronously. Wrong if the hook never
  observes `entry.agent === "subagent"` — a one-line log at the head of
  `contextLimitNotice` would show it. Costs nothing either way: the fallback of
  2.4 is correct in both cases.
- **A2 — `app.agents()` returns project-defined agents, not only built-ins.**
  Taken from its use as the source of resolved per-agent defaults
  (`tui/src/tui.tsx:387-400`). Wrong if a project agent is missing from the
  cycler; the hardcoded `LLM_AGENTS` fallback keeps the panel usable then.
- **A3 — the default table's numbers.** They encode a judgement about how much
  context each role needs, not a measurement. Wrong if a role routinely trips
  its ceiling before finishing — visible as `denialLoopNotice`
  (`src/notices.js:123`) firing for one role repeatedly. They are user-editable
  per type, so being wrong is cheap.

## 5. Open

- Whether the ceiling should also be settable **per running instance** (this
  `coder#3`, not every coder) is not decided here; the entry-level plumbing
  (`entry.ctxTokens`, `entry.sessionID`) would carry it, and `contextBudgetFor`
  would gain an entry argument in front of its type argument.
- Whether `maxPrimaryContext` / `endlessContext` should join the per-type scheme
  for multiple primaries lies outside this change.
