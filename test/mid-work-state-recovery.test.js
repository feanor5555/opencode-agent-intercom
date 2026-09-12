// A subagent torn down MID-WORK must leave its state behind in a file, and
// where it cannot, its session must be held rather than deleted.
//
// The loss this pins: an aborted subagent's reply that FITS the reply ceiling
// used to be filed nowhere — the file was only ever the overflow behind a cut —
// while the teardown deleted the session that held the work. Every mid-work
// ending now goes through `secureSubagentState` (src/resultfile.js) instead:
//
//   1. src/hooks.js  onSessionError   — the abort/error event.
//   2. src/watchdog.js timeoutSubagent — the inactivity reap.
//   3. src/tools.js  the `abort` tool  — the orchestrator's own stop.
//
// and each of the three files whatever it rescued, deletes the session only
// where that write took, and holds it where the write failed or the session
// could not be read at all.
//
// Run: node --test test/mid-work-state-recovery.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { PROJECT_RESULT_PREFIX } from "../src/resultfile.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-midwork-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  rmSync(join(fixtureDir, "work"), { recursive: true, force: true })
  resetSettings()
})

const textPart = (text) => ({ type: "text", text })
const assistantReply = (text) => [
  { info: { role: "user" }, parts: [textPart("task")] },
  {
    info: { role: "assistant", tokens: { input: 100, output: 10 }, time: { completed: 1 } },
    parts: [textPart(text)],
  },
]

// `readFails` is the case the whole hold rule turns on: the last read of the
// session does not answer, so nothing is established about what is in it.
function makeCtx({ messages = [], readFails = false, onPrompt } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        onPrompt?.(opts?.path?.id, (opts?.body?.parts ?? []).map((p) => p.text).join("\n"))
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => {
        if (readFails) throw new Error("connect ECONNREFUSED")
        return { data: messages }
      },
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, deleted }
}

// The result files the subagent's own project directory received. That is where
// overflowTarget puts them for a subagent whose entry carries an absolute
// directory, which every subagent spawned here does.
function filedResults() {
  try {
    return readdirSync(join(fixtureDir, "work")).filter((f) => f.startsWith(PROJECT_RESULT_PREFIX))
  } catch {
    return []
  }
}

async function spawnCoder(hooks, created) {
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  return created[created.length - 1]
}

// ---- 1. the inactivity reap -------------------------------------------------

// The reap is a mid-work ending: several finished steps deep, and the session
// about to be deleted is the only place they live. A rescued reply SHORT enough
// to pass the ceiling whole is filed all the same — the case that used to file
// nothing.
test("the watchdog files a rescued reply that fits the ceiling, and then deletes", async () => {
  const short = "Done: rewrote the parser; the migration is still open."
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply(short) })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)

  entryForSession(sessionID).lastActivityAt = Date.now() - 700_000
  await sweepWatchdog()

  const files = filedResults()
  assert.equal(files.length, 1, `the reaped subagent's state must be filed: ${files}`)
  assert.ok(
    readFileSync(join(fixtureDir, "work", files[0]), "utf8").endsWith(short),
    "the file must hold the rescued reply verbatim",
  )
  assert.deepEqual(deleted, [sessionID], "and only then may the session go")
})

// The other half of the rule on the same path: nothing reached a file, so the
// session is the only remaining copy and is kept.
test("the watchdog holds the session when its last read fails", async () => {
  const posted = []
  const { ctx, created, deleted } = makeCtx({
    readFails: true,
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)
  posted.length = 0

  entryForSession(sessionID).lastActivityAt = Date.now() - 700_000
  await sweepWatchdog()

  assert.deepEqual(deleted, [], "an unread session must not be deleted")
  assert.equal(entryForSession(sessionID), undefined, "its slot is freed all the same")
  const notice = posted.map((p) => p.text).join("\n")
  assert.match(notice, /being HELD, not destroyed/)
  assert.match(notice, /could not be read one last time/)
})

// A session that answered and simply said nothing is not the unreadable case:
// there is nothing to file and nothing to lose, so it goes as it always did.
test("a reaped session that answers with no text is deleted, not held", async () => {
  const { ctx, created, deleted } = makeCtx({
    messages: [{ info: { role: "user" }, parts: [textPart("task")] }],
  })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)

  entryForSession(sessionID).lastActivityAt = Date.now() - 700_000
  await sweepWatchdog()

  assert.deepEqual(deleted, [sessionID])
  assert.deepEqual(filedResults(), [], "nothing was produced, so nothing is filed")
})

// ---- 2. the abort/error event ------------------------------------------------

test("session.error files a rescued reply that fits the ceiling, and then deletes", async () => {
  const short = "Done: mapped the call sites; the migration is not written."
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply(short) })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)

  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "MessageAbortedError", data: { message: "stopped" } },
      },
    },
  })

  const files = filedResults()
  assert.equal(files.length, 1, `an aborted subagent's state must be filed: ${files}`)
  assert.ok(readFileSync(join(fixtureDir, "work", files[0]), "utf8").endsWith(short))
  assert.deepEqual(deleted, [sessionID])
})

test("session.error holds the session when its last read fails", async () => {
  const posted = []
  const { ctx, created, deleted } = makeCtx({
    readFails: true,
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)
  posted.length = 0

  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID, error: { name: "APIError", data: { message: "boom" } } },
    },
  })

  assert.deepEqual(deleted, [])
  const notice = posted.map((p) => p.text).join("\n")
  assert.match(notice, /being HELD, not destroyed/)
  assert.match(notice, /could not be read one last time/)
})

// ---- 3. the `abort` tool -----------------------------------------------------

// The path the loss was measured on: the orchestrator stops a subagent itself.
// This handler ends the session without going through teardownSubagent, so it
// carries the rule itself — and its own answer is where the orchestrator is
// told the file exists.
test("the abort tool files the subagent's state and names the file", async () => {
  const short = "Done: read six files; the fix is drafted in src/parser.js."
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply(short) })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)
  const handle = entryForSession(sessionID).handle

  const { output } = await hooks.tool.abort.execute({ subagent: handle }, toolCtx)

  const files = filedResults()
  assert.equal(files.length, 1, `an aborted subagent's state must be filed: ${files}`)
  const path = join(fixtureDir, "work", files[0])
  assert.ok(readFileSync(path, "utf8").endsWith(short))
  assert.ok(output.includes(path), `the abort answer must name the file: ${output}`)
  assert.deepEqual(deleted, [sessionID], "and only then may the session go")
})

test("the abort tool holds the session when its state cannot be filed", async () => {
  const { ctx, created, deleted } = makeCtx({ readFails: true })
  const hooks = await plugin(ctx)
  const sessionID = await spawnCoder(hooks, created)
  const handle = entryForSession(sessionID).handle

  const { output } = await hooks.tool.abort.execute({ subagent: handle }, toolCtx)

  assert.deepEqual(deleted, [], "the only remaining copy must not be deleted")
  assert.match(output, /HELD/)
  assert.ok(output.includes(sessionID), `the answer must name the held session: ${output}`)
  assert.equal(entryForSession(sessionID), undefined, "the slot is freed either way")
})
