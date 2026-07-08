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
import { postNotice } from "../src/client.js"
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
    assert.deepEqual(c.body.parts, [{ type: "text", text: "wake up" }])
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
