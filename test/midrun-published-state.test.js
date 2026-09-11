// The mid-run state the plugin PUBLISHES on a running subagent's session
// title, and what reads it.
//
// A subagent blocked inside its own `ask` call is `busy` to opencode and
// writes nothing to its session for as long as it waits — which is exactly
// what a subagent that has hung looks like from outside the plugin. Nothing a
// reader of the opencode server can ask distinguishes the two, so the state is
// published rather than inferred, on the one field of a subagent session this
// plugin owns: the title it already marks, as `[mid:msgs:N,asking]` behind the
// marker and behind the retention stamp's place.
//
// What is pinned here:
//   - a question opening stamps the title, and its ending takes the stamp off
//     again, however it ended;
//   - a message queued down carries the same `msgs:N` the orchestrator's own
//     `list` row shows;
//   - an entry that is no longer running is never stamped: a finished
//     subagent's title belongs to the retention publish, which takes the
//     mid-run stamp of the run just ended off with it;
//   - the marker stays the first thing in the title, so the bootstrap sweep's
//     attribution is untouched.
//
// Run: node --test test/midrun-published-state.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  upsertSession,
  trackPrimary,
  LIFECYCLE_RETAINED,
} from "../src/registry.js"
import { openAskFor } from "../src/agentmsg.js"
import { resetTurnNotices } from "../src/hooks.js"
import {
  SUBAGENT_SESSION_TITLE_MARKER,
  publishMidRunState,
  readMidRunStamp,
  retentionStampedTitle,
  stampedSubagentTitle,
} from "../src/teardown.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const SUB = "ses_sub1"
const WORK_TITLE = "rewrite the parser"
const primaryCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }
const subCtx = { sessionID: SUB, agent: "coder", messageID: "m2" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-midrun-published-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

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

// The fake client of the ask tests plus the one call this feature adds:
// `session.update`, which is how the state is published. Every title it is
// asked to write is recorded in order.
function makeCtx() {
  const titles = []
  const client = {
    session: {
      create: async () => ({ data: { id: SUB } }),
      promptAsync: async () => ({ data: undefined }),
      update: async (opts) => {
        titles.push({ sessionID: opts?.path?.id, title: opts?.body?.title })
        return { data: true }
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
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, titles, client }
}

function register(sessionID = SUB, { agent = "coder", parentID = PRIMARY } = {}) {
  trackPrimary(PRIMARY)
  return upsertSession(sessionID, {
    agent,
    prompt: "do x",
    parentID,
    directory: fixtureDir,
    title: WORK_TITLE,
  })
}

// The title as it stands after the last write for that session.
function titleOf(titles, sessionID = SUB) {
  let last
  for (const t of titles) if (t.sessionID === sessionID) last = t.title
  return last
}

async function untilAsking(sessionID = SUB) {
  for (let i = 0; i < 200 && !openAskFor(sessionID); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return openAskFor(sessionID)
}

// The publish follows the question's own registration — the `ask` handler
// posts the notice to the caller first — so a test that answers a still-blocked
// call waits for the title write rather than racing it.
async function untilTitles(titles, count) {
  for (let i = 0; i < 200 && titles.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return titles.length
}

// ---- the stamp itself -------------------------------------------------------

test("the stamp composes and reads back, and never displaces the marker", () => {
  const stamped = stampedSubagentTitle(WORK_TITLE, { asking: true, messagesIn: 2 })
  assert.equal(stamped, `${SUBAGENT_SESSION_TITLE_MARKER}[mid:msgs:2,asking] ${WORK_TITLE}`)
  assert.ok(
    stamped.startsWith(SUBAGENT_SESSION_TITLE_MARKER),
    "the bootstrap sweep attributes a session by the marker being first",
  )
  assert.deepEqual(readMidRunStamp(stamped), { asking: true, messagesIn: 2 })
})

test("a subagent with nothing on its channel gets the title spawn wrote", () => {
  assert.equal(
    stampedSubagentTitle(WORK_TITLE, { asking: false, messagesIn: 0 }),
    SUBAGENT_SESSION_TITLE_MARKER + WORK_TITLE,
  )
  assert.equal(stampedSubagentTitle(WORK_TITLE, {}), retentionStampedTitle(WORK_TITLE, 0))
})

test("a retention publish carries no mid-run stamp: that run is over", () => {
  const held = retentionStampedTitle(WORK_TITLE, 1_700_000_060_000)
  assert.deepEqual(readMidRunStamp(held), { asking: false, messagesIn: 0 })
})

// ---- the publish points -----------------------------------------------------

test("an open question is published on the title and taken off by the answer", async () => {
  const { ctx, titles } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  const asking = hooks.tool.ask.execute({ question: "which lockfile is authoritative?" }, subCtx)
  assert.ok(await untilAsking(), "the question is registered while the call blocks")
  await untilTitles(titles, 1)
  assert.equal(
    titleOf(titles),
    `${SUBAGENT_SESSION_TITLE_MARKER}[mid:asking] ${WORK_TITLE}`,
    "the row's evidence that this subagent is waiting and not hung",
  )
  assert.deepEqual(readMidRunStamp(titleOf(titles)), { asking: true, messagesIn: 0 })

  await hooks.tool.message.execute({ subagent: "coder#1", text: "package-lock.json" }, primaryCtx)
  await asking

  assert.equal(entry.pendingAsk, undefined)
  assert.equal(
    readMidRunStamp(titleOf(titles)).asking,
    false,
    "a marker left standing would name a question nobody can still answer",
  )
})

test("a question that expired unanswered takes its marker with it", async () => {
  const { ctx, titles } = makeCtx()
  const hooks = await plugin(ctx)
  settings({ answerWaitMs: 60, maxSubagentToolCallMs: 660000 })
  register()

  const result = await hooks.tool.ask.execute({ question: "which one?" }, subCtx)
  assert.match(result.output, /No answer came within/)
  assert.equal(readMidRunStamp(titleOf(titles)).asking, false)
})

test("a message queued down is counted on the title, in the vocabulary list uses", async () => {
  const { ctx, titles } = makeCtx()
  const hooks = await plugin(ctx)
  const entry = register()

  await hooks.tool.message.execute({ subagent: "coder#1", text: "use the new API" }, primaryCtx)
  assert.deepEqual(readMidRunStamp(titleOf(titles)), { asking: false, messagesIn: 1 })

  await hooks.tool.message.execute({ subagent: "coder#1", text: "and keep the old test" }, primaryCtx)
  assert.deepEqual(readMidRunStamp(titleOf(titles)), { asking: false, messagesIn: 2 })
  assert.equal(entry.messagesIn.length, 2, "the count on the title is the entry's own")
})

test("the two states stand together while a question is open", async () => {
  const { ctx, titles } = makeCtx()
  const hooks = await plugin(ctx)
  register()

  await hooks.tool.message.execute({ subagent: "coder#1", text: "use the new API" }, primaryCtx)
  const asking = hooks.tool.ask.execute({ question: "which lockfile?" }, subCtx)
  assert.ok(await untilAsking())
  await untilTitles(titles, 2)
  assert.deepEqual(readMidRunStamp(titleOf(titles)), { asking: true, messagesIn: 1 })

  await hooks.tool.message.execute({ subagent: "coder#1", text: "package-lock.json" }, primaryCtx)
  await asking
  assert.deepEqual(readMidRunStamp(titleOf(titles)), { asking: false, messagesIn: 1 })
})

// ---- what is never published ------------------------------------------------

test("nothing is published for a session this process holds no entry for", async () => {
  const { client, titles } = makeCtx()
  assert.equal(await publishMidRunState(client, "ses_nobody"), false)
  assert.equal(await publishMidRunState(client, undefined), false)
  assert.equal(titles.length, 0)
})

test("nothing is published for an entry that is no longer running", async () => {
  const { client, titles } = makeCtx()
  const entry = register()
  entry.messagesIn = [{ text: "x", sentAt: Date.now(), seen: false }]
  // What the retention path leaves behind: the run is over and the title is
  // the retention publish's to write.
  entry.lifecycle = LIFECYCLE_RETAINED
  entry.retainedAt = Date.now()

  assert.equal(await publishMidRunState(client, SUB), false)
  assert.equal(titles.length, 0, "a finished subagent's title is not this publish's to write")
  assert.ok(entryForSession(SUB), "and the entry itself is untouched")
})
