// Unit tests for the endless-mode settings keys (src/settings.js):
// `endlessMode` (the file's only boolean key), `endlessContext`,
// `endlessQuiesceTimeoutMs`, `endlessMaxCycles`, the single resolution point
// `primaryContextThreshold()` and the plugin's own write-back
// `writeEndlessMode()`.
//
// Resolution order is the one every other key uses: file > env > default.
//
// Run: node --test --test-timeout=2000 test/endless-settings.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getSettings,
  setSettingsPath,
  resetSettings,
  primaryContextThreshold,
  writeEndlessMode,
  DEFAULT_ENDLESS_MODE,
  DEFAULT_ENDLESS_CONTEXT,
} from "../src/settings.js"
import { recordPrimaryContext, shouldTriggerPrimaryHandoff } from "../src/registry.js"

const ENV_KEYS = [
  "OPENCODE_AGENT_INTERCOM_ENDLESS_MODE",
  "OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT",
  "OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS",
  "OPENCODE_AGENT_INTERCOM_ENDLESS_MAX_CYCLES",
  "OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT",
]

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k]
}

// Points settings.js at a file in a fresh temp dir. `content` undefined leaves
// the file absent, so only env + defaults resolve.
function isolate(content) {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-endless-"))
  const file = join(dir, "agent-intercom.json")
  if (content !== undefined) writeFileSync(file, JSON.stringify(content))
  setSettingsPath(file)
  return file
}

test.beforeEach(() => {
  clearEnv()
  resetSettings()
})

test("no file: endlessMode is false and endlessContext is 250000", () => {
  isolate()
  const s = getSettings()
  assert.equal(s.endlessMode, false)
  assert.equal(s.endlessMode, DEFAULT_ENDLESS_MODE)
  assert.equal(s.endlessContext, 250000)
  assert.equal(s.endlessContext, DEFAULT_ENDLESS_CONTEXT)
  assert.equal(s.endlessQuiesceTimeoutMs, 600000)
  assert.equal(s.endlessMaxCycles, 10)
})

test('a file with "endlessMode": true resolves to true', () => {
  isolate({ endlessMode: true })
  assert.equal(getSettings().endlessMode, true)
})

test('"true", 1 and null for endlessMode leave the default standing, without throwing', () => {
  for (const bad of ["true", 1, null, "1", [], {}]) {
    isolate({ endlessMode: bad })
    assert.equal(getSettings().endlessMode, false, `value ${JSON.stringify(bad)} must not arm the mode`)
  }
})

test("a non-integer or negative endlessContext leaves the default standing", () => {
  for (const bad of [250000.5, -1, "250000", null]) {
    isolate({ endlessContext: bad })
    assert.equal(getSettings().endlessContext, DEFAULT_ENDLESS_CONTEXT)
  }
})

test("the env vars resolve when the file is silent and lose to the file when it is not", () => {
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "123456"
  isolate()
  let s = getSettings()
  assert.equal(s.endlessMode, true)
  assert.equal(s.endlessContext, 123456)

  // "0" is the off value; anything else falls back to the default.
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "0"
  isolate()
  assert.equal(getSettings().endlessMode, false)
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "yes"
  isolate()
  assert.equal(getSettings().endlessMode, false)

  // File beats env on both keys.
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  isolate({ endlessMode: false, endlessContext: 7000 })
  s = getSettings()
  assert.equal(s.endlessMode, false)
  assert.equal(s.endlessContext, 7000)
})

test("primaryContextThreshold: endless off resolves maxPrimaryContext, endless on resolves endlessContext", () => {
  isolate({ endlessMode: false, maxPrimaryContext: 80000, endlessContext: 250000 })
  assert.equal(primaryContextThreshold(), 80000)

  isolate({ endlessMode: true, maxPrimaryContext: 80000, endlessContext: 250000 })
  assert.equal(primaryContextThreshold(), 250000)
})

test("primaryContextThreshold: endless on with endlessContext 0 arms nothing", () => {
  isolate({ endlessMode: true, maxPrimaryContext: 80000, endlessContext: 0 })
  assert.equal(primaryContextThreshold(), 0)
  recordPrimaryContext("ses-endless-threshold", 999_999)
  assert.equal(
    shouldTriggerPrimaryHandoff("ses-endless-threshold", primaryContextThreshold()),
    false,
    "endless mode on with a zero threshold is a legal state that arms nothing",
  )
})

test("writeEndlessMode: creates the file when absent and drops the cache", () => {
  const file = isolate()
  assert.equal(existsSync(file), false)
  assert.equal(getSettings().endlessMode, false)
  assert.equal(writeEndlessMode(true), true)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { endlessMode: true })
  assert.equal(getSettings().endlessMode, true, "the cache is dropped by the write")
})

test("writeEndlessMode: carries every other key over untouched", () => {
  const file = isolate({ endlessMode: true, maxSubagents: 3, searxngUrl: "http://x:1", unknown: 42 })
  assert.equal(writeEndlessMode(false), true)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    endlessMode: false,
    maxSubagents: 3,
    searxngUrl: "http://x:1",
    unknown: 42,
  })
})

test("writeEndlessMode: refuses to write over a present but unparsable file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-endless-"))
  const file = join(dir, "agent-intercom.json")
  writeFileSync(file, "{ this is not json")
  setSettingsPath(file)
  assert.equal(writeEndlessMode(true), false)
  assert.equal(readFileSync(file, "utf8"), "{ this is not json")
})

test("writeEndlessMode: refuses a file that parses but is not a JSON object", () => {
  // Content the write cannot merge into is content it must not replace — the
  // same rule as an unparsable file, and the same rule the sidebar's own
  // writer follows (createJsonObjectFile, tui/src/json-object-file.ts).
  for (const content of ["[1, 2, 3]", '"text"', "42", "null"]) {
    const dir = mkdtempSync(join(tmpdir(), "agent-intercom-endless-"))
    const file = join(dir, "agent-intercom.json")
    writeFileSync(file, content)
    setSettingsPath(file)
    assert.equal(writeEndlessMode(false), false, `${content} reported a successful write`)
    assert.equal(readFileSync(file, "utf8"), content, `${content} was written over`)
    // The stop still stands in this process, as it does on an unparsable file.
    assert.equal(getSettings().endlessMode, false)
  }
})

// Every one of endless mode's five stops is a `writeEndlessMode(false)`. If a
// failed write left the mode armed, the stop would be no stop at all: the
// primary's next turn re-arms the cycle from the file, and endlessMaxCycles
// cannot catch it (no handoff runs on a toast-only stop, so the generation
// never advances).
test("a failed write still switches the mode off in this process", () => {
  const file = isolate({ endlessMode: true })
  assert.equal(getSettings().endlessMode, true)
  // Present but unparsable: the write is refused so the user's file survives.
  writeFileSync(file, "{ this is not json")
  resetSettings()
  assert.equal(writeEndlessMode(false), false, "the value did not reach the disk")
  assert.equal(
    getSettings().endlessMode,
    false,
    "the mode is off all the same — the stop does not depend on the write succeeding",
  )
})

test("the file wins again as soon as it changes, so the sidebar can re-arm the mode", () => {
  const file = isolate({ endlessMode: true })
  writeFileSync(file, "{ this is not json")
  resetSettings()
  writeEndlessMode(false)
  assert.equal(getSettings().endlessMode, false)

  // The user repairs the file (or the sidebar toggles the row back on): the
  // plugin's own switch-off must not outlive the file it was written against.
  writeFileSync(file, JSON.stringify({ endlessMode: true, maxSubagents: 2 }))
  resetSettings()
  const s = getSettings()
  assert.equal(s.endlessMode, true, "a changed file drops the process-local hold")
  assert.equal(s.maxSubagents, 2)
})

test("a successful write is not overridden by a stale hold either", () => {
  const file = isolate({ endlessMode: true })
  assert.equal(writeEndlessMode(false), true)
  assert.equal(getSettings().endlessMode, false)
  writeFileSync(file, JSON.stringify({ endlessMode: true }))
  resetSettings()
  assert.equal(getSettings().endlessMode, true)
})
