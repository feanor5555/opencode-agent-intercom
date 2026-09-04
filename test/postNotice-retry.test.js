// Pure unit tests for the postNotice retry+backoff in src/client.js.
//
// Slice 3 of T3: wraps the transport call so transient failures recover
// without losing the wake notice, and propagates the last error on
// exhaustion so the existing hooks.js cleanup path runs unchanged.
//
// Run: node --test --test-timeout=2000 test/postNotice-retry.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import { postNotice, requestFailure } from "../src/client.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Pinned settings path so no real ~/.config file is read; deterministic order.
let tmpDir

const RETRIES_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRIES"
const BACKOFF_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRY_BACKOFF_MS"

test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-postnotice-"))
  setSettingsPath(join(tmpDir, "agent-intercom.json"))
  delete process.env[RETRIES_ENV]
  delete process.env[BACKOFF_ENV]
  resetSettings()
})

test.afterEach(() => {
  delete process.env[RETRIES_ENV]
  delete process.env[BACKOFF_ENV]
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// Build a minimal fake opencode SDK client whose session.promptAsync is
// programmable per-call. Records every invocation so tests can assert
// exactly how many transport attempts were made and the sessions they
// targeted.
function makeFakeClient(behavior) {
  const calls = []
  return {
    calls,
    async session() {
      return undefined
    },
    session: {
      promptAsync: async (req) => {
        calls.push(req)
        return await behavior(calls.length, req)
      },
    },
  }
}

test("postNotice succeeds on a later attempt after transient failures", async () => {
  // Squeeze the retry budget so we stay under node --test's default 2s.
  process.env[RETRIES_ENV] = "3"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()
  const s = getSettings()
  assert.equal(s.postNoticeRetries, 3)
  assert.equal(s.postNoticeRetryBackoffMs, 1)

  // Fail twice, succeed on the third attempt (= 1st retry success).
  let attempt = 0
  const client = makeFakeClient(async (n) => {
    attempt = n
    if (n < 3) throw new Error(`transient ${n}`)
    return undefined
  })

  await postNotice(client, "sess-1", "wake up")

  assert.equal(attempt, 3, "third attempt was the successful one")
  assert.equal(client.calls.length, 3)
  for (const c of client.calls) {
    assert.equal(c.path.id, "sess-1")
    // Parts carry the plugin-message marker (src/pluginmsg.js) so goal
    // scans can tell notices from real user messages.
    assert.deepEqual(c.body.parts, [
      { type: "text", text: "wake up", metadata: { agentIntercom: true } },
    ])
  }
})

test("postNotice exhausts retries then re-throws the last error", async () => {
  process.env[RETRIES_ENV] = "2"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  // Always-fail behavior. postNoticeRetries=2 -> 1 initial + 2 retries = 3
  // total attempts.
  const client = makeFakeClient(async () => {
    throw new Error("connection refused")
  })

  await assert.rejects(
    () => postNotice(client, "sess-2", "wake up"),
    (err) => {
      assert.equal(err.message, "connection refused")
      return true
    },
  )

  assert.equal(
    client.calls.length,
    3,
    "1 initial attempt + 2 retries = 3 total attempts when retries=2",
  )
})

test("postNotice with retries=0 makes exactly one attempt", async () => {
  process.env[RETRIES_ENV] = "0"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  const client = makeFakeClient(async () => {
    throw new Error("nope")
  })

  await assert.rejects(
    () => postNotice(client, "sess-3", "wake up"),
    (err) => {
      assert.equal(err.message, "nope")
      return true
    },
  )

  assert.equal(client.calls.length, 1, "no retries means a single attempt")
})

// ---- the HTTP-level failure the client never throws --------------------------
//
// opencode builds the plugin's SDK client without `throwOnError`, so a refused
// request RESOLVES with `{ error, request, response }` instead of rejecting.
// Everything below pins that postNotice reads that envelope: without it the
// retry loop is dead for every HTTP failure and a notice that was never
// delivered is reported as sent.

// An envelope of the shape the client really resolves with on a failure.
function errorEnvelope(status, name, message) {
  return {
    error: { name, data: { message } },
    request: {},
    response: { status },
  }
}

test("postNotice retries an error envelope the client resolved with", async () => {
  process.env[RETRIES_ENV] = "3"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  // Two 5xx envelopes — resolved, never thrown — then a real 204 success.
  const client = makeFakeClient(async (n) => {
    if (n < 3) return errorEnvelope(503, "ServerError", "upstream is restarting")
    return { data: undefined, request: {}, response: { status: 204 } }
  })

  await postNotice(client, "sess-envelope", "wake up")

  assert.equal(
    client.calls.length,
    3,
    "the resolved failures went through the retry loop, they were not counted as delivered",
  )
})

test("postNotice re-throws when every attempt comes back as an error envelope", async () => {
  process.env[RETRIES_ENV] = "2"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  const client = makeFakeClient(async () => errorEnvelope(500, "InternalError", "boom"))

  await assert.rejects(
    () => postNotice(client, "sess-5xx", "wake up"),
    (err) => {
      assert.match(err.message, /500/, "the status the server answered with")
      assert.match(err.message, /boom/, "and what it said")
      assert.equal(err.status, 500)
      return true
    },
  )

  assert.equal(client.calls.length, 3, "1 initial attempt + 2 retries, same budget as a throw")
})

test("postNotice does not retry a 404 — the target session is gone", async () => {
  process.env[RETRIES_ENV] = "3"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  const client = makeFakeClient(async () =>
    errorEnvelope(404, "NotFoundError", "Session not found: sess-gone"),
  )

  await assert.rejects(
    () => postNotice(client, "sess-gone", "wake up"),
    (err) => {
      assert.equal(err.status, 404)
      assert.equal(err.terminal, true)
      return true
    },
  )

  assert.equal(
    client.calls.length,
    1,
    "a deleted session stays deleted; the retry budget is not spent on it",
  )
})

test("postNotice treats a successful envelope as delivered", async () => {
  process.env[RETRIES_ENV] = "3"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  // The three success shapes the resolved client has used, one per call.
  const shapes = [
    { data: undefined, request: {}, response: { status: 204 } },
    { data: true },
    undefined,
  ]
  for (const [i, shape] of shapes.entries()) {
    const client = makeFakeClient(async () => shape)
    await postNotice(client, `sess-ok-${i}`, "wake up")
    assert.equal(client.calls.length, 1, `shape ${i} is a delivered notice, not a retry`)
  }
})

test("requestFailure reads the envelope and nothing else", () => {
  const op = "postNotice (session.promptAsync)"
  assert.equal(requestFailure(undefined, op), undefined)
  assert.equal(requestFailure({ data: undefined }, op), undefined)
  assert.equal(
    requestFailure({ data: undefined, response: { status: 204 } }, op),
    undefined,
    "a 204 carries a response object and is the normal success",
  )
  assert.equal(
    requestFailure({ data: undefined, error: null }, op),
    undefined,
    "a null error is no error",
  )

  const byError = requestFailure({ error: { name: "NotFoundError" }, response: { status: 404 } }, op)
  assert.ok(byError instanceof Error)
  assert.equal(byError.terminal, true)
  assert.equal(byError.kind, "refused", "the server answered, so the write did not take effect")

  // A status alone is enough: an envelope may carry the failure without a
  // parsed `error` body.
  const byStatus = requestFailure({ response: { status: 502 } }, op)
  assert.ok(byStatus instanceof Error)
  assert.equal(byStatus.status, 502)
  assert.equal(byStatus.terminal, false)
  assert.equal(byStatus.kind, "refused")
})

test("requestFailure names the operation in the message", () => {
  const err = requestFailure(
    { error: { name: "InternalError", data: { message: "boom" } }, response: { status: 500 } },
    "deleteSession (session.delete)",
  )
  assert.equal(err.message, "deleteSession (session.delete) failed (HTTP 500): boom")
  assert.equal(err.op, "deleteSession (session.delete)")

  // No label given: the generic one, so a message is never left half-built.
  assert.match(requestFailure({ response: { status: 500 } }).message, /^request failed \(HTTP 500\)$/)
})

test("requestFailure: every 4xx is terminal, not only 404", () => {
  // A request the server refused on its content is refused again on a retry.
  for (const status of [400, 401, 403, 404, 409, 422, 499]) {
    const err = requestFailure({ response: { status } }, "op")
    assert.equal(err.terminal, true, `HTTP ${status} is terminal`)
    assert.equal(err.kind, "refused")
  }
  for (const status of [500, 502, 503, 504]) {
    const err = requestFailure({ response: { status } }, "op")
    assert.equal(err.terminal, false, `HTTP ${status} is worth another attempt`)
    assert.equal(err.kind, "refused")
  }
  // A NotFoundError without a status stays terminal, as it always was.
  const named = requestFailure({ error: { name: "NotFoundError" } }, "op")
  assert.equal(named.terminal, true)
})

test("requestFailure: an envelope with no status at all is indeterminate", () => {
  // No response was seen, so nothing is known about whether the write landed.
  const err = requestFailure({ error: { message: "socket hang up" } }, "op")
  assert.equal(err.kind, "indeterminate")
  assert.equal(err.status, undefined)
  assert.equal(err.message, "op failed: socket hang up")
})

test("postNotice does not retry a 400 either — a refused body stays refused", () => {
  process.env[RETRIES_ENV] = "3"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()

  const client = makeFakeClient(async () => errorEnvelope(400, "BadRequestError", "invalid part"))

  return assert
    .rejects(
      () => postNotice(client, "sess-400", "wake up"),
      (err) => {
        assert.equal(err.status, 400)
        assert.equal(err.terminal, true)
        assert.equal(err.kind, "refused")
        return true
      },
    )
    .then(() => {
      assert.equal(client.calls.length, 1, "no budget is spent on a request the server refused")
    })
})
