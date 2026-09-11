// `entry.lifecycle`: the entry's own state, separate from registry membership.
//
// Until this split, "an entry is in the registry" WAS "a run is in flight":
// the concurrency cap, the quiesce predicate, the in-flight taskId set and
// both renderings of the active list each decided it for themselves, all with
// the same "not aborted" test. They now share one predicate, `isActiveEntry`,
// which is `lifecycle === "running"` AND not aborted.
//
// Nothing sets a lifecycle other than "running" — `createEntry` sets it and no
// other writer exists — so this file pins two things at once: that the
// predicate is what the five consumers read, and that with every entry running
// the answers are exactly the ones registry membership gave before.
//
// Run: node --test test/entry-lifecycle.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, aborted, registry } from "../src/state.js"
import {
  entryForSession,
  upsertSession,
  trackPrimary,
  isActiveEntry,
  entryLifecycle,
  LIFECYCLE_RUNNING,
  countActiveSubagents,
  noteMessageIn,
  markMessagesSeen,
  openAsk,
  clearAsk,
  spawnCapDecision,
  activeTaskIdsFor,
  isQuiesced,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-lifecycle-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  resetState()
  resetTurnNotices()
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

// Drives the messages hook the way opencode does and returns the synthetic
// text the plugin pushed onto the turn — where the primary's active-subagent
// snapshot lives.
async function turnNotice(hooks, sessionID, messageID) {
  const messages = [
    { info: { id: messageID, role: "user", sessionID }, parts: [{ type: "text", text: "task" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}

// A registered subagent of PRIMARY, straight through the registry so the state
// under test is set without going near the spawn path.
function register(sessionID, { agent = "researcher", taskId } = {}) {
  trackPrimary(PRIMARY)
  return upsertSession(sessionID, { agent, prompt: "do x", parentID: PRIMARY, taskId, directory: fixtureDir })
}

test("createEntry stamps lifecycle running, and nothing else writes the field", () => {
  const entry = register("ses_sub1")
  assert.equal(entry.lifecycle, LIFECYCLE_RUNNING)
  // upsert of an existing session must not disturb it
  const again = upsertSession("ses_sub1", { agent: "researcher", prompt: "do x", parentID: PRIMARY })
  assert.equal(again, entry)
  assert.equal(again.lifecycle, LIFECYCLE_RUNNING)
  assert.equal(entryLifecycle(again), LIFECYCLE_RUNNING)
})

test("isActiveEntry: running counts, aborted does not, a non-running lifecycle does not", () => {
  const entry = register("ses_sub1")
  assert.equal(isActiveEntry(entry), true)

  aborted.add(entry.sessionID)
  assert.equal(isActiveEntry(entry), false, "aborted is still excluded")
  aborted.delete(entry.sessionID)
  assert.equal(isActiveEntry(entry), true)

  entry.lifecycle = "retained"
  assert.equal(isActiveEntry(entry), false, "a lifecycle other than running holds no slot")

  // An entry built without the field — a hand-made fixture, or an entry from
  // before the field existed — reads as running, so nothing silently drops out
  // of the count.
  delete entry.lifecycle
  assert.equal(entryLifecycle(entry), LIFECYCLE_RUNNING)
  assert.equal(isActiveEntry(entry), true)

  assert.equal(isActiveEntry(undefined), false)
})

test("the concurrency cap counts running entries only", async () => {
  const a = register("ses_sub1")
  register("ses_sub2")
  assert.equal(countActiveSubagents(), 2)
  // maxSubagents default is 1, so a primary is refused at either figure
  assert.equal(spawnCapDecision(PRIMARY, 1).refused, true)
  assert.equal(spawnCapDecision(PRIMARY, 2).refused, true)

  a.lifecycle = "retained"
  assert.equal(countActiveSubagents(), 1, "the non-running entry stays in the registry")
  assert.equal(registry.size, 2)
  const decision = spawnCapDecision(PRIMARY, 2)
  assert.equal(decision.active, 1)
  assert.equal(decision.refused, false)
})

test("isQuiesced ignores a non-running entry and still waits for a running one", async () => {
  const entry = register("ses_sub1")
  assert.equal(await isQuiesced(PRIMARY), false)
  entry.lifecycle = "retained"
  assert.equal(await isQuiesced(PRIMARY), true)
  // and an aborted running entry is quiesced exactly as before
  entry.lifecycle = LIFECYCLE_RUNNING
  assert.equal(await isQuiesced(PRIMARY), false)
  aborted.add(entry.sessionID)
  assert.equal(await isQuiesced(PRIMARY), true)
})

test("activeTaskIdsFor holds a running entry's taskId and releases a non-running one", () => {
  const entry = register("ses_sub1", { taskId: "T5" })
  register("ses_sub2", { agent: "coder", taskId: "T6" })
  assert.deepEqual([...activeTaskIdsFor(PRIMARY)].sort(), ["T5", "T6"])

  entry.lifecycle = "retained"
  assert.deepEqual([...activeTaskIdsFor(PRIMARY)], ["T6"])

  // unchanged: another primary's tasks never appear, and an abort frees the id
  assert.deepEqual([...activeTaskIdsFor("ses_other")], [])
  aborted.add("ses_sub2")
  assert.deepEqual([...activeTaskIdsFor(PRIMARY)], [])
})

test("both renderings of the active list show running entries only", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const spawned = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  const entry = entryForSession(spawned.metadata.sessionID)
  assert.equal(entry.lifecycle, LIFECYCLE_RUNNING)

  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /researcher#1/)
  const notice = await turnNotice(hooks, PRIMARY, "msg_user1")
  assert.match(notice, /active subagents across all orchestrator sessions/i)
  assert.match(notice, /researcher#1 \(researcher\)/)

  entry.lifecycle = "retained"
  const listedAfter = await hooks.tool.list.execute({}, toolCtx)
  assert.equal(listedAfter.output, "No active subagents.")
  const noticeAfter = await turnNotice(hooks, PRIMARY, "msg_user2")
  assert.doesNotMatch(noticeAfter, /researcher#1/)
})

// ---- the mid-run channel's bookkeeping on one entry --------------------------
//
// The four helpers in src/registry.js are the whole interface to the five
// fields createEntry stamps for the channel. They are pure and synchronous —
// they take no lock, so the `message` tool may call them inside the same
// registryMutex section that decides the entry is still running — and an entry
// built without the fields reads as "nothing sent, no ask open".

test("createEntry stamps the mid-run fields empty", () => {
  const entry = register("ses_sub1")
  assert.deepEqual(entry.messagesIn, [])
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksOut, 0)
  assert.equal(entry.asksAnswered, 0)
  assert.equal(entry.asksUnanswered, 0)
})

test("noteMessageIn records a message unseen and markMessagesSeen raises it once", () => {
  const entry = register("ses_sub1")
  const first = noteMessageIn(entry, "use the HTTP API", 1000)
  assert.deepEqual(first, { text: "use the HTTP API", sentAt: 1000, seen: false })
  noteMessageIn(entry, "and skip the cache", 2000)
  assert.equal(entry.messagesIn.length, 2)

  assert.equal(markMessagesSeen(entry), 2, "both unseen messages are raised")
  assert.equal(markMessagesSeen(entry), 0, "a second LLM request raises nothing further")
  assert.deepEqual(entry.messagesIn.map((m) => m.seen), [true, true])

  // A message queued after the subagent's last request stays unseen, which is
  // what lets the completion notice name a steering attempt that was lost.
  noteMessageIn(entry, "too late", 3000)
  assert.deepEqual(entry.messagesIn.map((m) => m.seen), [true, true, false])
})

test("openAsk opens one question at a time and clearAsk counts how it ended", () => {
  const entry = register("ses_sub1")
  assert.equal(openAsk(entry, { id: "ask1", question: "which lockfile?", askedAt: 10 }), true)
  assert.deepEqual(entry.pendingAsk, { id: "ask1", question: "which lockfile?", askedAt: 10 })
  assert.equal(entry.asksOut, 1)

  // One at a time is a property of the entry, not of the tool that asks.
  assert.equal(openAsk(entry, { id: "ask2", question: "and the other?" }), false)
  assert.equal(entry.pendingAsk.id, "ask1")
  assert.equal(entry.asksOut, 1)

  assert.equal(clearAsk(entry, "answered"), true)
  assert.equal(entry.pendingAsk, undefined)
  assert.equal(entry.asksAnswered, 1)
  assert.equal(entry.asksUnanswered, 0)

  // Idempotent: every ending path may call it unconditionally and twice.
  assert.equal(clearAsk(entry, "answered"), false)
  assert.equal(entry.asksAnswered, 1)

  // Every ending that is not an answer counts as unanswered — from the
  // subagent's side an expiry, an abort and a reap are the same thing.
  for (const outcome of ["unanswered", "aborted", "timeout", "ended"]) {
    openAsk(entry, { id: `ask-${outcome}`, question: outcome })
    assert.equal(clearAsk(entry, outcome), true)
  }
  assert.equal(entry.asksOut, 5)
  assert.equal(entry.asksAnswered, 1)
  assert.equal(entry.asksUnanswered, 4)
})

test("an entry without the fields reads as nothing sent and no ask open", () => {
  // A hand-made fixture, or an entry from an older shape.
  const bare = { handle: "coder#9", sessionID: "ses_bare" }
  assert.equal(markMessagesSeen(bare), 0)
  assert.equal(clearAsk(bare, "answered"), false)
  assert.equal(markMessagesSeen(undefined), 0)
  assert.equal(clearAsk(undefined, "answered"), false)
  assert.equal(openAsk(undefined, { id: "ask1" }), false)
  assert.equal(openAsk(bare, { question: "no id" }), false, "an ask without an id opens nothing")
  assert.equal(noteMessageIn(undefined, "x"), undefined)

  // A message is never dropped, though: unlike the tool-call stamp, the array
  // is created rather than the write refused.
  const recorded = noteMessageIn(bare, "steer", 5)
  assert.deepEqual(bare.messagesIn, [{ text: "steer", sentAt: 5, seen: false }])
  assert.equal(recorded.seen, false)
})
