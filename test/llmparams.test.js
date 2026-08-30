// Unit tests for the `chat.params` hook (src/llmparams.js).
//
// The hook is the ONLY place a per-agent sampling parameter enters a request:
// the plugin's role definitions (src/agents.js) set none, so a key the user
// has not set must leave no field on the params output at all.
//
// Run: node --test test/llmparams.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatParamsHook, resolveForAgent, setParamsPath, resetCache } from "../src/llmparams.js"
import { setModelsPath } from "../src/llmmodel.js"

const dir = mkdtempSync(join(tmpdir(), "llmparams-"))
const file = join(dir, "llm-params.json")
// The hook has a second source — the per-agent reasoning effort in
// llm-models.json (see test/llm-effort-apply.test.js). These cases are about
// the params file alone, so the reader is pointed at an empty file of our own:
// without it the tests would read the developer's real ~/.config file and the
// exact `output.options` assertions below would depend on it.
const modelsFile = join(dir, "llm-models.json")
writeFileSync(modelsFile, "{}")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setParamsPath(file)
  setModelsPath(modelsFile)
})

// Writes the params file and drops the mtime cache, so a rewrite inside the
// same millisecond is still picked up.
function writeParams(obj) {
  writeFileSync(file, JSON.stringify(obj))
  resetCache()
}

// What opencode hands the hook as `output` before any plugin touched it: the
// keys exist as properties only once someone assigns them.
function freshOutput() {
  return { options: undefined }
}

test("no params file: the output carries no temperature at all", () => {
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal("temperature" in output, false, "no temperature key may be created")
  assert.equal(output.temperature, undefined)
  assert.equal("topP" in output, false)
  assert.equal(output.options, undefined)
})

test("file without an entry for this agent: still no temperature", () => {
  writeParams({ planner: { temperature: 0.9 } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal("temperature" in output, false)
  assert.deepEqual(resolveForAgent("coder"), {})
})

test("an explicit null or undefined in the file writes nothing", () => {
  // this is what a `[reset]` leaves behind if the TUI nulls a key instead of
  // deleting it — it must not turn into `temperature: null` on the request.
  writeParams({ coder: { temperature: null, top_p: 0.9 } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal("temperature" in output, false)
  assert.equal(output.topP, 0.9) // the sibling key still comes through
})

test("a user-set temperature reaches the request unchanged", () => {
  writeParams({ coder: { temperature: 0.73 } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal(output.temperature, 0.73)
})

test("a user-set temperature of 0 is passed through, not swallowed", () => {
  // 0 is a legitimate value (greedy decoding) and must survive the
  // null/undefined skip.
  writeParams({ coder: { temperature: 0 } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal("temperature" in output, true)
  assert.equal(output.temperature, 0)
})

test("each agent is resolved on its own — no cross-agent fallback", () => {
  writeParams({ orchestrator: { temperature: 0.3 } })
  const forCoder = freshOutput()
  chatParamsHook({ agent: "coder" }, forCoder)
  assert.equal("temperature" in forCoder, false)
  const forOrchestrator = freshOutput()
  chatParamsHook({ agent: "orchestrator" }, forOrchestrator)
  assert.equal(forOrchestrator.temperature, 0.3)
})

test("removing the agent's entry returns it to unset on the next request", () => {
  writeParams({ coder: { temperature: 0.73 } })
  const before = freshOutput()
  chatParamsHook({ agent: "coder" }, before)
  assert.equal(before.temperature, 0.73)

  writeParams({}) // what `[reset current agent]` leaves behind
  const afterReset = freshOutput()
  chatParamsHook({ agent: "coder" }, afterReset)
  assert.equal("temperature" in afterReset, false)
})

test("the other top-level keys map onto opencode's names", () => {
  writeParams({ coder: { top_p: 0.9, top_k: 40, max_tokens: 4096 } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal(output.topP, 0.9)
  assert.equal(output.topK, 40)
  assert.equal(output.maxOutputTokens, 4096)
})

test("llama.cpp keys and unknown keys ride through output.options", () => {
  writeParams({ coder: { min_p: 0.05, repeat_penalty: 1.05, some_future_key: "x" } })
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.deepEqual(output.options, { min_p: 0.05, repeat_penalty: 1.05, some_future_key: "x" })
  assert.equal("temperature" in output, false)
})

test("an unparseable params file is treated as empty, not as a default", () => {
  writeFileSync(file, "{ not json")
  resetCache()
  const output = freshOutput()
  chatParamsHook({ agent: "coder" }, output)
  assert.equal("temperature" in output, false)
})
