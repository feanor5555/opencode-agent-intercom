// Unit tests for the plugin debug log path (src/log.js).
//
// LOG_PATH is read at module load, so each case runs in a child process.
// Nothing here writes to the machine's ~/.cache/opencode-agent-intercom/debug.log.
//
// Run: node --test test/

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const LOG_JS = resolve(import.meta.dirname, "../src/log.js")
const DEFAULT_PATH = join(homedir(), ".cache", "opencode-agent-intercom", "debug.log")

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  if (!("OPENCODE_AGENT_INTERCOM_DEBUG_LOG" in extra)) delete env.OPENCODE_AGENT_INTERCOM_DEBUG_LOG
  if (!("OPENCODE_AGENT_INTERCOM_DEBUG" in extra)) env.OPENCODE_AGENT_INTERCOM_DEBUG = "1"
  return env
}

function printLogPath(env) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { LOG_PATH } from ${JSON.stringify(LOG_JS)}; process.stdout.write(LOG_PATH)`],
    { encoding: "utf8", env },
  )
}

test("LOG_PATH is the cache debug.log when OPENCODE_AGENT_INTERCOM_DEBUG_LOG is unset", () => {
  const r = printLogPath(childEnv())
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, DEFAULT_PATH)
})

test("LOG_PATH is OPENCODE_AGENT_INTERCOM_DEBUG_LOG when set", () => {
  const dest = join(tmpdir(), "aic-log-path-override.log")
  const r = printLogPath(childEnv({ OPENCODE_AGENT_INTERCOM_DEBUG_LOG: dest }))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, dest)
})

test("log() writes to OPENCODE_AGENT_INTERCOM_DEBUG_LOG when set", () => {
  const dir = mkdtempSync(join(tmpdir(), "aic-log-path-"))
  const dest = join(dir, "debug.log")
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { log, LOG_PATH } from ${JSON.stringify(LOG_JS)}
if (LOG_PATH !== process.env.OPENCODE_AGENT_INTERCOM_DEBUG_LOG) process.exit(2)
log("redirected-probe")`,
    ],
    { encoding: "utf8", env: childEnv({ OPENCODE_AGENT_INTERCOM_DEBUG_LOG: dest }) },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(dest, "utf8"), /redirected-probe/)
  rmSync(dir, { recursive: true, force: true })
})

test("log() creates a missing parent directory for OPENCODE_AGENT_INTERCOM_DEBUG_LOG", () => {
  const dir = mkdtempSync(join(tmpdir(), "aic-log-path-"))
  const dest = join(dir, "missing", "debug.log")
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { log, LOG_PATH } from ${JSON.stringify(LOG_JS)}
if (LOG_PATH !== process.env.OPENCODE_AGENT_INTERCOM_DEBUG_LOG) process.exit(2)
log("missing-parent-probe")`,
    ],
    { encoding: "utf8", env: childEnv({ OPENCODE_AGENT_INTERCOM_DEBUG_LOG: dest }) },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(dest, "utf8"), /missing-parent-probe/)
  rmSync(dir, { recursive: true, force: true })
})
