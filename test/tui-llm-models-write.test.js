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
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EFFORT_LADDER,
  cycleLlmModel,
  cycleLlmVariant,
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

// The pick list the sidebar builds from the configured providers, in the order
// [<]/[>] walks it.
const CHOICES = [
  { providerID: "anthropic", modelID: "opus", label: "Claude Opus" },
  { providerID: "anthropic", modelID: "sonnet", label: "Claude Sonnet" },
  { providerID: "openai", modelID: "gpt-5", label: "GPT-5" },
]

// A read-only file is still writable for root, so the failed-write case only
// says anything as an unprivileged user.
const rootSkip = process.getuid?.() === 0 ? "root writes read-only files" : false

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
  assert.equal("variant" in merged.coder, false)
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

test("an unparsable file is left alone rather than replaced", () => {
  writeFileSync(file, '{ "coder": { "providerID": "anthropic" },')
  const before = readFileSync(file, "utf8")

  const merged = setLlmModel("coder", { providerID: "anthropic", modelID: "opus" })

  assert.equal(readFileSync(file, "utf8"), before)
  assert.deepEqual(merged, {})
})

test("a cycle steps from the model the file holds, not from the panel's copy", () => {
  // Mount: the panel reads "opus" into its signal.
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))
  assert.deepEqual(readLlmModels(), {
    coder: { providerID: "anthropic", modelID: "opus" },
  })

  // Changed outside the panel while the sidebar still shows "opus".
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "sonnet" } }))

  const merged = cycleLlmModel("coder", 1, CHOICES)

  assert.deepEqual(merged, { coder: { providerID: "openai", modelID: "gpt-5" } })
  assert.deepEqual(onDisk(), merged)
})

test("cycling off the front of the list drops the agent's choice", () => {
  writeFileSync(
    file,
    JSON.stringify({
      coder: { providerID: "anthropic", modelID: "opus" },
      reviewer: { providerID: "openai", modelID: "gpt-5" },
    }),
  )

  const merged = cycleLlmModel("coder", -1, CHOICES)

  assert.equal("coder" in merged, false)
  assert.deepEqual(merged, { reviewer: { providerID: "openai", modelID: "gpt-5" } })
  assert.deepEqual(onDisk(), merged)
})

test("only the pair is stored when the cycle lands on a pick-list entry", () => {
  const merged = cycleLlmModel("coder", 1, CHOICES)

  assert.deepEqual(merged.coder, { providerID: "anthropic", modelID: "opus" })
  assert.equal("label" in merged.coder, false)
  assert.equal("variant" in merged.coder, false)
  assert.deepEqual(onDisk(), merged)
})

test("an empty pick list leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))
  const before = readFileSync(file, "utf8")

  const merged = cycleLlmModel("coder", 1, [])

  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "opus" } })
  assert.equal(readFileSync(file, "utf8"), before)
})

test("a write that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "opus" } }))
  chmodSync(file, 0o444)

  const merged = setLlmModel("coder", { providerID: "openai", modelID: "gpt-5" })

  assert.deepEqual(onDisk(), { coder: { providerID: "anthropic", modelID: "opus" } })
  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "opus" } })
  chmodSync(file, 0o644)
})

test("dropping an agent that has nothing on disk leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { providerID: "openai", modelID: "gpt-5" } }))
  const before = readFileSync(file, "utf8")

  const merged = setLlmModel("coder", null)

  assert.deepEqual(merged, { reviewer: { providerID: "openai", modelID: "gpt-5" } })
  assert.equal(readFileSync(file, "utf8"), before)
})

// --- the reasoning effort stored beside the pair -----------------------------

const OPUS = { providerID: "anthropic", modelID: "opus" }

test("the ladder is the one the effort row cycles, default first", () => {
  assert.deepEqual([...EFFORT_LADDER], ["default", "low", "medium", "high"])
})

test("an entry without an effort reads exactly as it did before", () => {
  writeFileSync(file, JSON.stringify({ coder: OPUS }))

  assert.deepEqual(readLlmModels(), { coder: OPUS })
})

test("a stored effort rides through the read beside its pair", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "high" } }))

  assert.deepEqual(readLlmModels(), { coder: { ...OPUS, variant: "high" } })
})

test("a nonsense variant in the file is dropped by the read", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "ludicrous" } }))

  assert.deepEqual(readLlmModels(), { coder: OPUS })
})

test("a nonsense variant in the file is dropped by the write that merges over it", () => {
  writeFileSync(
    file,
    JSON.stringify({
      coder: { ...OPUS, variant: "ludicrous" },
      reviewer: { providerID: "openai", modelID: "gpt-5", variant: 7 },
    }),
  )

  const merged = cycleLlmVariant("coder", 1, OPUS)

  assert.deepEqual(merged, {
    coder: { ...OPUS, variant: "low" },
    reviewer: { providerID: "openai", modelID: "gpt-5" },
  })
  assert.deepEqual(onDisk(), merged)
})

test("a variant of \"default\" in the file is dropped: default is the absent key", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "default" } }))

  assert.deepEqual(readLlmModels(), { coder: OPUS })
})

test("the effort steps from the value the file holds, not from the panel's copy", () => {
  // Mount: the panel reads "low" into its signal.
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "low" } }))
  assert.deepEqual(readLlmModels(), { coder: { ...OPUS, variant: "low" } })

  // Changed outside the panel while the sidebar still shows "low".
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "medium" } }))

  const merged = cycleLlmVariant("coder", 1, OPUS)

  assert.deepEqual(merged, { coder: { ...OPUS, variant: "high" } })
  assert.deepEqual(onDisk(), merged)
})

test("stepping past the top of the ladder wraps to default", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "high" } }))

  const merged = cycleLlmVariant("coder", 1, OPUS)

  assert.deepEqual(merged, { coder: OPUS })
  assert.equal("variant" in merged.coder, false)
  assert.deepEqual(onDisk(), merged)
})

test("landing on default deletes only the variant and keeps the pair", () => {
  writeFileSync(
    file,
    JSON.stringify({
      coder: { ...OPUS, variant: "low" },
      reviewer: { providerID: "openai", modelID: "gpt-5", variant: "high" },
    }),
  )

  const merged = cycleLlmVariant("coder", -1, OPUS)

  assert.deepEqual(merged, {
    coder: OPUS,
    reviewer: { providerID: "openai", modelID: "gpt-5", variant: "high" },
  })
  assert.deepEqual(onDisk(), merged)
})

test("stepping back from default lands on the top of the ladder", () => {
  writeFileSync(file, JSON.stringify({ coder: OPUS }))

  const merged = cycleLlmVariant("coder", -1, OPUS)

  assert.deepEqual(merged, { coder: { ...OPUS, variant: "high" } })
  assert.deepEqual(onDisk(), merged)
})

test("an effort on an agent with no entry materialises the resolved pair", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { providerID: "openai", modelID: "gpt-5" } }))

  const merged = cycleLlmVariant("coder", 1, OPUS)

  assert.deepEqual(merged, {
    coder: { ...OPUS, variant: "low" },
    reviewer: { providerID: "openai", modelID: "gpt-5" },
  })
  assert.deepEqual(onDisk(), merged)
})

test("landing on default for an agent with no entry leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { providerID: "openai", modelID: "gpt-5" } }))
  const before = readFileSync(file, "utf8")

  // Four steps from "default" come back to it, and the agent has no entry to
  // strip a key from, so nothing is materialised.
  const merged = cycleLlmVariant("coder", 4, OPUS)

  assert.equal("coder" in merged, false)
  assert.equal(readFileSync(file, "utf8"), before)
})

test("a model cycle after an effort drops the effort with the model it was chosen for", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "high" } }))

  const merged = cycleLlmModel("coder", 1, CHOICES)

  assert.deepEqual(merged, { coder: { providerID: "anthropic", modelID: "sonnet" } })
  assert.equal("variant" in merged.coder, false)
  assert.deepEqual(onDisk(), merged)
})

test("setting the model directly after an effort drops the effort too", () => {
  writeFileSync(file, JSON.stringify({ coder: { ...OPUS, variant: "high" } }))

  const merged = setLlmModel("coder", { providerID: "openai", modelID: "gpt-5" })

  assert.deepEqual(merged, { coder: { providerID: "openai", modelID: "gpt-5" } })
  assert.deepEqual(onDisk(), merged)
})

test("an effort write that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ coder: OPUS }))
  chmodSync(file, 0o444)

  const merged = cycleLlmVariant("coder", 1, OPUS)

  assert.deepEqual(onDisk(), { coder: OPUS })
  assert.deepEqual(merged, { coder: OPUS })
  chmodSync(file, 0o644)
})
