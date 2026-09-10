// Unit tests for src/reasoningeffort.js — the table that turns a ladder step
// into the option keys one provider family understands.
//
// The module is the last gate before a key lands in a provider request body:
// every "no" case here (unknown package, model that cannot reason, effort
// outside the ladder, no model at all) has to come out as null, because null
// is what makes the hook write nothing rather than something the provider
// would reject.
//
// Run: node --test test/reasoning-effort.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { effortOptions } from "../src/reasoningeffort.js"

// A model as `chat.params` hands it over: the AI-SDK package name on
// `api.npm`, the capability block on `capabilities`.
function model(npm, reasoning = true) {
  return {
    id: "m-1",
    providerID: "whatever",
    api: { id: "a", url: "https://example.invalid", npm },
    name: "M One",
    capabilities: { reasoning, input: { image: false } },
  }
}

test("the openai family takes reasoningEffort", () => {
  for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/azure"]) {
    assert.deepEqual(effortOptions("high", model(npm)), { reasoningEffort: "high" }, npm)
  }
})

test("xai takes reasoningEffort", () => {
  assert.deepEqual(effortOptions("low", model("@ai-sdk/xai")), { reasoningEffort: "low" })
})

test("the anthropic family takes effort", () => {
  for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/google-vertex-anthropic"]) {
    assert.deepEqual(effortOptions("medium", model(npm)), { effort: "medium" }, npm)
  }
})

test("xhigh passes through for the families that pass a string through", () => {
  // The step is not in every model's vocabulary — the panel keeps it off the
  // ladder of a model whose `variants` do not name it — but where the family
  // carries a plain effort string, this module hands it over as any other step.
  for (const npm of [
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/azure",
    "@ai-sdk/xai",
  ]) {
    assert.deepEqual(effortOptions("xhigh", model(npm)), { reasoningEffort: "xhigh" }, npm)
  }
  for (const npm of ["@ai-sdk/anthropic", "@ai-sdk/google-vertex-anthropic"]) {
    assert.deepEqual(effortOptions("xhigh", model(npm)), { effort: "xhigh" }, npm)
  }
  assert.deepEqual(effortOptions("xhigh", model("@openrouter/ai-sdk-provider")), {
    reasoning: { effort: "xhigh" },
  })
})

test("the google family takes a thinkingConfig block", () => {
  for (const npm of ["@ai-sdk/google", "@ai-sdk/google-vertex"]) {
    assert.deepEqual(
      effortOptions("high", model(npm)),
      { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } },
      npm,
    )
  }
})

test("the google family writes nothing for xhigh", () => {
  // `thinkingConfig.thinkingLevel` has low/medium/high and no step above them;
  // sending "xhigh" there would be a value the provider rejects, so the family
  // stays silent for it exactly as for a value it does not know.
  for (const npm of ["@ai-sdk/google", "@ai-sdk/google-vertex"]) {
    assert.equal(effortOptions("xhigh", model(npm)), null, npm)
  }
})

test("openrouter takes a nested reasoning block", () => {
  assert.deepEqual(effortOptions("low", model("@openrouter/ai-sdk-provider")), {
    reasoning: { effort: "low" },
  })
})

test("every ladder step that names an amount reaches the patch unchanged", () => {
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    assert.deepEqual(effortOptions(effort, model("@ai-sdk/openai")), { reasoningEffort: effort })
    assert.deepEqual(effortOptions(effort, model("@ai-sdk/openai-compatible")), {
      reasoningEffort: effort,
    })
  }
})

test("off switches thinking off through the chat template, openai-compatible only", () => {
  // llama-server takes the amount of thinking as reasoningEffort but does not
  // switch it off through that key — a top-level effort of "none" falls back
  // to low there. `chat_template_kwargs` is the key that suppresses it, and it
  // rides through output.options into the request body.
  assert.deepEqual(effortOptions("off", model("@ai-sdk/openai-compatible")), {
    chat_template_kwargs: { enable_thinking: false },
  })
  // No amount of thinking is named alongside it.
  assert.equal(
    "reasoningEffort" in effortOptions("off", model("@ai-sdk/openai-compatible")),
    false,
  )
})

test("off writes nothing for every other family", () => {
  // "off" is not a value in reasoningEffort / effort / reasoning.effort /
  // thinkingLevel; sending it there would be a string those providers reject.
  // The step reaches such a provider through opencode's own variant merge
  // alone, and only where the model's `variants` map named it in the first
  // place.
  for (const npm of [
    "@ai-sdk/openai",
    "@ai-sdk/azure",
    "@ai-sdk/xai",
    "@ai-sdk/anthropic",
    "@ai-sdk/google-vertex-anthropic",
    "@ai-sdk/google",
    "@ai-sdk/google-vertex",
    "@openrouter/ai-sdk-provider",
  ]) {
    assert.equal(effortOptions("off", model(npm)), null, npm)
  }
})

test("off is refused where any other step would be", () => {
  // The step is still gated on the model: no reasoning capability, no model,
  // an unknown package.
  assert.equal(effortOptions("off", model("@ai-sdk/openai-compatible", false)), null)
  assert.equal(effortOptions("off", model("@ai-sdk/mistral")), null)
  assert.equal(effortOptions("off", null), null)
})

test("an unknown provider package writes nothing", () => {
  // Not a guess at a key name: a family whose option shape we have not
  // established sends no field at all.
  assert.equal(effortOptions("high", model("@ai-sdk/mistral")), null)
  assert.equal(effortOptions("high", model("")), null)
  assert.equal(effortOptions("high", { capabilities: { reasoning: true } }), null)
  assert.equal(effortOptions("high", { capabilities: { reasoning: true }, api: {} }), null)
})

test("a model that does not declare reasoning writes nothing", () => {
  assert.equal(effortOptions("high", model("@ai-sdk/openai", false)), null)
  // absent block, and a truthy non-true value: the test is strict === true
  assert.equal(effortOptions("high", { api: { npm: "@ai-sdk/openai" } }), null)
  assert.equal(
    effortOptions("high", { api: { npm: "@ai-sdk/openai" }, capabilities: { reasoning: "yes" } }),
    null,
  )
})

test("an effort outside the ladder writes nothing", () => {
  for (const effort of ["default", "none", "minimal", "HIGH", "XHIGH", "xxhigh", "", 3, null, undefined]) {
    assert.equal(effortOptions(effort, model("@ai-sdk/openai")), null, String(effort))
  }
})

test("a missing model writes nothing", () => {
  assert.equal(effortOptions("high", undefined), null)
  assert.equal(effortOptions("high", null), null)
})

test("each call returns a fresh object the caller may mutate", () => {
  // The hook merges the patch into output.options and callers hold on to
  // neither; a shared table object would leak one request's edit into the next.
  const first = effortOptions("high", model("@ai-sdk/google"))
  first.thinkingConfig.thinkingLevel = "tampered"
  const second = effortOptions("high", model("@ai-sdk/google"))
  assert.deepEqual(second, { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } })
})

test("the off patch is a fresh nested object too", () => {
  const first = effortOptions("off", model("@ai-sdk/openai-compatible"))
  first.chat_template_kwargs.enable_thinking = true
  const second = effortOptions("off", model("@ai-sdk/openai-compatible"))
  assert.deepEqual(second, { chat_template_kwargs: { enable_thinking: false } })
})
