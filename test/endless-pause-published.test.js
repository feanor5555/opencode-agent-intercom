// The published copy of the endless self-stop pause (src/endlesspause.js), and
// that every write of the in-process pause map carries it (src/registry.js).
//
// The map is the authority for what the plugin DOES; the file exists so the
// sidebar can SHOW it, because the panel runs outside this process and used to
// paint `[on]` on a session whose loop had stopped itself. So what is pinned
// here is the mirror: the three places the map is written — pauseEndless,
// clearEndlessPause, forgetPrimary — and the pid that makes an entry readable
// only while the process that set it is still there.
//
// Everything runs under a temporary HOME, so the file under test is never the
// machine's own ~/.cache/opencode-agent-intercom/endless-pauses.json.
//
// Run: node --test --test-timeout=5000 test/endless-pause-published.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "intercom-pausefile-"))
process.env.HOME = HOME

const { resetState } = await import("../src/state.js")
const {
  endlessPauseFilePath,
  readPublishedEndlessPauses,
  unpublishEndlessPause,
  pruneDeadEndlessPauses,
  pauseWriterAlive,
} = await import("../src/endlesspause.js")
const {
  pauseEndless,
  clearEndlessPause,
  forgetPrimary,
  trackPrimary,
  isEndlessPaused,
  endlessPauseReason,
} = await import("../src/registry.js")

mkdirSync(join(HOME, ".cache", "opencode-agent-intercom"), { recursive: true })

const PRIMARY = "ses_primary"
const OTHER = "ses_other"
const NO_POINTS = "no open points left — paused for this session"
const CEILING = "cycle ceiling reached (10/10) — paused for this session"

// A pid that is certainly gone: a child that has already exited. Reused across
// the tests, and asked for once — pids are not recycled inside one test run.
const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

function fileBody() {
  return JSON.parse(readFileSync(endlessPauseFilePath(), "utf8"))
}

test.beforeEach(() => {
  resetState()
  writeFileSync(endlessPauseFilePath(), "{}\n")
})

test("the file lives in the plugin's own cache dir", () => {
  assert.equal(
    endlessPauseFilePath(),
    join(HOME, ".cache", "opencode-agent-intercom", "endless-pauses.json"),
  )
})

test("pauseEndless publishes the paused session, its reason and this pid", () => {
  const before = Date.now()
  pauseEndless(PRIMARY, NO_POINTS)
  const entry = readPublishedEndlessPauses()[PRIMARY]
  assert.ok(entry, "nothing was published for the paused session")
  assert.equal(entry.reason, NO_POINTS)
  assert.equal(entry.pid, process.pid)
  assert.ok(entry.at >= before && entry.at <= Date.now(), `at out of range: ${entry.at}`)
})

test("a second paused primary gets its own entry and neither displaces the other", () => {
  pauseEndless(PRIMARY, NO_POINTS)
  pauseEndless(OTHER, CEILING)
  const published = readPublishedEndlessPauses()
  assert.deepEqual(Object.keys(published).sort(), [OTHER, PRIMARY].sort())
  assert.equal(published[OTHER].reason, CEILING)
})

test("clearEndlessPause takes only that session off the file", () => {
  pauseEndless(PRIMARY, NO_POINTS)
  pauseEndless(OTHER, CEILING)
  clearEndlessPause(PRIMARY)
  const published = readPublishedEndlessPauses()
  assert.deepEqual(Object.keys(published), [OTHER])
})

test("forgetPrimary takes the replaced primary's pause off the file", () => {
  trackPrimary(PRIMARY)
  pauseEndless(PRIMARY, NO_POINTS)
  forgetPrimary(PRIMARY)
  assert.deepEqual(readPublishedEndlessPauses(), {})
})

test("a primary that was never paused costs no write when it is forgotten", () => {
  writeFileSync(endlessPauseFilePath(), "{}\n")
  const before = readFileSync(endlessPauseFilePath(), "utf8")
  assert.equal(unpublishEndlessPause(PRIMARY), false)
  assert.equal(readFileSync(endlessPauseFilePath(), "utf8"), before)
})

test("an entry whose writer is gone is dropped by the next write", () => {
  writeFileSync(
    endlessPauseFilePath(),
    JSON.stringify({ ses_dead: { reason: CEILING, at: 1, pid: deadPid } }),
  )
  pauseEndless(PRIMARY, NO_POINTS)
  assert.deepEqual(Object.keys(fileBody()), [PRIMARY])
})

test("pauseWriterAlive: this process yes, an exited child no, a non-pid no", () => {
  assert.equal(pauseWriterAlive(process.pid), true)
  assert.equal(pauseWriterAlive(deadPid), false)
  assert.equal(pauseWriterAlive(0), false)
  assert.equal(pauseWriterAlive(-1), false)
  assert.equal(pauseWriterAlive(undefined), false)
})

test("pruneDeadEndlessPauses keeps the live writer and drops the gone one", () => {
  const kept = pruneDeadEndlessPauses(
    {
      ses_live: { reason: "", at: 0, pid: 11 },
      ses_gone: { reason: "", at: 0, pid: 12 },
    },
    (pid) => pid === 11,
  )
  assert.deepEqual(Object.keys(kept), ["ses_live"])
})

test("a file that is missing, unparsable or not an object reads as nothing published", () => {
  writeFileSync(endlessPauseFilePath(), "{ not json")
  assert.deepEqual(readPublishedEndlessPauses(), {})
  writeFileSync(endlessPauseFilePath(), "[1,2,3]")
  assert.deepEqual(readPublishedEndlessPauses(), {})
  writeFileSync(endlessPauseFilePath(), '{"ses_x": 42, "ses_y": {"pid": 0}}')
  assert.deepEqual(readPublishedEndlessPauses(), {})
})

test("a pause published over a broken file replaces it rather than throwing", () => {
  writeFileSync(endlessPauseFilePath(), "{ not json")
  assert.equal(pauseEndless(PRIMARY, NO_POINTS), true)
  assert.deepEqual(Object.keys(fileBody()), [PRIMARY])
})

test("the pause map stays the authority: publishing is not read back into it", () => {
  writeFileSync(
    endlessPauseFilePath(),
    JSON.stringify({ [PRIMARY]: { reason: CEILING, at: 1, pid: process.pid } }),
  )
  // Nothing in the plugin asks the file whether a session is paused — the map
  // was reset, so the mode is not paused for this primary however the file
  // reads. The entry only survives until a write prunes or replaces it.
  assert.equal(isEndlessPaused(PRIMARY), false)
  assert.equal(endlessPauseReason(PRIMARY), "")
})

test("no temp file is left beside the published one", () => {
  pauseEndless(PRIMARY, NO_POINTS)
  assert.equal(existsSync(`${endlessPauseFilePath()}.${process.pid}.tmp`), false)
})
