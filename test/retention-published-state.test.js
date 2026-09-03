// The retention state the plugin PUBLISHES, and what it does when a held
// session goes away without it.
//
// Both halves of this file answer the same question from opposite ends: who
// knows whether a finished subagent is being held. The decision is the
// plugin's, taken on the reply and on the context the run ended at, and nothing
// outside the plugin's own memory can work it out. So it is written down where
// every reader of the opencode session already looks — the session title, which
// the plugin already marks — as `[retained:<epoch ms the window ends>]` right
// after that marker.
//
// What is pinned here:
//   - a retention that becomes final stamps the title, with the same window the
//     reap works to, and the marker stays in front so the bootstrap sweep's
//     attribution is untouched;
//   - a retention the plugin REFUSES stamps nothing — so no reader can paint
//     that subagent as held, not even for one poll;
//   - an accepted reuse takes the stamp off again, and a reuse whose prompt
//     never lands puts the original window back;
//   - at the shipped default (`maxRetainedSubagents = 0`) no title is written
//     at all;
//   - a retained entry whose opencode session is deleted by somebody else —
//     the sidebar's `x` on a held row is the case — goes with its session,
//     rather than standing until the window runs out.
//
// Run: node --test test/retention-published-state.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  countRetainedSubagents,
  entryLifecycle,
  upsertSession,
  trackPrimary,
  LIFECYCLE_RETAINED,
  LIFECYCLE_RUNNING,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import {
  SUBAGENT_SESSION_TITLE_MARKER,
  readRetentionStamp,
  retentionStampedTitle,
} from "../src/teardown.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings, getSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-published-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
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

// The same fake client the other retention tests use, plus the one call this
// feature adds: `session.update`, which is how the state is published. Every
// title it is asked to write is recorded in order.
function makeCtx({ messages = [] } = {}) {
  // Flipped by a test after its spawn has gone through, so only the reuse's
  // own prompt fails: a spawn whose prompt never lands cleans its session up
  // and there would be nothing left to retain.
  const control = { failPrompt: false }
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
  const titles = []
  const client = {
    session: {
      create: async (opts) => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        titles.push({ sessionID: id, title: opts?.body?.title })
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        const id = opts?.path?.id
        if (!created.includes(id)) {
          notices.push(id)
          return { data: undefined }
        }
        if (control.failPrompt) throw new Error("prompt refused")
        return { data: undefined }
      },
      update: async (opts) => {
        titles.push({ sessionID: opts?.path?.id, title: opts?.body?.title })
        return { data: true }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    deleted,
    notices,
    titles,
    control,
  }
}

function assistantReply(text, tokens = 4321) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

function idle(hooks, sessionID) {
  return hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
}

function sessionDeleted(hooks, sessionID) {
  return hooks.event({
    event: { type: "session.deleted", properties: { sessionID, info: { id: sessionID } } },
  })
}

// The title as it stands after the last write for that session.
function titleOf(titles, sessionID) {
  let last
  for (const t of titles) if (t.sessionID === sessionID) last = t.title
  return last
}

// ---- the stamp itself -------------------------------------------------------

test("the stamp composes and reads back, and never displaces the marker", () => {
  const stamped = retentionStampedTitle("Searching for latest Spring API", 1_700_000_060_000)
  assert.equal(
    stamped,
    "[agent-intercom] [retained:1700000060000] Searching for latest Spring API",
  )
  assert.ok(
    stamped.startsWith(SUBAGENT_SESSION_TITLE_MARKER),
    "the bootstrap sweep attributes a session by the marker being first",
  )
  assert.equal(readRetentionStamp(stamped), 1_700_000_060_000)
})

test("a title without the stamp reads as no retention at all", () => {
  assert.equal(readRetentionStamp("[agent-intercom] plain work"), undefined)
  assert.equal(readRetentionStamp("[retained:1700000060000] no marker"), undefined)
  assert.equal(readRetentionStamp("something a user typed"), undefined)
  assert.equal(readRetentionStamp(undefined), undefined)
  assert.equal(
    readRetentionStamp(retentionStampedTitle("work", 0)),
    undefined,
    "the plain form is what an ended retention writes back",
  )
})

// ---- publishing a retention that was granted --------------------------------

test("a retained subagent's title carries the window the reap works to", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 600000 })
  const { ctx, created, titles } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "planner", prompt: "x", description: "Plan the cut" },
    toolCtx,
  )
  const sessionID = created[0]

  await idle(hooks, sessionID)

  const entry = entryForSession(sessionID)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED)
  const published = titleOf(titles, sessionID)
  assert.equal(
    published,
    `${SUBAGENT_SESSION_TITLE_MARKER}[retained:${entry.retainedAt + 600000}] Plan the cut`,
    "the marker, the window, then the work — the title the panel reads",
  )
  assert.equal(
    readRetentionStamp(published),
    entry.retainedAt + getSettings().retainedSubagentTtlMs,
    "the published window is the entry's own, not a second one",
  )
})

// ---- the refusals: nothing is published, so nothing can show as held --------

test("a refused retention publishes nothing: a Blocked: reply", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, titles } = makeCtx({
    messages: assistantReply("Blocked: the briefing does not say which of the two"),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(deleted, [sessionID], "a blocked run is not a session to hold")
  assert.equal(
    readRetentionStamp(titleOf(titles, sessionID)),
    undefined,
    "and nothing was ever published that would paint it as held",
  )
})

test("a refused retention publishes nothing: over the reuse ceiling", async () => {
  withSettings({ maxRetainedSubagents: 3, maxReuseContext: 1000, agentContext: { planner: 0 } })
  const { ctx, created, deleted, titles } = makeCtx({
    messages: assistantReply("THE RESULT", 90000),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(deleted, [sessionID], "no later reuse could admit it")
  assert.equal(readRetentionStamp(titleOf(titles, sessionID)), undefined)
})

test("a refused retention publishes nothing: a nested child", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted, titles } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const parentSession = created[0]
  // A child whose parent is itself a tracked subagent: retention is refused
  // outright for it, and the child-first teardown depends on that.
  upsertSession("ses_nested", {
    agent: "researcher",
    prompt: "y",
    parentID: parentSession,
    title: "nested work",
  })

  await idle(hooks, "ses_nested")

  assert.equal(entryForSession("ses_nested"), undefined, "the entry goes as it always did")
  assert.ok(deleted.includes("ses_nested"))
  assert.equal(readRetentionStamp(titleOf(titles, "ses_nested")), undefined)
})

test("at the shipped default nothing is retained and no stamp is ever published", async () => {
  const { ctx, created, deleted, titles } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]

  await idle(hooks, sessionID)

  assert.deepEqual(deleted, [sessionID])
  assert.equal(countRetainedSubagents(), 0)
  const written = titles.filter((t) => t.sessionID === sessionID)
  assert.equal(written.length, 1, "the create, and nothing after it")
  // The marker goes on unconditionally — it is what attributes the session to
  // this plugin from outside, and nothing about it says the session is held.
  // The retention stamp is the part that stays away at the default.
  assert.equal(written[0].title, `${SUBAGENT_SESSION_TITLE_MARKER}planner: x`)
  assert.equal(readRetentionStamp(written[0].title), undefined, "no stamp at the default")
})

// ---- the reuse ends a retention, and says so --------------------------------

test("an accepted reuse takes the stamp off the title", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, titles } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute(
    { agent: "planner", prompt: "x", description: "Plan the cut" },
    toolCtx,
  )
  const sessionID = created[0]
  await idle(hooks, sessionID)
  const handle = entryForSession(sessionID).handle
  assert.ok(readRetentionStamp(titleOf(titles, sessionID)), "held first")

  await hooks.tool.reuse.execute({ subagent: handle, prompt: "which of the two?" }, toolCtx)

  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RUNNING)
  assert.equal(
    titleOf(titles, sessionID),
    `${SUBAGENT_SESSION_TITLE_MARKER}Plan the cut`,
    "a running subagent is not held, and its title no longer says it is",
  )
})

test("a reuse whose prompt never lands publishes the ORIGINAL window again", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 600000 })
  const { ctx, created, titles, control } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  const entry = entryForSession(sessionID)
  const retainedAt = entry.retainedAt
  const handle = entry.handle
  control.failPrompt = true

  await hooks.tool.reuse.execute({ subagent: handle, prompt: "which of the two?" }, toolCtx)

  const back = entryForSession(sessionID)
  assert.equal(entryLifecycle(back), LIFECYCLE_RETAINED, "no run started, so it is held again")
  assert.equal(back.retainedAt, retainedAt, "on its original window")
  assert.equal(
    readRetentionStamp(titleOf(titles, sessionID)),
    retainedAt + 600000,
    "and the published state says the same thing the registry does",
  )
})

// ---- the entry goes when its session goes -----------------------------------

test("a held subagent whose session is deleted from outside loses its entry", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created, deleted } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  assert.equal(countRetainedSubagents(), 1, "held to begin with")

  // What the sidebar's `x` on a held row does: a held subagent is idle, so
  // there is no run to abort — the session itself is deleted.
  await sessionDeleted(hooks, sessionID)

  assert.equal(entryForSession(sessionID), undefined, "the entry goes with its session")
  assert.equal(countRetainedSubagents(), 0)
  assert.deepEqual(deleted, [], "the plugin deletes nothing: the session is already gone")
})

test("the handle a dropped retention held is offered to nobody", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  await idle(hooks, sessionID)
  const handle = entryForSession(sessionID).handle

  await sessionDeleted(hooks, sessionID)

  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.ok(!listed.output.includes(handle), "list must not name a handle with no session")
  const reused = await hooks.tool.reuse.execute({ subagent: handle, prompt: "?" }, toolCtx)
  assert.match(reused.output, /unknown|spawn/i, "and a reuse on it points at spawn")
})

test("a running subagent's session.deleted is left to the paths that own it", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx, created } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RUNNING)

  await sessionDeleted(hooks, sessionID)

  assert.ok(
    entryForSession(sessionID),
    "the parent is still waiting for a result; the watchdog is what tells it, not this handler",
  )
})

test("session.deleted for a session this plugin never tracked is a no-op", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const { ctx } = makeCtx({ messages: assistantReply("THE RESULT") })
  const hooks = await plugin(ctx)
  trackPrimary(PRIMARY)

  await sessionDeleted(hooks, "ses_someone_else")
  await sessionDeleted(hooks, undefined)

  assert.equal(countRetainedSubagents(), 0)
})
