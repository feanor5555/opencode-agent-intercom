// The `ask` tool: the subagent's half of the mid-run channel, and the lifecycle
// wiring that keeps a blocked question from outliving its session.
//
// What is pinned here: the question reaches the caller as a routed parent
// notice and the call blocks on the answer; the answer comes back as that
// call's own result; the wait expires as a refusal to go on guessing rather
// than as a kill; a nested subagent is refused, which is what makes the channel
// deadlock-free; one question at a time; and every ending path — abort, the
// watchdog reap, the teardown, a state reset — settles the waiter.
//
// Run: node --test test/ask-tool.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, pendingAsks } from "../src/state.js"
import { entryForSession, upsertSession, trackPrimary } from "../src/registry.js"
import { openAskFor, openAsksFor } from "../src/agentmsg.js"
import { timeoutSubagent, resetTurnNotices } from "../src/hooks.js"
import { teardownSubagent } from "../src/teardown.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const SUB = "ses_sub1"
const NESTED = "ses_sub2"
const primaryCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }
const subCtx = { sessionID: SUB, agent: "coder", messageID: "m2" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-ask-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

function settings(values) {
  writeFileSync(settingsFile, JSON.stringify({ postNoticeRetries: 0, maxSubagents: 4, ...values }))
  resetSettings()
}

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  settings({})
})

function makeCtx() {
  const posted = []
  const client = {
    session: {
      create: async () => ({ data: { id: SUB } }),
      promptAsync: async (req) => {
        posted.push({ sessionID: req.path.id, text: req.body.parts[0].text })
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, posted, client }
}

function register(sessionID = SUB, { agent = "coder", parentID = PRIMARY } = {}) {
  trackPrimary(PRIMARY)
  return upsertSession(sessionID, { agent, prompt: "do x", parentID, directory: fixtureDir })
}

// Waits until the question is registered, so a test can answer a call that is
// still blocked without racing its own setup.
async function untilAsking(sessionID = SUB) {
  for (let i = 0; i < 200 && !openAskFor(sessionID); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return openAskFor(sessionID)
}

test("the question is posted to the caller, the call blocks, and the answer is its result", async () => {
  const { ctx, posted } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const asking = hooks.tool.ask.execute({ question: "which lockfile is authoritative?" }, subCtx)
  const open = await untilAsking()
  assert.ok(open, "the question is registered while the call blocks")
  assert.equal(entry.pendingAsk.question, "which lockfile is authoritative?")
  assert.equal(entry.asksOut, 1)
  assert.deepEqual(openAsksFor(PRIMARY).map((a) => a.sessionID), [SUB])

  assert.equal(posted.length, 1)
  assert.equal(posted[0].sessionID, PRIMARY)
  assert.match(posted[0].text, /❓ agent-intercom: your subagent "coder#1" \(coder/)
  assert.match(posted[0].text, /asks you:/)

  await hooks.tool.message.execute({ subagent: "coder#1", text: "package-lock.json" }, primaryCtx)
  const result = await asking
  assert.match(result.output, /The orchestrator answers: package-lock\.json/)
  assert.match(result.output, /Do not ask the same thing again/)
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksAnswered, 1)
  assert.equal(pendingAsks.size, 0)
})

test("the wait expires as an instruction to go on, not as a kill", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  settings({ answerWaitMs: 60, maxSubagentToolCallMs: 660000 })

  const result = await hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  assert.match(result.output, /No answer came within/)
  assert.match(result.output, /best reading you can defend/)
  assert.match(result.output, /`Blocked:`/)
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksOut, 1)
  assert.equal(entry.asksUnanswered, 1)
  assert.equal(pendingAsks.size, 0)
})

test("answerWaitMs 0 delivers the question and returns at once", async () => {
  const { ctx, posted } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  settings({ answerWaitMs: 0 })

  const result = await hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  assert.match(result.output, /does not wait for answers/)
  assert.equal(posted.length, 1, "the question still reaches the caller")
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(pendingAsks.size, 0)
})

test("a nested subagent is refused: its caller is blocked and could never answer", async () => {
  const { ctx, posted } = makeCtx()
  const hooks = await plugin(ctx)
  register()
  register(NESTED, { agent: "researcher", parentID: SUB })

  const result = await hooks.tool.ask.execute(
    { question: "which one?" },
    { sessionID: NESTED, agent: "researcher" },
  )
  assert.match(result.output, /your caller is itself a subagent/)
  assert.match(result.output, /`Blocked:`/)
  assert.equal(posted.length, 0)
  assert.equal(pendingAsks.size, 0)
})

test("one question at a time, and an empty or oversized one is refused", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  register()

  const asking = hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  await untilAsking()
  const second = await hooks.tool.ask.execute({ question: "and the other?" }, subCtx)
  assert.match(second.output, /one question at a time/)
  assert.match(second.output, /which one\?/)

  await hooks.tool.message.execute({ subagent: "coder#1", text: "the npm one" }, primaryCtx)
  await asking

  assert.match(
    (await hooks.tool.ask.execute({ question: "   " }, subCtx)).output,
    /`question` is empty/,
  )
  settings({ maxMessageTokens: 10 })
  assert.match(
    (await hooks.tool.ask.execute({ question: "word ".repeat(400) }, subCtx)).output,
    /over the 10-token ceiling/,
  )
})

test("with the channel off the question is refused and the subagent is told what to do instead", async () => {
  const { ctx, posted } = makeCtx()
  const hooks = await plugin(ctx)
  register()
  settings({ midRunMessaging: false })

  const result = await hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  assert.match(result.output, /switched off/)
  assert.match(result.output, /`Blocked:`/)
  assert.equal(posted.length, 0)
})

test("a session that is not a tracked subagent has nobody to ask", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const result = await hooks.tool.ask.execute({ question: "which one?" }, primaryCtx)
  assert.match(result.output, /ask is for a running subagent/)
})

// ---- no ending path leaves a waiter -----------------------------------------

test("abort settles the blocked question and tells the subagent to finish", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const asking = hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  await untilAsking()
  await hooks.tool.abort.execute({ subagent: "coder#1" }, primaryCtx)

  const result = await asking
  assert.match(result.output, /ended without an answer \(aborted\)/)
  assert.match(result.output, /start it with `Blocked:`/)
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksUnanswered, 1)
  assert.equal(pendingAsks.size, 0)
})

test("a watchdog reap settles the question and the notice reports it", async () => {
  const { ctx, posted } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const asking = hooks.tool.ask.execute({ question: "which lockfile?" }, subCtx)
  await untilAsking()
  posted.length = 0

  await timeoutSubagent(entry, { ms: 90000, setting: "maxSubagentAgeMs", kind: "silence" }, 91000)
  const result = await asking
  assert.match(result.output, /ended without an answer \(timeout\)/)
  assert.equal(pendingAsks.size, 0)
  assert.equal(entry.asksUnanswered, 1)

  const notice = posted.find((p) => p.sessionID === PRIMARY && /agent-intercom/.test(p.text))
  assert.ok(notice, "the parent is woken with the timeout notice")
  assert.match(notice.text, /It had a question open to YOU/)
  assert.match(notice.text, /which lockfile\?/)
})

test("teardownSubagent is the catch-all: no ending path leaves a waiter behind", async () => {
  const { ctx, client } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const asking = hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  await untilAsking()

  await teardownSubagent(
    client,
    { sessionID: SUB, handle: entry.handle, parentID: PRIMARY, agent: entry.agent },
    { label: "test" },
  )
  const result = await asking
  assert.match(result.output, /ended without an answer/)
  assert.equal(pendingAsks.size, 0)
})

test("resetState settles a leftover waiter instead of leaving its promise pending", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  register()

  const asking = hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  await untilAsking()
  resetState()

  const result = await asking
  assert.match(result.output, /ended without an answer \(abandoned\)/)
  assert.equal(pendingAsks.size, 0)
})
