// Unit tests for the `forum_search` route: the two legs, the bang chain, the
// keyword reduction, the thread shape, the per-engine cap inside the searxng
// lane and the quota-plus-fill merge.
//
// No live network — `globalThis.fetch` is stubbed and dispatches on the URL,
// so both legs are driven from canned Exa SSE and searxng JSON.
//
// Run: node --test test/forumsearch.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  setSettingsPath,
  resetSettings,
  getForumBangs,
  DEFAULT_FORUM_BANGS,
} from "../src/settings.js"
import { searxToEntries, renderEntries } from "../src/searchcore.js"
import { isThreadUrl } from "../src/threadshape.js"
import {
  forumEnvelope,
  reduceToKeywords,
  bangQuery,
  searxLane,
  partitionByShape,
  pickFromLanes,
  isForumSearchEnabled,
  createForumSearchTool,
} from "../src/forumsearch.js"
import { createTools } from "../src/tools.js"
import { AGENTS } from "../src/agents.js"

const SEARXNG_BASE = "http://searxng.test:8080"

// Point settings.js at a fresh temp file and clear every env var that could
// otherwise leak the developer's shell into the assertions.
function isolate(fileSettings) {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-forum-"))
  const file = join(dir, "agent-intercom.json")
  setSettingsPath(file)
  delete process.env.OPENCODE_AGENT_INTERCOM_SEARXNG_URL
  delete process.env.EXA_API_KEY
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH
  if (fileSettings) writeFileSync(file, JSON.stringify(fileSettings))
  resetSettings()
  return { dir, file }
}

// ── canned backend replies ────────────────────────────────────────────────

function exaSse(text, isError = false) {
  const result = { content: [{ type: "text", text }] }
  if (isError) result.isError = true
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result })
  return { ok: true, status: 200, text: async () => `event: message\ndata: ${payload}\n` }
}

// `count` Exa blocks in Exa's own text shape, URLs numbered so order is visible.
function exaBlocks(count, host = "exa.example") {
  const blocks = []
  for (let i = 1; i <= count; i++) {
    blocks.push(`Title: exa ${i}\nURL: https://${host}/${i}\nHighlights:\nthread ${i}`)
  }
  return blocks.join("\n---\n")
}

function searxRows(count, score = 1, host = "searx.example", engine = "") {
  const rows = []
  for (let i = 1; i <= count; i++) {
    rows.push({ url: `https://${host}/${i}`, title: `searx ${i}`, content: `row ${i}`, score, engine })
  }
  return rows
}

const searxJson = (results) => ({ ok: true, status: 200, json: async () => ({ results }) })
const httpFail = (status, body) => ({ ok: false, status, text: async () => body })

// Stub fetch, routing by URL. `exa` / `searx` are called per request and return
// the canned reply; every request is recorded for the assertions.
function stubFetch({ exa, searx }) {
  const original = globalThis.fetch
  const calls = { exa: [], searx: [] }
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith("https://mcp.exa.ai")) {
      calls.exa.push({ url: u, body: JSON.parse(init.body), headers: init.headers })
      return exa ? exa() : exaSse(exaBlocks(1))
    }
    calls.searx.push({ url: u, query: new URL(u).searchParams.get("q") })
    return searx ? searx() : searxJson(searxRows(1))
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const urlsOf = (output) => [...output.matchAll(/^URL: (.+)$/gm)].map((m) => m[1])

// ── the bang set ──────────────────────────────────────────────────────────

test("getForumBangs: no settings file → the five built-in bangs, !gh not among them", () => {
  const { dir } = isolate()
  try {
    assert.deepEqual(getForumBangs(), ["!st", "!ubuntu", "!su", "!hn", "!lo"])
    // !gh returns repository roots — 0 of 30 with an issue or discussion path —
    // and a repository is not what this route's output contract offers.
    assert.ok(!getForumBangs().includes("!gh"))
    assert.deepEqual(getForumBangs(), DEFAULT_FORUM_BANGS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("getForumBangs: a configured set REPLACES the built-in one, it does not extend it", () => {
  const { dir } = isolate({ forumBangs: ["!hn", "!lo", "!se"] })
  try {
    assert.deepEqual(getForumBangs(), ["!hn", "!lo", "!se"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("getForumBangs: blank entries are trimmed and dropped, the rest is honoured", () => {
  const { dir } = isolate({ forumBangs: ["  !hn  ", "   ", "!se"] })
  try {
    assert.deepEqual(getForumBangs(), ["!hn", "!se"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("getForumBangs: an empty array, a non-array and an all-invalid array fall back, no throw", () => {
  for (const value of [[], "!hn", 42, null, [1, 2, 3], ["   ", ""]]) {
    const { dir, file } = isolate()
    try {
      writeFileSync(file, JSON.stringify({ forumBangs: value }))
      resetSettings()
      assert.deepEqual(getForumBangs(), DEFAULT_FORUM_BANGS, `unusable forumBangs: ${JSON.stringify(value)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

// ── query construction ────────────────────────────────────────────────────

test("the Exa query is the envelope prefix plus the user query verbatim", () => {
  assert.equal(
    forumEnvelope("running zfs special vdev"),
    "forum threads where people report their real experience with running zfs special vdev",
  )
})

test("the searxng query is the bangs, single-spaced, then the BARE user query", () => {
  assert.equal(
    bangQuery("zfs special vdev", ["!hn", "!lo"]),
    "!hn !lo zfs special vdev",
  )
})

test("forum_search sends the envelope to Exa and the bare bang query to searxng", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({ exa: () => exaSse(exaBlocks(3)), searx: () => searxJson(searxRows(3)) })
  try {
    await createForumSearchTool().execute({ query: "zfs special vdev", numResults: 4 }, {})

    const exaArgs = stub.calls.exa[0].body.params.arguments
    assert.equal(
      exaArgs.query,
      "forum threads where people report their real experience with zfs special vdev",
    )
    assert.equal(stub.calls.exa.length, 1, "exactly one Exa call per invocation")

    const q = stub.calls.searx[0].query
    assert.equal(q, "!st !ubuntu !su !hn !lo zfs special vdev")
    assert.doesNotMatch(q, /forum threads where people report/, "envelope prose must stay off searxng")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no domain argument and no domain name reaches Exa — an ignored parameter leaves no trace", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({ exa: () => exaSse(exaBlocks(2)), searx: () => searxJson(searxRows(2)) })
  try {
    await createForumSearchTool().execute({ query: "proxmox upgrade" }, {})
    const exaArgs = stub.calls.exa[0].body.params.arguments
    assert.deepEqual(
      Object.keys(exaArgs).sort(),
      ["numResults", "query"],
      "web_search_exa takes query and numResults only; anything else is silently ignored",
    )
    assert.doesNotMatch(exaArgs.query, /reddit|forum\.proxmox|\.com\b|\.org\b/, "no domain in the envelope")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the Exa leg over-fetches numResults * 2, capped at the endpoint's 20", async () => {
  const { dir } = isolate()
  for (const [asked, expected] of [[undefined, 16], [4, 8], [12, 20], [20, 20]]) {
    const stub = stubFetch({ exa: () => exaSse(exaBlocks(2)) })
    try {
      const args = asked === undefined ? { query: "x" } : { query: "x", numResults: asked }
      await createForumSearchTool().execute(args, {})
      assert.equal(stub.calls.exa[0].body.params.arguments.numResults, expected)
    } finally {
      stub.restore()
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

test("the configured bang set is what goes out on the wire", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE, forumBangs: ["!se"] })
  const stub = stubFetch({ exa: () => exaSse(exaBlocks(1)), searx: () => searxJson(searxRows(1)) })
  try {
    await createForumSearchTool().execute({ query: "btrfs raid5" }, {})
    assert.equal(stub.calls.searx[0].query, "!se btrfs raid5")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the keyword form of the searxng query ─────────────────────────────────

test("reduceToKeywords strips the question frame and the route's own experience words", () => {
  assert.equal(
    reduceToKeywords("What is it like running Kubernetes on Raspberry Pi in practice, and what breaks?"),
    "Kubernetes Raspberry Pi",
    "the interrogative frame and running/practice/breaks go; case and order stay",
  )
})

test("reduceToKeywords keeps at most four tokens, in their original order", () => {
  assert.equal(
    reduceToKeywords("kubernetes raspberry pi cluster networking storage"),
    "kubernetes raspberry pi cluster",
  )
})

test("reduceToKeywords passes an already-short keyword string through unchanged", () => {
  assert.equal(reduceToKeywords("zfs special vdev"), "zfs special vdev")
})

test("reduceToKeywords on nothing but stopwords falls back to the query, never to empty", () => {
  // an empty searxng query would cost the leg every row; a bad one costs it some
  assert.equal(reduceToKeywords("What is it like in practice?"), "What is it like in practice?")
  assert.equal(reduceToKeywords(""), "")
})

test("the searxng leg is sent `keywords` when supplied, and the derivation when not", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE, forumBangs: ["!st"] })
  for (const [args, expected] of [
    [{ query: "does zfs special vdev hold up in practice", keywords: "zfs special vdev" },
      "!st zfs special vdev"],
    [{ query: "does zfs special vdev hold up in practice" }, "!st zfs special vdev hold"],
    [{ query: "does zfs special vdev hold up in practice", keywords: "   " }, "!st zfs special vdev hold"],
  ]) {
    const stub = stubFetch({ exa: () => exaSse(exaBlocks(2)), searx: () => searxJson(searxRows(2)) })
    try {
      await createForumSearchTool().execute(args, {})
      assert.equal(stub.calls.searx[0].query, expected)
      // the Exa leg keeps the prose either way
      assert.match(stub.calls.exa[0].body.params.arguments.query, /experience with does zfs special vdev/)
    } finally {
      stub.restore()
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

// ── the thread shape ──────────────────────────────────────────────────────

test("isThreadUrl is true for the shapes any host may carry", () => {
  for (const url of [
    "https://forums.example.com/viewtopic.php?t=1",
    "https://example.com/showthread.php?tid=3",
    "https://example.com/questions/12/x",
    "https://example.com/q/12",
    "https://discuss.example.org/t/topic/9",
    "https://example.com/r/x/comments/abc",
    "https://news.ycombinator.com/item?id=1",
    "https://github.com/o/r/issues/7",
    "https://github.com/o/r/discussions/7",
    "https://community.example.net/topic/4",
    "https://board.example.net/threads/5",
    "https://answers.example.net/a/12",
  ]) {
    assert.equal(isThreadUrl(url), true, url)
  }
})

test("isThreadUrl is false for a page that is not a discussion", () => {
  for (const url of [
    "https://example.com/blog/post",
    "https://github.com/o/r",
    "https://github.com/o/r/issues",
    "https://medium.com/@a/b",
    "https://example.com/docs/api",
    // a lobste.rs row is the SUBMITTED page — the discussion is one hop away
    "https://gaultier.github.io/blog/x.html",
    "",
    null,
    "not a url at all %%",
  ]) {
    assert.equal(isThreadUrl(url), false, String(url))
  }
})

// ── the searxng lane ──────────────────────────────────────────────────────

test("searxToEntries carries searxng's score and engine and defaults both", () => {
  const entries = searxToEntries([
    { url: "https://a.example/1", title: "a", content: "x", score: 4.5, engine: "stackoverflow" },
    { url: "https://b.example/2", title: "b", content: "y" },
    { url: "https://c.example/3", title: "c", content: "z", score: "2", engine: "  hackernews " },
  ])
  assert.deepEqual(entries.map((e) => e.score), [4.5, 0, 2])
  assert.deepEqual(entries.map((e) => e.engine), ["stackoverflow", "", "hackernews"])
})

test("renderEntries prints neither score nor engine — web_search's output shape is untouched", () => {
  const entries = searxToEntries([
    { url: "https://a.example/1", title: "a", content: "x", score: 9, engine: "lobste.rs" },
  ])
  assert.equal(
    renderEntries(entries),
    "Title: a\nURL: https://a.example/1\nPublished: N/A\nAuthor: N/A\nHighlights:\nx",
  )
})

test("searxLane caps each engine at two rows and represents every engine that answered", () => {
  // 80 rows: the loud engine holds 30, the four thread engines the rest. Scores
  // are searxng's reciprocal rank, so each engine's own rank-1 row scores 1.
  const entries = []
  const engines = { loud: 30, so: 20, su: 15, ubuntu: 10, hn: 5 }
  for (const [engine, count] of Object.entries(engines)) {
    for (let i = 1; i <= count; i++) {
      entries.push({ url: `https://${engine}.example/${i}`, score: 1 / i, engine })
    }
  }
  const lane = searxLane(entries, 16)
  const perEngine = {}
  for (const e of lane) perEngine[e.engine] = (perEngine[e.engine] ?? 0) + 1
  assert.deepEqual(perEngine, { loud: 2, so: 2, su: 2, ubuntu: 2, hn: 2 })
  assert.equal(lane.length, 10, "two per engine is the whole lane here")
  // each engine's own highest-ranked rows, not an arbitrary two
  assert.deepEqual(
    lane.filter((e) => e.engine === "loud").map((e) => e.url),
    ["https://loud.example/1", "https://loud.example/2"],
  )
})

test("searxLane truncates the lane to `limit`", () => {
  const entries = []
  for (let i = 1; i <= 60; i++) {
    entries.push({ url: `https://searx.example/${i}`, score: 61 - i, engine: `e${i}` })
  }
  const lane = searxLane(entries, 8)
  assert.equal(lane.length, 8)
  assert.equal(lane[0].url, "https://searx.example/1", "the score ordering is kept")
  assert.ok(!lane.some((e) => e.url === "https://searx.example/9"))
})

test("searxLane on an all-zero-score response keeps its rows and does not throw", () => {
  const entries = [{ url: "a", score: 0 }, { url: "b" }, { url: "c", score: 0 }]
  assert.equal(searxLane(entries, 8).length, 3, "a row naming no engine takes no shared bucket")
  assert.deepEqual(searxLane([], 8), [])
})

// ── the merge ─────────────────────────────────────────────────────────────

test("partitionByShape puts a lane's threads first and removes nothing", () => {
  const lane = [
    { url: "https://example.com/blog/post" },
    { url: "https://example.com/q/12" },
    { url: "https://medium.com/@a/b" },
    { url: "https://news.ycombinator.com/item?id=7" },
  ]
  assert.deepEqual(partitionByShape(lane).map((e) => e.url), [
    "https://example.com/q/12",
    "https://news.ycombinator.com/item?id=7",
    "https://example.com/blog/post",
    "https://medium.com/@a/b",
  ])
})

// merged-list builders for the lane merge
const exaEntry = (url) => ({ url, source: "exa" })
const searxEntry = (url) => ({ url, source: "searxng" })

test("a searxng lane of no threads spends at most floor(numResults / 4) slots", () => {
  const merged = []
  for (let i = 1; i <= 16; i++) merged.push(exaEntry(`https://exa.example/q/${i}`))
  for (let i = 1; i <= 4; i++) merged.push(searxEntry(`https://searx.example/blog/${i}`))
  const picked = pickFromLanes(merged, 8)
  assert.equal(picked.length, 8)
  assert.equal(picked.filter((e) => e.source === "searxng").length, 2, "floor(8 / 4)")
  assert.equal(picked.filter((e) => e.source === "exa").length, 6, "the rest goes to the Exa lane")
})

test("with both lanes thread-shaped the output alternates, Exa first", () => {
  const merged = []
  for (let i = 1; i <= 4; i++) merged.push(exaEntry(`https://exa.example/t/${i}`))
  for (let i = 1; i <= 4; i++) merged.push(searxEntry(`https://searx.example/q/${i}`))
  assert.deepEqual(pickFromLanes(merged, 6).map((e) => e.url), [
    "https://exa.example/t/1",
    "https://searx.example/q/1",
    "https://exa.example/t/2",
    "https://searx.example/q/2",
    "https://exa.example/t/3",
    "https://searx.example/q/3",
  ])
})

test("the quota bounds a weak leg's share, never the yield: skipped rows fill the output", () => {
  // two Exa rows and ten non-thread searxng rows at numResults 8: the quota
  // hands out 2 searxng slots, and the fill step has to carry the other 4.
  const merged = [exaEntry("https://exa.example/t/1"), exaEntry("https://exa.example/t/2")]
  for (let i = 1; i <= 10; i++) merged.push(searxEntry(`https://searx.example/blog/${i}`))
  const picked = pickFromLanes(merged, 8)
  assert.equal(picked.length, 8, "never shorter than min(numResults, merged.length)")
  assert.deepEqual(picked.slice(0, 4).map((e) => e.url), [
    "https://exa.example/t/1",
    "https://searx.example/blog/1",
    "https://exa.example/t/2",
    "https://searx.example/blog/2",
  ])
  // the fill appends in merged order, and repeats nothing
  assert.equal(new Set(picked.map((e) => e.url)).size, 8)
  assert.deepEqual(picked.slice(4).map((e) => e.url), [
    "https://searx.example/blog/3",
    "https://searx.example/blog/4",
    "https://searx.example/blog/5",
    "https://searx.example/blog/6",
  ])
})

test("a shape the rule does not know costs order, never presence", () => {
  const merged = [
    exaEntry("https://lemmy.example/post/9"),
    exaEntry("https://exa.example/t/1"),
    searxEntry("https://searx.example/q/1"),
  ]
  const picked = pickFromLanes(merged, 8)
  assert.equal(picked.length, 3)
  assert.ok(picked.some((e) => e.url === "https://lemmy.example/post/9"))
  assert.equal(picked[0].url, "https://exa.example/t/1", "the known shape leads its lane")
})

test("a lopsided merge (20 Exa, 60 searxng) starts with Exa and bounds the weak lane", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () => exaSse(exaBlocks(20)),
    searx: () => searxJson(searxRows(60)),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "k3s on raspberry pi" }, {})
    const urls = urlsOf(out.output)
    assert.equal(urls.length, 8, "capped at numResults (default 8)")
    assert.match(urls[0], /exa\.example/, "the Exa leg leads — its ordering is the measured one")
    // neither lane is thread-shaped here, so the searxng lane gets its quota
    assert.equal(urls.filter((u) => u.includes("searx.example")).length, 2, "floor(8 / 4)")
    assert.equal(urls.filter((u) => u.includes("exa.example")).length, 6)
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a thread-shaped searxng row is not touched by the non-thread quota", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () => exaSse(exaBlocks(20)),
    searx: () =>
      searxJson(
        [1, 2, 3, 4, 5, 6].map((i) => ({
          url: `https://superuser.example/q/${i}`,
          title: `su ${i}`,
          content: `row ${i}`,
          score: 1 / i,
          engine: `engine${i}`,
        })),
      ),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "k3s on raspberry pi" }, {})
    const urls = urlsOf(out.output)
    assert.equal(urls.filter((u) => u.includes("superuser.example")).length, 4, "round-robin, unquotaed")
    assert.equal(urls[0], "https://exa.example/1")
    assert.equal(urls[1], "https://superuser.example/q/1")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nothing is filtered out by host: a plain article URL is returned like any other", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () =>
      exaSse(
        "Title: a blog post\nURL: https://some-blog.example/post\nHighlights:\nnot a forum\n" +
          "---\n" +
          "Title: a thread\nURL: https://forums.raspberrypi.com/t/1\nHighlights:\nthread",
      ),
    searx: () => searxJson(searxRows(1)),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "pi cluster" }, {})
    const urls = urlsOf(out.output)
    assert.ok(urls.includes("https://some-blog.example/post"), "no whitelist, no host matching")
    assert.ok(urls.includes("https://forums.raspberrypi.com/t/1"))
    assert.equal(urls[0], "https://forums.raspberrypi.com/t/1", "shape orders, it does not gate")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── failure behaviour ─────────────────────────────────────────────────────

test("both legs dead → forum_search failed, naming both reasons", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () => httpFail(500, "exa down"),
    searx: () => httpFail(502, "searxng down"),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "x" }, {})
    assert.match(out.output, /^forum_search failed: /)
    assert.match(out.output, /exa: Exa HTTP 500/)
    assert.match(out.output, /searxng: searxng HTTP 502/)
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("one leg dead → the other's results are returned and nothing throws", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({ exa: () => httpFail(500, "exa down"), searx: () => searxJson(searxRows(3)) })
  try {
    const out = await createForumSearchTool().execute({ query: "x", numResults: 3 }, {})
    assert.deepEqual(urlsOf(out.output), [
      "https://searx.example/1",
      "https://searx.example/2",
      "https://searx.example/3",
    ])
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an Exa isError rate-limit reply is a failed leg, not zero results — searxng still renders", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () => exaSse("You've hit Exa's free MCP rate limit.", true),
    searx: () => searxJson(searxRows(2)),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "x", numResults: 2 }, {})
    assert.deepEqual(urlsOf(out.output), ["https://searx.example/1", "https://searx.example/2"])
    assert.doesNotMatch(out.output, /rate limit/, "the limit text is a reason, never content")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an Exa isError reply with searxng also dead names the rate limit as the reason", async () => {
  const { dir } = isolate({ searxngUrl: SEARXNG_BASE })
  const stub = stubFetch({
    exa: () => exaSse("You've hit Exa's free MCP rate limit.", true),
    searx: () => httpFail(502, "searxng down"),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "x" }, {})
    assert.match(out.output, /^forum_search failed: exa: You've hit Exa's free MCP rate limit\./)
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an Exa isError payload does not abort the scan: a later usable payload wins", async () => {
  const { dir } = isolate()
  const sse = (...payloads) => ({
    ok: true,
    status: 200,
    text: async () => payloads.map((p) => `event: message\ndata: ${JSON.stringify(p)}\n`).join("\n"),
  })
  const stub = stubFetch({
    exa: () =>
      sse(
        { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "rate limit" }] } },
        { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: exaBlocks(2) }] } },
      ),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "x", numResults: 2 }, {})
    assert.deepEqual(urlsOf(out.output), ["https://exa.example/1", "https://exa.example/2"])
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an Exa isError payload carrying no text part still names a reason", async () => {
  const { dir } = isolate()
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "resource", uri: "exa://rate-limit" }] },
  }
  const stub = stubFetch({
    exa: () => ({
      ok: true,
      status: 200,
      text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n`,
    }),
  })
  try {
    const out = await createForumSearchTool().execute({ query: "x" }, {})
    assert.match(out.output, /^forum_search failed: exa: /)
    assert.match(out.output, /exa:\/\/rate-limit/, "the raw parts name the reason")
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("searxngUrl unset → no searxng request is made and the Exa leg still renders", async () => {
  const { dir } = isolate()
  const stub = stubFetch({ exa: () => exaSse(exaBlocks(2)) })
  try {
    const out = await createForumSearchTool().execute({ query: "x", numResults: 2 }, {})
    assert.equal(stub.calls.searx.length, 0, "no searxng call without a configured base URL")
    assert.deepEqual(urlsOf(out.output), ["https://exa.example/1", "https://exa.example/2"])
  } finally {
    stub.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── registration ──────────────────────────────────────────────────────────

test("forum_search is registered by default and omitted when disabled", () => {
  const { dir } = isolate()
  try {
    const make = () => createTools({ client: {}, directory: dir, permissionGuard: () => true })
    assert.equal(isForumSearchEnabled(), true)
    assert.ok(make().forum_search, "expected forum_search to be registered")

    process.env.OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH = "1"
    try {
      assert.equal(isForumSearchEnabled(), false)
      assert.equal(make().forum_search, undefined)
    } finally {
      delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── prompt routing ────────────────────────────────────────────────────────

test("the researcher prompt routes experience questions to forum_search", () => {
  const prompt = AGENTS.researcher.prompt
  // the route decision is read off the question, before any query goes out:
  // forum_search comes FIRST and is explicitly not a fallback for an empty
  // web_search.
  assert.match(prompt, /call `forum_search` FIRST/)
  assert.match(prompt, /never a fallback for one that came back empty/)
  // the trigger words the model matches on are the ones the Exa envelope puts
  // into the query, so the route it takes searches for the phrasing it matched.
  assert.match(prompt, /works in practice/)
  assert.match(prompt, /which settings people actually run/)
  assert.match(prompt, /what breaks on them/)
  // guard against over-triggering, and the both-sided question
  assert.match(prompt, /For documentation, a release, an announcement, a version or an official fact use `web_search`/)
  assert.match(prompt, /A question carrying both takes `forum_search` first and `web_search` after it/)
  // excerpts are triage material, not the answer
  assert.match(prompt, /Forum excerpts are triage: pick the threads worth reading and `webfetch` them/)
})

test("the researcher description names forum_search beside web_search", () => {
  // the orchestrator picks the agent by this string, so both routes have to be
  // visible in it.
  const description = AGENTS.researcher.description
  assert.match(description, /`web_search`/)
  assert.match(description, /`forum_search`/)
  // and the role itself must not deny the tool its prompt tells it to call
  assert.notEqual(AGENTS.researcher.permission?.forum_search, "deny")
})
