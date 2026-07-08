// Slice S3 tests for src/opendesign-cli.js.
// Pure in-memory: a FAKE client (no network), writable buffers for stdout/stderr.
//
// Run: node --test test/opendesign-cli.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { Writable } from "node:stream"

import { run } from "../src/opendesign-cli.js"
import { OpenDesignHttpError } from "../src/opendesign.js"

// ─── helpers ────────────────────────────────────────────────────────────────

/** Writable stream that accumulates everything written to it as a string. */
function makeBuffer() {
  let buf = ""
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString("utf8")
      cb()
    },
  })
  stream.text = () => buf
  return stream
}

/** Build a fake client whose methods record calls and return canned values. */
function makeFakeClient(overrides = {}) {
  const calls = { health: 0, status: 0, request: [] }
  return {
    calls,
    health: async () => {
      calls.health++
      return overrides.health ?? { ok: true, version: "0.14.1" }
    },
    status: async () => {
      calls.status++
      return overrides.status ?? { ok: true, port: 7456 }
    },
    request: async (path, opts = {}) => {
      calls.request.push({ path, opts })
      if (typeof overrides.request === "function") return overrides.request(path, opts)
      return overrides.request ?? { ok: true, path, ...opts }
    },
  }
}

function depsWith(extra) {
  return {
    stdout: makeBuffer(),
    stderr: makeBuffer(),
    version: "9.9.9-test",
    ...extra,
  }
}

// ─── (a) health ─────────────────────────────────────────────────────────────

test("health: calls client.health once, prints JSON, returns 0", async () => {
  const client = makeFakeClient({ health: { ok: true, ping: "pong" } })
  const deps = depsWith({ client })

  const code = await run(["health"], deps)

  assert.equal(code, 0)
  assert.equal(client.calls.health, 1)
  assert.equal(client.calls.status, 0)
  assert.equal(client.calls.request.length, 0)

  const out = deps.stdout.text()
  assert.doesNotMatch(out, /undefined/)
  assert.doesNotMatch(out, /NaN/)
  const parsed = JSON.parse(out)
  assert.deepEqual(parsed, { ok: true, ping: "pong" })
  assert.equal(deps.stderr.text(), "")
})

// ─── (b) request with method flag ───────────────────────────────────────────

test("request /api/projects -X GET: calls client.request with path + method, prints JSON, returns 0", async () => {
  const client = makeFakeClient({
    request: { ok: true, projects: [{ id: 1 }, { id: 2 }] },
  })
  const deps = depsWith({ client })

  const code = await run(["request", "/api/projects", "-X", "GET"], deps)

  assert.equal(code, 0)
  assert.equal(client.calls.request.length, 1)
  assert.equal(client.calls.request[0].path, "/api/projects")
  assert.equal(client.calls.request[0].opts.method, "GET")
  assert.equal(client.calls.request[0].opts.body, undefined)

  const parsed = JSON.parse(deps.stdout.text())
  assert.deepEqual(parsed, { ok: true, projects: [{ id: 1 }, { id: 2 }] })
  assert.equal(deps.stderr.text(), "")
})

// ─── (c) request with -d body ───────────────────────────────────────────────

test("request /api/x -d '{\"a\":1}': client.request called with body {a:1}, returns 0", async () => {
  const client = makeFakeClient({ request: { created: true, id: 42 } })
  const deps = depsWith({ client })

  const code = await run(["request", "/api/x", "-d", '{"a":1}'], deps)

  assert.equal(code, 0)
  assert.equal(client.calls.request.length, 1)
  assert.equal(client.calls.request[0].path, "/api/x")
  assert.deepEqual(client.calls.request[0].opts.body, { a: 1 })
  // No -X → method defaults to "GET" (per S2 client contract).
  assert.equal(client.calls.request[0].opts.method, "GET")

  const parsed = JSON.parse(deps.stdout.text())
  assert.deepEqual(parsed, { created: true, id: 42 })
  assert.equal(deps.stderr.text(), "")
})

// ─── (d) OpenDesignHttpError → stderr, exit 1, stdout empty ─────────────────

test("OpenDesignHttpError 404: writes to stderr (mentions 404), returns 1, stdout empty", async () => {
  const client = makeFakeClient({
    request: async () => {
      throw new OpenDesignHttpError("not found", {
        status: 404,
        body: '{"error":"project gone"}',
        url: "http://lukas:7456/api/missing",
        method: "GET",
      })
    },
  })
  const deps = depsWith({ client })

  const code = await run(["request", "/api/missing"], deps)

  assert.equal(code, 1)
  const err = deps.stderr.text()
  assert.match(err, /404/)
  assert.equal(deps.stdout.text(), "")
})

// ─── (e) --version ─────────────────────────────────────────────────────────

test("--version: stdout is the version string, returns 0", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client, version: "1.7.3" })

  const code = await run(["--version"], deps)

  assert.equal(code, 0)
  assert.equal(deps.stdout.text().trim(), "1.7.3")
  assert.equal(deps.stderr.text(), "")
  // No client methods should have been called for --version.
  assert.equal(client.calls.health, 0)
  assert.equal(client.calls.status, 0)
  assert.equal(client.calls.request.length, 0)
})

test("version subcommand: same as --version", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client, version: "1.7.3" })

  const code = await run(["version"], deps)

  assert.equal(code, 0)
  assert.equal(deps.stdout.text().trim(), "1.7.3")
  assert.equal(client.calls.health, 0)
})

// ─── (f) no args / --help ──────────────────────────────────────────────────

test("no args: writes usage to stdout, returns 0", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client })

  const code = await run([], deps)

  assert.equal(code, 0)
  const out = deps.stdout.text()
  assert.match(out, /opendesign/)
  assert.match(out, /Usage:/i)
  assert.match(out, /health/)
  assert.match(out, /status/)
  assert.match(out, /request/)
  assert.equal(deps.stderr.text(), "")
  assert.equal(client.calls.health, 0)
  assert.equal(client.calls.status, 0)
  assert.equal(client.calls.request.length, 0)
})

test("--help: writes usage to stdout, returns 0", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client })

  const code = await run(["--help"], deps)

  assert.equal(code, 0)
  const out = deps.stdout.text()
  assert.match(out, /opendesign/)
  assert.match(out, /Usage:/i)
  assert.equal(deps.stderr.text(), "")
  assert.equal(client.calls.health, 0)
})

// ─── extra coverage: query params, -X via long flag, error propagation ─────

test("request with -q pairs: client.request receives the query object", async () => {
  const client = makeFakeClient({ request: { ok: true } })
  const deps = depsWith({ client })

  const code = await run(
    ["request", "/api/runs", "-q", "limit=5", "-q", "cursor=abc"],
    deps,
  )

  assert.equal(code, 0)
  assert.equal(client.calls.request.length, 1)
  assert.equal(client.calls.request[0].path, "/api/runs")
  assert.deepEqual(client.calls.request[0].opts.query, { limit: "5", cursor: "abc" })
})

test("request with --method (long flag) and -d: both forwarded", async () => {
  const client = makeFakeClient({ request: { ok: true } })
  const deps = depsWith({ client })

  const code = await run(
    ["request", "/api/things", "--method", "POST", "-d", '{"name":"x"}'],
    deps,
  )

  assert.equal(code, 0)
  assert.equal(client.calls.request[0].opts.method, "POST")
  assert.deepEqual(client.calls.request[0].opts.body, { name: "x" })
})

test("request with -d that is not valid JSON: returns 2, writes to stderr, client NOT called", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client })

  const code = await run(["request", "/api/x", "-d", "not-json{"], deps)

  assert.equal(code, 2)
  assert.match(deps.stderr.text(), /valid JSON|not valid/i)
  assert.equal(client.calls.request.length, 0)
})

test("request with no <path>: returns 2, writes to stderr, client NOT called", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client })

  const code = await run(["request"], deps)

  assert.equal(code, 2)
  assert.match(deps.stderr.text(), /<path>|path/)
  assert.equal(client.calls.request.length, 0)
})

test("unknown subcommand: returns 2, writes to stderr, no client calls", async () => {
  const client = makeFakeClient()
  const deps = depsWith({ client })

  const code = await run(["nope"], deps)

  assert.equal(code, 2)
  assert.match(deps.stderr.text(), /unknown command/)
  assert.equal(client.calls.health, 0)
  assert.equal(client.calls.status, 0)
  assert.equal(client.calls.request.length, 0)
})

test("status: calls client.status once, prints JSON, returns 0", async () => {
  const client = makeFakeClient({ status: { ok: true, port: 7456, version: "0.14.1" } })
  const deps = depsWith({ client })

  const code = await run(["status"], deps)

  assert.equal(code, 0)
  assert.equal(client.calls.status, 1)
  assert.deepEqual(JSON.parse(deps.stdout.text()), { ok: true, port: 7456, version: "0.14.1" })
})
