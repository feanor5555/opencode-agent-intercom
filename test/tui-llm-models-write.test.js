// Unit tests for the sidebar's writes to the per-agent model file
// (tui/src/llm-models-file.ts).
//
// The sidebar seeds its `llmModels` signal once at mount. Every write therefore
// re-reads the file and merges in only the agent the user just changed, so an
// edit made outside the panel meanwhile is not overwritten with stale state.
//
// Run: node --test test/tui-llm-models-write.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readLlmModels,
  setLlmModel,
  setLlmModelsPath,
} from "../tui/src/llm-models-file.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-llm-models-"))
const file = join(dir, "llm-models.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setLlmModelsPath(file)
})

const onDisk = () => JSON.parse(readFileSync(file, "utf8"))

test("an external edit between mount and a sidebar write survives that write", () => {
  // Mount: the panel reads the file once and keeps that copy in its signal.
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))
  const atMount = readLlmModels()
  assert.deepEqual(atMount, { coder: { providerID: "anthropic", modelID: "opus" } })

  // Someone edits the file while the sidebar is open: a new agent block.
  writeFileSync(
    file,
    JSON.stringify({
      coder: { providerID: "anthropic", modelID: "opus" },
      reviewer: { providerID: "openai", modelID: "gpt-5" },
    }),
  )

  // The user steps the model of "coder" one on.
  const merged = setLlmModel("coder", { providerID: "anthropic", modelID: "sonnet" })

  assert.deepEqual(merged, {
    coder: { providerID: "anthropic", modelID: "sonnet" },
    reviewer: { providerID: "openai", modelID: "gpt-5" },
  })
  // The signal the panel now shows and the file agree.
  assert.deepEqual(onDisk(), merged)
})

test("dropping one agent's model keeps another agent added externally", () => {
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))
  readLlmModels()
  writeFileSync(
    file,
    JSON.stringify({
      coder: { providerID: "anthropic", modelID: "opus" },
      reviewer: { providerID: "openai", modelID: "gpt-5" },
    }),
  )

  const merged = setLlmModel("coder", null)

  assert.deepEqual(merged, { reviewer: { providerID: "openai", modelID: "gpt-5" } })
  assert.equal("coder" in merged, false)
  assert.deepEqual(onDisk(), merged)
})

test("a re-read materialises no agent that is absent from the file", () => {
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))

  const merged = setLlmModel("reviewer", { providerID: "openai", modelID: "gpt-5" })

  assert.deepEqual(Object.keys(merged).sort(), ["coder", "reviewer"])
  assert.equal("planner" in merged, false)
  assert.deepEqual(onDisk(), merged)
})

test("only the pair is stored, not the label the pick list carries", () => {
  const merged = setLlmModel("coder", {
    providerID: "anthropic",
    modelID: "opus",
    label: "Claude Opus",
  })

  assert.deepEqual(merged.coder, { providerID: "anthropic", modelID: "opus" })
  assert.equal("label" in merged.coder, false)
  assert.deepEqual(onDisk(), merged)
})

test("a half-entry in the file is dropped by the write that merges over it", () => {
  writeFileSync(
    file,
    JSON.stringify({ planner: { providerID: "anthropic" }, coder: { providerID: "x", modelID: "y" } }),
  )

  const merged = setLlmModel("coder", { providerID: "anthropic", modelID: "opus" })

  assert.equal("planner" in merged, false)
  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "opus" } })
  assert.deepEqual(onDisk(), merged)
})

test("a missing file is treated as empty and written fresh", () => {
  assert.equal(existsSync(file), false)

  const merged = setLlmModel("coder", { providerID: "anthropic", modelID: "opus" })

  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "opus" } })
  assert.deepEqual(onDisk(), merged)
})

test("an unparsable file is treated as empty and replaced", () => {
  writeFileSync(file, "{ not json")

  const merged = setLlmModel("coder", { providerID: "anthropic", modelID: "opus" })

  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "opus" } })
  assert.deepEqual(onDisk(), merged)
})

test("dropping an agent that has nothing on disk leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { providerID: "openai", modelID: "gpt-5" } }))
  const before = readFileSync(file, "utf8")

  const merged = setLlmModel("coder", null)

  assert.deepEqual(merged, { reviewer: { providerID: "openai", modelID: "gpt-5" } })
  assert.equal(readFileSync(file, "utf8"), before)
})
