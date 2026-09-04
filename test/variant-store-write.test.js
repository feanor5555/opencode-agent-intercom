// Unit tests for the third route the stored reasoning effort takes: opencode's
// own per-model variant store (src/variantstore.js), written by the `config`
// hook in src/llmmodel.js.
//
// The other two routes — `config.agent[<name>].variant` and the per-request
// `output.options` of `chat.params` — carry the effort to the PROVIDER. Neither
// reaches the label opencode's TUI prints in the chat area: the TUI seeds a
// fresh session's variant from this store alone. Without the write, an effort
// set in the sidebar is applied but invisible after a restart.
//
// Two properties are load-bearing here and are pinned harder than the rest,
// because the file belongs to another program:
//
//   - nothing else in it may change. `recent`, `favorite` and the variant of
//     every model the plugin did not name come back out byte-identical.
//   - a store that cannot be parsed is left exactly as it stands. Replacing it
//     with a fresh object would silently drop the user's recent-model list.
//
// The store is keyed per MODEL and the sidebar per AGENT, so two agents sharing
// a model cannot both be expressed. The key goes to the primary agent — the
// session the chat area shows — and `default_agent` wins among primaries.
//
// Run: node --test test/variant-store-write.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { applyModelChoices, setModelsPath, resetCache } from "../src/llmmodel.js"
import {
  saveModelVariants,
  setVariantStorePath,
  variantStorePath,
  modelKey,
  DEFAULT_VARIANT,
} from "../src/variantstore.js"

const dir = mkdtempSync(join(tmpdir(), "variantstore-"))
const modelsFile = join(dir, "llm-models.json")
const storeFile = join(dir, "model.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(modelsFile, { force: true })
  rmSync(storeFile, { force: true })
  setModelsPath(modelsFile)
  setVariantStorePath(storeFile)
})

function writeModels(obj) {
  writeFileSync(modelsFile, JSON.stringify(obj))
  resetCache()
}

function writeStore(obj) {
  writeFileSync(storeFile, typeof obj === "string" ? obj : JSON.stringify(obj))
}

function readStore() {
  return JSON.parse(readFileSync(storeFile, "utf8"))
}

// A resolved config as `installAgents` leaves it: `orchestrator` is the primary
// this plugin ships and the default agent; the rest are subagent roles.
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

// What opencode's own store looks like: the variant map sits beside two lists
// that have nothing to do with the effort and must survive every write.
function populatedStore() {
  return {
    recent: [
      { providerID: "xai", modelID: "grok-4.6" },
      { providerID: "google", modelID: "gemini-3.7-flash" },
    ],
    favorite: [{ providerID: "xai", modelID: "grok-4.6" }],
    variant: { "google/gemini-3.7-flash": "low", "minimax/MiniMax-M3": "default" },
  }
}

// --- the write itself -----------------------------------------------------

test("the primary agent's effort lands under its model key", () => {
  writeStore(populatedStore())
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], "high")
})

test("every other entry of the store survives the write", () => {
  const before = populatedStore()
  writeStore(before)
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  applyModelChoices(freshConfig())

  const after = readStore()
  assert.deepEqual(after.recent, before.recent)
  assert.deepEqual(after.favorite, before.favorite)
  assert.equal(after.variant["google/gemini-3.7-flash"], "low")
  assert.equal(after.variant["minimax/MiniMax-M3"], "default")
  assert.deepEqual(Object.keys(after).sort(), ["favorite", "recent", "variant"])
})

test("a key the store did not have is added rather than replacing the map", () => {
  writeStore({ variant: { "other/model": "medium" } })
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "low" } })
  applyModelChoices(freshConfig())
  assert.deepEqual(readStore().variant, { "other/model": "medium", "xai/grok-4.6": "low" })
})

test("an existing key for the same model is overwritten with the new effort", () => {
  writeStore({ variant: { "xai/grok-4.6": "default" } })
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "xhigh" } })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], "xhigh")
})

test("a store that is not there yet is created", () => {
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  assert.doesNotThrow(() => applyModelChoices(freshConfig()))
  assert.deepEqual(readStore(), { variant: { "xai/grok-4.6": "high" } })
})

test("the file is written as opencode writes it: a JSON object, indented by two", () => {
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  applyModelChoices(freshConfig())
  const text = readFileSync(storeFile, "utf8")
  assert.equal(text, JSON.stringify({ variant: { "xai/grok-4.6": "high" } }, null, 2))
})

test("no temp file is left beside the store", () => {
  writeStore(populatedStore())
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  applyModelChoices(freshConfig())
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
  )
})

// --- `default` is a value, not an absent key ------------------------------

test("a stored default effort is written as the name opencode itself stores", () => {
  // `default` is held in llm-models.json as the absence of a `variant` key, but
  // the store spells it out — deleting the key instead would leave the model to
  // whatever the TUI last saved for it.
  writeStore({ variant: { "xai/grok-4.6": "high" } })
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "default" } })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], DEFAULT_VARIANT)
  assert.equal(DEFAULT_VARIANT, "default")
})

test("an entry with no variant at all also writes default", () => {
  writeStore({ variant: { "xai/grok-4.6": "high" } })
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6" } })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], "default")
})

test("a variant outside the ladder writes default, not the hand-edited string", () => {
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "ultra" } })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], "default")
})

// --- who owns a model's key ----------------------------------------------

test("a subagent's effort claims no key of its own", () => {
  writeModels({ coder: { providerID: "anthropic", modelID: "claude-x", variant: "high" } })
  const config = freshConfig()
  applyModelChoices(config)
  // The effort still reaches the agent definition — that route is untouched.
  assert.equal(config.agent.coder.variant, "high")
  assert.throws(() => readStore(), "the store must not have been created at all")
})

test("a subagent sharing the primary's model does not take the key from it", () => {
  writeModels({
    coder: { providerID: "xai", modelID: "grok-4.6", variant: "low" },
    orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" },
  })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["xai/grok-4.6"], "high")
})

test("default_agent wins where two primaries share one model", () => {
  writeModels({
    build: { providerID: "xai", modelID: "grok-4.6", variant: "low" },
    orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" },
  })
  const config = freshConfig()
  // `build` comes first in config order, so only the default_agent rule can
  // decide this one.
  config.agent = { build: { prompt: "P", mode: "primary" }, ...config.agent }
  applyModelChoices(config)
  assert.equal(readStore().variant["xai/grok-4.6"], "high")
})

test("with no default_agent among them the first primary in config order wins", () => {
  writeModels({
    build: { providerID: "xai", modelID: "grok-4.6", variant: "low" },
    plan: { providerID: "xai", modelID: "grok-4.6", variant: "medium" },
  })
  const config = freshConfig()
  config.agent = {
    build: { prompt: "P", mode: "primary" },
    plan: { prompt: "P", mode: "primary" },
    ...config.agent,
  }
  applyModelChoices(config)
  assert.equal(readStore().variant["xai/grok-4.6"], "low")
})

test("two primaries on different models each get their own key", () => {
  writeModels({
    build: { providerID: "anthropic", modelID: "claude-x", variant: "medium" },
    orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" },
  })
  const config = freshConfig()
  config.agent.build = { prompt: "P", mode: "primary" }
  applyModelChoices(config)
  assert.deepEqual(readStore().variant, {
    "anthropic/claude-x": "medium",
    "xai/grok-4.6": "high",
  })
})

test("a hidden primary claims no key", () => {
  // opencode's own `compaction`, `title` and `summary` are primary and hidden
  // both; the chat area never shows one of their sessions.
  writeModels({ title: { providerID: "xai", modelID: "grok-4.6", variant: "low" } })
  const config = freshConfig()
  config.agent.title = { prompt: "P", mode: "primary", hidden: true }
  applyModelChoices(config)
  assert.throws(() => readStore())
})

test("a primary with an effort but no model choice uses the model in its config", () => {
  writeModels({ orchestrator: { variant: "high" } })
  const config = freshConfig()
  config.agent.orchestrator.model = "openrouter/openai/gpt-oss-120b"
  applyModelChoices(config)
  // Split at the first slash only, as everywhere else in this module.
  assert.equal(readStore().variant["openrouter/openai/gpt-oss-120b"], "high")
})

test("a primary with neither a chosen nor a configured model writes nothing", () => {
  writeModels({ orchestrator: { variant: "high" } })
  applyModelChoices(freshConfig())
  assert.throws(() => readStore())
})

test("a model no primary uses keeps whatever stands in the file", () => {
  writeStore({ variant: { "anthropic/claude-x": "xhigh" } })
  writeModels({
    coder: { providerID: "anthropic", modelID: "claude-x", variant: "low" },
    orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" },
  })
  applyModelChoices(freshConfig())
  assert.equal(readStore().variant["anthropic/claude-x"], "xhigh")
})

// --- failing soft ---------------------------------------------------------

test("a malformed store does not throw and is left exactly as it stands", () => {
  const corrupt = '{"recent": [ not json'
  writeStore(corrupt)
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  assert.doesNotThrow(() => applyModelChoices(freshConfig()))
  assert.equal(readFileSync(storeFile, "utf8"), corrupt)
})

test("a store holding something other than an object is left as it stands", () => {
  for (const text of ["[1,2,3]", '"a string"', "42", "null"]) {
    writeStore(text)
    writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
    assert.doesNotThrow(() => applyModelChoices(freshConfig()))
    assert.equal(readFileSync(storeFile, "utf8"), text)
  }
})

test("a store whose variant field is not a map is replaced by one, the rest kept", () => {
  writeStore({ recent: [{ providerID: "xai", modelID: "grok-4.6" }], variant: "nonsense" })
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  applyModelChoices(freshConfig())
  const after = readStore()
  assert.deepEqual(after.variant, { "xai/grok-4.6": "high" })
  assert.deepEqual(after.recent, [{ providerID: "xai", modelID: "grok-4.6" }])
})

test("an unwritable store does not throw", () => {
  // The parent of the target is a regular file, so both the mkdir and the write
  // fail — the case a read-only or vanished state directory produces.
  const blocked = join(dir, "blocker")
  writeFileSync(blocked, "not a directory")
  setVariantStorePath(join(blocked, "model.json"))
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  const config = freshConfig()
  assert.doesNotThrow(() => applyModelChoices(config))
  // The rest of the hook still did its work.
  assert.equal(config.agent.orchestrator.model, "xai/grok-4.6")
  assert.equal(config.agent.orchestrator.variant, "high")
})

test("a config without an agent map still writes nothing and does not throw", () => {
  writeModels({ orchestrator: { providerID: "xai", modelID: "grok-4.6", variant: "high" } })
  assert.doesNotThrow(() => applyModelChoices(undefined))
  assert.doesNotThrow(() => applyModelChoices({}))
  assert.throws(() => readStore())
})

test("a model key of __proto__ lands as an own key, not on Object.prototype", () => {
  saveModelVariants([["__proto__", "high"]])
  assert.equal({}.high, undefined)
  assert.equal(Object.prototype.high, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(readStore().variant, "__proto__")?.value, "high")
})

// --- the store's own interface --------------------------------------------

test("nothing is written where there is nothing to change", () => {
  writeStore({ variant: { "xai/grok-4.6": "high" } })
  const before = readFileSync(storeFile, "utf8")
  assert.equal(saveModelVariants([["xai/grok-4.6", "high"]]), false)
  assert.equal(readFileSync(storeFile, "utf8"), before)
  assert.equal(saveModelVariants([]), false)
  assert.equal(saveModelVariants([["", "high"], ["xai/grok-4.6", ""]]), false)
})

test("modelKey is the provider/model form the store is keyed by", () => {
  assert.equal(modelKey("xai", "grok-4.6"), "xai/grok-4.6")
  assert.equal(modelKey("openrouter", "openai/gpt-oss-120b"), "openrouter/openai/gpt-oss-120b")
})

test("the store path is opencode's own, resolved from XDG_STATE_HOME", () => {
  // `join(Path.state, "model.json")` in the opencode binary, with
  // `Path.state = join(XDG_STATE_HOME || ~/.local/state, "opencode")`.
  const previous = process.env.XDG_STATE_HOME
  try {
    setVariantStorePath(null)
    process.env.XDG_STATE_HOME = "/tmp/xdg-state-fixture"
    assert.equal(variantStorePath(), join("/tmp/xdg-state-fixture", "opencode", "model.json"))
    delete process.env.XDG_STATE_HOME
    assert.equal(variantStorePath(), join(homedir(), ".local", "state", "opencode", "model.json"))
    process.env.XDG_STATE_HOME = "" // empty falls through, as it does in opencode
    assert.equal(variantStorePath(), join(homedir(), ".local", "state", "opencode", "model.json"))
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    setVariantStorePath(storeFile)
  }
})
