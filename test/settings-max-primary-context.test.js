// Pure unit tests for maxPrimaryContext in src/settings.js.
//
// Slice 2 of T1: the setting mirrors maxContext (env > json > default),
// default 80000, 0 = disabled (honored as "off", not a trigger). Independent
// of maxContext.
//
// Run: node --test --test-timeout=2000 test/settings-max-primary-context.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Pinned settings path so no real ~/.config file is read.
let tmpDir
const ENV_NAME = "OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT"

test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  setSettingsPath(join(tmpDir, "agent-intercom.json"))
  // Start each test with env cleared so order is deterministic.
  delete process.env[ENV_NAME]
  resetSettings()
})

test.afterEach(() => {
  delete process.env[ENV_NAME]
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

test("maxPrimaryContext defaults to 80000 when env and json are absent", () => {
  assert.equal(getSettings().maxPrimaryContext, 80000)
})

test("maxPrimaryContext is overridden by the env var when set", () => {
  process.env[ENV_NAME] = "120000"
  resetSettings()
  assert.equal(getSettings().maxPrimaryContext, 120000)
})

test("maxPrimaryContext accepts 0 as disabled (env), independent of maxContext", () => {
  // Pick a non-zero maxContext in env to prove independence.
  process.env[OPENCODE_AGENT_INTERCOM_MAX_CONTEXT_NAME()] = "40000"
  process.env[ENV_NAME] = "0"
  resetSettings()
  const s = getSettings()
  assert.equal(s.maxPrimaryContext, 0, "0 is honored as a valid value")
  assert.equal(s.maxContext, 40000, "maxContext is resolved independently")
})

// Tiny helper kept local so we don't import a constant from settings.js
// (the env name is the public spec contract, not a variable).
function OPENCODE_AGENT_INTERCOM_MAX_CONTEXT_NAME() {
  return "OPENCODE_AGENT_INTERCOM_MAX_CONTEXT"
}
