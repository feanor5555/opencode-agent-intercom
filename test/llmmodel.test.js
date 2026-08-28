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
