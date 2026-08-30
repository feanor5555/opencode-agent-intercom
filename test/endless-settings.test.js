// Unit tests for the endless-mode settings keys (src/settings.js):
// `endlessMode` (the file's only boolean key), `endlessContext`,
// `endlessQuiesceTimeoutMs`, `endlessMaxCycles` and the single resolution
// point `primaryContextThreshold()`, which reads the switch and the caller's
// per-session pause together (`endlessModeInEffect`).
//
// `endlessMode` is the USER's switch: nothing in src/ writes it. The mode's own
// stops pause one primary session instead (test/endless-pause.test.js), and the
// sidebar is the only half that persists a change to the key
// (test/tui-settings-write.test.js).
//
// Resolution order is the one every other key uses: file > env > default.
//
// Run: node --test --test-timeout=2000 test/endless-settings.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getSettings,
  setSettingsPath,
  resetSettings,
  primaryContextThreshold,
  endlessModeInEffect,
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

test("no file: endlessMode is true and endlessContext is 250000", () => {
  isolate()
  const s = getSettings()
  assert.equal(s.endlessMode, true)
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
    assert.equal(
      getSettings().endlessMode,
      DEFAULT_ENDLESS_MODE,
      `value ${JSON.stringify(bad)} must leave the default standing`,
    )
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
  assert.equal(getSettings().endlessMode, DEFAULT_ENDLESS_MODE)

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

test("primaryContextThreshold: a paused primary resolves maxPrimaryContext and arms on it", () => {
  // The mode is on and the file says so; only THIS session stopped itself. It
  // starts no cycle, so leaving endlessContext in effect on it would arm
  // nothing at all and the session would grow until the provider's own context
  // limit ended it.
  isolate({ endlessMode: true, maxPrimaryContext: 80000, endlessContext: 250000 })

  assert.equal(primaryContextThreshold({ endlessPaused: true }), 80000)
  assert.equal(
    primaryContextThreshold({ endlessPaused: false }),
    250000,
    "an unpaused primary still hands the threshold to endlessContext",
  )
  assert.equal(primaryContextThreshold(), 250000, "and that is the default reading")

  recordPrimaryContext("ses-endless-paused-threshold", 100_000)
  assert.equal(
    shouldTriggerPrimaryHandoff(
      "ses-endless-paused-threshold",
      primaryContextThreshold({ endlessPaused: true }),
    ),
    true,
    "100k is over the plain threshold, so the plain handoff arms on a paused primary",
  )
  assert.equal(
    shouldTriggerPrimaryHandoff(
      "ses-endless-paused-threshold",
      primaryContextThreshold({ endlessPaused: false }),
    ),
    false,
    "and under the endless one, which is why the pause may not keep it",
  )
})

test("endlessModeInEffect: the switch and the per-session pause together", () => {
  isolate({ endlessMode: true })
  assert.equal(endlessModeInEffect(), true)
  assert.equal(endlessModeInEffect({ endlessPaused: false }), true)
  assert.equal(
    endlessModeInEffect({ endlessPaused: true }),
    false,
    "a paused session is a session with the mode off, for the threshold",
  )

  isolate({ endlessMode: false })
  assert.equal(endlessModeInEffect(), false)
  assert.equal(endlessModeInEffect({ endlessPaused: true }), false)
})
