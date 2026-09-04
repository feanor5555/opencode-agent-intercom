// How the `show agentcom` flip reaches this process (src/agentcomsync.js:
// startAgentcomVisibilityWatch).
//
// The switch is written by the companion TUI plugin, in another process, into
// the shared settings file. What the flip is worth once observed is pinned in
// test/agentcom-retroactive.test.js; this file pins only how it ARRIVES.
//
// It arrives on an fs.watch of the directory the settings file sits in — the
// directory and not the file, because the write replaces the file and a
// file-bound watcher would then be following an inode nothing writes to again.
// The slow fallback tick is the backstop for a write the watch did not report,
// and it is deliberately slow: asking once a second is what grew debug.log to
// hundreds of megabytes, and no amount of settings-reading is worth that.
//
// Run: node --test --test-timeout=10000 test/agentcom-watch.test.js

import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AGENTCOM_FALLBACK_INTERVAL_MS,
  AGENTCOM_WATCH_DEBOUNCE_MS,
  resetAgentcomVisibilityWatch,
  startAgentcomVisibilityWatch,
} from "../src/agentcomsync.js"
import { primarySessions, resetState } from "../src/state.js"
import { setServerUrl } from "../src/client.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const SID = "ses_primary"
const URL_BASE = "http://127.0.0.1:4712"
const realFetch = globalThis.fetch
// Long enough that nothing in this file can be reached by the fallback tick:
// what these tests observe therefore came from the watch.
const NO_TICK_MS = 3600000

let tmpDir
let settingsFile

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-watch-"))
  settingsFile = join(tmpDir, "agent-intercom.json")
  setSettingsPath(settingsFile)
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  resetSettings()
  resetState()
  resetAgentcomVisibilityWatch()
  setServerUrl(URL_BASE)
})

afterEach(() => {
  globalThis.fetch = realFetch
  setServerUrl("")
  resetAgentcomVisibilityWatch()
  resetState()
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// The one notice part the sweep works on, and a client that hands it back with
// whatever flag the last PATCH left on it. Stateful on purpose: a flip back has
// nothing to write unless the first flip's write is what the session now holds.
function fixture() {
  const calls = []
  let synthetic = false
  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "user" },
            parts: [
              {
                id: "prt_a",
                sessionID: SID,
                messageID: "msg_1",
                type: "text",
                text: "\u{1F514} agent-intercom: x",
                metadata: { agentIntercom: true },
                ...(synthetic ? { synthetic: true } : {}),
              },
            ],
          },
        ],
      }),
    },
  }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    synthetic = body.synthetic === true
    calls.push({ url, method: init.method, synthetic })
    return { ok: true, status: 200 }
  }
  return { client, calls }
}

// Waits until `done()` holds or the budget runs out. Returns whether it held.
async function until(done, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (done()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return done()
}

// A settle longer than the debounce, for the assertions that nothing happened.
const settle = () =>
  new Promise((r) => setTimeout(r, AGENTCOM_WATCH_DEBOUNCE_MS + 200))

function writeSwitch(on) {
  writeFileSync(settingsFile, JSON.stringify({ showAgentcom: on }))
}

// The TUI's own write shape: a full replacement of the file, which is what a
// watcher bound to the file itself would go deaf on.
function replaceSwitch(on) {
  const staging = `${settingsFile}.tmp`
  writeFileSync(staging, JSON.stringify({ showAgentcom: on }))
  renameSync(staging, settingsFile)
}

test("the fallback tick is slow enough not to be a heartbeat", () => {
  assert.ok(
    AGENTCOM_FALLBACK_INTERVAL_MS >= 60000,
    `the fallback must not poll on the order of seconds, is ${AGENTCOM_FALLBACK_INTERVAL_MS}ms`,
  )
})

test("a write to the settings file sweeps without waiting for the tick", async () => {
  writeSwitch(true)
  resetSettings()
  primarySessions.add(SID)
  const { client, calls } = fixture()

  startAgentcomVisibilityWatch(client, { intervalMs: NO_TICK_MS })
  writeSwitch(false)

  assert.equal(
    await until(() => calls.length > 0),
    true,
    "the flip has to reach the sweep through the watch alone",
  )
  assert.equal(calls[0].method, "PATCH")
  assert.equal(calls[0].url, `${URL_BASE}/session/${SID}/message/msg_1/part/prt_a`)
})

test("a file REPLACED rather than rewritten is still noticed", async () => {
  // The directory watch is the whole point: a watch on the file would be
  // holding the replaced inode from here on and would never fire again.
  writeSwitch(true)
  resetSettings()
  primarySessions.add(SID)
  const { client, calls } = fixture()

  startAgentcomVisibilityWatch(client, { intervalMs: NO_TICK_MS })
  replaceSwitch(false)

  assert.equal(await until(() => calls.length > 0), true, "the replace has to be seen")
})

test("a second replace after the first is noticed too", async () => {
  writeSwitch(true)
  resetSettings()
  primarySessions.add(SID)
  const { client, calls } = fixture()

  startAgentcomVisibilityWatch(client, { intervalMs: NO_TICK_MS })
  replaceSwitch(false)
  assert.equal(await until(() => calls.length === 1), true, "the first flip is swept")

  replaceSwitch(true)
  assert.equal(
    await until(() => calls.length === 2),
    true,
    "the watch is still live after the inode it started on was replaced",
  )
})

test("a write that changes nothing sweeps nothing", async () => {
  writeSwitch(false)
  resetSettings()
  primarySessions.add(SID)
  const { client, calls } = fixture()

  startAgentcomVisibilityWatch(client, { intervalMs: NO_TICK_MS })
  writeSwitch(false)
  await settle()

  assert.equal(calls.length, 0, "the event says the file changed, the comparison says the value did not")
})

test("the watch is closed by the reset and reports nothing afterwards", async () => {
  writeSwitch(true)
  resetSettings()
  primarySessions.add(SID)
  const { client, calls } = fixture()

  startAgentcomVisibilityWatch(client, { intervalMs: NO_TICK_MS })
  resetAgentcomVisibilityWatch()
  writeSwitch(false)
  await settle()

  assert.equal(calls.length, 0, "a closed watch must leave no listener behind")
})

test("a settings directory that does not exist leaves the watch startable", () => {
  setSettingsPath(join(tmpDir, "absent", "agent-intercom.json"))
  const timer = startAgentcomVisibilityWatch(fixture().client, { intervalMs: NO_TICK_MS })
  assert.notEqual(timer, null, "an unwatchable directory still leaves the fallback tick running")
  assert.equal(timer.hasRef(), false)
})
