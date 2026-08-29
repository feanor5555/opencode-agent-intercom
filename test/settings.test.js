// Unit tests for settings.js — the orchestrator-primary context-refresh
// threshold `maxPrimaryContext`, and `contextBudgetFor`, the per-agent-type
// subagent context budget.
//
// `maxPrimaryContext` resolves as JSON config file (if present) > env var >
// built-in default. `contextBudgetFor` extends that order by a per-type level
// at the top and a per-type table at the bottom:
//   agentContext[agent] > flat maxContext from the file > env var >
//   DEFAULT_AGENT_CONTEXT[agent] > DEFAULT_MAX_CONTEXT.
// `0` is a valid value meaning "disabled" — it must be preserved through
// every layer, not treated as falsy.
//
// Run: node --test --test-timeout=2000 test/settings.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_MAX_CONTEXT,
  contextBudgetFor,
  getSettings,
  setSettingsPath,
  resetSettings,
} from "../src/settings.js"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT"

// Make sure no leftover env from the developer's shell skews the assertions.
function clearEnv() {
  delete process.env[ENV_NAME]
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS
  delete process.env.OPENCODE_AGENT_INTERCOM_SEARXNG_URL
}

// Point settings.js at an empty temp dir so the JSON loader has no opinion.
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  setSettingsPath(join(dir, "agent-intercom.json"))
  return dir
}

test("maxPrimaryContext defaults to 80000 when neither env nor JSON file is set", () => {
  clearEnv()
  isolate()
  const s = getSettings()
  assert.equal(s.maxPrimaryContext, 80000, "default must be 80000 tokens")
  // Sanity: independent from maxContext — maxContext keeps its own default.
  assert.equal(s.maxContext, 40000)
})

test("maxPrimaryContext picks up the env var override", () => {
  clearEnv()
  isolate()
  process.env[ENV_NAME] = "120000"
  resetSettings()
  assert.equal(getSettings().maxPrimaryContext, 120000)
})

test("maxPrimaryContext = 0 is honored as 'disabled' (not silently replaced by the default)", () => {
  clearEnv()
  isolate()
  // Env path: 0 must round-trip.
  process.env[ENV_NAME] = "0"
  resetSettings()
  assert.equal(getSettings().maxPrimaryContext, 0, "env=0 must be preserved")

  // JSON file path: 0 must round-trip there too, and beat the env default.
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  const file = join(dir, "agent-intercom.json")
  writeFileSync(file, JSON.stringify({ maxPrimaryContext: 0 }))
  delete process.env[ENV_NAME]
  setSettingsPath(file)
  assert.equal(getSettings().maxPrimaryContext, 0, "json=0 must be preserved")
})

// Writes a settings file into a fresh temp dir and points settings.js at it.
function withSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  const file = join(dir, "agent-intercom.json")
  writeFileSync(file, JSON.stringify(content))
  setSettingsPath(file)
  return file
}

test("contextBudgetFor falls back to the built-in table per agent type", () => {
  clearEnv()
  isolate()
  assert.equal(contextBudgetFor("coder"), 60000)
  assert.equal(contextBudgetFor("designer"), 30000)
  assert.equal(contextBudgetFor("planner"), 40000)
})

test("contextBudgetFor gives an unknown agent name DEFAULT_MAX_CONTEXT", () => {
  clearEnv()
  isolate()
  // A project's own agent, and the provisional name a subagent carries until
  // spawn upgrades it — both behave as the single old global default did.
  assert.equal(contextBudgetFor("some-project-agent"), DEFAULT_MAX_CONTEXT)
  assert.equal(contextBudgetFor("subagent"), DEFAULT_MAX_CONTEXT)
  // The orchestrator is deliberately not in the table: the budget is
  // subagent-only, the primary is governed by primaryContextThreshold.
  assert.equal(Object.hasOwn(DEFAULT_AGENT_CONTEXT, "orchestrator"), false)
})

test("an agentContext entry wins for its own type and leaves the others alone", () => {
  clearEnv()
  withSettings({ agentContext: { coder: 12345 } })
  assert.equal(contextBudgetFor("coder"), 12345)
  assert.equal(contextBudgetFor("planner"), 40000)
  assert.equal(contextBudgetFor("unknown"), DEFAULT_MAX_CONTEXT)
})

test("the flat maxContext seeds every type that has no entry of its own", () => {
  clearEnv()
  withSettings({ maxContext: 25000 })
  assert.equal(contextBudgetFor("coder"), 25000)
  assert.equal(contextBudgetFor("researcher"), 25000)
  assert.equal(contextBudgetFor("unknown"), 25000)
})

test("an agentContext entry beats the flat maxContext seed", () => {
  clearEnv()
  withSettings({ maxContext: 25000, agentContext: { coder: 90000 } })
  assert.equal(contextBudgetFor("coder"), 90000)
  assert.equal(contextBudgetFor("planner"), 25000)
})

test("the env var seeds every unconfigured type and loses to file and entry", () => {
  clearEnv()
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "50000"
  resetSettings()
  assert.equal(contextBudgetFor("coder"), 50000, "env displaces the built-in table")
  assert.equal(contextBudgetFor("unknown"), 50000)

  withSettings({ maxContext: 25000 })
  assert.equal(contextBudgetFor("coder"), 25000, "the file's flat key beats the env var")

  withSettings({ agentContext: { coder: 11000 } })
  assert.equal(contextBudgetFor("coder"), 11000, "the type's own entry beats the env var")
  assert.equal(contextBudgetFor("planner"), 50000, "an unconfigured type still takes the env var")
  clearEnv()
})

test("an env var equal to DEFAULT_MAX_CONTEXT still displaces the per-type table", () => {
  clearEnv()
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = String(DEFAULT_MAX_CONTEXT)
  resetSettings()
  assert.equal(contextBudgetFor("coder"), DEFAULT_MAX_CONTEXT)
  clearEnv()
})

test("0 is a real budget at every level and disables that type", () => {
  clearEnv()
  // Per type: 0 beats the non-zero built-in default of that type.
  withSettings({ agentContext: { coder: 0 } })
  assert.equal(contextBudgetFor("coder"), 0)
  assert.equal(contextBudgetFor("planner"), 40000)

  // As the flat seed: 0 disables every type that has no entry of its own.
  withSettings({ maxContext: 0, agentContext: { coder: 60000 } })
  assert.equal(contextBudgetFor("planner"), 0)
  assert.equal(contextBudgetFor("unknown"), 0)
  assert.equal(contextBudgetFor("coder"), 60000)

  // As the env var: same, and the file's entry still wins.
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "0"
  resetSettings()
  assert.equal(contextBudgetFor("coder"), 0)
  clearEnv()
})

test("a malformed agentContext map is dropped entry by entry", () => {
  clearEnv()
  withSettings({
    agentContext: { coder: "lots", planner: -1, reviewer: 2.5, designer: 1000, "": 5 },
  })
  assert.equal(contextBudgetFor("coder"), 60000, "non-integer entry must be dropped")
  assert.equal(contextBudgetFor("planner"), 40000, "negative entry must be dropped")
  assert.equal(contextBudgetFor("reviewer"), 40000, "fractional entry must be dropped")
  assert.equal(contextBudgetFor("designer"), 1000, "the one valid entry must survive")
})

test("an agentContext that is not a plain object leaves the key unset", () => {
  clearEnv()
  for (const bad of [[1, 2], "60000", null, 42]) {
    withSettings({ agentContext: bad })
    assert.deepEqual(getSettings().agentContext, {}, `bad map ${JSON.stringify(bad)}`)
    assert.equal(contextBudgetFor("coder"), 60000)
  }
})

test("getSettings names where the flat maxContext came from", () => {
  clearEnv()
  isolate()
  assert.equal(getSettings().maxContextSource, "default")
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "50000"
  resetSettings()
  assert.equal(getSettings().maxContextSource, "env")
  withSettings({ maxContext: 25000 })
  assert.equal(getSettings().maxContextSource, "file")
  // A file value the validator rejects leaves the env resolution standing.
  withSettings({ maxContext: "lots" })
  assert.equal(getSettings().maxContextSource, "env")
  clearEnv()
})
