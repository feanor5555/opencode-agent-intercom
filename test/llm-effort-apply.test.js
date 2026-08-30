// Unit tests for the reasoning-effort half of the `chat.params` hook: the
// stored `variant` of ~/.config/opencode/llm-models.json reaching
// `output.options` through src/reasoningeffort.js.
//
// Two files meet in this hook. llm-params.json is the hand-edit escape hatch
// and has to win on any key both would write; llm-models.json only ever adds
// what the ladder allows. An agent with neither must leave the params output
// exactly as opencode handed it over — no `options` object brought into being.
//
// Run: node --test test/llm-effort-apply.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatParamsHook, setParamsPath, resetCache as resetParams } from "../src/llmparams.js"
import { setModelsPath, resetCache as resetModels } from "../src/llmmodel.js"

const dir = mkdtempSync(join(tmpdir(), "llm-effort-"))
const paramsFile = join(dir, "llm-params.json")
const modelsFile = join(dir, "llm-models.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(paramsFile, { force: true })
  rmSync(modelsFile, { force: true })
  setParamsPath(paramsFile)
  setModelsPath(modelsFile)
})

// Writing plus a cache drop, so a rewrite inside the same millisecond is still
// picked up.
function writeParams(obj) {
  writeFileSync(paramsFile, JSON.stringify(obj))
  resetParams()
}
function writeModels(obj) {
  writeFileSync(modelsFile, JSON.stringify(obj))
  resetModels()
}

// The model of the request, as `chat.params` hands it over.
function model(npm = "@ai-sdk/openai", reasoning = true) {
  return {
    id: "gpt-5",
    providerID: "openai",
    api: { id: "openai", url: "https://api.openai.invalid", npm },
    name: "GPT-5",
    capabilities: { reasoning, input: { image: true } },
  }
}

// What opencode hands the hook before any plugin touched it.
const freshOutput = () => ({ options: undefined })

test("a stored variant reaches output.options for an openai-family model", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.deepEqual(output.options, { reasoningEffort: "high" })
})

test("the model of the request decides the key, not the pair in the file", () => {
  // The file's pair is what the model hook applies; by the time chat.params
  // runs, `input.model` is the model actually resolved for the request.
  writeModels({ coder: { providerID: "google", modelID: "gemini-x", variant: "medium" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model("@ai-sdk/google") }, output)
  assert.deepEqual(output.options, {
    thinkingConfig: { thinkingLevel: "medium", includeThoughts: true },
  })
})

test("no stored variant writes nothing and creates no options object", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.equal(output.options, undefined)
})

test("no models file at all writes nothing", () => {
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.equal(output.options, undefined)
})

test("a non-reasoning model writes nothing even with a variant stored", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model("@ai-sdk/openai", false) }, output)
  assert.equal(output.options, undefined)
})

test("a variant outside the ladder in the file writes nothing", () => {
  // A hand-edited file must not be able to put an arbitrary string into a
  // provider request body.
  for (const variant of ["default", "ultra", "", "HIGH", 7, null]) {
    writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant } })
    const output = freshOutput()
    chatParamsHook({ agent: "coder", model: model() }, output)
    assert.equal(output.options, undefined, `variant ${String(variant)} must write nothing`)
  }
})

test("a key the params file already set is not overwritten by the patch", () => {
  writeParams({ coder: { reasoningEffort: "minimal" } })
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.deepEqual(output.options, { reasoningEffort: "minimal" })
})

test("the params file's other keys survive beside the effort", () => {
  writeParams({ coder: { temperature: 0.4, min_p: 0.05 } })
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "low" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.equal(output.temperature, 0.4)
  assert.deepEqual(output.options, { min_p: 0.05, reasoningEffort: "low" })
})

test("each agent is resolved on its own — no cross-agent fallback", () => {
  writeModels({ orchestrator: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const forCoder = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, forCoder)
  assert.equal(forCoder.options, undefined)
  const forOrchestrator = freshOutput()
  chatParamsHook({ agent: "orchestrator", model: model() }, forOrchestrator)
  assert.deepEqual(forOrchestrator.options, { reasoningEffort: "high" })
})

test("a request without a model, or without an agent, writes nothing", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const noModel = freshOutput()
  chatParamsHook({ agent: "coder" }, noModel)
  assert.equal(noModel.options, undefined)
  const noAgent = freshOutput()
  chatParamsHook({ model: model() }, noAgent)
  assert.equal(noAgent.options, undefined)
})

test("removing the variant returns the request to unset", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  const before = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, before)
  assert.deepEqual(before.options, { reasoningEffort: "high" })

  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const afterEdit = freshOutput()
  chatParamsHook({ agent: "coder", model: model() }, afterEdit)
  assert.equal(afterEdit.options, undefined)
})

test("an options object opencode already filled is added to, not replaced", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "low" } })
  const output = { options: { fromOpencode: 1 } }
  chatParamsHook({ agent: "coder", model: model() }, output)
  assert.deepEqual(output.options, { fromOpencode: 1, reasoningEffort: "low" })
})

test("a missing output does not throw", () => {
  writeParams({ coder: { temperature: 0.4 } })
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5", variant: "high" } })
  assert.doesNotThrow(() => chatParamsHook({ agent: "coder", model: model() }, undefined))
})
