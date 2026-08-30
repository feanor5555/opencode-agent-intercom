// Regression tests for abort/error teardown: opencode may still flush a session
// after `session.error`, so the plugin must wait for that session's idle event
// before deleting it, with a bounded fallback when no idle event arrives.

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, pendingSessionQuiescence } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { SESSION_QUIESCE_TIMEOUT_MS } from "../src/teardown.js"

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

function makeCtx() {
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
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, deleted }
}

beforeEach(() => {
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

  // The entry and slot are released by the error path, but the underlying
  // session remains protected until its own cleanup reports idle.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entryForSession(idleID), undefined)
  assert.deepEqual(deleted, [])
  assert.ok(pendingSessionQuiescence.has(idleID))

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: idleID } },
  })
  await idleTeardown
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
  // Same microtask flush as the first phase above. The error path reads the
  // session once before teardown — to recover the last text the subagent
  // produced for the error notice — so registering the quiescence guard is no
  // longer reachable within the event handler's synchronous prefix. What is
  // pinned is unchanged: the guard is registered, and nothing is deleted while
  // it holds.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(deleted, [idleID])
  assert.ok(pendingSessionQuiescence.has(timeoutID))
  await timeoutTeardown
  assert.deepEqual(deleted, [idleID, timeoutID])
  assert.equal(SESSION_QUIESCE_TIMEOUT_MS > 0, true)
})
