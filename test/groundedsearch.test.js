// Unit tests for the `grounded_search` route: the API-key lookup order, the
// request the tool sends, the source extraction and dedupe, the `max_sources`
// clamp, and the missing-key and HTTP-error paths.
//
// No live network — `globalThis.fetch` is stubbed and every request is
// recorded. The key lookup is isolated by pointing XDG_DATA_HOME at a fresh
// temp directory and clearing the three env vars, so neither the developer's
// shell nor the machine's real opencode auth file can reach an assertion.
//
// Run: node --test test/groundedsearch.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  API_KEY_ENV_VARS,
  DEFAULT_GROUNDING_MODEL,
  DEFAULT_MAX_SOURCES,
  authFilePath,
  clampMaxSources,
  createGroundedSearchTool,
  extractAnswer,
  extractSearchQueries,
  extractSources,
  generateContentUrl,
  groundedRequestBody,
  httpErrorMessage,
  isGroundedSearchEnabled,
  missingKeyMessage,
  renderGroundedResult,
  resolveGoogleApiKey,
} from "../src/groundedsearch.js"
import { createTools } from "../src/tools.js"

// Placeholders only — never a real key in the repository.
const ENV_KEY_INTERCOM = "intercom-placeholder-not-a-real-key"
const ENV_KEY_GEMINI = "gemini-placeholder-not-a-real-key"
const ENV_KEY_GOOGLE = "google-placeholder-not-a-real-key"
const FILE_KEY = "authfile-placeholder-not-a-real-key"

const TOUCHED_ENV = [
  ...API_KEY_ENV_VARS,
  "XDG_DATA_HOME",
  "OPENCODE_AGENT_INTERCOM_GROUNDING_TIMEOUT_MS",
  "OPENCODE_AGENT_INTERCOM_DISABLE_GROUNDED_SEARCH",
]

const savedEnv = Object.fromEntries(TOUCHED_ENV.map((n) => [n, process.env[n]]))

test.after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

// A data home of our own, empty unless a case writes an auth file into it.
function isolate(authContent) {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-grounded-"))
  for (const name of TOUCHED_ENV) delete process.env[name]
  process.env.XDG_DATA_HOME = dir
  if (authContent !== undefined) {
    mkdirSync(join(dir, "opencode"), { recursive: true })
    writeFileSync(join(dir, "opencode", "auth.json"), authContent)
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── canned Gemini replies ─────────────────────────────────────────────────

function geminiReply({ parts, groundingMetadata }) {
  const candidate = { content: { parts } }
  if (groundingMetadata) candidate.groundingMetadata = groundingMetadata
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [candidate] }),
    text: async () => "",
  }
}

const httpFail = (status, body) => ({
  ok: false,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
})

const webChunk = (uri, title) => ({ web: { uri, title } })
const support = (...indices) => ({ groundingChunkIndices: indices })

// Stub fetch, recording every request. `reply` is called per request; the
// default is a one-source grounded answer.
function stubFetch(reply) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
      signal: init?.signal,
    })
    if (init?.signal?.aborted) {
      const err = new Error("This operation was aborted")
      err.name = "AbortError"
      throw err
    }
    return reply
      ? reply()
      : geminiReply({
          parts: [{ text: "answer" }],
          groundingMetadata: {
            groundingChunks: [webChunk("https://a.example/1", "A")],
            groundingSupports: [support(0)],
            webSearchQueries: ["a"],
          },
        })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ── key lookup order ──────────────────────────────────────────────────────

test("no env var and no auth file: the key resolves to the empty string", () => {
  const { cleanup } = isolate()
  try {
    assert.equal(resolveGoogleApiKey(), "")
  } finally {
    cleanup()
  }
})

test("the plugin's own env var wins over GEMINI_API_KEY, GOOGLE_API_KEY and the auth file", () => {
  const { cleanup } = isolate(JSON.stringify({ google: { type: "api", key: FILE_KEY } }))
  try {
    process.env.OPENCODE_AGENT_INTERCOM_GOOGLE_API_KEY = ENV_KEY_INTERCOM
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    process.env.GOOGLE_API_KEY = ENV_KEY_GOOGLE
    assert.equal(resolveGoogleApiKey(), ENV_KEY_INTERCOM)
  } finally {
    cleanup()
  }
})

test("GEMINI_API_KEY comes before GOOGLE_API_KEY, and both before the auth file", () => {
  const { cleanup } = isolate(JSON.stringify({ google: { key: FILE_KEY } }))
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    process.env.GOOGLE_API_KEY = ENV_KEY_GOOGLE
    assert.equal(resolveGoogleApiKey(), ENV_KEY_GEMINI)

    delete process.env.GEMINI_API_KEY
    assert.equal(resolveGoogleApiKey(), ENV_KEY_GOOGLE)

    delete process.env.GOOGLE_API_KEY
    assert.equal(resolveGoogleApiKey(), FILE_KEY, "the auth file is the last place consulted")
  } finally {
    cleanup()
  }
})

test("a whitespace-only env value counts as unset and the next place is consulted", () => {
  const { cleanup } = isolate(JSON.stringify({ google: { key: FILE_KEY } }))
  try {
    process.env.OPENCODE_AGENT_INTERCOM_GOOGLE_API_KEY = "   "
    process.env.GEMINI_API_KEY = ""
    assert.equal(resolveGoogleApiKey(), FILE_KEY)

    process.env.GEMINI_API_KEY = `  ${ENV_KEY_GEMINI}  `
    assert.equal(resolveGoogleApiKey(), ENV_KEY_GEMINI, "surrounding whitespace is stripped")
  } finally {
    cleanup()
  }
})

test("the auth file is read from XDG_DATA_HOME, falling back to ~/.local/share", () => {
  const { dir, cleanup } = isolate()
  try {
    assert.equal(authFilePath(), join(dir, "opencode", "auth.json"))
    delete process.env.XDG_DATA_HOME
    assert.match(authFilePath(), /\.local[/\\]share[/\\]opencode[/\\]auth\.json$/)
  } finally {
    cleanup()
  }
})

test("a missing, unparseable or google-less auth file resolves to no key, never a throw", () => {
  for (const content of [
    undefined,
    "{ not json",
    JSON.stringify({}),
    JSON.stringify({ google: {} }),
    JSON.stringify({ google: { key: "   " } }),
    JSON.stringify({ google: { key: 42 } }),
  ]) {
    const { cleanup } = isolate(content)
    try {
      assert.equal(resolveGoogleApiKey(), "", `unusable auth file: ${content}`)
    } finally {
      cleanup()
    }
  }
})

test("the auth file's key is trimmed", () => {
  const { cleanup } = isolate(JSON.stringify({ google: { key: `  ${FILE_KEY}  ` } }))
  try {
    assert.equal(resolveGoogleApiKey(), FILE_KEY)
  } finally {
    cleanup()
  }
})

// ── the missing-key path ──────────────────────────────────────────────────

test("no key anywhere: the call fails naming all four places and sends nothing", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch()
  try {
    await assert.rejects(
      () => createGroundedSearchTool().execute({ query: "x" }, {}),
      (err) => {
        for (const name of API_KEY_ENV_VARS) {
          assert.ok(err.message.includes(name), `the error must name ${name}`)
        }
        assert.ok(err.message.includes(authFilePath()), "the error must name the auth file path")
        return true
      },
    )
    assert.equal(stub.calls.length, 0, "no request may be made without a key")
  } finally {
    stub.restore()
    cleanup()
  }
})

test("the missing-key message names the four places and echoes no value", () => {
  const { cleanup } = isolate(JSON.stringify({ google: { key: FILE_KEY } }))
  try {
    const msg = missingKeyMessage()
    for (const name of API_KEY_ENV_VARS) assert.ok(msg.includes(name))
    assert.ok(msg.includes(authFilePath()))
    assert.equal(msg.includes(FILE_KEY), false, "no key value may appear in the message")
  } finally {
    cleanup()
  }
})

// ── the request ───────────────────────────────────────────────────────────

test("the request is one POST to generateContent with the key in the x-goog-api-key header", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch()
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    await createGroundedSearchTool().execute({ query: "who released node 24" }, {})

    assert.equal(stub.calls.length, 1, "exactly one call per invocation")
    const call = stub.calls[0]
    assert.equal(call.method, "POST")
    assert.equal(
      call.url,
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GROUNDING_MODEL}:generateContent`,
    )
    assert.equal(call.headers["x-goog-api-key"], ENV_KEY_GEMINI)
    assert.equal(call.headers["Content-Type"], "application/json")
    assert.equal(
      call.url.includes(ENV_KEY_GEMINI),
      false,
      "the key must never travel in the URL query",
    )
  } finally {
    stub.restore()
    cleanup()
  }
})

test("the body is one user turn plus the snake_case google_search tool", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch()
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    await createGroundedSearchTool().execute({ query: "zfs special vdev sizing" }, {})

    const body = stub.calls[0].body
    assert.deepEqual(body, {
      contents: [{ role: "user", parts: [{ text: "zfs special vdev sizing" }] }],
      tools: [{ google_search: {} }],
    })
    assert.deepEqual(groundedRequestBody("q"), {
      contents: [{ role: "user", parts: [{ text: "q" }] }],
      tools: [{ google_search: {} }],
    })
    assert.equal("googleSearch" in body.tools[0], false, "camelCase is not the shape sent")
  } finally {
    stub.restore()
    cleanup()
  }
})

test("Search grounding always uses gemini-3.7-flash", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch()
  try {
    assert.equal(DEFAULT_GROUNDING_MODEL, "gemini-3.7-flash")

    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    const res = await createGroundedSearchTool().execute({ query: "x" }, {})

    assert.equal(
      stub.calls[0].url,
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GROUNDING_MODEL}:generateContent`,
    )
    assert.equal(res.metadata.model, DEFAULT_GROUNDING_MODEL)
  } finally {
    stub.restore()
    cleanup()
  }
})

test("the model name is path-encoded, so it cannot reshape the URL", () => {
  assert.equal(
    generateContentUrl("weird/model name"),
    "https://generativelanguage.googleapis.com/v1beta/models/weird%2Fmodel%20name:generateContent",
  )
})

// ── answers and sources ───────────────────────────────────────────────────

test("the answer is every text part joined, thought parts excluded", () => {
  assert.equal(
    extractAnswer({
      candidates: [
        {
          content: {
            parts: [
              { text: "reasoning", thought: true },
              { text: "first " },
              { functionCall: {} },
              { text: "second" },
            ],
          },
        },
      ],
    }),
    "first second",
  )
  assert.equal(extractAnswer({}), "", "a reply without candidates yields no answer")
  assert.equal(extractAnswer({ candidates: [{ content: {} }] }), "")
})

test("sources follow the support order and are deduped by uri", () => {
  const metadata = {
    groundingChunks: [
      webChunk("https://a.example/1", "A"),
      webChunk("https://b.example/2", "B"),
      webChunk("https://c.example/3", "C"),
    ],
    groundingSupports: [support(2), support(0, 2), support(1, 0)],
  }
  assert.deepEqual(extractSources(metadata, 10), [
    { title: "C", uri: "https://c.example/3" },
    { title: "A", uri: "https://a.example/1" },
    { title: "B", uri: "https://b.example/2" },
  ])
})

test("two chunks carrying the same uri are one source", () => {
  const metadata = {
    groundingChunks: [
      webChunk("https://a.example/1", "A"),
      webChunk("https://a.example/1", "A mirror"),
    ],
    groundingSupports: [support(0), support(1)],
  }
  const sources = extractSources(metadata, 10)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].title, "A", "the first title seen is kept")
})

test("without usable supports the chunks themselves are the source list", () => {
  const chunks = [webChunk("https://a.example/1", "A"), webChunk("https://b.example/2", "B")]
  assert.deepEqual(extractSources({ groundingChunks: chunks }, 10), [
    { title: "A", uri: "https://a.example/1" },
    { title: "B", uri: "https://b.example/2" },
  ])
  // supports that point at nothing usable fall back the same way
  assert.deepEqual(
    extractSources({ groundingChunks: chunks, groundingSupports: [support(7)] }, 10),
    [
      { title: "A", uri: "https://a.example/1" },
      { title: "B", uri: "https://b.example/2" },
    ],
  )
})

test("a chunk without a web uri contributes nothing, and a missing title falls back to the uri", () => {
  const metadata = {
    groundingChunks: [
      { retrievedContext: { uri: "https://ignored.example" } },
      { web: { uri: "https://a.example/1" } },
      { web: { title: "no uri" } },
    ],
  }
  assert.deepEqual(extractSources(metadata, 10), [
    { title: "https://a.example/1", uri: "https://a.example/1" },
  ])
  assert.deepEqual(extractSources(undefined, 10), [], "no metadata at all yields no sources")
})

test("webSearchQueries are trimmed, blanks dropped, a missing field is an empty list", () => {
  assert.deepEqual(extractSearchQueries({ webSearchQueries: [" node 24 ", "", "lts"] }), [
    "node 24",
    "lts",
  ])
  assert.deepEqual(extractSearchQueries({}), [])
  assert.deepEqual(extractSearchQueries(undefined), [])
})

// ── the max_sources clamp ─────────────────────────────────────────────────

test("max_sources clamps into 1..20 and defaults to 8", () => {
  assert.equal(clampMaxSources(undefined), DEFAULT_MAX_SOURCES)
  assert.equal(DEFAULT_MAX_SOURCES, 8)
  assert.equal(clampMaxSources("nonsense"), DEFAULT_MAX_SOURCES)
  assert.equal(clampMaxSources(null), DEFAULT_MAX_SOURCES, "null means the parameter was not given")
  assert.equal(clampMaxSources(""), DEFAULT_MAX_SOURCES, "a blank string means the same")
  assert.equal(clampMaxSources(0), 1)
  assert.equal(clampMaxSources(-5), 1)
  assert.equal(clampMaxSources(21), 20)
  assert.equal(clampMaxSources(1000), 20)
  assert.equal(clampMaxSources(8.9), 8, "a fractional count is floored")
  assert.equal(clampMaxSources(3), 3)
})

test("the clamp bounds the rendered source list", async () => {
  const { cleanup } = isolate()
  const chunks = []
  const supports = []
  for (let i = 0; i < 30; i++) {
    chunks.push(webChunk(`https://s.example/${i}`, `S${i}`))
    supports.push(support(i))
  }
  const stub = stubFetch(() =>
    geminiReply({
      parts: [{ text: "answer" }],
      groundingMetadata: { groundingChunks: chunks, groundingSupports: supports },
    }),
  )
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    const tool = createGroundedSearchTool()

    const capped = await tool.execute({ query: "x", max_sources: 99 }, {})
    assert.equal(capped.metadata.sourceCount, 20)
    assert.equal((capped.output.match(/^\d+\. /gm) ?? []).length, 20)

    const floored = await tool.execute({ query: "x", max_sources: 0 }, {})
    assert.equal(floored.metadata.sourceCount, 1)

    const dflt = await tool.execute({ query: "x" }, {})
    assert.equal(dflt.metadata.sourceCount, DEFAULT_MAX_SOURCES)
  } finally {
    stub.restore()
    cleanup()
  }
})

// ── rendering and metadata ────────────────────────────────────────────────

test("the output is the answer, then the numbered sources, then the queries", () => {
  assert.equal(
    renderGroundedResult({
      answer: "Node 24 is the current LTS.",
      sources: [
        { title: "Release", uri: "https://nodejs.org/en/blog/release" },
        { title: "Schedule", uri: "https://github.com/nodejs/release" },
      ],
      queries: ["node 24 lts", "node release schedule"],
    }),
    "Node 24 is the current LTS.\n\n" +
      "Sources:\n" +
      "1. Release — https://nodejs.org/en/blog/release\n" +
      "2. Schedule — https://github.com/nodejs/release\n\n" +
      "Search queries: node 24 lts, node release schedule",
  )
})

test("an empty block is left out, and a reply with nothing in it says so", () => {
  assert.equal(
    renderGroundedResult({ answer: "just an answer", sources: [], queries: [] }),
    "just an answer",
  )
  assert.match(
    renderGroundedResult({ answer: "", sources: [], queries: [] }),
    /^grounded_search: the model returned neither/,
  )
})

test("the tool result carries model, grounded, searchQueries and sourceCount", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch(() =>
    geminiReply({
      parts: [{ text: "grounded answer" }],
      groundingMetadata: {
        groundingChunks: [webChunk("https://a.example/1", "A")],
        groundingSupports: [support(0)],
        webSearchQueries: ["a query"],
      },
    }),
  )
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    const res = await createGroundedSearchTool().execute({ query: "x" }, {})
    assert.deepEqual(res.metadata, {
      model: DEFAULT_GROUNDING_MODEL,
      grounded: true,
      searchQueries: ["a query"],
      sourceCount: 1,
    })
    assert.match(res.output, /^grounded answer\n\nSources:\n1\. A — https:\/\/a\.example\/1/)
    assert.match(res.output, /\nSearch queries: a query$/)
  } finally {
    stub.restore()
    cleanup()
  }
})

test("an answer with no grounding metadata is reported as not grounded", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch(() => geminiReply({ parts: [{ text: "ungrounded" }] }))
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    const res = await createGroundedSearchTool().execute({ query: "x" }, {})
    assert.equal(res.metadata.grounded, false)
    assert.equal(res.metadata.sourceCount, 0)
    assert.equal(res.output, "ungrounded")
  } finally {
    stub.restore()
    cleanup()
  }
})

// ── the HTTP error path ───────────────────────────────────────────────────

test("a non-2xx reply throws with the status and the body's error message", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch(() =>
    httpFail(429, JSON.stringify({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } })),
  )
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    await assert.rejects(
      () => createGroundedSearchTool().execute({ query: "x" }, {}),
      /Gemini HTTP 429: Quota exceeded/,
    )
  } finally {
    stub.restore()
    cleanup()
  }
})

test("a non-JSON error body is surfaced verbatim", () => {
  assert.equal(
    httpErrorMessage(502, "<html><body>Bad Gateway</body></html>"),
    "Gemini HTTP 502: <html><body>Bad Gateway</body></html>",
  )
  assert.equal(httpErrorMessage(500, ""), "Gemini HTTP 500")
  assert.equal(httpErrorMessage(400, JSON.stringify({ error: {} })), 'Gemini HTTP 400: {"error":{}}')
  assert.equal(
    httpErrorMessage(403, JSON.stringify({ error: { message: "API key not valid" } })),
    "Gemini HTTP 403: API key not valid",
  )
})

test("the failing status never carries the key into the error text", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch(() => httpFail(400, JSON.stringify({ error: { message: "bad request" } })))
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    await assert.rejects(
      () => createGroundedSearchTool().execute({ query: "x" }, {}),
      (err) => {
        assert.equal(err.message.includes(ENV_KEY_GEMINI), false)
        return true
      },
    )
  } finally {
    stub.restore()
    cleanup()
  }
})

// ── the caller's abort signal ─────────────────────────────────────────────

test("an already-aborted caller signal ends the call as an abort, not a timeout", async () => {
  const { cleanup } = isolate()
  const stub = stubFetch()
  try {
    process.env.GEMINI_API_KEY = ENV_KEY_GEMINI
    const ctl = new AbortController()
    ctl.abort()
    await assert.rejects(
      () => createGroundedSearchTool().execute({ query: "x" }, { abort: ctl.signal }),
      /grounded_search: the call was aborted/,
    )
  } finally {
    stub.restore()
    cleanup()
  }
})

// ── registration ──────────────────────────────────────────────────────────

test("grounded_search is registered by default and its args are query + max_sources", () => {
  const { cleanup } = isolate()
  try {
    assert.equal(isGroundedSearchEnabled(), true)
    const tools = createTools({
      client: {},
      directory: "/tmp",
      permissionGuard: { checkTaskPermission: async () => "", checkSpawnPermission: async () => "" },
    })
    assert.ok(tools.grounded_search, "expected the grounded_search tool to be present")
    assert.deepEqual(Object.keys(tools.grounded_search.args).sort(), ["max_sources", "query"])
    assert.match(tools.grounded_search.description, /grounding/i)
  } finally {
    cleanup()
  }
})

test("OPENCODE_AGENT_INTERCOM_DISABLE_GROUNDED_SEARCH=1 omits the tool", () => {
  const { cleanup } = isolate()
  try {
    process.env.OPENCODE_AGENT_INTERCOM_DISABLE_GROUNDED_SEARCH = "1"
    assert.equal(isGroundedSearchEnabled(), false)
    const tools = createTools({
      client: {},
      directory: "/tmp",
      permissionGuard: { checkTaskPermission: async () => "", checkSpawnPermission: async () => "" },
    })
    assert.equal(tools.grounded_search, undefined)
  } finally {
    cleanup()
  }
})
