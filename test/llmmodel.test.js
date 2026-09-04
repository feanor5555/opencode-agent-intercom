// Unit tests for the two hooks in src/llmmodel.js: `chat.message`
// (chatMessageHook) and the `config` half (applyModelChoices).
//
// Together they are the only places a user-chosen model enters a request. An
// agent the user has not chosen a model for must come out of either untouched
// — neither may invent, blank or reshape the model opencode resolved.
//
// Run: node --test test/llmmodel.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chatMessageHook,
  applyModelChoices,
  resolveModelForAgent,
  resolveEffortForAgent,
  setModelsPath,
  resetCache,
} from "../src/llmmodel.js"

const dir = mkdtempSync(join(tmpdir(), "llmmodel-"))
const file = join(dir, "llm-models.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setModelsPath(file)
})

// Writes the models file and drops the mtime cache, so a rewrite inside the
// same millisecond is still picked up.
function writeModels(obj) {
  writeFileSync(file, JSON.stringify(obj))
  resetCache()
}

// What opencode hands the hook as `output`: the user message it is about to
// run, already carrying the model it resolved on its own.
function freshOutput(agent = "coder") {
  return {
    message: {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      agent,
      model: { providerID: "opencode", modelID: "resolved-default" },
    },
    parts: [],
  }
}

test("no models file: the resolved model is left untouched", () => {
  const output = freshOutput()
  chatMessageHook({ sessionID: "ses_1", agent: "coder" }, output)
  assert.deepEqual(output.message.model, {
    providerID: "opencode",
    modelID: "resolved-default",
  })
  assert.equal(resolveModelForAgent("coder"), null)
})

test("file without an entry for this agent: model left untouched", () => {
  writeModels({ planner: { providerID: "anthropic", modelID: "claude-x" } })
  const output = freshOutput("coder")
  chatMessageHook({ sessionID: "ses_1", agent: "coder" }, output)
  assert.equal(output.message.model.modelID, "resolved-default")
})

test("a chosen model reaches the message as a providerID/modelID pair", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })
  const output = freshOutput("coder")
  chatMessageHook({ sessionID: "ses_1", agent: "coder" }, output)
  assert.deepEqual(output.message.model, {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  })
})

test("the agent comes from the message when the input names none", () => {
  // `chat.message` declares `agent` optional; the message itself always has it.
  writeModels({ reviewer: { providerID: "openai", modelID: "gpt-5" } })
  const output = freshOutput("reviewer")
  chatMessageHook({ sessionID: "ses_1" }, output)
  assert.deepEqual(output.message.model, { providerID: "openai", modelID: "gpt-5" })
})

test("each agent is resolved on its own — no cross-agent fallback", () => {
  writeModels({ orchestrator: { providerID: "anthropic", modelID: "claude-opus-4-5" } })
  const forCoder = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, forCoder)
  assert.equal(forCoder.message.model.modelID, "resolved-default")
  const forOrchestrator = freshOutput("orchestrator")
  chatMessageHook({ agent: "orchestrator" }, forOrchestrator)
  assert.equal(forOrchestrator.message.model.modelID, "claude-opus-4-5")
})

test("removing the agent's entry returns it to opencode's model", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })
  const before = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, before)
  assert.equal(before.message.model.modelID, "claude-sonnet-4-5")

  writeModels({}) // what `[reset current agent]` leaves behind
  const afterReset = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, afterReset)
  assert.equal(afterReset.message.model.modelID, "resolved-default")
})

test("a half-written entry is ignored rather than half-applied", () => {
  writeModels({
    coder: { providerID: "anthropic" },
    planner: { modelID: "claude-x" },
    reviewer: { providerID: "", modelID: "" },
    designer: "anthropic/claude-x",
  })
  for (const agent of ["coder", "planner", "reviewer", "designer"]) {
    assert.equal(resolveModelForAgent(agent), null, `${agent} must not resolve`)
    const output = freshOutput(agent)
    chatMessageHook({ agent }, output)
    assert.equal(output.message.model.modelID, "resolved-default")
  }
})

test("an unparseable models file is treated as empty, not as a default", () => {
  writeFileSync(file, "{ not json")
  resetCache()
  const output = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, output)
  assert.equal(output.message.model.modelID, "resolved-default")
})

test("a message-less output does not throw", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x" } })
  assert.doesNotThrow(() => chatMessageHook({ agent: "coder" }, {}))
  assert.doesNotThrow(() => chatMessageHook({ agent: "coder" }, undefined))
})

// --- the `config` hook half ----------------------------------------------
//
// Same store, the other interface: `config.agent[name].model` takes the string
// form "providerID/modelID" and holds for every prompt of the instance. What
// the message hook must never do — invent a model for an agent the user did
// not choose one for — this one must not do either.

// A resolved config as the plugin's own `installAgents` leaves it: the agent
// keys exist, none of them carries a `model`.
function freshConfig() {
  return {
    agent: {
      coder: { prompt: "P", permission: {} },
      planner: { prompt: "P", permission: {} },
      orchestrator: { prompt: "P", permission: {}, mode: "primary" },
    },
    default_agent: "orchestrator",
  }
}

test("a stored choice becomes config.agent[name].model in provider/model form", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "anthropic/claude-sonnet-4-5")
})

test("an agent without a choice gets no model key at all", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal("model" in config.agent.planner, false, "planner must stay untouched")
  assert.equal("model" in config.agent.orchestrator, false)
})

test("no models file: every agent stays untouched", () => {
  const config = freshConfig()
  applyModelChoices(config)
  for (const name of Object.keys(config.agent)) {
    assert.equal("model" in config.agent[name], false, `${name} must stay untouched`)
  }
})

test("an unparseable models file leaves the config as it stands", () => {
  writeFileSync(file, "{ not json")
  resetCache()
  const config = freshConfig()
  config.agent.coder.model = "project/pinned"
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "project/pinned")
  assert.equal("model" in config.agent.planner, false)
})

test("a choice for an agent that does not exist creates no agent", () => {
  writeModels({ nosuchagent: { providerID: "anthropic", modelID: "claude-x" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.nosuchagent, undefined)
  assert.deepEqual(Object.keys(config.agent), ["coder", "planner", "orchestrator"])
})

test("a half-written entry writes nothing rather than a half model string", () => {
  writeModels({
    coder: { providerID: "anthropic" },
    planner: { modelID: "claude-x" },
    orchestrator: "anthropic/claude-x",
  })
  const config = freshConfig()
  applyModelChoices(config)
  for (const name of Object.keys(config.agent)) {
    assert.equal("model" in config.agent[name], false, `${name} must stay untouched`)
  }
})

test("the user's choice overrides a model the project pinned on that agent", () => {
  // The message hook overrides a project model too; both halves have to agree
  // on the same stored choice, so this one does as well.
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.coder.model = "project/pinned"
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "openai/gpt-5")
})

test("a __proto__ entry in the file does not reach Object.prototype", () => {
  writeModels({ __proto__: { providerID: "evil", modelID: "m" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal({}.model, undefined)
  assert.equal(Object.prototype.model, undefined)
})

test("a config without an agent map does not throw", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x" } })
  assert.doesNotThrow(() => applyModelChoices({}))
  assert.doesNotThrow(() => applyModelChoices(undefined))
  assert.doesNotThrow(() => applyModelChoices({ agent: null }))
})

test("both halves apply the same stored choice", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })
  const config = freshConfig()
  applyModelChoices(config)
  const output = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, output)
  assert.equal(
    config.agent.coder.model,
    `${output.message.model.providerID}/${output.message.model.modelID}`,
  )
})

// --- removing a choice after the config hook has pinned one ---------------
//
// The one sequence that needs both halves: the config hook writes
// `config.agent[name].model` at bootstrap, so from then on that string is what
// opencode resolves for the agent. Dropping the choice in the panel therefore
// cannot fall through to it — the message hook has to put back what the pin
// displaced.

// The message opencode builds once the config hook has pinned `ref` on the
// agent: it carries the pinned pair, not the pre-bootstrap one.
function outputWithModel(agent, providerID, modelID) {
  const output = freshOutput(agent)
  output.message.model = { providerID, modelID }
  return output
}

test("a choice removed after the pin returns the model the pin displaced", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.coder.model = "project/pinned"
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "openai/gpt-5")

  writeModels({}) // what `[reset current agent]` leaves behind
  const output = outputWithModel("coder", "openai", "gpt-5")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, { providerID: "project", modelID: "pinned" })
})

test("the displaced model is split at the first slash only", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.coder.model = "openrouter/openai/gpt-oss-120b"
  applyModelChoices(config)

  writeModels({})
  const output = outputWithModel("coder", "openai", "gpt-5")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, {
    providerID: "openrouter",
    modelID: "openai/gpt-oss-120b",
  })
})

test("a second run of the config hook keeps the displaced model, not its own", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.coder.model = "project/pinned"
  applyModelChoices(config)
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x" } })
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "anthropic/claude-x")

  writeModels({})
  const output = outputWithModel("coder", "anthropic", "claude-x")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, { providerID: "project", modelID: "pinned" })
})

test("an agent the pin found without a model keeps it until the next start", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "openai/gpt-5")

  writeModels({})
  const output = outputWithModel("coder", "openai", "gpt-5")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, { providerID: "openai", modelID: "gpt-5" })
})

test("an agent the config hook never pinned is left untouched", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.planner.model = "project/pinned"
  applyModelChoices(config)

  writeModels({})
  const output = outputWithModel("planner", "project", "pinned")
  chatMessageHook({ agent: "planner" }, output)
  assert.deepEqual(output.message.model, { providerID: "project", modelID: "pinned" })
})

test("a malformed displaced value is not put back as a half pair", () => {
  writeModels({ coder: { providerID: "openai", modelID: "gpt-5" } })
  const config = freshConfig()
  config.agent.coder.model = "bare-model-name"
  applyModelChoices(config)

  writeModels({})
  const output = outputWithModel("coder", "openai", "gpt-5")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, { providerID: "openai", modelID: "gpt-5" })
})

// --- the reasoning effort stored beside the pair --------------------------
//
// An entry may carry one optional key, `variant`, holding the reasoning effort
// the TUI's effort row set. The config hook mirrors it into the agent definition;
// `chat.params` also translates it per request. The pair still comes out of the
// same entry untouched, and only the four ladder values are ever handed on — a
// hand-edited file must not be able to name a fifth.

test("the pair is returned unchanged when a variant sits beside it", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" } })
  assert.deepEqual(resolveModelForAgent("coder"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  })
  const output = freshOutput("coder")
  chatMessageHook({ agent: "coder" }, output)
  assert.deepEqual(output.message.model, {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
  })
})

test("a stored effort reaches config.agent[name].variant", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "low" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "anthropic/claude-sonnet-4-5")
  assert.equal(config.agent.coder.variant, "low")
  assert.deepEqual(Object.keys(config.agent.coder).sort(), ["model", "permission", "prompt", "variant"])
})

test("the default effort leaves config.agent[name].variant unset", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "default" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.coder.model, "anthropic/claude-sonnet-4-5")
  assert.equal("variant" in config.agent.coder, false)
})

test("removing an effort clears config.agent[name].variant", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" } })
  const config = freshConfig()
  applyModelChoices(config)
  assert.equal(config.agent.coder.variant, "high")

  writeModels({ coder: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } })
  applyModelChoices(config)
  assert.equal("variant" in config.agent.coder, false)
})

test("each ladder value is read back as it stands", () => {
  for (const variant of ["low", "medium", "high", "xhigh"]) {
    writeModels({ coder: { providerID: "anthropic", modelID: "claude-x", variant } })
    assert.equal(resolveEffortForAgent("coder"), variant)
  }
})

test("xhigh survives the round trip beside its pair", () => {
  // The panel offers the step only on a model whose `variants` name it, but the
  // reader is model-blind: a stored xhigh has to come back out as it went in,
  // or the choice would be silently dropped on the way to `chat.params`.
  writeModels({ coder: { providerID: "xai", modelID: "grok-4.6", variant: "xhigh" } })
  assert.equal(resolveEffortForAgent("coder"), "xhigh")
  assert.deepEqual(resolveModelForAgent("coder"), { providerID: "xai", modelID: "grok-4.6" })
})

test("an entry without a variant has no effort", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x" } })
  assert.equal(resolveEffortForAgent("coder"), null)
})

test("a variant outside the ladder is not handed on", () => {
  // `default` is stored as the absence of the key; anything else is a
  // hand-edit and reads as no effort at all.
  for (const variant of ["default", "ultra", "", "HIGH", " high", "xxhigh", "XHIGH", 3, null, {}, ["high"]]) {
    writeModels({ coder: { providerID: "anthropic", modelID: "claude-x", variant } })
    assert.equal(resolveEffortForAgent("coder"), null, `variant ${JSON.stringify(variant)}`)
  }
})

test("the effort is resolved per agent, with no file and no entry reading as none", () => {
  assert.equal(resolveEffortForAgent("coder"), null) // no file at all
  writeModels({ planner: { providerID: "anthropic", modelID: "claude-x", variant: "high" } })
  assert.equal(resolveEffortForAgent("coder"), null)
  assert.equal(resolveEffortForAgent("planner"), "high")
  assert.equal(resolveEffortForAgent(""), null)
  assert.equal(resolveEffortForAgent(undefined), null)
})

test("a non-object entry has no effort rather than throwing", () => {
  writeModels({ coder: "anthropic/claude-x", planner: 5, reviewer: null })
  for (const agent of ["coder", "planner", "reviewer", "constructor", "__proto__"]) {
    assert.equal(resolveEffortForAgent(agent), null, agent)
  }
})

test("an unparseable models file yields no effort", () => {
  writeFileSync(file, "{ not json")
  resetCache()
  assert.equal(resolveEffortForAgent("coder"), null)
})
