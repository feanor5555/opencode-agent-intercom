// The `message` tool: the orchestrator's half of the mid-run channel.
//
// What is pinned here: a message reaches a RUNNING subagent as a queued user
// message that starts no turn (`noReply`), framed so it cannot be read as a
// fresh task; every refusal path names the rule it refused on; a message sent
// while a question is open is that question's ANSWER and writes nothing to the
// session; a send that fails leaves no bookkeeping claiming it was delivered;
// and the primary may call `message` while `ask` stays refused to it.
//
// Run: node --test test/agent-message-tool.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, aborted, pendingAsks } from "../src/state.js"
import { entryForSession, upsertSession, trackPrimary, openAsk } from "../src/registry.js"
import { registerAskWaiter } from "../src/agentmsg.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const SUB = "ses_sub1"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-message-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// Written before the plugin is loaded where the test needs other values; the
// channel's own switch is read live, so it may also be rewritten mid-test.
function settings(values) {
  writeFileSync(settingsFile, JSON.stringify({ postNoticeRetries: 0, ...values }))
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
  const prompts = []
  const fail = { promptAsync: null }
  const client = {
    session: {
      create: async () => ({ data: { id: SUB } }),
      promptAsync: async (req) => {
        if (fail.promptAsync) throw new Error(fail.promptAsync)
        prompts.push(req)
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
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, prompts, fail }
}

// A running subagent of PRIMARY, registered straight through the registry so
// the tool is exercised and not the spawn path.
function register(sessionID = SUB, { agent = "coder", parentID = PRIMARY } = {}) {
  trackPrimary(PRIMARY)
  return upsertSession(sessionID, { agent, prompt: "do x", parentID, directory: fixtureDir })
}

test("a message is queued into the running subagent's session and starts no turn", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const res = await hooks.tool.message.execute(
    { subagent: "coder#1", text: "drop the SQLite path, use the HTTP API" },
    toolCtx,
  )

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].path.id, SUB)
  assert.equal(prompts[0].body.noReply, true, "a steering message must not start a second turn")
  const text = prompts[0].body.parts[0].text
  assert.match(text, /^📨 agent-intercom: message from the orchestrator/)
  assert.match(text, /drop the SQLite path/)
  assert.equal(prompts[0].body.parts[0].metadata.agentIntercom, true)

  assert.match(res.output, /Queued for "coder#1"/)
  assert.match(res.output, /next step/)
  assert.equal(res.metadata.sessionID, SUB)
  assert.equal(entry.messagesIn.length, 1)
  assert.equal(entry.messagesIn[0].seen, false)
})

test("the tool result names the tool call the subagent is sitting in", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  register()
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: SUB, callID: "c1" })

  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "use the API" }, toolCtx)
  assert.match(res.output, /inside `bash` right now/)
})

test("list shows the message count and the asking marker", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  assert.doesNotMatch((await hooks.tool.list.execute({}, toolCtx)).output, /msgs:/)

  await hooks.tool.message.execute({ subagent: "coder#1", text: "use the API" }, toolCtx)
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /coder#1 .*msgs:1/)
  assert.doesNotMatch(listed.output, /asking/)

  openAsk(entry, { id: "ask1", question: "which one?" })
  assert.match((await hooks.tool.list.execute({}, toolCtx)).output, /msgs:1 {2}asking/)
})

test("a foreign or unknown handle reads as unknown, so ownership is not leaked", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  register(SUB, { parentID: "ses_other_primary" })

  assert.match(
    (await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)).output,
    /Unknown subagent "coder#1"/,
  )
  assert.match(
    (await hooks.tool.message.execute({ subagent: "nope#9", text: "x" }, toolCtx)).output,
    /Unknown subagent "nope#9"/,
  )
  assert.equal(prompts.length, 0)
})

test("a subagent the wake has claimed is refused, and nothing is written to it", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  entry.dispatched = true
  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)
  assert.match(res.output, /no longer running/)
  // At the shipped default retention is on, so the way forward the refusal
  // names is the rung above a fresh spawn: the run may still be held.
  assert.match(res.output, /check list\(\) for a RETAINED row and use reuse\("coder#1"/)
  assert.equal(prompts.length, 0)

  entry.dispatched = false
  aborted.add(SUB)
  assert.match(
    (await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)).output,
    /no longer running/,
  )
  aborted.delete(SUB)
  entry.timedOut = true
  assert.match(
    (await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)).output,
    /no longer running/,
  )
  assert.equal(prompts.length, 0)
})

test("with retention off the same refusal points at a fresh spawn instead", async () => {
  // The other half of the ladder: where nothing is ever held, `reuse` does not
  // exist and naming it would send the orchestrator at a tool it has not got.
  settings({ maxRetainedSubagents: 0 })
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  entry.dispatched = true
  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)
  assert.match(res.output, /no longer running/)
  assert.match(res.output, /Spawn a fresh subagent carrying what you wanted to say\./)
  assert.doesNotMatch(res.output, /reuse\(/)
  assert.equal(prompts.length, 0)
})

test("the channel's off switch is read live and both refusals name it", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  register()

  settings({ midRunMessaging: false })
  const refused = await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)
  assert.match(refused.output, /mid-run channel is switched off/)
  assert.match(refused.output, /midRunMessaging/)
  assert.equal(prompts.length, 0)

  // No restart: switching it back on takes effect in the same instance.
  settings({})
  assert.match(
    (await hooks.tool.message.execute({ subagent: "coder#1", text: "x" }, toolCtx)).output,
    /Queued for "coder#1"/,
  )
})

test("an oversized message is refused on its own ceiling, not on the reply ceiling", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  register()
  settings({ maxMessageTokens: 10 })

  const res = await hooks.tool.message.execute(
    { subagent: "coder#1", text: "word ".repeat(400) },
    toolCtx,
  )
  assert.match(res.output, /over the 10-token ceiling/)
  assert.match(res.output, /maxMessageTokens/)
  assert.equal(prompts.length, 0)

  assert.match(
    (await hooks.tool.message.execute({ subagent: "coder#1", text: "  " }, toolCtx)).output,
    /`text` is empty/,
  )
})

test("a subagent at its context budget is not pushed over it by a steering note", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  entry.ctxTokens = 999999

  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "use the API" }, toolCtx)
  assert.match(res.output, /would put it over/)
  assert.equal(prompts.length, 0)
})

test("the budget gate is measured in the unit every other budget figure is in", async () => {
  // 700 ASCII characters: 175 tokens to `estimateTokens`, the arithmetic every
  // context budget in the plugin is done in, and 200 to the `estimateReplyTokens`
  // that decides where a REPLY is cut. At 810 of an 1000-token budget the text
  // fits under the first and not under the second, so the gate refusing here
  // would be refusing earlier than the budget it names.
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  settings({ maxContext: 1000 })
  entry.ctxTokens = 810
  const text = "x".repeat(700)

  const res = await hooks.tool.message.execute({ subagent: "coder#1", text }, toolCtx)
  assert.match(res.output, /Queued for "coder#1"/)
  assert.equal(prompts.length, 1)

  // And one token over the budget in that same unit is refused, quoting the
  // estimateTokens figure rather than the reply one.
  entry.ctxTokens = 826
  const refused = await hooks.tool.message.execute({ subagent: "coder#1", text }, toolCtx)
  assert.match(refused.output, /826 tokens of its 1.0k coder budget, and 175 more would put it over/)
  assert.equal(prompts.length, 1, "nothing further was written to the session")
})

test("with a question open the text is its answer: the waiter settles and nothing is sent", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const waiter = registerAskWaiter(SUB, PRIMARY, { question: "which lockfile?" })
  openAsk(entry, waiter)

  const res = await hooks.tool.message.execute(
    { subagent: "coder#1", text: "package-lock.json" },
    toolCtx,
  )
  assert.match(res.output, /Answer delivered to "coder#1"/)
  assert.match(res.output, /which lockfile\?/)
  assert.equal(prompts.length, 0, "an answer is the blocked call's return value, not a session write")

  const outcome = await waiter.promise
  assert.equal(outcome.status, "answered")
  assert.equal(outcome.answer, "package-lock.json")
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksAnswered, 1)
  assert.equal(entry.messagesIn.length, 0, "an answer is not counted as a message down")
  assert.equal(pendingAsks.size, 0)
})

test("an answer that arrives after the wait ran out is reported as not delivered", async () => {
  const { ctx, prompts } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  // The state between the timer firing and the subagent's own handler clearing
  // the flag: the waiter is gone, the entry still says a question is open.
  openAsk(entry, { id: "ask1", question: "which lockfile?" })

  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "the npm one" }, toolCtx)
  assert.match(res.output, /had a question open but its wait had already run out/)
  assert.match(res.output, /Send it again/)
  assert.equal(prompts.length, 0)
  assert.equal(entry.asksAnswered ?? 0, 0)
  assert.equal(entry.asksUnanswered, 1)
})

test("a failed send is reported verbatim and leaves no record claiming delivery", async () => {
  const { ctx, fail } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  fail.promptAsync = "session is gone"

  const res = await hooks.tool.message.execute({ subagent: "coder#1", text: "use the API" }, toolCtx)
  assert.match(res.output, /Message NOT delivered to "coder#1": .*session is gone/)
  assert.equal(entry.messagesIn.length, 0, "the record is taken back out again")
})

test("the primary may call message; ask stays refused to it by the orchestrator allowlist", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  trackPrimary(PRIMARY)

  await hooks["tool.execute.before"]({ tool: "message", sessionID: PRIMARY, callID: "a-message" })
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "ask", sessionID: PRIMARY, callID: "d-ask" }),
    /orchestrator session/,
  )
})

test("the transform hook marks a queued message as seen at the subagent's next request", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()
  await hooks.tool.message.execute({ subagent: "coder#1", text: "use the API" }, toolCtx)
  assert.equal(entry.messagesIn[0].seen, false)

  const messages = [
    { info: { id: "msg_1", role: "user", sessionID: SUB }, parts: [{ type: "text", text: "task" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(entry.messagesIn[0].seen, true, "a request after the send is the observation")
})

test("a subagent may not steer another subagent, and is denied message at the schema level", async () => {
  const { AGENTS } = await import("../src/agents.js")
  for (const [name, def] of Object.entries(AGENTS)) {
    if (def.mode !== "subagent") continue
    assert.equal(def.permission.message, "deny", `${name} must not carry message`)
    assert.equal(def.permission.ask, undefined, `${name} may ask its caller`)
  }
  assert.equal(AGENTS.orchestrator.permission.ask, "deny")
  assert.equal(AGENTS.orchestrator.permission.message, undefined)
})

test("solo mode holds against both names, whatever put them in the schema", async () => {
  const { SOLO_DENIED_TOOLS } = await import("../src/hooks.js")
  assert.ok(SOLO_DENIED_TOOLS.includes("message"))
  assert.ok(SOLO_DENIED_TOOLS.includes("ask"))
})
