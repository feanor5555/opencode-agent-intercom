// Parity between the plugin's limit resolution (src/settings.js) and the
// sidebar's copy of it (tui/src/settings-file.ts).
//
// The TUI is a separate npm package and cannot import the plugin module, so it
// carries its own copy of the two defaults, the two env var names and the
// file > env > default order. Nothing at runtime notices when the two drift
// apart; these tests do, by pinning both sides at the same file and env.
//
// Run: node --test test/settings-defaults-parity.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS,
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import {
  DEFAULT_MAX_CONTEXT as TUI_DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS as TUI_DEFAULT_MAX_SUBAGENTS,
  readSettings,
  setSettingsPath as setTuiSettingsPath,
} from "../tui/src/settings-file.ts"

const dir = mkdtempSync(join(tmpdir(), "settings-parity-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  // Both sides read the same file, so the comparison is over one input.
  setSettingsPath(file)
  setTuiSettingsPath(file)
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
})

// Both limits as each side resolves them right now. The plugin caches for
// TTL_MS, so its cache is dropped first.
function bothSides() {
  resetSettings()
  const plugin = getSettings()
  const tui = readSettings()
  return [
    { maxSubagents: plugin.maxSubagents, maxContext: plugin.maxContext },
    tui,
  ]
}

test("the two modules carry the same built-in defaults", () => {
  assert.equal(DEFAULT_MAX_SUBAGENTS, TUI_DEFAULT_MAX_SUBAGENTS)
  assert.equal(DEFAULT_MAX_CONTEXT, TUI_DEFAULT_MAX_CONTEXT)
})

test("with neither file nor env both resolve the built-in defaults", () => {
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    maxContext: DEFAULT_MAX_CONTEXT,
  })
  assert.deepEqual(tui, plugin)
})

test("with env alone both resolve the env value", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, { maxSubagents: 4, maxContext: 70000 })
  assert.deepEqual(tui, plugin)
})

test("with file and env both let the file win", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  writeFileSync(file, JSON.stringify({ maxSubagents: 2, maxContext: 95000 }))
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, { maxSubagents: 2, maxContext: 95000 })
  assert.deepEqual(tui, plugin)
})

test("both reject the same file values and fall back to env or default", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  writeFileSync(file, JSON.stringify({ maxSubagents: -1, maxContext: "lots" }))
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, { maxSubagents: 4, maxContext: DEFAULT_MAX_CONTEXT })
  assert.deepEqual(tui, plugin)
})

test("both keep 0 as a value in its own right", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 0, maxContext: 0 }))
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, { maxSubagents: 0, maxContext: 0 })
  assert.deepEqual(tui, plugin)
})
