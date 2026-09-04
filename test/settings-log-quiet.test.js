// What getSettings() writes to the debug log (src/settings.js).
//
// The resolve is not a rare event: the cache lives 2s, and the agentcom watch
// (src/agentcomsync.js) resolves once a second for as long as opencode runs. A
// line per resolve is therefore a heartbeat that says nothing and grows
// ~/.cache/opencode-agent-intercom/debug.log without bound — it reached 352 MB
// on one long-running instance. What a reader needs is the settings that were
// in effect and every change to them, which is what these tests pin.
//
// Run in a child process with its own HOME so the assertions are made against a
// log this test alone wrote.
//
// Run: node --test test/settings-log-quiet.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const settingsUrl = new URL("../src/settings.js", import.meta.url).href

// Runs `script` in a child with a private HOME and returns the "settings
// resolved" lines its debug log holds afterwards.
function resolvedLines(script) {
  const home = mkdtempSync(join(tmpdir(), "intercom-settings-log-"))
  const settingsFile = join(home, ".config", "opencode", "agent-intercom.json")
  mkdirSync(join(home, ".config", "opencode"), { recursive: true })
  try {
    const source = `
      import { writeFileSync } from "node:fs"
      import { getSettings, resetSettings } from ${JSON.stringify(settingsUrl)}
      const settingsFile = ${JSON.stringify(settingsFile)}
      const write = (o) => writeFileSync(settingsFile, JSON.stringify(o))
      ${script}
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        OPENCODE_AGENT_INTERCOM_DEBUG: "1",
      },
    })
    assert.equal(result.status, 0, result.stderr)
    const logPath = join(home, ".cache", "opencode-agent-intercom", "debug.log")
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.includes("settings resolved"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("the first resolve of a process is logged", () => {
  const lines = resolvedLines("getSettings()")
  assert.equal(lines.length, 1, "a reader has to see the settings the process started with")
  assert.match(lines[0], /"maxSubagents":/)
})

test("re-resolving the same settings writes nothing", () => {
  // Exactly the agentcom watch's pattern: the cache goes, the values do not.
  const lines = resolvedLines(`
    getSettings()
    for (let i = 0; i < 50; i++) { resetSettings(); getSettings() }
  `)
  assert.equal(lines.length, 1, "51 resolves of one unchanged value are one line, not 51")
})

test("a changed value is logged, and only the change", () => {
  const lines = resolvedLines(`
    getSettings()
    resetSettings(); getSettings()
    write({ maxSubagents: 7 })
    resetSettings(); getSettings()
    resetSettings(); getSettings()
    resetSettings(); getSettings()
  `)
  assert.equal(lines.length, 2, "one line for the start, one for the change")
  assert.equal(lines[1].includes('"maxSubagents":7'), true, "the new value is what the line carries")
  assert.equal(lines[0].includes('"maxSubagents":7'), false)
})

test("a value that changes back is logged again", () => {
  // The signature is the settings in effect, not a set of values already seen:
  // going back to the default is as much a change as leaving it.
  const lines = resolvedLines(`
    write({ maxSubagents: 7 })
    getSettings()
    write({ maxSubagents: 3 })
    resetSettings(); getSettings()
    write({ maxSubagents: 7 })
    resetSettings(); getSettings()
  `)
  assert.equal(lines.length, 3)
  assert.equal(lines[2].includes('"maxSubagents":7'), true)
})

test("the log line still masks the Exa key", () => {
  const lines = resolvedLines(`
    write({ exaApiKey: "exa-secret-value" })
    getSettings()
  `)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].includes("exa-secret-value"), false, "the key is a secret")
  assert.match(lines[0], /"exaApiKey":"<set>"/)
})

test("src/settings.js holds no unconditional log of the resolved object", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/settings.js", import.meta.url)),
    "utf8",
  )
  const call = source.indexOf('log("settings resolved"')
  assert.notEqual(call, -1, "the line itself stays — a reader needs the settings in effect")
  const guard = source.lastIndexOf("if (signature !== loggedSettings) {", call)
  assert.notEqual(guard, -1, "the call sits behind the change check")
  assert.ok(call - guard < 200, "the change check is the call's own guard, not a distant one")
})
