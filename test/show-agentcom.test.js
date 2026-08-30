// Unit tests for the `showAgentcom` setting (src/settings.js): the switch that
// decides whether the plugin's own postings appear in the transcript. While it
// is off they are kept off it and their text still reaches the model.
//
// It is a boolean key and resolves in the order every other key uses:
// file > env > default. The file value counts only as a REAL boolean —
// "true", 1 and null leave the env-or-default resolution standing, the same
// discipline a bad number gets.
//
// Run: node --test --test-timeout=2000 test/show-agentcom.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_SHOW_AGENTCOM,
  getSettings,
  setSettingsPath,
  resetSettings,
} from "../src/settings.js"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM"

let dir
let file

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-intercom-show-agentcom-"))
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

// The default is what a user who sets nothing gets: the plugin's postings are
// rendered, which is the behaviour the transcript has always had.
test("showAgentcom is on when neither file nor env says otherwise", () => {
  assert.equal(DEFAULT_SHOW_AGENTCOM, true)
  assert.equal(getSettings().showAgentcom, true)
})

test("showAgentcom comes from the file as a real boolean", () => {
  writeSettings({ showAgentcom: true })
  assert.equal(getSettings().showAgentcom, true)

  writeSettings({ showAgentcom: false })
  assert.equal(getSettings().showAgentcom, false)
})

test("a file value that is not a boolean leaves the default standing", () => {
  for (const bad of ["true", 1, null, [], { on: true }]) {
    writeSettings({ showAgentcom: bad })
    assert.equal(getSettings().showAgentcom, DEFAULT_SHOW_AGENTCOM)
  }
})

test("the env var resolves as 1/0 while the file is silent", () => {
  process.env[ENV_NAME] = "1"
  resetSettings()
  assert.equal(getSettings().showAgentcom, true)

  process.env[ENV_NAME] = "0"
  resetSettings()
  assert.equal(getSettings().showAgentcom, false)
})

test("anything but 1/0 in the env var leaves the default standing", () => {
  for (const bad of ["yes", "true", "", " "]) {
    process.env[ENV_NAME] = bad
    resetSettings()
    assert.equal(getSettings().showAgentcom, DEFAULT_SHOW_AGENTCOM)
  }
})

test("the file wins over the env var in both directions", () => {
  process.env[ENV_NAME] = "0"
  writeSettings({ showAgentcom: true })
  assert.equal(getSettings().showAgentcom, true)

  process.env[ENV_NAME] = "1"
  writeSettings({ showAgentcom: false })
  assert.equal(getSettings().showAgentcom, false)
})

test("an unreadable settings file leaves the env-or-default resolution standing", () => {
  writeFileSync(file, "{ not json")
  process.env[ENV_NAME] = "0"
  resetSettings()
  assert.equal(getSettings().showAgentcom, false)
})

test("showAgentcom does not disturb the other boolean key", () => {
  writeSettings({ showAgentcom: false, endlessMode: true })
  const s = getSettings()
  assert.equal(s.showAgentcom, false)
  assert.equal(s.endlessMode, true)

  writeSettings({ showAgentcom: false })
  const onlyHidden = getSettings()
  assert.equal(onlyHidden.showAgentcom, false)
  assert.equal(onlyHidden.endlessMode, false)
})

// The old key is gone, not aliased: a file still carrying `hideChatter` says
// nothing about this setting.
test("the superseded hideChatter key does not resolve showAgentcom", () => {
  writeSettings({ hideChatter: true })
  assert.equal(getSettings().showAgentcom, DEFAULT_SHOW_AGENTCOM)
})
