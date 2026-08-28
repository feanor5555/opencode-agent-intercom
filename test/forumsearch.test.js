// Unit tests for the `forum_search` route: the two legs, the bang chain, the
// relative score cut inside the searxng leg and the round-robin merge.
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
import {
  forumEnvelope,
  bangQuery,
  cutByScore,
  cutSearxLeg,
  interleave,
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

function searxRows(count, score = 1, host = "searx.example") {
  const rows = []
  for (let i = 1; i <= count; i++) {
    rows.push({ url: `https://${host}/${i}`, title: `searx ${i}`, content: `row ${i}`, score })
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

test("getForumBangs: no settings file → the six built-in bangs", () => {
  const { dir } = isolate()
  try {
    assert.deepEqual(getForumBangs(), ["!hn", "!lo", "!st", "!ubuntu", "!su", "!gh"])
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
    assert.equal(q, "!hn !lo !st !ubuntu !su !gh zfs special vdev")
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

// ── the searxng-side score cut ────────────────────────────────────────────

test("searxToEntries carries searxng's score and defaults it to 0", () => {
  const entries = searxToEntries([
    { url: "https://a.example/1", title: "a", content: "x", score: 4.5 },
    { url: "https://b.example/2", title: "b", content: "y" },
    { url: "https://c.example/3", title: "c", content: "z", score: "2" },
  ])
  assert.deepEqual(entries.map((e) => e.score), [4.5, 0, 2])
})

test("renderEntries does not print the score — web_search's output shape is untouched", () => {
  const entries = searxToEntries([{ url: "https://a.example/1", title: "a", content: "x", score: 9 }])
  assert.equal(
    renderEntries(entries),
    "Title: a\nURL: https://a.example/1\nPublished: N/A\nAuthor: N/A\nHighlights:\nx",
  )
})

test("cutByScore drops below one tenth of the top score and keeps a row exactly at it", () => {
  const entries = [
    { url: "a", score: 1 },
    { url: "b", score: 10 },
    { url: "c", score: 0.99 },
    { url: "d", score: 5 },
  ]
  const kept = cutByScore(entries)
  assert.deepEqual(kept.map((e) => e.url), ["b", "d", "a"], "sorted by score, the 0.99 row dropped")
})

test("cutByScore on an all-zero response keeps everything and does not throw", () => {
  const entries = [{ url: "a", score: 0 }, { url: "b" }, { url: "c", score: 0 }]
  assert.equal(cutByScore(entries).length, 3)
  assert.deepEqual(cutByScore([]), [])
})

test("cutSearxLeg bounds the lane to `limit` after the score cut", () => {
  // 60 rows, descending scores, none low enough for the score cut to reach.
  const entries = []
  for (let i = 1; i <= 60; i++) {
    entries.push({ url: `https://searx.example/${i}`, score: 61 - i })
  }
  const lane = cutSearxLeg(entries, 16)
  assert.equal(lane.length, 16, "numResults * 2 rows at most")
  assert.equal(lane[0].url, "https://searx.example/1", "the cut's ranking is kept")
  assert.ok(
    !lane.some((e) => e.url === "https://searx.example/17"),
    "the 17th-ranked row cannot reach the merge",
  )
  // the score cut runs first, so the lane can be shorter than the bound
  assert.equal(cutSearxLeg([{ url: "a", score: 10 }, { url: "b", score: 0.5 }], 16).length, 1)
})

// ── the merge ─────────────────────────────────────────────────────────────

test("interleave takes the primary leg first, starves neither and honours the cap", () => {
  const a = [1, 2, 3].map((n) => ({ url: `a${n}` }))
  const b = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `b${n}` }))
  assert.deepEqual(interleave(a, b, 6).map((e) => e.url), ["a1", "b1", "a2", "b2", "a3", "b3"])
  assert.deepEqual(interleave(a, b, 3).map((e) => e.url), ["a1", "b1", "a2"])
  assert.deepEqual(interleave([], b, 2).map((e) => e.url), ["b1", "b2"])
  assert.deepEqual(interleave(a, [], 5).map((e) => e.url), ["a1", "a2", "a3"])
})

test("a lopsided merge (20 Exa, 60 searxng) starts with Exa and represents both legs", async () => {
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
    assert.equal(urls.filter((u) => u.includes("exa.example")).length, 4)
    assert.equal(urls.filter((u) => u.includes("searx.example")).length, 4)
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
