# Per-agent-type token ceiling

The subagent context budget is a value **per agent type**. There is no single
user-facing ceiling governing all subagents. Every type carries its own
number; a type nobody configured falls back to a built-in per-type default, not
to a user-editable global.

Boundary: the `opencode-agent-intercom` plugin — `src/` (server half, plain JS)
and `tui/src/` (TUI half, TS, separate npm package, no import across the two).

---

## 1. Settings shape

The file key `agentContext` in `~/.config/opencode/agent-intercom.json`, next to
`maxSubagents`:

```json
{ "agentContext": { "coder": 60000, "researcher": 90000, "gitter": 0 } }
```

`Record<agentName, wholeTokens>`. A key is kept only when
`Number.isInteger(v) && v >= 0`; anything else is dropped silently, the
discipline `forumBangs` uses (`src/settings.js:693-701`). A value that is not a
plain object (array, string, `null`) leaves the key unset entirely. An agent
absent from the map is absent — nothing is materialised on read
(`tui/src/llm-params-file.ts:55-67` follows the same rule). Whole tokens,
settings cached for `TTL_MS = 2000` (`src/settings.js:411`, `:543`).

`maxContext` is **legacy-only**: parsed (`src/settings.js:606-609`), not the
ceiling, not editable in the TUI, and recorded with the level that produced it
as `maxContextSource` (`src/settings.js:546-547`, `:608`), because "the user set
100000" and "nobody set anything" pick different budgets for a type that has a
built-in default. The per-type map is a separate key rather than a
`number | object` union on `maxContext`, so "migrated" is a presence test
(`agentContext` there) rather than a shape test in every reader, validator and
writer.

The budget lives in the intercom settings file and not in `llm-params.json`:
that file's hook forwards every key it does not recognise into
`output.options`, i.e. into the provider request body
(`src/llmparams.js:114-116`).

**Env var: `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT` is the value for every type that
has no own one.** It is not "the ceiling": it displaces the built-in default table
and is displaced by any `agentContext` entry (`src/settings.js:6-21`,
`src/settings.js:821`). It is the only lever a headless or CI run has. There is
no per-type env var; per-type values live in the file.

## 2. Built-in per-type defaults

In `src/settings.js`, exported (`src/settings.js:123`, `:130-142`); the TUI
mirrors both (`tui/src/settings-file.ts:175`, `tui/src/agent-roles.ts:83-95`)
and `test/settings-defaults-parity.test.js` pins the two halves against each
other and the table's keys against `SPAWNABLE_ROLES`:

```js
export const DEFAULT_MAX_CONTEXT = 100000   // unknown agent name, legacy flat key fallback
export const DEFAULT_AGENT_CONTEXT = {
  planner: 100000, coder: 100000, debugger: 100000, reviewer: 100000,
  documenter: 100000, researcher: 100000, grounder: 100000, designer: 100000,
  gitter: 100000, scout: 100000, checker: 100000,
}
```

Every spawnable type defaults to 100000 tokens. `DEFAULT_MAX_CONTEXT` is the
fallback for a name not in the table and for the legacy flat `maxContext`
key. `orchestrator` has no entry: the budget is subagent-only
(`src/hooks.js:940` calls `contextLimitNotice` in the subagent branch
alone); the primary is governed by `primaryContextThreshold()`
(`src/settings.js:1117-1120`).

## 3. Resolution — one function

```js
export function contextBudgetFor(agent) // -> whole tokens, 0 = disabled
```

in `src/settings.js:818`, over the same 2 s-cached `getSettings()` object. Order:

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
  disables every unconfigured type. Both enforcement points treat `<= 0` as
  off (`src/hooks.js:1129,2891`).
- **Type not yet known.** The entry is provisional `"subagent"`
  (`src/registry.js:1082,1113`) until `spawn` upgrades it, and the upgrade runs
  *after* `await promptSession(...)` (`src/tools.js:785` then `:835-853`), which
  is `client.session.promptAsync` (`src/client.js:367-407`) — it returns once the
  run is queued, so a first LLM turn can reach the hook with `entry.agent ===
  "subagent"`. In that window `"subagent"` is a name not in the table and
  resolves to `DEFAULT_MAX_CONTEXT` (level 5) — unless the user has put an
  explicit `"subagent"` entry in `agentContext`, which is then honoured and is
  the way to steer the window. The budget only bites at `ctxTokens >= budget`,
  and a session that has not had its first assistant step has
  `ctxTokens == null` (`src/hooks.js:1158`).
- Therefore: **the budget is resolved per call from `entry.agent`, never cached
  on the entry.** The value corrects itself on the first call after the upgrade.

The type is on the entry: `upsertSession(sessionID, { agent: args.agent, ... })`
(`src/tools.js:835-853`), stored by `createEntry(sessionID, agent || "subagent", ...)`
(`src/registry.js:1081-1083`), re-keyed by `upgradeProvisionalAgent`
(`src/registry.js:1112-1119`), whose first guard is
`if (!agent || agent === "subagent" || entry.agent !== "subagent") return`
(`src/registry.js:1113`).

## 4. Migration of an existing file

Read-time, no write by the server half:

- File has `agentContext` → it wins per type.
- File has only the flat `maxContext: N` → `N` is the value for **every** type
  that has no `agentContext` entry. The user's configured number governs every
  subagent, indefinitely and with no write. This is what a user who never opens
  the TUI keeps.
- The **TUI performs the one-shot migration at the moment the user first edits a
  ceiling**: the writer materialises `agentContext` for every agent the cycler
  knows, from the values then in effect (own > flat/env > default), applies the
  step to the selected one, and deletes the flat `maxContext` key. The frozen
  map reproduces what was in effect, so nothing loosens or tightens
  (`stepPerAgentCeiling`, `tui/src/settings-file.ts:699-727`).

## 5. Enforcement

A tree-wide grep for `contextBudgetFor` across `src/` finds these readers: the
spawn package gate (`src/tools.js:144`), the reuse and retention gates
(`src/tools.js:1205`, `src/hooks.js:2179`), the `message` refusal
(`src/midrun.js:164`), a delegating subagent's limits block
(`src/hooks.js:1628`, `:1635`), the wake notices (`src/notices.js:103`, `:350`),
and the three points on the running subagent and its orchestrator:

1. `const maxContext = contextBudgetFor(entry.agent)` (`src/hooks.js:1128`)
   at the head of `contextLimitNotice(client, entry)` (`src/hooks.js:1127`).
   `0` disables (`src/hooks.js:1129`). The `ctxTokens == null` or
   pre-band guard is `entry.ctxTokens < maxContext * CTX_NEAR_BUDGET`
   (`src/hooks.js:1158`). The reserve-band open is
   `entry.ctxTokens < maxContext * CTX_STOP_RESERVE` (`src/hooks.js:1179`).
   The lockdown open is `entry.ctxTokens < maxContext` (`src/hooks.js:1215`).
   The constants are `CTX_NEAR_BUDGET = 0.7` and `CTX_STOP_RESERVE = 0.9`
   (`src/hooks.js:348,359`). The injected text prints the number that
   actually applied.
2. `const maxContext = contextBudgetFor(entry.agent)` (`src/hooks.js:2890`)
   at the head of the tool-call guard, which runs after
   `permissionGuard.checkToolPermission` (`src/hooks.js:2878-2889`). The
   hard-deny condition is
   `maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext`
   (`src/hooks.js:2891`). `MID_RUN_MESSAGING_TOOLS` is exempted
   (`src/hooks.js:2911-2920`).
3. The orchestrator-only `{{limits}}` block (§6).

`contextLimitNotice` has **three bands**: plan, reserve, lockdown, split by
`CTX_NEAR_BUDGET` and `CTX_STOP_RESERVE` (`src/hooks.js:1089-1101`).

- Plan band (`>= CTX_NEAR_BUDGET`, `< CTX_STOP_RESERVE`): denies nothing,
  demands nothing, names the room left and the reserve threshold in tokens,
  adds `resultCeilingPlan` (`src/prompts.js:427`). Counted in
  `entry.contextPlanNotices` (`src/hooks.js:1180`).
- Reserve band (`>= CTX_STOP_RESERVE`, `< budget`): tools still work, demands
  the `Done:` / `Blocked:` summary NOW while both the tools and the room
  remain, adds `resultCeilingDemand` (`src/prompts.js:463`). Counted in
  `entry.contextWarnings` (`src/hooks.js:1216`).
- Lockdown (`>= budget`): `guardToolExecute` denies every work tool, the block
  escalates over successive LLM turns and notifies the parent at
  `BUDGET_NOTIFY_AFTER = 3` (`src/hooks.js:372`); counted in
  `entry.stopInjections` (`src/hooks.js:1272`).

Every band re-fires on each crossing turn — the block rides on the
per-request copy of the message array and is never written back to the
session (`src/hooks.js:1118-1126`).

**Compaction instead of lockdown, when switched on for the type.** The
crossing buys a `client.session.summarize` instead of the lockdown, up to
`MAX_SUBAGENT_COMPACTIONS`; `startSubagentCompaction` (`src/compaction.js:210`,
called at `src/hooks.js:1255`) takes the decision and owns the latch. False
means the crossing is the lockdown's after all — switch off, cap spent, or a
question open. The reserve band is the same either way.

The subagent's notice rides in a **carrier message appended at the END of
the per-request array** (`isNoticeCarrier` / `tailNoticeCarrier`,
`src/hooks.js:838,859`), not on the last user message — which in a subagent
session is message 0. The primary's notice hangs off its own last user message
(`src/hooks.js:956-961`).

`denialLoopNotice` (`src/notices.js:607-616`) carries no budget, and
`recordPrimaryContext` (`src/hooks.js:480`) is a different setting.

## 6. The `{{limits}}` block

`formatLimitsNotice()` (`src/hooks.js:1472-1526`) lists the budget per spawnable
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
· grounder 100k (−8k fixed → 92k) · designer 100k (−8k fixed → 92k) · gitter off
· scout 100k (−10k fixed → 90k) · checker 100k (−10k fixed → 90k).
Per entry: the budget, the fixed overhead every spawn of that type carries
before your own words (subagent guides, PROJECT.md, the project snapshot the
plugin prepends, AGENTS.md where that type keeps it), and the headroom left of
the budget for your prompt text and the subagent's own work.
Use the budget — the first number of the agent you are spawning — in the
right-sized-chunks rule of the orchestration protocol above.
```

(The `showAgentcom` tail — "Subagent results and handoff messages are hidden
from the user's screen…" — is appended only while that setting is off.)

The list is built from `SPAWNABLE_ROLES` (`src/hooks.js:1490,1492`; the
`mode: "subagent"` roles of `AGENTS`, `src/agents.js:595-599`) mapped through
`contextBudgetFor` — the plugin's own roles, which are the ones the orchestrator
prompt tells it to spawn (`src/agents.js:49`). The block feeds the orchestrator
prompt only (`src/promptsfile.js:21,364,411`); `src/promptsfile.js:21,364`
document the placeholder as "current maxSubagents + per-agent context budgets".

## 7. TUI

**The per-agent ceiling sits behind an agent cycler that walks the full
role list (`AGENT_NAMES`, orchestrator included), in the LLM params
section, directly after the `effort` row and before `[reset current
agent]`, with the Subagents section carrying no agent cycler**
(`tui/src/tui.tsx:2603-2612`, `:2705-2739`):

```
  agent          [<]  coder        [>]
  max Token(k)   [-]   60          [+] ★
```

It is the pattern the panel runs for LLM params and for the per-agent model
(`tui/src/tui.tsx:2603-2673`) — same cycler, same `holdRepeat` steppers, same
`★` for "this agent's own value, not the inherited one"
(`tui/src/tui.tsx:2734-2736`), same read-modify-write store. `[-]` at the
type's own value stepping below zero **drops the entry** so the inherited
default shows again, the behaviour `stepLlmParam` has
(`tui/src/llm-params-file.ts:148-149`). `[reset current agent]`
(`tui/src/tui.tsx:2866-2871`) clears the agent's LLM params and model entry and
leaves the ceiling untouched.

The cycler walks `AGENT_NAMES` (`tui/src/agent-roles.ts:19-32`, `cycleLlmAgent` at
`tui/src/tui.tsx:776-780`), the plugin's own twelve roles with `orchestrator`
included; a project's own agents get no row.

The displayed value is the **effective** ceiling in thousands
(`effectiveAgentContext`, `tui/src/settings-file.ts:508`: own > flat/env >
built-in default), so a type with no entry reads its inherited value, never
`0`; `0` renders as `off` (`formatContextCeiling`, `tui/src/tui.tsx:353-355`),
as `maxSubagents` renders `unlimited` (`tui/src/tui.tsx:2313`). The writer is
`stepAgentContext` (`tui/src/settings-file.ts:734`) through the shared
`stepPerAgentCeiling` with the migration of §4; `agentContext` is a member of
the `Settings` interface (`tui/src/settings-file.ts:117-142`), so the
`SETTING_VALIDATORS` mapped type forces a validator for it
(`tui/src/settings-file.ts:341-365`).

A running subagent's row shows its context as `· <k> ctx`
(`tui/src/tui.tsx:2176-2179`), without the ceiling.

## 8. Agent types known at runtime

- Server: `AGENTS` (`src/agents.js:414-568`) — twelve roles: `orchestrator,
  planner, coder, debugger, reviewer, documenter, researcher, grounder,
  designer, gitter, scout, checker` — merged non-destructively into opencode's
  resolved config by `installAgents` (`src/agents.js:835-924`), where a project
  may add its own or override one. The `spawn` tool's gate reads
  `SPAWNABLE_ROLES` (`src/agents.js:595-599`), the eleven `mode: "subagent"`
  roles — the closed spawnable set is this plugin's own roles. `contextBudgetFor`
  keeps its unknown-name fallback of §2 for any read path that is not the spawn
  gate, and nothing is materialised on read.
- TUI: the live merged list from `api.client.app.agents({})`
  (`tui/src/tui.tsx:670`), whose records carry `name` and
  `mode: "subagent" | "primary" | "all"` (`@opencode-ai/sdk`
  `types.gen.d.ts:1399-1402`), feeds the resolved per-agent defaults
  (`refreshOpencodeDefaults`, `tui/src/tui.tsx:668-710`); the ceiling rows
  iterate the hardcoded `AGENT_NAMES`.
