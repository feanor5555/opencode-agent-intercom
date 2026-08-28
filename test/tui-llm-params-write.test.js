// Unit tests for the sidebar's writes to the LLM parameter file
// (tui/src/llm-params-file.ts).
//
// The sidebar seeds its `llmParams` signal once at mount. Every write therefore
// re-reads the file and merges in only the entry the user just changed, so an
// edit made outside the panel meanwhile is not overwritten with stale state.
//
// Run: node --test test/tui-llm-params-write.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearLlmParamsAgent,
  readLlmParams,
  setLlmParam,
  setLlmParamsPath,
  stepLlmParam,
} from "../tui/src/llm-params-file.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-llm-params-"))
const file = join(dir, "llm-params.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setLlmParamsPath(file)
})

const onDisk = () => JSON.parse(readFileSync(file, "utf8"))

// The stepping rule of the temperature row, as the sidebar defines it.
const TEMPERATURE = { key: "temperature", step: 0.05, min: 0, max: 2, decimals: 2 }

// A read-only file is still writable for root, so the failed-write case only
// says anything as an unprivileged user.
const rootSkip = process.getuid?.() === 0 ? "root writes read-only files" : false

test("an external edit between mount and a sidebar write survives that write", () => {
  // Mount: the panel reads the file once and keeps that copy in its signal.
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 } }))
  const atMount = readLlmParams()
  assert.deepEqual(atMount, { coder: { temperature: 0.7 } })

  // Someone edits the file while the sidebar is open: a new agent block, and a
  // second parameter on the agent the user is about to touch.
  writeFileSync(
    file,
    JSON.stringify({ coder: { temperature: 0.7, top_k: 40 }, reviewer: { min_p: 0.05 } }),
  )

  // The user presses + on temperature for "coder".
  const merged = setLlmParam("coder", "temperature", 0.75)

  assert.deepEqual(merged, {
    coder: { temperature: 0.75, top_k: 40 },
    reviewer: { min_p: 0.05 },
  })
  // The signal the panel now shows and the file agree.
  assert.deepEqual(onDisk(), merged)
})

test("clearing one agent keeps another agent added externally", () => {
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 } }))
  readLlmParams()
  writeFileSync(
    file,
    JSON.stringify({ coder: { temperature: 0.7 }, reviewer: { top_p: 0.9 } }),
  )

  const merged = clearLlmParamsAgent("coder")

  assert.deepEqual(merged, { reviewer: { top_p: 0.9 } })
  assert.deepEqual(onDisk(), merged)
})

test("a re-read materialises no key that is absent from the file", () => {
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 } }))

  const merged = setLlmParam("coder", "top_p", 0.9)

  assert.deepEqual(Object.keys(merged.coder).sort(), ["temperature", "top_p"])
  assert.equal("top_k" in merged.coder, false)
  assert.equal("max_tokens" in merged.coder, false)
  assert.deepEqual(onDisk(), merged)
})

test("dropping the last parameter of an agent removes the agent", () => {
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 }, reviewer: { top_p: 0.9 } }))

  const merged = setLlmParam("coder", "temperature", null)

  assert.deepEqual(merged, { reviewer: { top_p: 0.9 } })
  assert.equal("coder" in merged, false)
  assert.deepEqual(onDisk(), merged)
})

test("a missing file is treated as empty and written fresh", () => {
  assert.equal(existsSync(file), false)

  const merged = setLlmParam("coder", "temperature", 0.7)

  assert.deepEqual(merged, { coder: { temperature: 0.7 } })
  assert.deepEqual(onDisk(), merged)
})

test("an unparsable file is left alone rather than replaced", () => {
  writeFileSync(file, '{ "coder": { "temperature": 0.7 },')
  const before = readFileSync(file, "utf8")

  const merged = setLlmParam("coder", "temperature", 0.7)

  assert.equal(readFileSync(file, "utf8"), before)
  assert.deepEqual(merged, {})
})

test("a step starts from the value the file holds, not from the panel's copy", () => {
  // Mount: the panel reads 0.7 into its signal.
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 } }))
  assert.deepEqual(readLlmParams(), { coder: { temperature: 0.7 } })

  // Raised outside the panel while the sidebar still shows 0.7.
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.9, top_k: 40 } }))

  const merged = stepLlmParam("coder", TEMPERATURE, 0.05, null)

  assert.deepEqual(merged, { coder: { temperature: 0.95, top_k: 40 } })
  assert.deepEqual(onDisk(), merged)
})

test("with nothing in the file the step starts from what opencode resolved", () => {
  const merged = stepLlmParam("coder", TEMPERATURE, 0.05, 0.3)

  assert.deepEqual(merged, { coder: { temperature: 0.35 } })
  assert.deepEqual(onDisk(), merged)
})

test("stepping the agent's own value below the floor drops that override", () => {
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0, top_k: 40 } }))

  const merged = stepLlmParam("coder", TEMPERATURE, -0.05, null)

  assert.deepEqual(merged, { coder: { top_k: 40 } })
  assert.deepEqual(onDisk(), merged)
})

test("stepping down a parameter nothing sets leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { top_p: 0.9 } }))
  const before = readFileSync(file, "utf8")

  const merged = stepLlmParam("coder", TEMPERATURE, -0.05, null)

  assert.deepEqual(merged, { reviewer: { top_p: 0.9 } })
  assert.equal(readFileSync(file, "utf8"), before)
})

test("a write that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ coder: { temperature: 0.7 } }))
  chmodSync(file, 0o444)

  const merged = setLlmParam("coder", "top_p", 0.9)

  assert.deepEqual(onDisk(), { coder: { temperature: 0.7 } })
  assert.deepEqual(merged, { coder: { temperature: 0.7 } })
  chmodSync(file, 0o644)
})

test("a legacy \"*\" block is dropped by the write that merges over it", () => {
  writeFileSync(file, JSON.stringify({ "*": { temperature: 0.6 }, coder: { top_k: 40 } }))

  const merged = setLlmParam("coder", "temperature", 0.7)

  assert.equal("*" in merged, false)
  assert.deepEqual(merged, { coder: { top_k: 40, temperature: 0.7 } })
  assert.deepEqual(onDisk(), merged)
})

test("an entry that is not a bucket of numbers is dropped by the write that merges over it", () => {
  // The params hook forwards every key it does not recognise into the provider
  // request body, so nothing but finite numbers may survive a write.
  writeFileSync(
    file,
    JSON.stringify({
      planner: "abc",
      designer: 3,
      reviewer: { top_p: "high" },
      coder: { top_k: 40, min_p: null },
    }),
  )

  const merged = setLlmParam("coder", "temperature", 0.7)

  assert.deepEqual(merged, { coder: { top_k: 40, temperature: 0.7 } })
  assert.deepEqual(onDisk(), merged)
})

test("clearing an agent that has nothing on disk leaves the file untouched", () => {
  writeFileSync(file, JSON.stringify({ reviewer: { top_p: 0.9 } }))
  const before = readFileSync(file, "utf8")

  const merged = clearLlmParamsAgent("coder")

  assert.deepEqual(merged, { reviewer: { top_p: 0.9 } })
  assert.equal(readFileSync(file, "utf8"), before)
})
