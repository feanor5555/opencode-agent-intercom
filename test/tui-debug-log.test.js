// The sidebar panel's own debug log (tui/src/debug-log.ts).
//
// The panel used to write nothing. When the TUI dropped to its start page there
// was no way to tell which of the two holes in the route escape had fired,
// because neither the route at the moment of the deletion nor the panel's row
// map was observable from outside. The panel now writes into the same file the
// plugin half writes, in the same shape, so its lines interleave by time with
// the spawn and teardown lines around them.
//
// The write tests run in a child process with its own HOME, so what is asserted
// is a log this test alone wrote.
//
// Run: node --test test/tui-debug-log.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { debugLogLine } from "../tui/src/debug-log.ts"

const tuiLogUrl = new URL("../tui/src/debug-log.ts", import.meta.url).href
const pluginLogUrl = new URL("../src/log.js", import.meta.url).href

// Runs `script` in a child with a private HOME and returns the lines its debug
// log holds afterwards.
function loggedLines(script, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "intercom-tui-log-"))
  try {
    const source = `
      import { debugLog } from ${JSON.stringify(tuiLogUrl)}
      import { log as pluginLog } from ${JSON.stringify(pluginLogUrl)}
      ${script}
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, OPENCODE_AGENT_INTERCOM_DEBUG: "1", ...env },
    })
    assert.equal(result.status, 0, result.stderr)
    const logPath = join(home, ".cache", "opencode-agent-intercom", "debug.log")
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("a line is an ISO timestamp, the message, and JSON for everything else", () => {
  const now = new Date("2026-09-04T10:28:29.480Z")
  assert.equal(
    debugLogLine(["tui route escape", { sessionID: "ses_a", target: null }], now),
    '2026-09-04T10:28:29.480Z tui route escape {"sessionID":"ses_a","target":null}\n',
  )
})

test("the panel writes into the plugin's own log file, in the plugin's own shape", () => {
  const lines = loggedLines(`
    pluginLog("plugin line", { a: 1 })
    debugLog("tui line", { a: 1 })
  `)
  assert.equal(lines.length, 2, "both halves append to the one file")
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (.+) \{"a":1\}$/
  const plugin = shape.exec(lines[0])
  const tui = shape.exec(lines[1])
  assert.notEqual(plugin, null, lines[0])
  assert.notEqual(tui, null, lines[1])
  assert.equal(plugin[1], "plugin line")
  assert.equal(tui[1], "tui line")
})

test("OPENCODE_AGENT_INTERCOM_DEBUG=0 turns the panel's lines off", () => {
  assert.deepEqual(
    loggedLines('debugLog("tui line", { a: 1 })', { OPENCODE_AGENT_INTERCOM_DEBUG: "0" }),
    [],
  )
})

test("a log that cannot be written does not take the panel down", () => {
  // The cache dir is occupied by a FILE, so mkdir and append both fail. The
  // call has to return normally all the same: a log that fails is a log that
  // did not happen, never a panel that crashed.
  const lines = loggedLines(`
    import { mkdirSync, writeFileSync } from "node:fs"
    import { homedir } from "node:os"
    import { join } from "node:path"
    mkdirSync(join(homedir(), ".cache"), { recursive: true })
    writeFileSync(join(homedir(), ".cache", "opencode-agent-intercom"), "not a directory")
    debugLog("tui line", { a: 1 })
    process.stdout.write("survived")
  `)
  assert.deepEqual(lines, [])
})
