// The endless cycle's wind-down permit: the one spawn a winding-down cycle recognises as its own.
//
// Two halves. The permit state in src/registry.js — armed, consumed atomically,
// restored at most once, disarmed — and the admission branch in `spawnHandler`
// that reads it: the conforming call is recognised once and blocks on its child;
// a wrong token, a wrong agent, a nested caller and a second call are ordinary
// spawns that leave the permit alone. Spawn is open through the whole cycle.
//
// Run: node --test test/wind-down-permit.test.js

import test, { beforeEach, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import {
  resetState,
  endlessWindDownPermits,
  pendingChildResults,
  endlessWindingDown,
} from "../src/state.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  armEndlessWindDown,
  endlessWindDownPermit,
  consumeEndlessWindDown,
  restoreEndlessWindDown,
  noteEndlessWindDownChild,
  disarmEndlessWindDown,
  createWindDownToken,
  markEndlessPending,
  claimPendingEndless,
  upsertSession,
  entryForSession,
  forgetPrimary,
  retentionDecision,
} from "../src/registry.js"
import { settleChildWaiter, hasChildWaiter } from "../src/childwait.js"
import { WIND_DOWN_TOKEN_PREFIX } from "../src/handoff.js"
import { WIND_DOWN_HANDOVER_HEADING } from "../src/prompts.js"

const PRIMARY = "ses_primary"
const TOKEN = "0123456789abcdef"

const projectDir = mkdtempSync(join(tmpdir(), "intercom-winddown-test-"))
writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "wind-down-fixture" }))
const settingsFile = join(projectDir, "agent-intercom.json")
before(() => setSettingsPath(settingsFile))

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// ---------------------------------------------------------------------------
// The permit state
// ---------------------------------------------------------------------------

test("createWindDownToken: 16 hex characters, and not the same one twice", () => {
  const a = createWindDownToken()
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.notEqual(a, createWindDownToken())
})

test("armEndlessWindDown: the record the cycle waits on, and nothing without a token", () => {
  assert.equal(armEndlessWindDown(PRIMARY, { agent: "planner" }), null)
  assert.equal(armEndlessWindDown("", { token: TOKEN, agent: "planner" }), null)
  const permit = armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.deepEqual(permit, {
    token: TOKEN,
    agent: "planner",
    consumed: false,
    restores: 0,
    childSessionID: null,
    settlement: null,
  })
  assert.equal(endlessWindDownPermit(PRIMARY), permit)
})

// The discipline reservePendingTaskId already follows for the identical reason:
// the test and the consume are one synchronous step, so two spawn calls in the
// same turn carrying the same token cannot both pass.
test("consumeEndlessWindDown: single use — the second call is refused", () => {
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" }).ok, true)
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" }), {
    ok: false,
    reason: "consumed",
  })
})

test("consumeEndlessWindDown: a wrong token, a wrong agent and no permit are each refused, and none consumes", () => {
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" }), {
    ok: false,
    reason: "none",
  })
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: "wrong", agent: "planner" }), {
    ok: false,
    reason: "token",
  })
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: "", agent: "planner" }), {
    ok: false,
    reason: "token",
  })
  assert.deepEqual(consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "coder" }), {
    ok: false,
    reason: "agent",
  })
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, false, "a refusal never consumes")
  assert.equal(consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" }).ok, true)
})

// The consume is a reservation, not a burn: everything that can still fail sits
// after it, and a transient failure must not sit the whole cycle out.
test("restoreEndlessWindDown: gives the permit back exactly once", () => {
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.equal(restoreEndlessWindDown(PRIMARY), false, "nothing to give back before a consume")
  consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  noteEndlessWindDownChild(PRIMARY, { childSessionID: "ses_child", settlement: Promise.resolve() })
  assert.equal(restoreEndlessWindDown(PRIMARY), true)
  const permit = endlessWindDownPermit(PRIMARY)
  assert.equal(permit.consumed, false)
  assert.equal(permit.restores, 1)
  assert.equal(permit.childSessionID, null, "the child the failed attempt named is dropped with it")
  assert.equal(permit.token, TOKEN, "the same token, so the repeat is the same call")
  consumeEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.equal(restoreEndlessWindDown(PRIMARY), false, "a second failure leaves it consumed")
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, true)
})

test("noteEndlessWindDownChild: the child and the settlement the cycle gates on", async () => {
  assert.equal(noteEndlessWindDownChild(PRIMARY, { childSessionID: "ses_child" }), false)
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  const settlement = Promise.resolve({ status: "completed" })
  assert.equal(noteEndlessWindDownChild(PRIMARY, { childSessionID: "ses_child", settlement }), true)
  const permit = endlessWindDownPermit(PRIMARY)
  assert.equal(permit.childSessionID, "ses_child")
  assert.deepEqual(await permit.settlement, { status: "completed" })
})

test("no permit outlives its cycle: disarm and forgetPrimary each drop it", () => {
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  assert.equal(disarmEndlessWindDown(PRIMARY), true)
  assert.equal(endlessWindDownPermit(PRIMARY), undefined)
  assert.equal(disarmEndlessWindDown(PRIMARY), false)
  armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
  forgetPrimary(PRIMARY)
  assert.equal(endlessWindDownPermit(PRIMARY), undefined)
  assert.equal(endlessWindDownPermits.size, 0)
})

test("the wind-down child is never retained", () => {
  const entry = upsertSession("ses_child", {
    agent: "planner",
    parentID: PRIMARY,
    windDown: true,
  })
  assert.equal(entry.windDown, true)
  assert.deepEqual(retentionDecision(entry, 3), { retain: false, reason: "wind-down" })
})

// ---------------------------------------------------------------------------
// The admission branch in `spawnHandler`
// ---------------------------------------------------------------------------

function makeCtx({ createFails = false, promptThrows = false } = {}) {
  let counter = 0
  const prompts = []
  const client = {
    session: {
      create: async () => {
        if (createFails) return { data: {} }
        counter += 1
        return { data: { id: `ses_sub${counter}` } }
      },
      promptAsync: async (opts) => {
        if (promptThrows) throw new Error("prompt refused")
        prompts.push({
          sessionID: opts?.path?.id,
          agent: opts?.body?.agent,
          text: (opts?.body?.parts ?? []).map((p) => p?.text ?? "").join(""),
        })
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: projectDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: projectDir, worktree: projectDir, project: {} }, prompts }
}

const primaryCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

// The cycle is executing and has claimed its wind-down — set directly, the
// claim's own reading is pinned in test/endless-latch.test.js.
function windDownCycle() {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  endlessWindingDown.add(PRIMARY)
}

// ...and the permit is armed: the state the wind-down turn runs in.
function armCycle() {
  windDownCycle()
  return armEndlessWindDown(PRIMARY, { token: TOKEN, agent: "planner" })
}

const windDownPrompt = (token = TOKEN, payload = "what is open: the migration script.") =>
  `${WIND_DOWN_TOKEN_PREFIX} ${token}\n${payload}`

test("a winding-down cycle without a permit spawns as usual", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  windDownCycle()
  const res = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  assert.doesNotMatch(res.output, /spawn failed|Endless mode|no further subagent/)
  assert.notEqual(res.metadata?.windDown, true)
  assert.equal(entryForSession("ses_sub1")?.windDown, undefined, "an ordinary entry, not the wind-down child")
})

test("an armed permit leaves a wrong call an ordinary spawn and is not consumed by it", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  armCycle()
  let n = 0
  for (const args of [
    { agent: "planner", prompt: "no token line at all" },
    { agent: "planner", prompt: windDownPrompt("deadbeefdeadbeef") },
    { agent: "coder", prompt: windDownPrompt() },
    { agent: "planner", prompt: `prose first\n${WIND_DOWN_TOKEN_PREFIX} ${TOKEN}\n` },
  ]) {
    const res = await hooks.tool.spawn.execute(args, primaryCtx)
    n += 1
    assert.doesNotMatch(res.output, /spawn failed|Endless mode|ONE spawn/)
    assert.equal(entryForSession(`ses_sub${n}`)?.windDown, undefined)
  }
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, false, "no ordinary spawn consumed the permit")
})

test("the conforming spawn is recognised once; the second one is an ordinary spawn", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  armCycle()
  const call = hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  // The permitted spawn BLOCKS on its child's own ending — that settlement, not
  // the orchestrator's text, is the cycle's gate.
  await new Promise((r) => setTimeout(r, 30))
  const permit = endlessWindDownPermit(PRIMARY)
  assert.equal(permit.consumed, true)
  assert.equal(permit.childSessionID, "ses_sub1")
  assert.equal(hasChildWaiter("ses_sub1"), true, "a waiter is registered although the parent is a primary")

  const second = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  assert.doesNotMatch(second.output, /spawn failed|Endless mode|no further subagent/)
  assert.equal(entryForSession("ses_sub2")?.windDown, undefined, "a second call finds the permit consumed")
  assert.equal(endlessWindDownPermit(PRIMARY).childSessionID, "ses_sub1", "the child stays the first one")

  settleChildWaiter("ses_sub1", { status: "completed", agent: "planner", result: "8 open" })
  const res = await call
  assert.equal(res.metadata.windDown, true)
  assert.equal(res.metadata.status, "completed")
  assert.match(res.output, /8 open/)
  assert.equal(await permit.settlement !== undefined, true)
})

// The orchestrator supplies a payload, not instructions: without this the
// permit would hand it one arbitrary file-writing `planner` run whose task it
// chooses, in the session's own directory.
test("the plugin composes the child's prompt around the hand-over", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  armCycle()
  const call = hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt(TOKEN, "the migration script is half done.") },
    primaryCtx,
  )
  await new Promise((r) => setTimeout(r, 30))
  settleChildWaiter("ses_sub1", { status: "completed", agent: "planner", result: "done" })
  await call
  const sent = prompts.find((p) => p.sessionID === "ses_sub1")
  assert.equal(sent.agent, "planner")
  assert.match(sent.text, /You are the wind-down subagent/)
  assert.ok(sent.text.includes(WIND_DOWN_HANDOVER_HEADING))
  assert.match(sent.text, /the migration script is half done\./)
  assert.match(sent.text, /Edit ONLY between the two marker lines/)
  assert.ok(
    !sent.text.includes(`${WIND_DOWN_TOKEN_PREFIX} ${TOKEN}`),
    "the token line is stripped before the payload travels",
  )
})

test("a create failure gives the permit back and invites one repeat", async () => {
  const { ctx } = makeCtx({ createFails: true })
  const hooks = await plugin(ctx)
  armCycle()
  const res = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  assert.match(res.output, /repeat that one call ONCE/)
  const permit = endlessWindDownPermit(PRIMARY)
  assert.equal(permit.consumed, false)
  assert.equal(permit.restores, 1)
  // The repeat is admitted; the one after it is not, so the window cannot be
  // reopened indefinitely.
  const second = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  assert.match(second.output, /Failed to create subagent session\.$/)
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, true)
})

test("a prompt failure gives the permit back, settles the waiter and leaves no child", async () => {
  const { ctx } = makeCtx({ promptThrows: true })
  const hooks = await plugin(ctx)
  armCycle()
  const res = await hooks.tool.spawn.execute(
    { agent: "planner", prompt: windDownPrompt() },
    primaryCtx,
  )
  assert.match(res.output, /did not start .*prompt refused/)
  assert.match(res.output, /repeat that one call ONCE/)
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, false)
  assert.equal(pendingChildResults.has("ses_sub1"), false, "no waiter is left behind")
})

test("a nested caller never reaches the permit", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  armCycle()
  // A subagent of that primary: a session with a registry entry is a nested
  // caller, and the permit branch is closed to it.
  upsertSession("ses_sub_caller", { agent: "planner", parentID: PRIMARY, directory: projectDir })
  // A nested spawn blocks on its child, so the call is left running and the
  // child settled once the permit has been read.
  const call = hooks.tool.spawn.execute(
    { agent: "researcher", prompt: windDownPrompt() },
    { sessionID: "ses_sub_caller", agent: "planner", messageID: "m2" },
  )
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, false)
  assert.equal(entryForSession("ses_sub1")?.windDown, undefined)
  settleChildWaiter("ses_sub1", { status: "completed", agent: "researcher", result: "found" })
  const res = await call
  assert.doesNotMatch(res.output, /endless mode is handing/i)
  assert.equal(endlessWindDownPermit(PRIMARY).consumed, false)
})
