// Regression tests for abort/error teardown: opencode still flushes a session
// after `session.error` — that event is published from the run fiber's
// interrupt handler, the flush from the finalizer behind it — so the plugin
// must wait for that session's idle event both before READING the session for
// the text it rescues and before deleting it, with a bounded fallback when no
// idle event arrives. And the other way round on the abort paths, where the
// idle event has already gone by when the wait is armed: a wait that arms
// after it must not sit out its timeout for a session that is already still.

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, pendingSessionQuiescence, quiescedSessions } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import {
  SESSION_QUIESCE_TIMEOUT_MS,
  QUIESCE_MARK_TTL_MS,
  signalSessionIdle,
  waitForSessionQuiescence,
} from "../src/teardown.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-abort-quiescence-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// `messages` supplies the session's message list on every read (and is what
// makes a read observable at all), `onPrompt` sees every posted notice, and
// `onAbort` stands in for whatever opencode does inside its own abort request
// — the place it publishes the aborted session's `session.idle`.
function makeCtx({ messages = () => [], onPrompt, onAbort } = {}) {
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
      abort: async (opts) => {
        await onAbort?.(opts?.path?.id)
        return { data: true }
      },
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: messages() }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, deleted }
}

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

test("abort/error teardown deletes only after idle or its bounded timeout", async () => {
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)

  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const idleID = created[0]
  const idleTeardown = hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: idleID,
        error: { name: "MessageAbortedError", data: { message: "stopped" } },
      },
    },
  })

  // The whole tail of the error path — the rescue read, the notice, the entry
  // removal, the delete — is parked on the session's own quiescence, so at
  // this point the entry is still registered (latched `errored`, so no other
  // path takes it) and nothing has been deleted.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(deleted, [])
  assert.ok(pendingSessionQuiescence.has(idleID))

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: idleID } },
  })
  await idleTeardown
  // Only now are the entry and its slot released, and the session deleted.
  assert.equal(entryForSession(idleID), undefined)
  assert.deepEqual(deleted, [idleID])

  // No idle signal is delivered for this session. The same teardown therefore
  // reaches DELETE only when the named rescue timeout expires, and does so once.
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const timeoutID = created[1]
  const timeoutTeardown = hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID: timeoutID,
        error: { name: "MessageAbortedError", data: { message: "stopped" } },
      },
    },
  })

  assert.deepEqual(deleted, [idleID])
  // Same microtask flush as the first phase above: the guard is registered,
  // and nothing is deleted while it holds.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(deleted, [idleID])
  assert.ok(pendingSessionQuiescence.has(timeoutID))
  await timeoutTeardown
  assert.deepEqual(deleted, [idleID, timeoutID])
  assert.equal(SESSION_QUIESCE_TIMEOUT_MS > 0, true)
})

// ---- the rescue read on the error path ---------------------------------------

// opencode publishes `session.error` from inside its run fiber's interrupt
// handler, BEFORE the finalizer that flushes the in-flight text part. A
// snapshot taken on receipt of that event therefore still sees the pre-flush
// state of the session and loses the paragraph the subagent was in the middle
// of. The session below models exactly that: it answers with the earlier,
// completed step until its flush has happened, and with the whole final
// paragraph afterwards, and the flush is tied to the same `session.idle` event
// opencode reports it with.
const EARLIER = "Done: only the earlier step, before the last paragraph."
const FLUSHED = "Done: the whole final paragraph, flushed by the cleanup."

function flushingSession(isFlushed) {
  return () => [
    {
      info: { role: "assistant", tokens: { input: 700, output: 0 } },
      parts: [{ type: "text", text: isFlushed() ? FLUSHED : EARLIER }],
    },
  ]
}

test("the error path's rescue read waits for the flush the error event precedes", async () => {
  let flushed = false
  let reads = 0
  const posted = []
  const { ctx, created } = makeCtx({
    messages: () => {
      reads += 1
      return flushingSession(() => flushed)()
    },
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)

  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  posted.length = 0
  reads = 0

  const teardown = hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "APIError", data: { message: "context length exceeded" } },
      },
    },
  })

  // The quiescence wait is armed BEFORE the read, not only before the delete:
  // no read has happened yet, and the session is still protected.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 0, "the rescue read must not run before the session has gone quiet")
  assert.ok(pendingSessionQuiescence.has(sessionID))

  flushed = true
  await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  await teardown

  assert.equal(reads, 1, "the session is read exactly once, after the flush")
  const notice = posted.map((p) => p.text).join("\n")
  assert.match(notice, /failed: APIError: context length exceeded/)
  assert.match(notice, /the whole final paragraph, flushed by the cleanup/)
  assert.doesNotMatch(notice, /only the earlier step/)
})

test("the rescue read still happens when no idle event ever arrives", async () => {
  let reads = 0
  const posted = []
  const { ctx, created, deleted } = makeCtx({
    messages: () => {
      reads += 1
      return flushingSession(() => true)()
    },
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)

  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  posted.length = 0
  reads = 0

  // No `session.idle` is delivered. The bounded fallback releases the read, so
  // the notice still carries the text and the session is still deleted.
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } },
    },
  })

  assert.equal(reads, 1)
  assert.match(posted.map((p) => p.text).join("\n"), /the whole final paragraph/)
  assert.deepEqual(deleted, [sessionID])
  // And the wait is not paid twice: the teardown behind the read does not arm a
  // second one for an idle event that is never coming.
  assert.equal(pendingSessionQuiescence.has(sessionID), false)
})

// ---- an idle already seen answers the next wait -------------------------------

test("a session that has already gone idle answers the next quiescence wait at once", async () => {
  const sessionID = "ses_already_idle"
  assert.equal(signalSessionIdle(sessionID), false, "nothing is waiting on it yet")

  const started = Date.now()
  const reason = await waitForSessionQuiescence(sessionID)
  assert.equal(reason, "idle")
  assert.ok(
    Date.now() - started < SESSION_QUIESCE_TIMEOUT_MS,
    "the wait must not sit out its timeout for a session that is already still",
  )
  // Nothing was armed, so nothing is left behind to time out later.
  assert.equal(pendingSessionQuiescence.has(sessionID), false)
  // And the record is consumed: a second wait is a wait again.
  assert.equal(quiescedSessions.has(sessionID), false)
  assert.equal(await waitForSessionQuiescence(sessionID, 20), "timeout")
})

test("an idle older than its TTL says nothing about a run started since", async () => {
  const sessionID = "ses_stale_idle"
  quiescedSessions.set(sessionID, Date.now() - QUIESCE_MARK_TTL_MS - 1000)
  assert.equal(await waitForSessionQuiescence(sessionID, 20), "timeout")
  assert.equal(quiescedSessions.has(sessionID), false)
})

// ---- the watchdog path --------------------------------------------------------

// Spawns one subagent, back-dates it past the inactivity window and runs the
// real sweep over it, timing the whole reap. `onAbort` is what opencode does
// inside its own abort request.
async function timedReap({ onAbort }) {
  const abortHook = { fire: null }
  const { ctx, created, deleted } = makeCtx({
    messages: () => flushingSession(() => true)(),
    onAbort: (id) => abortHook.fire?.(id),
  })
  const hooks = await plugin(ctx)
  abortHook.fire = onAbort ? (id) => onAbort(hooks, id) : null
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  entryForSession(sessionID).lastActivityAt = Date.now() - 600_000
  const started = Date.now()
  await sweepWatchdog()
  return { elapsed: Date.now() - started, sessionID, deleted }
}

test("the watchdog teardown does not pay the quiescence timeout for an already idle session", async () => {
  const { elapsed, sessionID, deleted } = await timedReap({
    onAbort: (hooks, id) =>
      hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } }),
  })
  assert.deepEqual(deleted, [sessionID])
  assert.ok(
    elapsed < SESSION_QUIESCE_TIMEOUT_MS,
    `the reap must not burn the quiescence timeout after an abort that went idle (took ${elapsed} ms)`,
  )
})

test("the watchdog teardown still waits when nothing reports the session idle", async () => {
  const { elapsed, sessionID, deleted } = await timedReap({ onAbort: null })
  assert.deepEqual(deleted, [sessionID])
  assert.ok(
    elapsed >= SESSION_QUIESCE_TIMEOUT_MS,
    `an unreported session must still be waited out before the delete (took ${elapsed} ms)`,
  )
})
