// Unit tests for settings.js — focused on `maxPrimaryContext`, the new
// orchestrator-primary context-refresh threshold (slice 2 of T1).
//
// Mirrors the resolution order used for `maxContext`:
//   JSON config file (if present) > env var > built-in default.
// `0` is a valid value meaning "disabled" — it must be preserved through
// every layer, not treated as falsy.
//
// Run: node --test --test-timeout=2000 test/settings.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getSettings, setSettingsPath, resetSettings } from "../src/settings.js"

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