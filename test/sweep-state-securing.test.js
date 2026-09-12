// The bootstrap sweep must SECURE a leftover subagent's state before it deletes
// the session that holds it.
//
// The sweep is the collector for the sessions a `hold` leaves behind: a
// mid-work ending whose state could not be filed keeps the opencode session
// standing precisely because it is the only remaining copy (src/teardown.js
// `hold`, src/resultfile.js `secureSubagentState`). Until this rule the sweep
// deleted exactly those sessions unread at the next plugin load, which undid
// every hold the previous process had taken.
//
// What is pinned here:
//   - a candidate is read one last time and its reply written to a result file
//     before the delete, and the file carries the reply verbatim;
//   - the file lands in the directory the SESSION carries — the registry entry
//     that used to carry it died with the previous process — with the sweep's
//     own directory as the fallback and the private cache dir behind that;
//   - a candidate whose state cannot be secured is HELD: not deleted, and not
//     reported as swept;
//   - the hold is bounded. ORPHAN_SWEEP_HOLD_GRACE_MS past the sweep's own age
//     bound the session is deleted unfiled, so a session nothing can ever read
//     is not an immortal row;
//   - nothing is read for a session that fails an attribution criterion.
//
// Run: node --test test/sweep-state-securing.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetState } from "../src/state.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { PROJECT_RESULT_PREFIX, resultsDir } from "../src/resultfile.js"
import {
  sweepOrphanedSubagentSessions,
  SUBAGENT_SESSION_TITLE_MARKER,
  ORPHAN_SWEEP_TTL_FACTOR,
  ORPHAN_SWEEP_MIN_AGE_MS,
  ORPHAN_SWEEP_WATCHDOG_FACTOR,
  ORPHAN_SWEEP_HOLD_GRACE_MS,
  ORPHAN_RESULT_HANDLE,
} from "../src/teardown.js"

// The whole file runs against a temp HOME: one case falls back to the private
// cache dir, which is derived from it.
const realHome = process.env.HOME
const home = mkdtempSync(join(tmpdir(), "intercom-sweepsecure-home-"))
process.env.HOME = home

function project(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "main.js"), "// fixture")
  return dir
}

// The project the plugin load runs in, and a second one a leftover session may
// have been spawned into. Two of them is what makes "the session's own
// directory" a statement and not a coincidence.
const sweepDir = project("intercom-sweepsecure-")
const ownDir = project("intercom-sweepsecure-own-")

const settingsFile = join(sweepDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => {
  process.env.HOME = realHome
  for (const dir of [home, sweepDir, ownDir]) rmSync(dir, { recursive: true, force: true })
})

const TTL = 3600000
const SILENCE = 90000
const IN_TOOL = 660000
const SETTINGS = {
  maxRetainedSubagents: 3,
  retainedSubagentTtlMs: TTL,
  maxSubagentAgeMs: SILENCE,
  maxSubagentToolCallMs: IN_TOOL,
}
// The bound the sweep computes from those settings, mirrored here so the ages
// below are stated against the same figure the code uses.
const MIN_AGE = Math.max(
  ORPHAN_SWEEP_TTL_FACTOR * TTL,
  ORPHAN_SWEEP_MIN_AGE_MS,
  ORPHAN_SWEEP_WATCHDOG_FACTOR * Math.max(SILENCE, IN_TOOL),
)
const now = Date.now()
const IDLE_SINCE = now - MIN_AGE - 60000

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  for (const dir of [sweepDir, ownDir]) rmSync(join(dir, "work"), { recursive: true, force: true })
  rmSync(join(home, ".cache"), { recursive: true, force: true })
  writeFileSync(settingsFile, JSON.stringify(SETTINGS))
  resetSettings()
})

// One session record as `session.list` returns it. The defaults are a leaked
// subagent session: this plugin's marker, a parent, long idle, and its own
// project directory as the server reports it.
function session(id, over = {}) {
  return {
    id,
    parentID: "ses_old_primary",
    directory: ownDir,
    title: `${SUBAGENT_SESSION_TITLE_MARKER}planner: do x`,
    time: { created: IDLE_SINCE, updated: IDLE_SINCE },
    ...over,
  }
}

const textPart = (text) => ({ type: "text", text })
const assistantReply = (text) => [
  { info: { role: "user" }, parts: [textPart("task")] },
  {
    info: { role: "assistant", tokens: { input: 100, output: 10 }, time: { completed: 1 } },
    parts: [textPart(text)],
  },
]

// `replies` maps a session id to what its last read answers: an array of
// messages, or the string "unreadable" for the read that does not answer at all
// — the case the whole hold rule turns on.
function makeClient({ sessions = [], replies = {} } = {}) {
  const deleted = []
  const read = []
  const client = {
    session: {
      list: async () => ({ data: sessions }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      messages: async (opts) => {
        const id = opts?.path?.id
        read.push(id)
        const reply = replies[id]
        if (reply === "unreadable") throw new Error("connection reset")
        return { data: reply ?? [] }
      },
      get: async () => ({ data: { directory: ownDir } }),
    },
    tui: { showToast: async () => ({ data: true }) },
  }
  return { client, deleted, read }
}

const sweep = (client, opts = {}) =>
  sweepOrphanedSubagentSessions(client, { directory: sweepDir, now, ...opts })

const resultFiles = (dir) => {
  const workDir = join(dir, "work")
  if (!existsSync(workDir)) return []
  return readdirSync(workDir).filter((name) => name.startsWith(PROJECT_RESULT_PREFIX))
}

// ---- the securing step -------------------------------------------------------

test("a leftover's reply is filed before its session is deleted", async () => {
  const reply = "the work this subagent had done when its process died"
  const { client, deleted, read } = makeClient({
    sessions: [session("ses_leaked")],
    replies: { ses_leaked: assistantReply(reply) },
  })

  assert.deepEqual(await sweep(client), ["ses_leaked"])
  assert.deepEqual(read, ["ses_leaked"], "the candidate is read exactly once")
  assert.deepEqual(deleted, ["ses_leaked"], "and deleted, because the state reached a file")

  const files = resultFiles(ownDir)
  assert.deepEqual(files, [`${PROJECT_RESULT_PREFIX}${ORPHAN_RESULT_HANDLE}-ses_leaked.md`])
  const body = readFileSync(join(ownDir, "work", files[0]), "utf8")
  assert.ok(body.endsWith(reply), "the reply is in the file verbatim")
  assert.match(body, /^# subagent result — orphan \(unknown\)$/m)
  assert.match(body, /^session: ses_leaked$/m)
  assert.match(
    body,
    new RegExp(`^finished: ${new Date(IDLE_SINCE).toISOString()}$`, "m"),
    "dated when the session last moved, not when the sweep ran",
  )
})

test("a leftover that said nothing is deleted and files nothing", async () => {
  const { client, deleted } = makeClient({ sessions: [session("ses_silent")] })

  assert.deepEqual(await sweep(client), ["ses_silent"])
  assert.deepEqual(deleted, ["ses_silent"])
  assert.deepEqual(resultFiles(ownDir), [], "there is nothing to lose and nothing to write")
})

test("only a candidate is read; an unattributable session is not touched", async () => {
  const { client, deleted, read } = makeClient({
    sessions: [
      // No marker: not this plugin's.
      session("ses_foreign", { title: "a user's own session" }),
      // A primary: no parent.
      session("ses_primary_like", { parentID: undefined }),
      // Too young for the bound.
      session("ses_young", { time: { created: now, updated: now - MIN_AGE + 1000 } }),
    ],
    replies: { ses_foreign: assistantReply("x") },
  })

  assert.deepEqual(await sweep(client), [])
  assert.deepEqual(read, [], "the securing read costs nothing on a session the sweep will not judge")
  assert.deepEqual(deleted, [])
})

// ---- where the file lands ----------------------------------------------------

test("the file goes to the session's own directory, not the sweep's", async () => {
  const { client } = makeClient({
    sessions: [session("ses_elsewhere")],
    replies: { ses_elsewhere: assistantReply("filed where it ran") },
  })

  await sweep(client)
  assert.equal(resultFiles(ownDir).length, 1, "the session's own project holds it")
  assert.deepEqual(resultFiles(sweepDir), [], "the project this load runs in holds nothing")
})

test("a session the server reports no directory for falls back to the sweep's", async () => {
  const { client } = makeClient({
    sessions: [session("ses_nodir", { directory: undefined })],
    replies: { ses_nodir: assistantReply("filed against this load's project") },
  })

  await sweep(client)
  assert.deepEqual(resultFiles(sweepDir), [
    `${PROJECT_RESULT_PREFIX}${ORPHAN_RESULT_HANDLE}-ses_nodir.md`,
  ])
})

test("a relative session directory is no directory: the file falls back to the cache", async () => {
  // `directory` is whatever the row carries; a relative one names nothing
  // reliable, which is the same rule overflowTarget applies to a live entry.
  const { client, deleted } = makeClient({
    sessions: [session("ses_relative", { directory: "some/relative/path" })],
    replies: { ses_relative: assistantReply("filed in the private cache") },
  })

  assert.deepEqual(await sweep(client, { directory: undefined }), ["ses_relative"])
  assert.deepEqual(deleted, ["ses_relative"])
  assert.deepEqual(readdirSync(resultsDir()), [`${ORPHAN_RESULT_HANDLE}-ses_relative.md`])
})

// ---- the hold ----------------------------------------------------------------

test("a session that cannot be READ is held, not deleted", async () => {
  const { client, deleted, read } = makeClient({
    sessions: [session("ses_unreadable")],
    replies: { ses_unreadable: "unreadable" },
  })

  assert.deepEqual(await sweep(client), [], "a held session is not reported as swept")
  assert.deepEqual(read, ["ses_unreadable"])
  assert.deepEqual(deleted, [], "nothing is established about it, so it stays")
})

test("a session whose file cannot be WRITTEN is held, not deleted", async () => {
  // A plain file where `work/` has to be a directory: the recursive mkdir in
  // writeOverflow throws EEXIST and nothing is secured.
  writeFileSync(join(ownDir, "work"), "not a directory")
  const { client, deleted } = makeClient({
    sessions: [session("ses_unfiled")],
    replies: { ses_unfiled: assistantReply("the only copy there is") },
  })

  assert.deepEqual(await sweep(client), [])
  assert.deepEqual(deleted, [], "the session is the last copy of a reply that reached no file")
})

test("a held session is filed and deleted by a later sweep once the read answers", async () => {
  // The hold is not a state of the session, only of the sweep's last attempt:
  // the next load meets the same candidate and tries again.
  const first = makeClient({
    sessions: [session("ses_retry")],
    replies: { ses_retry: "unreadable" },
  })
  assert.deepEqual(await sweep(first.client), [])
  assert.deepEqual(first.deleted, [])

  const second = makeClient({
    sessions: [session("ses_retry")],
    replies: { ses_retry: assistantReply("readable this time") },
  })
  assert.deepEqual(await sweep(second.client), ["ses_retry"])
  assert.deepEqual(second.deleted, ["ses_retry"])
  assert.equal(resultFiles(ownDir).length, 1)
})

test("the hold ends ORPHAN_SWEEP_HOLD_GRACE_MS past the sweep's own bound", async () => {
  const graceBound = MIN_AGE + ORPHAN_SWEEP_HOLD_GRACE_MS
  const { client, deleted } = makeClient({
    sessions: [
      session("ses_within_grace", {
        time: { created: 0, updated: now - graceBound },
      }),
      session("ses_past_grace", {
        time: { created: 0, updated: now - graceBound - 1 },
      }),
    ],
    replies: { ses_within_grace: "unreadable", ses_past_grace: "unreadable" },
  })

  assert.deepEqual(
    await sweep(client),
    ["ses_past_grace"],
    "the grace is exclusive at its edge, exactly like the age bound",
  )
  assert.deepEqual(deleted, ["ses_past_grace"])
})

test("the grace sits ON TOP of the age bound, so a wide watchdog cannot spend it", async () => {
  // A tool-call window wide enough to push the age bound past the grace itself.
  // An absolute cap would already be spent the first time such a candidate is
  // seen, and the hold would never happen at all.
  const inTool = ORPHAN_SWEEP_HOLD_GRACE_MS
  writeFileSync(
    settingsFile,
    JSON.stringify({ ...SETTINGS, maxSubagentToolCallMs: inTool }),
  )
  resetSettings()
  const bound = ORPHAN_SWEEP_WATCHDOG_FACTOR * inTool
  assert.ok(bound > ORPHAN_SWEEP_HOLD_GRACE_MS, "the age bound alone is past a week")

  const { client, deleted } = makeClient({
    sessions: [session("ses_wide", { time: { created: 0, updated: now - bound - 1 } })],
    replies: { ses_wide: "unreadable" },
  })

  assert.deepEqual(await sweep(client), [], "a fresh candidate still gets its full grace")
  assert.deepEqual(deleted, [])
})
