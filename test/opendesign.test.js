// Slice S2 tests for src/opendesign.js.
// Mocks global fetch — no real network. Exercises createClient({...}).
//
// Run: node --test test/opendesign.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { createClient, OpenDesignHttpError } from "../src/opendesign.js"

// ---- fetch mock helpers -----------------------------------------------------

/**
 * Install a fake global fetch for the duration of `fn`. Returns an object the
 * test can poke to set the next response and to read captured requests.
 */
function withFetch(plan, fn) {
  const calls = []
  let next = null
  const queue = Array.isArray(plan) ? plan.slice() : [plan]

  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const responder = next ?? queue.shift()
    if (!responder) {
      throw new Error("withFetch: no more queued responses")
    }
    next = responder.next ?? null
    return responder.respond({ url, init })
  }

  const prevFetch = globalThis.fetch
  globalThis.fetch = fakeFetch
  const harness = {
    calls,
    setNext(responder) {
      next = responder
    },
  }
  return Promise.resolve()
    .then(() => fn(harness))
    .finally(() => {
      globalThis.fetch = prevFetch
    })
}

function jsonResponse({ status = 200, body, headers } = {}) {
  return {
    respond({ url, init }) {
      const text = body === undefined ? "" : JSON.stringify(body)
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: statusTextFor(status),
        text: async () => text,
        url: typeof url === "string" ? url : String(url),
      })
    },
  }
}

function statusTextFor(status) {
  return {
    200: "OK",
    201: "Created",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    500: "Internal Server Error",
  }[status] ?? ""
}

// ---- tests ------------------------------------------------------------------

test("createClient returns an object with health, status, request, baseURL, token", () => {
  const c = createClient({ baseURL: "http://x:1", token: "t" })
  assert.equal(typeof c.health, "function")
  assert.equal(typeof c.status, "function")
  assert.equal(typeof c.request, "function")
  assert.equal(c.baseURL, "http://x:1")
  assert.equal(c.token, "t")
})

test("request sets Authorization: Bearer <token> from provided token", async () => {
  await withFetch(jsonResponse({ status: 200, body: { ok: true } }), async ({ calls }) => {
    const c = createClient({ baseURL: "http://lukas:7456", token: "secret-token-xyz" })
    const out = await c.request("/api/version")
    assert.deepEqual(out, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token-xyz")
  })
})

test("request prepends baseURL to path", async () => {
  await withFetch(jsonResponse({ status: 200, body: {} }), async ({ calls }) => {
    const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
    await c.request("/api/agents")
    assert.equal(calls[0].url, "http://lukas:7456/api/agents")
  })
})

test("request appends query params and sets method=GET by default", async () => {
  await withFetch(jsonResponse({ status: 200, body: [] }), async ({ calls }) => {
    const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
    await c.request("/api/runs", { query: { limit: 5, cursor: "abc" } })
    assert.equal(calls[0].init.method, "GET")
    const u = new URL(calls[0].url)
    assert.equal(u.pathname, "/api/runs")
    assert.equal(u.searchParams.get("limit"), "5")
    assert.equal(u.searchParams.get("cursor"), "abc")
  })
})

test("request JSON-encodes body and sets Content-Type", async () => {
  await withFetch(jsonResponse({ status: 201, body: { id: 1 } }), async ({ calls }) => {
    const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
    const out = await c.request("/api/things", { method: "POST", body: { name: "x" } })
    assert.deepEqual(out, { id: 1 })
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.body, JSON.stringify({ name: "x" }))
    assert.equal(calls[0].init.headers["Content-Type"], "application/json")
    assert.equal(calls[0].init.headers.Accept, "application/json")
  })
})

test("request returns parsed JSON on 2xx", async () => {
  await withFetch(
    jsonResponse({ status: 200, body: { ok: true, version: "0.14.1" } }),
    async () => {
      const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
      const out = await c.request("/api/health")
      assert.deepEqual(out, { ok: true, version: "0.14.1" })
    },
  )
})

test("request throws OpenDesignHttpError on non-2xx with status + message", async () => {
  await withFetch(
    jsonResponse({ status: 500, body: { error: "boom" } }),
    async () => {
      const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
      await assert.rejects(
        () => c.request("/api/agents"),
        (err) => {
          assert.ok(err instanceof OpenDesignHttpError)
          assert.equal(err.name, "OpenDesignHttpError")
          assert.equal(err.status, 500)
          assert.equal(err.method, "GET")
          assert.match(err.url, /\/api\/agents$/)
          assert.match(err.message, /500/)
          assert.match(err.message, /boom/)
          return true
        },
      )
    },
  )
})

test("request throws OpenDesignHttpError on 401/403 too", async () => {
  await withFetch(
    jsonResponse({ status: 401, body: { error: "unauthorized" } }),
    async () => {
      const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
      await assert.rejects(
        () => c.request("/api/agents"),
        (err) => err instanceof OpenDesignHttpError && err.status === 401,
      )
    },
  )
})

test("health() hits /api/health", async () => {
  await withFetch(
    jsonResponse({ status: 200, body: { ok: true, version: "0.14.1" } }),
    async ({ calls }) => {
      const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
      const out = await c.health()
      assert.deepEqual(out, { ok: true, version: "0.14.1" })
      assert.equal(calls[0].url, "http://lukas:7456/api/health")
      assert.equal(calls[0].init.headers.Authorization, "Bearer t")
    },
  )
})

test("status() hits /api/daemon/status", async () => {
  await withFetch(
    jsonResponse({ status: 200, body: { ok: true, version: "0.14.1", port: 7456 } }),
    async ({ calls }) => {
      const c = createClient({ baseURL: "http://lukas:7456", token: "t" })
      const out = await c.status()
      assert.deepEqual(out, { ok: true, version: "0.14.1", port: 7456 })
      assert.equal(calls[0].url, "http://lukas:7456/api/daemon/status")
      assert.equal(calls[0].init.headers.Authorization, "Bearer t")
    },
  )
})

test("missing token → request goes out WITHOUT Authorization header (no throw)", async () => {
  await withFetch(jsonResponse({ status: 200, body: { ok: true } }), async ({ calls }) => {
    // No token in env (we don't control env here, but we pass token: null explicitly).
    const c = createClient({ baseURL: "http://lukas:7456", token: null })
    const out = await c.request("/api/health")
    assert.deepEqual(out, { ok: true })
    assert.equal(calls.length, 1)
    assert.equal("Authorization" in calls[0].init.headers, false)
  })
})

test("config defaults: baseURL and token from env when not provided", async () => {
  const prevBase = process.env.OPENDESIGN_BASE_URL
  const prevToken = process.env.OPENDESIGN_API_TOKEN
  process.env.OPENDESIGN_BASE_URL = "http://env-host:9999"
  process.env.OPENDESIGN_API_TOKEN = "env-token-1"
  try {
    const c = createClient()
    assert.equal(c.baseURL, "http://env-host:9999")
    assert.equal(c.token, "env-token-1")
  } finally {
    if (prevBase === undefined) delete process.env.OPENDESIGN_BASE_URL
    else process.env.OPENDESIGN_BASE_URL = prevBase
    if (prevToken === undefined) delete process.env.OPENDESIGN_API_TOKEN
    else process.env.OPENDESIGN_API_TOKEN = prevToken
  }
})

test("config defaults: token is null when neither arg nor env provide one", () => {
  const prevToken = process.env.OPENDESIGN_API_TOKEN
  delete process.env.OPENDESIGN_API_TOKEN
  try {
    const c = createClient({ baseURL: "http://x:1" })
    assert.equal(c.token, null)
  } finally {
    if (prevToken !== undefined) process.env.OPENDESIGN_API_TOKEN = prevToken
  }
})
