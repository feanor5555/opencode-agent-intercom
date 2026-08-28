// The endless-mode spawn freeze (src/tools.js): while the latch is set, the
// primary's `spawn` is refused and no concurrency slot is taken. Drives the
// real plugin factory with a mock client, the way test/plugin.test.js does.
//
// The refusal is a THROW inside the spawn handler; `guard` in tools.js catches
// every handler throw and turns it into a tool result, so what the model sees
// at the tool boundary is `spawn failed: <the refusal text>`. Both halves are
// asserted here: the text reaches the model, and no session was created.
//
// Run: node --test --test-timeout=5000 test/endless-spawn-freeze.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  countActiveSubagents,
} from "../src/registry.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-freeze-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx() {
  let counter = 0
  const created = []
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
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

const toolCtx = { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" }

test("with the latch set, spawn is refused and no subagent slot is taken", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(toolCtx.sessionID)

  const before = countActiveSubagents()
  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.match(res.output, /^spawn failed: /, "the refusal is a throw, wrapped by the tool guard")
  assert.match(res.output, /Endless mode is saving this session's open points/)
  assert.match(res.output, /No new subagent will start/)
  assert.match(res.output, /End your turn now/)
  assert.equal(countActiveSubagents(), before, "the count does not change")
  assert.deepEqual(created, [], "no session was created")
})

test("the freeze also holds while the cycle is executing, not only while it is pending", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(toolCtx.sessionID)
  claimPendingEndless(toolCtx.sessionID)

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.match(res.output, /Endless mode is saving this session's open points/)
  assert.deepEqual(created, [])
})

test("with the latch cleared, spawn proceeds", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(toolCtx.sessionID)
  claimPendingEndless(toolCtx.sessionID)
  releaseEndless(toolCtx.sessionID)

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.doesNotMatch(res.output, /Endless mode/)
  assert.deepEqual(created, ["ses_sub1"])
  assert.equal(countActiveSubagents(), 1)
})
