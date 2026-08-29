// Unit tests for the `hideChatter` setting (src/settings.js): the switch that
// keeps the plugin's own postings off the transcript while their text still
// reaches the model.
//
// It is a boolean key and resolves in the order every other key uses:
// file > env > default. The file value counts only as a REAL boolean —
// "true", 1 and null leave the env-or-default resolution standing, the same
// discipline a bad number gets.
//
// Run: node --test --test-timeout=2000 test/hide-chatter.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_HIDE_CHATTER,
  getSettings,
  setSettingsPath,
  resetSettings,
} from "../src/settings.js"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_HIDE_CHATTER"

let dir
let file

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-intercom-hide-chatter-"))
  file = join(dir, "agent-intercom.json")
  setSettingsPath(file)
  delete process.env[ENV_NAME]
  resetSettings()
})

test.afterEach(() => {
  delete process.env[ENV_NAME]
  resetSettings()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// Writes the settings file and drops the TTL cache so the next read sees it.
function writeSettings(obj) {
  writeFileSync(file, JSON.stringify(obj))
  resetSettings()
}

test("hideChatter is off when neither file nor env says otherwise", () => {
  assert.equal(DEFAULT_HIDE_CHATTER, false)
  assert.equal(getSettings().hideChatter, false)
})

test("hideChatter comes from the file as a real boolean", () => {
  writeSettings({ hideChatter: true })
  assert.equal(getSettings().hideChatter, true)

  writeSettings({ hideChatter: false })
  assert.equal(getSettings().hideChatter, false)
})

test("a file value that is not a boolean leaves the default standing", () => {
  for (const bad of ["true", 1, null, [], { on: true }]) {
    writeSettings({ hideChatter: bad })
    assert.equal(getSettings().hideChatter, DEFAULT_HIDE_CHATTER)
  }
})

test("the env var resolves as 1/0 while the file is silent", () => {
  process.env[ENV_NAME] = "1"
  resetSettings()
  assert.equal(getSettings().hideChatter, true)

  process.env[ENV_NAME] = "0"
  resetSettings()
  assert.equal(getSettings().hideChatter, false)
})

test("anything but 1/0 in the env var leaves the default standing", () => {
  for (const bad of ["yes", "true", "", " "]) {
    process.env[ENV_NAME] = bad
    resetSettings()
    assert.equal(getSettings().hideChatter, DEFAULT_HIDE_CHATTER)
  }
})

test("the file wins over the env var in both directions", () => {
  process.env[ENV_NAME] = "0"
  writeSettings({ hideChatter: true })
  assert.equal(getSettings().hideChatter, true)

  process.env[ENV_NAME] = "1"
  writeSettings({ hideChatter: false })
  assert.equal(getSettings().hideChatter, false)
})

test("an unreadable settings file leaves the env-or-default resolution standing", () => {
  writeFileSync(file, "{ not json")
  process.env[ENV_NAME] = "1"
  resetSettings()
  assert.equal(getSettings().hideChatter, true)
})

test("hideChatter does not disturb the other boolean key", () => {
  writeSettings({ hideChatter: true, endlessMode: true })
  const s = getSettings()
  assert.equal(s.hideChatter, true)
  assert.equal(s.endlessMode, true)

  writeSettings({ hideChatter: true })
  const onlyHidden = getSettings()
  assert.equal(onlyHidden.hideChatter, true)
  assert.equal(onlyHidden.endlessMode, false)
})
