// Translates a reasoning-effort choice into the provider option keys an
// AI-SDK provider package expects, for the `chat.params` hook to merge into
// `output.options`.
//
// Pure: no I/O, no state. The effort itself comes from
// `resolveEffortForAgent` (src/llmmodel.js), which reads it out of
// ~/.config/opencode/llm-models.json; the model comes from the hook input.
//
// The family key is the model's `api.npm` — the AI-SDK package name opencode
// reports on `Model.api` — not `providerID`, which a user-defined provider can
// name freely while still running one of these packages.
//
// One ladder (`low`/`medium`/`high`/`xhigh`/`off`) serves every family: no
// per-model value discovery, no numeric token budget. A model whose provider
// wants either is served by hand-editing llm-params.json, whose unknown keys
// ride through into `output.options` already. Two steps are not taken by every
// family — `xhigh`, which the google family's `thinkingLevel` vocabulary has no
// level for, and `off`, which only the openai-compatible family has an
// established form for — and a family without a form for the step it is given
// writes nothing, exactly as for a value it does not know.

// The ladder steps that mean an override. `default` is the absence of a
// value and never reaches this module.
const LADDER = new Set(["low", "medium", "high", "xhigh", "off"])

// The step that switches thinking off instead of choosing an amount of it. It
// is opt-in per model: the panel offers it only where the model's own
// `variants` map names it.
const OFF = "off"

// The steps the google family's `thinkingConfig.thinkingLevel` takes.
const THINKING_LEVELS = new Set(["low", "medium", "high"])

const thinkingConfig = (e) =>
  THINKING_LEVELS.has(e) ? { thinkingConfig: { thinkingLevel: e, includeThoughts: true } } : null

// The families that carry the step as a plain string under one key. `off` is
// not a value in those vocabularies, so they write nothing for it and the step
// reaches such a provider only through opencode's own variant merge.
const stringUnder = (key) => (e) => (e === OFF ? null : { [key]: e })

// The openai-compatible family — llama.cpp's llama-server among them — takes
// the amount of thinking as `reasoningEffort`, but switching thinking off runs
// through the chat template instead: a top-level effort of `none` falls back to
// `low` there, while `chat_template_kwargs: { enable_thinking: false }`
// suppresses thinking. That key rides through `output.options` into the request
// body like the other llama.cpp keys (src/llmparams.js).
const openaiCompatible = (e) =>
  e === OFF ? { chat_template_kwargs: { enable_thinking: false } } : { reasoningEffort: e }

// api.npm -> the patch for that family, built fresh per call so a caller
// mutating the returned object cannot alter the table. A family that has no
// key for the step it is given returns null, i.e. nothing is written.
const FAMILIES = {
  "@ai-sdk/openai": stringUnder("reasoningEffort"),
  "@ai-sdk/openai-compatible": openaiCompatible,
  "@ai-sdk/azure": stringUnder("reasoningEffort"),
  "@ai-sdk/xai": stringUnder("reasoningEffort"),
  "@ai-sdk/anthropic": stringUnder("effort"),
  "@ai-sdk/google-vertex-anthropic": stringUnder("effort"),
  "@ai-sdk/google": thinkingConfig,
  "@ai-sdk/google-vertex": thinkingConfig,
  "@openrouter/ai-sdk-provider": (e) => (e === OFF ? null : { reasoning: { effort: e } }),
}

// For an effort and the model of the request, the object to merge into
// `output.options` — or null, which means nothing is written at all.
//
// Null for: an effort outside the ladder (including null/`default`), a model
// that does not declare `capabilities.reasoning === true`, a missing model, a
// provider package the table does not name, and a step that family has no
// value for. Writing a key blindly for an unknown family would put an
// unrecognised field into that provider's request body, so silence is the
// answer there.
export function effortOptions(effort, model) {
  if (!LADDER.has(effort)) return null
  if (model?.capabilities?.reasoning !== true) return null
  const build = Object.hasOwn(FAMILIES, model?.api?.npm ?? "") ? FAMILIES[model.api.npm] : null
  return build ? build(effort) : null
}
