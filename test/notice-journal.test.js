// Durable delivery of the notices this plugin posts into a parent session
// (src/noticejournal.js), and the one door they all go through
// (postParentNotice, src/teardown.js).
//
// The behaviour under test exists because `POST /session/:id/prompt_async`
// answers 204 as soon as it has FORKED the fiber that writes the message row:
// the post's own answer says "accepted" and never "persisted". So a notice is
// journalled before it is posted, confirmed afterwards by reading the target
// session's tail back, cleared only on that confirmation, and replayed at the
// next plugin load when a process died with an entry still pending.
//
// Everything runs under a temporary HOME, so the journal under test is never
// the machine's own ~/.cache/opencode-agent-intercom/notice-journal/.
//
// Run: node --test --test-timeout=10000 test/notice-journal.test.js

import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "intercom-noticejournal-"))
process.env.HOME = HOME

const { resetState } = await import("../src/state.js")
const { setSettingsPath, resetSettings } = await import("../src/settings.js")
const { INTERCOM_DELIVERY_METADATA_KEY, messageCarriesDelivery } = await import(
  "../src/pluginmsg.js"
)
const { postNotice, fetchSessionTail } = await import("../src/client.js")
const {
  noticeJournalDir,
  journalFilePath,
  newDeliveryID,
  recordPendingNotice,
  clearPendingNotice,
  readPendingNotices,
  confirmNoticeDelivered,
  deliverParentNotice,
  replayPendingNotices,
  awaitNoticeConfirmations,
  replayHeader,
  NOTICE_CONFIRM_TAIL_LIMIT,
  NOTICE_JOURNAL_TTL_MS,
  MAX_REPLAY_SKIPS,
} = await import("../src/noticejournal.js")
const { postParentNotice } = await import("../src/teardown.js")

const PARENT = "ses_primary"
const LOG_PATH = join(HOME, ".cache", "opencode-agent-intercom", "debug.log")

// A pid that is certainly gone: a child that has already exited. Asked for
// once — pids are not recycled inside one test run.
const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

// A fake opencode SDK client.
//
//   `post`     decides what promptAsync answers per call (undefined = the 204).
//   `tail`     answers session.messages; by default it plays the server that
//              persisted everything this client was posted, which is the
//              healthy case.
// Every request is recorded, so a test can assert the exact reads and writes.
function makeClient({ post, tail } = {}) {
  const posts = []
  const reads = []
  const client = {
    posts,
    reads,
    session: {
      promptAsync: async (req) => {
        posts.push(req)
        return post ? await post(req, posts.length) : undefined
      },
      messages: async (req) => {
        reads.push(req)
        const messages = tail
          ? await tail(req, posts)
          : posts
              .filter((p) => p.path.id === req.path.id)
              .map((p) => ({ info: { role: "user" }, parts: p.body.parts }))
        return { data: messages }
      },
    },
  }
  return client
}

// The 404 envelope this SDK client resolves with rather than rejecting.
function notFound() {
  return { error: { name: "NotFoundError" }, response: { status: 404 } }
}

function journalFiles() {
  try {
    return readdirSync(noticeJournalDir()).filter((n) => n.endsWith(".json")).sort()
  } catch {
    return []
  }
}

function readLog() {
  try {
    return readFileSync(LOG_PATH, "utf8")
  } catch {
    return ""
  }
}

// Journals one entry as a DEAD previous process left it: a pid that is gone and
// a boot token that is not this process's, which together are what makes the
// replay pick it up.
function journalFromDeadProcess(deliveryID, overrides = {}) {
  mkdirSync(noticeJournalDir(), { recursive: true })
  const entry = {
    sessionID: PARENT,
    requestedFor: PARENT,
    kind: "completion",
    text: '🔔 agent-intercom: your subagent "researcher#1" has finished',
    at: Date.now(),
    pid: deadPid,
    boot: "an-earlier-process",
    replays: 0,
    skips: 0,
    ...overrides,
  }
  writeFileSync(journalFilePath(deliveryID), JSON.stringify(entry, null, 2) + "\n")
  return entry
}

let tmpDir

// The transport retry is not what these tests are about (test/postNotice-retry
// .test.js pins it) and its backoff would put seconds on every failing-post
// case here, so the budget is squeezed to a single attempt.
const RETRIES_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRIES"
const BACKOFF_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRY_BACKOFF_MS"

// The confirmation waits on UNREF'd timers, so a test that awaits the shipped
// schedule has to hold the event loop open itself — in the server opencode's
// own listener does that.
async function withLoopHeldOpen(fn) {
  const keepAlive = setInterval(() => {}, 25)
  try {
    return await fn()
  } finally {
    clearInterval(keepAlive)
  }
}

test.beforeEach(() => {
  resetState()
  tmpDir = mkdtempSync(join(tmpdir(), "intercom-nj-settings-"))
  setSettingsPath(join(tmpDir, "agent-intercom.json"))
  process.env[RETRIES_ENV] = "0"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()
  rmSync(noticeJournalDir(), { recursive: true, force: true })
  rmSync(LOG_PATH, { force: true })
})

test.afterEach(async () => {
  await withLoopHeldOpen(() => awaitNoticeConfirmations())
  delete process.env[RETRIES_ENV]
  delete process.env[BACKOFF_ENV]
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// ── where the journal lives, and what one entry is ─────────────────────────

test("the journal is a directory of its own in the plugin's cache dir", () => {
  assert.equal(
    noticeJournalDir(),
    join(HOME, ".cache", "opencode-agent-intercom", "notice-journal"),
  )
  assert.equal(journalFilePath("n-abc"), join(noticeJournalDir(), "n-abc.json"))
})

test("a delivery id can never steer the path it is joined into", () => {
  assert.equal(journalFilePath("../../etc/passwd"), join(noticeJournalDir(), "..-..-etc-passwd.json"))
  assert.equal(journalFilePath(""), join(noticeJournalDir(), "delivery.json"))
})

test("a recorded entry reads back with its target, kind, text and writer", () => {
  const id = newDeliveryID()
  assert.equal(recordPendingNotice({ deliveryID: id, sessionID: PARENT, text: "wake", kind: "completion" }), true)
  const [entry] = readPendingNotices()
  assert.equal(entry.deliveryID, id)
  assert.equal(entry.sessionID, PARENT)
  assert.equal(entry.kind, "completion")
  assert.equal(entry.text, "wake")
  assert.equal(entry.pid, process.pid)
  assert.ok(entry.boot, "the entry names the process instance that wrote it")
  assert.equal(clearPendingNotice(id), true)
  assert.deepEqual(readPendingNotices(), [])
})

test("a journal file that does not parse is dropped, not raised", () => {
  mkdirSync(noticeJournalDir(), { recursive: true })
  writeFileSync(journalFilePath("n-broken"), "{ this is not json")
  writeFileSync(journalFilePath("n-empty"), JSON.stringify({ sessionID: PARENT }))
  assert.deepEqual(readPendingNotices(), [])
  assert.deepEqual(journalFiles(), [], "both unusable entries were removed")
})

test("an absent journal directory reads as nothing pending", () => {
  rmSync(noticeJournalDir(), { recursive: true, force: true })
  assert.deepEqual(readPendingNotices(), [])
})

// ── the bounded tail read ──────────────────────────────────────────────────

test("the tail read never asks for limit 0 — opencode reads that as the whole history", async () => {
  const client = makeClient()
  for (const limit of [0, -3, undefined, 1.7]) {
    await fetchSessionTail(client, PARENT, limit)
  }
  for (const read of client.reads) {
    assert.ok(Number.isInteger(read.query.limit), "the limit is an integer")
    assert.ok(read.query.limit >= 1, `limit ${read.query.limit} would fetch the whole history`)
  }
  await fetchSessionTail(client, PARENT, 8)
  assert.equal(client.reads.at(-1).query.limit, 8)
})

test("a refused tail read answers with no messages rather than throwing", async () => {
  const client = makeClient({ tail: async () => { throw new Error("socket died") } })
  assert.deepEqual(await fetchSessionTail(client, PARENT, 8), [])
})

// ── journal, post, confirm ─────────────────────────────────────────────────

test("the notice is journalled BEFORE it is posted", async () => {
  let journalledAtPostTime = null
  const client = makeClient({
    post: async () => {
      journalledAtPostTime = journalFiles()
      return undefined
    },
  })
  await deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", {
    kind: "completion",
    confirm: { delaysMs: [0] },
  })
  assert.equal(journalledAtPostTime.length, 1, "the post ran with nothing journalled behind it")
  await awaitNoticeConfirmations()
})

test("the posted part carries the delivery id, and the tail read confirms on it", async () => {
  const client = makeClient()
  const id = await deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", {
    kind: "completion",
    confirm: { delaysMs: [0] },
  })
  const part = client.posts[0].body.parts[0]
  assert.equal(part.metadata[INTERCOM_DELIVERY_METADATA_KEY], id)
  assert.equal(part.metadata.agentIntercom, true, "the plugin-message marker still holds")
  await awaitNoticeConfirmations()
  assert.deepEqual(journalFiles(), [], "the confirmation cleared the journal entry")
  assert.equal(client.reads.length >= 1, true)
  assert.equal(client.reads[0].path.id, PARENT)
  assert.equal(client.reads[0].query.limit, NOTICE_CONFIRM_TAIL_LIMIT)
})

test("a post that carries no delivery id keeps the body it always had", async () => {
  const client = makeClient()
  await postNotice(client, PARENT, "wake up")
  assert.deepEqual(client.posts[0].body.parts, [
    { type: "text", text: "wake up", metadata: { agentIntercom: true } },
  ])
})

test("a confirmation that comes back NEGATIVE leaves the entry journalled and says so", async () => {
  // The live failure: 204, no error anywhere, and the row never written.
  const client = makeClient({ tail: async () => [{ info: { role: "user" }, parts: [{ type: "text", text: "an unrelated message" }] }] })
  const id = await deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", {
    kind: "completion",
    confirm: { delaysMs: [0, 0] },
  })
  await awaitNoticeConfirmations()
  assert.deepEqual(journalFiles(), [`${id}.json`], "an unconfirmed notice stays pending")
  assert.equal(client.reads.length, 2, "the confirmation read out its whole schedule")
  assert.match(readLog(), /notice delivery LOST/, "a lost notice now produces a log line")
  assert.match(readLog(), /the target session never showed the posted notice/)
})

test("a tail that cannot be read at all is not a confirmation either", async () => {
  const client = makeClient({ tail: async () => [] })
  assert.equal(await confirmNoticeDelivered(client, PARENT, "n-nothing"), undefined)
})

test("a terminal post failure clears the entry and re-throws for the caller's own path", async () => {
  const client = makeClient({ post: async () => notFound() })
  await assert.rejects(
    () => deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", { confirm: { delaysMs: [0] } }),
    /HTTP 404/,
  )
  await awaitNoticeConfirmations()
  assert.deepEqual(journalFiles(), [], "a notice no replay could ever land is not kept pending")
})

test("an indeterminate post failure keeps the entry and still confirms", async () => {
  // The post threw, so nothing is known — but it may have reached the server.
  // The confirmation is what settles that, in this process, without waiting for
  // the next plugin load.
  const posted = []
  const client = makeClient({
    post: async (req) => {
      posted.push(req)
      throw new Error("socket hung up")
    },
    tail: async (_req, posts) =>
      posts.map((p) => ({ info: { role: "user" }, parts: p.body.parts })),
  })
  await assert.rejects(
    () => deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", { confirm: { delaysMs: [0] } }),
    /socket hung up/,
  )
  await awaitNoticeConfirmations()
  assert.deepEqual(journalFiles(), [], "the post had landed after all, so the entry is gone")
})

test("messageCarriesDelivery matches the id and nothing else", () => {
  const part = { type: "text", text: "x", metadata: { agentIntercom: true, [INTERCOM_DELIVERY_METADATA_KEY]: "n-1" } }
  assert.equal(messageCarriesDelivery({ info: { role: "user" }, parts: [part] }, "n-1"), true)
  assert.equal(messageCarriesDelivery({ info: { role: "user" }, parts: [part] }, "n-2"), false)
  assert.equal(messageCarriesDelivery({ parts: [{ type: "text", text: "x" }] }, "n-1"), false)
  assert.equal(messageCarriesDelivery({ role: "user", content: [part] }, "n-1"), true)
  assert.equal(messageCarriesDelivery(undefined, "n-1"), false)
  assert.equal(messageCarriesDelivery({ parts: [part] }, undefined), false)
})

// ── replay across a restart ────────────────────────────────────────────────

test("replay re-delivers what a dead process left pending, and only then clears it", async () => {
  const id = journalFromDeadProcess("n-left-behind")
  // The target session is alive and holds other traffic, but not the notice.
  const client = makeClient({
    tail: async (req, posts) => [
      { info: { role: "user" }, parts: [{ type: "text", text: "the user typed something" }] },
      ...posts.filter((p) => p.path.id === req.path.id).map((p) => ({ info: { role: "user" }, parts: p.body.parts })),
    ],
  })
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.deepEqual(
    { pending: counts.pending, replayed: counts.replayed, confirmed: counts.confirmed, skipped: counts.skipped },
    { pending: 1, replayed: 1, confirmed: 0, skipped: 0 },
  )
  assert.equal(client.posts.length, 1, "the pending notice was posted again")
  const text = client.posts[0].body.parts[0].text
  assert.ok(text.startsWith(replayHeader()), "the re-delivery says it is one")
  assert.ok(text.endsWith(id.text), "the original notice is carried verbatim underneath")
  await awaitNoticeConfirmations()
  assert.equal(existsSync(journalFilePath("n-left-behind")), false, "the old entry is gone")
  assert.deepEqual(journalFiles(), [], "and the fresh one was confirmed")
})

test("replay confirms an entry whose notice DID land, and posts nothing", async () => {
  journalFromDeadProcess("n-actually-landed")
  const client = makeClient({
    tail: async () => [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "…", metadata: { agentIntercom: true, [INTERCOM_DELIVERY_METADATA_KEY]: "n-actually-landed" } }],
      },
    ],
  })
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(counts.confirmed, 1)
  assert.equal(counts.replayed, 0)
  assert.equal(client.posts.length, 0, "a notice that landed is not posted twice")
  assert.deepEqual(journalFiles(), [])
})

test("replay posts nothing into a session that reads back empty, and drops the entry on the next load", async () => {
  journalFromDeadProcess("n-target-gone")
  const client = makeClient({ tail: async () => [] })

  const first = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(first.skipped, 1)
  assert.equal(client.posts.length, 0, "nothing may be posted into a session that cannot be read")
  const [kept] = readPendingNotices()
  assert.equal(kept.skips, MAX_REPLAY_SKIPS)
  assert.equal(kept.pid, deadPid, "the entry still belongs to the process that wrote it")

  const second = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(second.expired, 1)
  assert.equal(client.posts.length, 0)
  assert.deepEqual(journalFiles(), [])
  assert.match(readLog(), /the target session read back empty on every replay/)
})

test("replay leaves an entry belonging to a LIVE other instance alone", async () => {
  journalFromDeadProcess("n-someone-elses", { pid: process.pid, boot: "another-live-instance" })
  // Same pid, different boot token: for THIS test that is a predecessor and is
  // replayable, so the live case is the one that has to be built separately.
  rmSync(journalFilePath("n-someone-elses"), { force: true })
  journalFromDeadProcess("n-live-instance", { pid: process.pid + 0, boot: "another-instance" })
  rmSync(journalFilePath("n-live-instance"), { force: true })

  // A live foreign writer: a pid that answers signal 0 and is not ours. The
  // test runner's own parent is such a process; where there is none, this
  // process's id under a foreign boot is deliberately NOT it (see above), so
  // the live case is expressed with process.ppid.
  const livePid = process.ppid
  journalFromDeadProcess("n-foreign-live", { pid: livePid, boot: "a-live-instance" })
  const client = makeClient()
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(counts.pending, 1)
  assert.equal(counts.replayed, 0)
  assert.equal(counts.skipped, 0)
  assert.equal(client.posts.length, 0)
  assert.deepEqual(journalFiles(), ["n-foreign-live.json"], "the other instance's entry is untouched")
  rmSync(journalFilePath("n-foreign-live"), { force: true })
})

test("replay ignores an entry this very process is still confirming", async () => {
  const client = makeClient({ tail: async () => [] })
  const id = await deliverParentNotice(client, PARENT, "🔔 agent-intercom: done", {
    confirm: { delaysMs: [0] },
  })
  await awaitNoticeConfirmations()
  assert.deepEqual(journalFiles(), [`${id}.json`], "unconfirmed, so still pending")
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(counts.pending, 1)
  assert.equal(counts.replayed + counts.skipped + counts.confirmed + counts.expired, 0)
  clearPendingNotice(id)
})

test("an entry past the replay window is dropped and reported lost", async () => {
  journalFromDeadProcess("n-stale", { at: Date.now() - NOTICE_JOURNAL_TTL_MS - 1000 })
  const client = makeClient()
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(counts.expired, 1)
  assert.equal(client.posts.length, 0)
  assert.equal(client.reads.length, 0, "an expired entry is not even read for")
  assert.deepEqual(journalFiles(), [])
  assert.match(readLog(), /the journal entry outlived the replay window/)
})

test("one load replays at most `max` entries and leaves the rest for the next", async () => {
  for (let i = 0; i < 3; i += 1) {
    journalFromDeadProcess(`n-batch-${i}`, { at: Date.now() - (3 - i) * 1000 })
  }
  const client = makeClient({
    tail: async (req, posts) => [
      { info: { role: "user" }, parts: [{ type: "text", text: "history" }] },
      ...posts.map((p) => ({ info: { role: "user" }, parts: p.body.parts })),
    ],
  })
  const counts = await replayPendingNotices(client, { max: 2, confirm: { delaysMs: [0] } })
  assert.equal(counts.replayed, 2)
  assert.equal(counts.deferred, 1)
  await awaitNoticeConfirmations()
  // The two oldest were the ones taken; the newest is still there.
  assert.deepEqual(journalFiles(), ["n-batch-2.json"])
  rmSync(journalFilePath("n-batch-2"), { force: true })
})

test("a replay whose own post fails leaves the entry pending for the next load", async () => {
  journalFromDeadProcess("n-post-fails")
  const client = makeClient({
    post: async () => { throw new Error("server down") },
    tail: async () => [{ info: { role: "user" }, parts: [{ type: "text", text: "history" }] }],
  })
  const counts = await replayPendingNotices(client, { confirm: { delaysMs: [0] } })
  assert.equal(counts.failed, 1)
  await awaitNoticeConfirmations()
  assert.ok(
    journalFiles().includes("n-post-fails.json"),
    "the notice a restart could not deliver is still pending",
  )
  rmSync(noticeJournalDir(), { recursive: true, force: true })
})

// ── the one door: postParentNotice ─────────────────────────────────────────

test("postParentNotice delivers through the journal and names the notice kind", async () => {
  let journalledAtPostTime = []
  const client = makeClient({
    post: async () => {
      journalledAtPostTime = journalFiles().map((n) =>
        JSON.parse(readFileSync(join(noticeJournalDir(), n), "utf8")),
      )
      return undefined
    },
  })
  await postParentNotice(client, PARENT, "🔔 agent-intercom: your subagent has finished", {
    kind: "completion",
  })
  assert.equal(journalledAtPostTime.length, 1)
  assert.equal(journalledAtPostTime[0].kind, "completion")
  assert.equal(journalledAtPostTime[0].sessionID, PARENT)
  assert.equal(journalledAtPostTime[0].requestedFor, PARENT)
  await withLoopHeldOpen(() => awaitNoticeConfirmations())
  assert.deepEqual(journalFiles(), [], "the shipped confirmation schedule cleared it")
})

test("every notice the plugin posts into a parent goes through the one door", async () => {
  // postNotice is the raw transport and has exactly two callers in src/: the
  // durable delivery that journals it, and nothing else. A path added later
  // that calls it directly would post a notice nothing could recover.
  const { readdirSync: rd, readFileSync: rf } = await import("node:fs")
  const srcDir = new URL("../src/", import.meta.url).pathname
  const callers = []
  for (const name of rd(srcDir)) {
    if (!name.endsWith(".js")) continue
    if (name === "client.js" || name === "noticejournal.js") continue
    const body = rf(join(srcDir, name), "utf8")
    // Strip comments so the doc-comments that MENTION postNotice do not count.
    const code = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
    if (/\bpostNotice\s*\(/.test(code)) callers.push(name)
  }
  assert.deepEqual(callers, [], "postNotice is called outside the durable delivery")
})
