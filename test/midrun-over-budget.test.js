// The mid-run channel under the context-budget lockdown.
//
// What is pinned here: a subagent that has crossed its context budget still
// gets `message` and `ask` through the tool guard, while every other tool stays
// denied; the escalation text it is refused with, and the block injected on its
// turn, say so; an aborted subagent is denied both; the per-agent deny map
// still wins over the exemption; a compaction in flight holds the channel with
// its own refusal; and an admitted channel call does not reset the escalation
// counters of a session that is still over its budget.
//
// Run: node --test test/midrun-over-budget.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { MID_RUN_MESSAGING_TOOLS, SOLO_DENIED_TOOLS, resetTurnNotices } from "../src/hooks.js"
import { resetState, aborted } from "../src/state.js"
import { upsertSession, trackPrimary } from "../src/registry.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const SUB = "ses_sub1"
const BUDGET = 1000
const OVER = BUDGET + 1

// Tools a subagent runs work with — none of them may pass the lockdown.
const WORK_TOOLS = ["read", "edit", "bash", "webfetch", "web_search", "spawn", "list"]

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-budget-channel-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

function settings(values) {
  writeFileSync(settingsFile, JSON.stringify({ postNoticeRetries: 0, maxContext: BUDGET, ...values }))
  resetSettings()
}

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  settings({})
})

// `agentConfig` is what the opencode client reports as the resolved config, so
// a test can put a `permission.<tool>` deny on the role the guard reads.
function makeCtx({ agentConfig = {} } = {}) {
  const client = {
    session: {
      create: async () => ({ data: { id: SUB } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
      summarize: async () => ({ data: true }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  return { client, directory: fixtureDir, worktree: fixtureDir, project: {} }
}

// A running coder subagent of PRIMARY, sitting at `ctxTokens`.
function register(ctxTokens = OVER) {
  trackPrimary(PRIMARY)
  const entry = upsertSession(SUB, {
    agent: "coder",
    prompt: "do x",
    parentID: PRIMARY,
    directory: fixtureDir,
  })
  entry.ctxTokens = ctxTokens
  return entry
}

// Runs the guard for one tool; returns null when it was admitted, the error
// message when it was denied.
async function callTool(hooks, tool, callID = "c1") {
  try {
    await hooks["tool.execute.before"]({ tool, sessionID: SUB, callID })
    return null
  } catch (err) {
    return err.message
  }
}

test("the exemption is a named set of exactly the channel's two tools", () => {
  assert.deepEqual([...MID_RUN_MESSAGING_TOOLS], ["message", "ask"])
  assert.ok(Object.isFrozen(MID_RUN_MESSAGING_TOOLS), "an enforcement authority must be frozen")
  // The same two names solo mode denies — one collection, read by both.
  for (const name of MID_RUN_MESSAGING_TOOLS) assert.ok(SOLO_DENIED_TOOLS.includes(name))
})

test("over its budget a subagent keeps message and ask, and loses everything else", async () => {
  const hooks = await plugin(makeCtx())
  register()

  assert.equal(await callTool(hooks, "message"), null, "`message` must survive the lockdown")
  assert.equal(await callTool(hooks, "ask"), null, "`ask` must survive the lockdown")

  for (const tool of WORK_TOOLS) {
    const denied = await callTool(hooks, tool)
    assert.ok(denied, `${tool} must stay denied over budget`)
  }
  assert.match(await callTool(hooks, "read"), /context budget is exhausted/)
})

test("the refusal of a work tool names the channel as what is left", async () => {
  const hooks = await plugin(makeCtx())
  register()

  assert.match(await callTool(hooks, "read"), /`message` and `ask` still reach your caller/)

  // With the channel switched off both tools refuse every call in their own
  // handlers, so the refusal does not point at them.
  settings({ midRunMessaging: false })
  assert.doesNotMatch(await callTool(hooks, "read"), /`message` and `ask`/)
})

test("the injected lockdown block tells the subagent the channel is still open", async () => {
  const hooks = await plugin(makeCtx())
  register()

  const notice = await turnNotice(hooks)
  assert.match(notice, /🛑 STOP\./)
  assert.match(notice, /work tools are now DISABLED/)
  assert.match(notice, /ask\(question\)/)
  assert.match(notice, /message\(subagent, text\)/)
  assert.match(notice, /MUST BEGIN WITH "Done:"/)
})

test("with the channel off the lockdown block names neither tool", async () => {
  const hooks = await plugin(makeCtx())
  register()
  settings({ midRunMessaging: false })

  const notice = await turnNotice(hooks)
  assert.match(notice, /work tools are now DISABLED/)
  assert.doesNotMatch(notice, /ask\(question\)/)
  assert.doesNotMatch(notice, /message\(subagent, text\)/)
})

test("an aborted subagent is denied the channel as well", async () => {
  const hooks = await plugin(makeCtx())
  register(10)
  aborted.add(SUB)

  for (const tool of ["message", "ask", "read"]) {
    assert.match(
      await callTool(hooks, tool),
      /aborted by the orchestrator/,
      `${tool} must not pass an aborted session`,
    )
  }
})

test("the per-agent deny map still wins over the exemption", async () => {
  const hooks = await plugin(makeCtx({ agentConfig: { coder: { permission: { message: "deny" } } } }))
  register()

  assert.match(await callTool(hooks, "message"), /deny map/)
  assert.equal(await callTool(hooks, "ask"), null, "only the denied name is denied")
})

test("a compaction in flight holds the channel, and is not counted as a denial", async () => {
  const hooks = await plugin(makeCtx())
  const entry = register()
  entry.compactingSince = Date.now()

  for (const tool of MID_RUN_MESSAGING_TOOLS) {
    assert.match(await callTool(hooks, tool), /held while your session is being compacted/)
  }
  assert.ok(!entry.budgetDenials, "a call held by a compaction is not a subagent ignoring a stop")

  entry.compactingSince = undefined
  assert.equal(await callTool(hooks, "ask"), null)
})

test("an admitted channel call leaves the escalation counters of an over-budget run alone", async () => {
  const hooks = await plugin(makeCtx())
  const entry = register()
  entry.stopInjections = 3
  entry.budgetDenials = 2
  entry.notifiedParentOfLoop = true

  assert.equal(await callTool(hooks, "ask"), null)
  assert.equal(entry.stopInjections, 3, "the ladder must not reopen at the bottom")
  assert.equal(entry.budgetDenials, 2)
  assert.equal(entry.notifiedParentOfLoop, true, "the parent must not be notified a second time")

  // Under the budget the same call clears them, as any admitted call does.
  entry.ctxTokens = 10
  assert.equal(await callTool(hooks, "ask"), null)
  assert.equal(entry.stopInjections, 0)
  assert.equal(entry.budgetDenials, 0)
  assert.equal(entry.notifiedParentOfLoop, false)
})

// The block the transform hook injects on this subagent's turn: it appends it
// as synthetic parts to the user message it is given.
async function turnNotice(hooks) {
  const messages = [
    {
      info: { id: "mu1", role: "user", sessionID: SUB },
      parts: [{ type: "text", text: "task", synthetic: false }],
    },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}
