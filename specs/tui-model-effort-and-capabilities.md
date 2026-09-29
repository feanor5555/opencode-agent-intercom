# TUI: reasoning effort and model capability badges

The sidebar's LLM-params section shows, per agent, the model's vision and reasoning
capability as two ASCII badge columns, and carries an `effort` row that sets the
reasoning effort for agents whose model supports it. The chosen effort is stored
alongside the model choice and travels three ways: `applyModelChoices` writes it
into `config.agent[<name>].variant`, which is what actually reaches the
provider for the families opencode's own `variants` map covers;
`chatParamsHook` writes the provider option for the families it does not;
and `applyModelChoices` additionally seeds opencode's own variant store at
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json` under its
`variant` map, keyed `"<providerID>/<modelID>"`, so opencode's TUI shows
the active variant in a freshly started session.

## 1. Capability metadata kept from `/config/providers`

`refreshModelChoices` (`tui/src/tui.tsx:724-772`) reads the response through a
structural cast that names `id`, `providerID`, `name`, the capability block and
the `variants` map (`tui/src/tui.tsx:727-740`):

```ts
models?: Record<string, {
  id?: string; providerID?: string; name?: string;
  capabilities?: { reasoning?: boolean; input?: { image?: boolean } };
  variants?: Record<string, unknown>;
}>;
```

`ModelChoice` (`tui/src/tui.tsx:204-209`) carries two booleans, filled with a
strict `=== true` test so a missing block reads as `false`, and one nullable
field filled by `variantNames` (`tui/src/tui.tsx:214-216`) — the keys of the
model's `variants` map, or null where the provider list reports no such map (an
unknown list, not an empty one):

```ts
interface ModelChoice extends ModelRef {
  label: string;
  vision: boolean;    // m.capabilities?.input?.image === true
  reasoning: boolean; // m.capabilities?.reasoning === true
  variants: string[] | null; // Object.keys(m.variants) or null
}
```

Nothing else is kept. `cost`, `limit`, `toolcall`, `attachment`, `status`,
`release_date`, `options` and `headers` are dropped.

The list is sorted by provider, then label (`tui/src/tui.tsx:764-767`), and
re-fetched every 60 s (`tui/src/tui.tsx:774`).

## 2. Model row: badge columns

The model row (`tui/src/tui.tsx:2644-2673`) renders

```
  model          [<] grok 4.6     [>] ★ VR
```

**The ★ slot is fixed-width.** It is an unconditional two-column `<text>` holding
`" ★"` or `"  "` (`tui/src/tui.tsx:2667-2669`), so the badge field to its right never
shifts sideways. The colour is `theme.success`.

**A badge cell follows it**: one leading space and two fixed columns, rendered as
two separate `<text>` nodes so each carries its own colour.

| column | `V` | `R` |
|---|---|---|
| resolved model found in `modelChoices()`, capability present | `V` | `R` |
| resolved model found, capability absent | `-` | `-` |
| resolved model not in the pick list | `?` | `?` |
| no resolved model (`not set`) | space | space |

Present badges are `theme.success`, `-` and `?` are `theme.textMuted`. The letter
carries the meaning; the colour only reinforces it, so the row reads correctly
with colour off. All four glyphs are ASCII and survive a terminal without
Unicode.

The model row is itself the selection surface — `[<]`/`[>]` cycle the pick list in
place (`cycleModel`, `tui/src/tui.tsx:816-818`) — so the badges describe the model
currently under the cursor and no separate dialog is needed.

The model name is formatted by `formatLlmModel` (`tui/src/tui.tsx:295-298`) and
cut to 12 columns by `fitCell(..., MODEL_NAME_W)` (`tui/src/tui.tsx:193-194`,
`:186`); the badges sit outside the name cell and cost the row three columns.
The row is the widest in the section at 42 columns (2 indent + 15 label + 3 +
14 + 3 + 2 + 3); the section does not wrap to `panelWidth`
(`tui/src/tui.tsx:2033-2038`).

The subagent list rows (`tui/src/subagent-label.ts`) name the model alone (`subagentModel`, `tui/src/subagent-label.ts:311-321`, `MODEL_MAX_W = 12`
at `:62`) and carry no badges and no effort.

## 3. The `effort` row

The row sits directly under the model row and above the `max Token(k)`,
`reuse Token(k)` and `result Token` ceiling rows
(`tui/src/tui.tsx:2679-2701`), built like the model row: label `effort`,
`[<]`/`[>]` with `holdRepeat`, value in `fitCell(..., MODEL_NAME_W)` so the agent,
model and effort rows line their buttons up, and a fixed-width ★ column for a
stored effort.

**Value set — a per-model ladder built from the model's `variants` map:**

The row's widest ladder, used when no model is resolved, is
`default → low → medium → high → xhigh → off` — `default` is the absence of a
stored value and stands in front of the five override steps in cycle order,
`off` is not an amount of thinking but its absence and stands at the end. For a
resolved model, the row offers `default` plus every override step the model
declares as a key in its `variants` map:

- a model that reports no `variants` key at all (null) falls back to the
  assumed steps `low`/`medium`/`high` — the steps every mapped provider family
  takes, so the row still cycles on a model the provider list describes
  without enumerating effort values. `xhigh` and `off` are never assumed;
- a model that reports a `variants` map with at least one of `low`, `medium`,
  `high`, `xhigh`, `off` as a key offers exactly that subset, in cycle order;
- a model whose `variants` map is empty, or whose
  `capabilities.reasoning !== true`, makes the row inert.

`effortLadderFor(supported)` (`tui/src/llm-models-file.ts:56-64`) is what
produces this. The ladder a model carries is then `["default", ...steps]`,
prepended with `default` so it can always be cycled to. `default` means no
override: the entry carries no `variant` and the model's own default effort
stands. There is no numeric budget-token control; a model whose provider wants
a token budget or an exotic effort name is served by hand-editing
`llm-params.json`, whose unknown keys ride through into `output.options`
(`src/llmparams.js:114-116`).

**What the cell shows,** resolved on the priority the other rows use:

1. the `variant` stored for this agent → shown as it stands;
2. otherwise the effort opencode resolved for this agent → shown in parentheses and muted;
3. otherwise `default`.

**When the model cannot do it:** the resolved model is in the pick list with
`reasoning === false` → the cell shows `n/a`, and `[<]`/`[>]` render in
`theme.textMuted`; their handlers remain wired, but the action's `live` gate
makes them inert. The resolved model is in the pick list with
`reasoning === true` but its `variants` map is empty → the same `n/a` and
inert buttons, since `effortLadderFor([])` returns just `["default"]` and the
cycle has nothing to step to. The resolved model is not in the pick list, or
there is none → the cell shows the stored `variant` where one is stored and
`n/a` otherwise, with the same always-wired, in-action guard. A stale or
hand-written choice stays visible rather than turning silently into `default`.

**The inherited effort** comes from the signal
`opencodeEfforts: Record<string, string>` (`tui/src/tui.tsx:667`), filled in `refreshOpencodeDefaults`
(`tui/src/tui.tsx:668-710`) from each agent's `options` map — `Agent.options` is
`{ [key: string]: unknown }` in the SDK type the TUI compiles against. The probe
takes the first string it finds, lowercased, in this order:
`reasoningEffort`, `effort`, `reasoning.effort`, `thinkingConfig.thinkingLevel`.
It is a signal of its own beside `OpencodeDefaults`
(`tui/src/tui.tsx:257`), which is typed to numbers.

**Setting an effort pins the model.** Where the row's model came from opencode
rather than the file, stepping the effort writes the full entry
`{ providerID, modelID, variant }`, so the model row shows its `★` from the same
step on. Both rows then describe one file entry.

**Changing the model drops the effort.** `setLlmModel`
(`tui/src/llm-models-file.ts:157-167`) and `cycleLlmModel` (`:175-197`)
assign a fresh object to `models[agent]`, so no `variant` outlives the model it
was chosen for.

**Store helpers** in `tui/src/llm-models-file.ts`, same read-modify-write
shape as their neighbours:

```ts
export const EFFORT_LADDER = ["default", "low", "medium", "high", "xhigh", "off"] as const;
export function effortLadderFor(supported: readonly string[] | null | undefined): EffortValue[];
export function cycleLlmVariant(agent: string, delta: number, model: ModelRef, ladder?: readonly EffortValue[]): LlmModels;
```

`EFFORT_LADDER` is the widest ladder — `default` plus the five override steps —
and is what the row walks for an agent with no resolved model. `effortLadderFor`
takes the key list of the resolved model's `variants` map (or null) and returns
`["default", ...steps]` filtered to those steps the model declares; null falls
back to the assumed `low`/`medium`/`high`, which carries neither `xhigh` nor
`off`. `cycleLlmVariant` takes the ladder
explicitly so the caller — `cycleEffort` (`tui/src/tui.tsx:828-834`) — passes
the one `effortLadderFor` produced for the resolved model. It steps from the
position the file holds at this moment, so an outside edit is stepped from
rather than overwritten. Landing on `default` deletes only the `variant` key
and leaves `{ providerID, modelID }` in place; landing anywhere else writes
`models[agent] = { ...model, variant }`, materialising the pair from the
resolved model where the agent had no entry. `resetLlmAgent`
(`tui/src/tui.tsx:849-856`) drops the whole entry, effort included.

## 4. Persistence

`~/.config/opencode/llm-models.json` holds one entry per agent: the model pair
plus one optional `variant` key. There is no version key.

```jsonc
{ "researcher": { "providerID": "xai", "modelID": "grok-4-6", "variant": "high" } }
```

In `tui/src/llm-models-file.ts`:

- `ModelRef` (`:24-27`) is the pure pair, and `sameModel` (`:103-104`)
  compares only the pair, so an effort never affects model matching in the
  cycler.
- `export interface ModelEntry extends ModelRef { variant?: string }` (`:82`),
  and `LlmModels = Record<string, ModelEntry>` (`:86`).
- `isModelRef` (`:93-101`) gates on `providerID` + `modelID`.
- `filterModels` (`:117-127`) copies `variant` through only when it is a member of
  `EFFORT_LADDER` other than `default`, and drops it otherwise. A file
  without `variant`, and a file with a nonsense `variant`, both read as a plain
  pair; the next write persists the cleanup, as it does for a half-entry.

Server side, `src/llmmodel.js` mirrors this: `resolveModelForAgent` (`:91-98`)
returns the bare pair, and `resolveEffortForAgent` (`:116`) reads the effort off
the same mtime-keyed cache (`:65-82`):

```js
export function resolveEffortForAgent(agent)   // -> "low" | "medium" | "high" | "xhigh" | "off" | null
```

It returns null for anything not in that set, so a hand-edited file cannot put
an arbitrary string into a request. `xhigh` and `off` are not offered by every
model; the panel keeps a step off the ladder of a model that does not name it,
and a model that is sent it anyway rejects it as it would any effort it does
not take.

## 5. How the effort reaches the model call

The effort chosen in the sidebar is stored as the optional `variant` on the
entry in `~/.config/opencode/llm-models.json`, and from there it travels three
ways:

- **Native variant** — opencode models a per-agent variant:
  `config.agent[<name>].variant` exists on the resolved config, and
  `applyModelChoices` (`src/llmmodel.js`) writes the stored effort there —
  deleting the key for an absent or `default` effort — so opencode itself
  resolves it for the request. This is what actually reaches the provider
  for the families opencode's own `variants` map covers.

- **`chat.params` hook** — `chatParamsHook` (`src/llmparams.js`) translates the
  effort into the provider family's own option key and writes it through
  `output.options`, via `src/reasoningeffort.js`. This is the route that
  covers provider families opencode's own `variants` map does not. `off` is
  the one step that is not an effort string: `@ai-sdk/openai-compatible` gets
  `chat_template_kwargs: { enable_thinking: false }` and no `reasoningEffort`,
  because a top-level effort of `none` does not switch llama-server's thinking
  off while the chat-template switch does; every other family has no
  established form for it and writes nothing, so `off` reaches such a provider
  through the native variant alone.

- **opencode's variant store** — `applyModelChoices` also calls
  `saveModelVariants` (`src/variantstore.js`) to seed opencode's own variant
  store at `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json`,
  under its `variant` map, keyed `"<providerID>/<modelID>"`. The TUI seeds a
  fresh session's variant from that store; it never reads
  `config.agent[<name>].variant`. That store is keyed per model, so its
  entry takes the effort of the visible primary agent
  (`mode === "primary"` and not `hidden`; `default_agent` wins where two
  visible primaries share a model). Every ladder step goes in under its own
  name, `off` included — the panel offers a step only against a model whose
  own `variants` map declares it, so the name is one opencode's TUI resolves
  for that model. A `default`, absent or out-of-ladder effort writes
  `DEFAULT_VARIANT = "default"`. Writes are atomic
  (temp file + rename in the same directory); a store that does not parse
  is left untouched; `saveModelVariants` is wrapped in a try/catch so every
  failure is swallowed and a load of the plugin cannot break.

`UserMessage` and the `chat.message` hook output carry no `variant` field,
so the message hook does not write one; the input side of `chat.message`
does expose `variant?: string`, which the plugin reads but cannot set.

## 6. Tests

- `test/reasoning-effort.test.js` — `effortOptions`: one case per family row of
  §5, `off` through the chat template for `@ai-sdk/openai-compatible` only;
  unknown `api.npm` → nothing; `capabilities.reasoning === false` → nothing; an
  effort outside the ladder → nothing; a missing `model` → nothing.
- `test/llm-effort-apply.test.js` — the hook: a stored `variant` reaches
  `output.options.reasoningEffort` for an openai-family model; no stored variant
  writes nothing; a non-reasoning model writes nothing; a key the params file
  already set is not overwritten by the patch; a `variant` outside the ladder in
  the file writes nothing.
- `test/tui-llm-models-write.test.js` — a model write stores the pair and no
  `variant` (`"only the pair is stored, not the label the pick list carries"`,
  `:104`; `"only the pair is stored when the cycle lands on a pick-list entry"`,
  `:181`); the ladder per model; `cycleLlmVariant` steps from the file's value
  rather than the caller's; landing on `default` deletes only `variant` and
  keeps the pair; setting an effort on an agent with no entry materialises the
  pair from the resolved model; a following model cycle drops the `variant`; a
  nonsense `variant` in the file is dropped by the write that merges over it.
- `test/llmmodel.test.js` — `resolveModelForAgent` returns the pair unchanged
  when a `variant` sits beside it (`:363`).
- `test/llmparams.test.js` — the setup points `setModelsPath` at an empty temp
  file, so the effort merge is inert for the parameter cases and
  `"llama.cpp keys and unknown keys ride through output.options"` (`:123`)
  asserts its exact `output.options`.

The TUI tests under `test/` are store tests (`tui-llm-models-write`,
`tui-subagent-store`) and the panel has no render harness. The rows and badges
are verified optically, by a screenshot of the sidebar with the LLM section
expanded.

## 7. What the feature relies on in opencode

- **`/config/providers` reports capabilities per model** — the SDK type
  `Model.capabilities.{reasoning, input.image}`. Where the running opencode does
  not serialise that block, the badges read `--` everywhere and the effort row
  is inert; nothing else breaks.
- **The AI-SDK provider packages accept the §5 keys passed through
  `output.options`.** The captured request body (`captureParams`,
  `src/index.js:344-348`) shows whether a key reached the provider; the key per
  family is one table row in `src/reasoningeffort.js`.
- **`app.agents()` exposes a project-set effort in the agent's `options` map.**
  Where it does not, the effort row shows `default` for such an agent until the
  user sets a value; setting still works.
