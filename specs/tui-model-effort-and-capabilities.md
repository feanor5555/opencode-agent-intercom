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

`refreshModelChoices` (`tui/src/tui.tsx:451-476`) reads the response through a
structural cast that today names only `id`, `providerID`, `name`
(`tui/src/tui.tsx:452-456`). The cast gains one nested block:

```ts
models?: Record<string, {
  id?: string; providerID?: string; name?: string;
  capabilities?: { reasoning?: boolean; input?: { image?: boolean } };
}>;
```

`ModelChoice` (`tui/src/tui.tsx:137-139`) gains two booleans, filled with a strict
`=== true` test so a missing block reads as `false`:

```ts
interface ModelChoice extends ModelRef {
  label: string;
  vision: boolean;    // m.capabilities?.input?.image === true
  reasoning: boolean; // m.capabilities?.reasoning === true
}
```

Nothing else is kept. `cost`, `limit`, `toolcall`, `attachment`, `status`,
`release_date`, `options` and `headers` stay dropped.

`variants` is read. The cast gains one nested block:

```ts
models?: Record<string, {
  id?: string; providerID?: string; name?: string;
  capabilities?: { reasoning?: boolean; input?: { image?: boolean } };
  variants?: Record<string, unknown>;
}>;
```

`ModelChoice` (`tui/src/tui.tsx:157-162`) gains one nullable field, filled by
`variantNames` (`tui/src/tui.tsx:167-169`) — the keys of the model's `variants`
map, or null where the provider list reports no such map (an unknown list, not
an empty one):

```ts
interface ModelChoice extends ModelRef {
  label: string;
  vision: boolean;    // m.capabilities?.input?.image === true
  reasoning: boolean; // m.capabilities?.reasoning === true
  variants: string[] | null; // Object.keys(m.variants) or null
}
```

Nothing else is kept. `cost`, `limit`, `toolcall`, `attachment`, `status`,
`release_date`, `options` and `headers` stay dropped.

Sorting (`tui/src/tui.tsx:468-471`) and the 60 s poll (`tui/src/tui.tsx:478`) are
unchanged.

## 2. Model row: badge columns

The model row (`tui/src/tui.tsx:1820-1846`) renders

```
  model          [<] grok 4.6     [>] ★ VR
```

Two changes to that row:

**The ★ slot becomes fixed-width.** Today it is a `<Show when={source === "agent"}>`
wrapping `" ★"` (`tui/src/tui.tsx:1841-1843`). It becomes an unconditional
two-column `<text>` holding `" ★"` or `"  "`, so the badge field to its right never
shifts sideways. The colour stays `theme.success`.

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
place (`cycleModel`, `tui/src/tui.tsx:522-524`) — so the badges describe the model
currently under the cursor and requirement (c) needs no separate dialog.

`formatLlmModel` (`tui/src/tui.tsx:199-202`) and the 12-column cut
`fitCell(..., MODEL_NAME_W)` (`tui/src/tui.tsx:126-135`) are unchanged: the badges
sit outside the name cell and cost the row three columns. The row becomes the
widest in the section at 42 columns (2 indent + 15 label + 3 + 14 + 3 + 2 + 3);
the section does not wrap to `panelWidth` (`tui/src/tui.tsx:1396-1402`) and needs
no other adjustment.

`tui/src/subagent-label.ts` is untouched: the subagent list rows keep naming the
model alone (`subagentModel`, `tui/src/subagent-label.ts:270-298`, `MODEL_MAX_W = 12`
at `:62`) and carry no badges and no effort.

## 3. The `effort` row

A new row directly under the model row and above `[reset current agent]`
(`tui/src/tui.tsx:1847-1852`), built like the model row: label `effort`,
`[<]`/`[>]` with `holdRepeat`, value in `fitCell(..., MODEL_NAME_W)` so the agent,
model and effort rows line their buttons up.

**Value set — a per-model ladder built from the model's `variants` map:**

The row's widest ladder, used when no model is resolved, is
`default → low → medium → high → xhigh` — `default` is the absence of a stored
value and stands in front of the four override steps in cycle order. For a
resolved model, the row offers `default` plus every override step the model
declares as a key in its `variants` map:

- a model that reports no `variants` key at all (null) falls back to the
  assumed steps `low`/`medium`/`high` — the steps every mapped provider family
  takes, so the row still cycles on a model the provider list describes
  without enumerating effort values;
- a model that reports a `variants` map with at least one of `low`, `medium`,
  `high`, `xhigh` as a key offers exactly that subset, in cycle order;
- a model whose `variants` map is empty, or whose
  `capabilities.reasoning !== true`, makes the row inert.

`effortLadderFor(supported)` (`tui/src/llm-models-file.ts:52-60`) is what
produces this. The ladder a model carries is then `["default", ...steps]`,
prepended with `default` so it can always be cycled to. `default` means no
override: the entry carries no `variant` and the model's own default effort
stands. There is no numeric budget-token control; a model whose provider wants
a token budget or an exotic effort name is served by hand-editing
`llm-params.json`, whose unknown keys already ride through into `output.options`
(`src/llmparams.js:85-89`).

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

**The inherited effort** comes from a new signal
`opencodeEfforts: Record<string, string>`, filled in `refreshOpencodeDefaults`
(`tui/src/tui.tsx:399-436`) from each agent's `options` map — `Agent.options` is
`{ [key: string]: unknown }` in the SDK type the TUI compiles against. The probe
takes the first string it finds, lowercased, in this order:
`reasoningEffort`, `effort`, `reasoning.effort`, `thinkingConfig.thinkingLevel`.
It is a separate signal rather than a widening of `OpencodeDefaults`
(`tui/src/tui.tsx:158`), which is typed to numbers.

**Setting an effort pins the model.** Where the row's model came from opencode
rather than the file, stepping the effort writes the full entry
`{ providerID, modelID, variant }`, so the model row gains its `★` in the same
step. Both rows then describe one file entry.

**Changing the model drops the effort.** `setLlmModel`
(`tui/src/llm-models-file.ts:89-99`) and `cycleLlmModel` (`:107-129`) already
assign a fresh object to `models[agent]`; keeping that assignment as it stands
means no `variant` can outlive the model it was chosen for. No validation code is
added anywhere for this.

**Store helper**, new in `tui/src/llm-models-file.ts`, same read-modify-write
shape as its neighbours:

```ts
export const EFFORT_LADDER = ["default", "low", "medium", "high", "xhigh"] as const;
export function effortLadderFor(supported: readonly string[] | null | undefined): EffortValue[];
export function cycleLlmVariant(agent: string, delta: number, model: ModelRef, ladder?: readonly EffortValue[]): LlmModels;
```

`EFFORT_LADDER` is the widest ladder — `default` plus the four override steps —
and is what the row walks for an agent with no resolved model. `effortLadderFor`
takes the key list of the resolved model's `variants` map (or null) and returns
`["default", ...steps]` filtered to those steps the model declares; null falls
back to the assumed `low`/`medium`/`high`. `cycleLlmVariant` takes the ladder
explicitly so the caller — `cycleEffort` (`tui/src/tui.tsx:676-682`) — passes
the one `effortLadderFor` produced for the resolved model. It steps from the
position the file holds at this moment, so an outside edit is stepped from
rather than overwritten. Landing on `default` deletes only the `variant` key
and leaves `{ providerID, modelID }` in place; landing anywhere else writes
`models[agent] = { ...model, variant }`, materialising the pair from the
resolved model where the agent had no entry. `resetLlmAgent`
(`tui/src/tui.tsx:697-703`) needs no change: it drops the whole entry.

## 4. Persistence

`~/.config/opencode/llm-models.json` keeps its shape and gains one optional key
per entry. No new file, no version key, no migration.

```jsonc
{ "researcher": { "providerID": "xai", "modelID": "grok-4-6", "variant": "high" } }
```

In `tui/src/llm-models-file.ts`:

- `ModelRef` (`:24-29`) stays the pure pair, and `sameModel` (`:38-39`) keeps
  comparing only the pair, so an effort never affects model matching in the
  cycler.
- new `export interface ModelEntry extends ModelRef { variant?: string }`, and
  `LlmModels = Record<string, ModelEntry>`.
- `isModelRef` (`:31-36`) is unchanged: the gate stays `providerID` + `modelID`.
- `filterModels` (`:53-59`) copies `variant` through only when it is a member of
  `EFFORT_LADDER` other than `default`, and drops it otherwise. An old file
  without `variant`, and a file with a nonsense `variant`, both read as a plain
  pair; the next write persists the cleanup, exactly as it does for a half-entry
  today.

Server side, `src/llmmodel.js` mirrors this: `resolveModelForAgent` (`:76-83`)
keeps returning the bare pair, and a sibling reads the effort off the same
mtime-keyed cache (`:54-68`):

```js
export function resolveEffortForAgent(agent)   // -> "low" | "medium" | "high" | "xhigh" | null
```

It returns null for anything not in that set, so a hand-edited file cannot put
an arbitrary string into a request. `xhigh` is not offered by every model; the
panel keeps it off the ladder of a model that does not name it, and a model
that is sent it anyway rejects it as it would any effort it does not take.

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
  covers provider families opencode's own `variants` map does not.

- **opencode's variant store** — `applyModelChoices` also calls
  `saveModelVariants` (`src/variantstore.js`) to seed opencode's own variant
  store at `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json`,
  under its `variant` map, keyed `"<providerID>/<modelID>"`. The TUI seeds a
  fresh session's variant from that store; it never reads
  `config.agent[<name>].variant`. That store is keyed per model, so its
  entry takes the effort of the visible primary agent
  (`mode === "primary"` and not `hidden`; `default_agent` wins where two
  visible primaries share a model). A `default`, absent or out-of-ladder
  effort writes `DEFAULT_VARIANT = "default"`. Writes are atomic
  (temp file + rename in the same directory); a store that does not parse
  is left untouched; `saveModelVariants` is wrapped in a try/catch so every
  failure is swallowed and a load of the plugin cannot break.

`UserMessage` and the `chat.message` hook output carry no `variant` field,
so the message hook does not write one; the input side of `chat.message`
does expose `variant?: string`, which the plugin reads but cannot set.



## 6. Tests

Touched under `test/`:

- `test/tui-llm-models-write.test.js` — `"only the pair is stored, not the label the pick list carries"` (`:100`)
  and `"only the pair is stored when the cycle lands on a pick-list entry"` (`:176`)
  assert the exact stored entry; they keep asserting that a model write stores no
  `variant`.
- `test/llmmodel.test.js` — the `resolveModelForAgent` block (`:55-135`) keeps
  proving the pair is returned unchanged when a `variant` sits beside it.
- `test/llmparams.test.js` — the setup now also points `setModelsPath` at an empty
  temp file, so the effort merge is inert for the existing cases and
  `"llama.cpp keys and unknown keys ride through output.options"` (`:114`) keeps
  its exact `output.options`.
- `test/plugin.test.js` — asserts the hook surface; unchanged in content, checked
  because it imports the same modules.

New:

- `test/reasoning-effort.test.js` — `effortOptions`: one case per family row of
  §5; unknown `api.npm` → null; `capabilities.reasoning === false` → null; an
  effort outside the ladder → null; a missing `model` → null.
- `test/llm-effort-apply.test.js` — the hook: a stored `variant` reaches
  `output.options.reasoningEffort` for an openai-family model; no stored variant
  writes nothing; a non-reasoning model writes nothing; a key the params file
  already set is not overwritten by the patch; a `variant` outside the ladder in
  the file writes nothing.
- `test/tui-llm-models-write.test.js`, added cases — `cycleLlmVariant` steps from
  the file's value rather than the caller's; landing on `default` deletes only
  `variant` and keeps the pair; setting an effort on an agent with no entry
  materialises the pair from the resolved model; a following model cycle drops
  the `variant`; a nonsense `variant` in the file is dropped by the write that
  merges over it.

No render test is added: the TUI tests under `test/` are store tests
(`tui-llm-models-write`, `tui-subagent-store`) and the panel has no render
harness. The rows and badges are verified optically, by a screenshot of the
sidebar with the LLM section expanded.

## 7. Build order

Each step leaves `npm run check` and `npm test` green.

1. **File shape and server read.** `ModelEntry` + `variant` filtering in
   `tui/src/llm-models-file.ts`; `resolveEffortForAgent` in `src/llmmodel.js`;
   the touched cases of `test/tui-llm-models-write.test.js` and
   `test/llmmodel.test.js`. Depends on nothing.
2. **Effort application.** `src/reasoningeffort.js`, the merge at the end of
   `chatParamsHook`, `test/reasoning-effort.test.js`,
   `test/llm-effort-apply.test.js`, the `setModelsPath` setup in
   `test/llmparams.test.js`. Depends on step 1 for `resolveEffortForAgent`.
   After this step the feature works end to end by hand-editing the file.
3. **Badges.** The capability fields in `refreshModelChoices`, the fixed-width ★
   slot and the badge cell on the model row. Depends on nothing; independent of
   1 and 2.
4. **Effort row.** `EFFORT_LADDER` and `cycleLlmVariant` in
   `tui/src/llm-models-file.ts`, the `opencodeEfforts` signal, the row itself and
   its added store cases. Depends on 1 and 3 (`reasoning` on `ModelChoice` decides
   whether the row is live).

## 8. Assumptions

- **A1 — `/config/providers` reports capabilities per model.** Taken from the
  generated SDK type `Model.capabilities.{reasoning, input.image}`, not from a
  live response. Holds if the running opencode serialises that block. Shown
  wrong by the badge cell reading `--` for a model that is known to take images.
  Consequence if wrong: badges read `--` everywhere and the effort row is inert;
  nothing else breaks.
- **A2 — the AI-SDK provider packages accept the §5 keys passed through
  `output.options`.** Taken from opencode's provider-option lowering as
  documented, not from a request of ours. Shown wrong by a provider rejecting the
  first request after an effort is set, or by the captured request body
  (`captureParams`, `src/index.js:196-200`) not carrying the key. Consequence if
  wrong: the key is corrected in one table row in `src/reasoningeffort.js`.
- **A3 — `app.agents()` exposes a project-set effort in the agent's `options`
  map.** Shown wrong by the effort row reading `default` for an agent whose
  `opencode.json` sets `reasoningEffort`. Consequence if wrong: the row shows
  `default` until the user sets a value; setting still works.
