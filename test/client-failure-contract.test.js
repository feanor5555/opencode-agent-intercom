// The failure contract of src/client.js: the three primitives (requestFailure,
// attempt, withRetry) and what every wrapper built on them returns or throws
// when the opencode SDK client refuses a request.
//
// The client opencode hands a plugin carries no `throwOnError`, so a failed
// request RESOLVES with `{ error, request, response }` instead of rejecting.
// Every test below drives BOTH failure routes — the resolved envelope and the
// thrown transport error — because a wrapper that only handles one of them
// reports a request that never took effect as done.
//
// Run: node --test --test-timeout=5000 test/client-failure-contract.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetSettings, setSettingsPath } from "../src/settings.js"
import {
  abortSession,
  archiveSession,
  attempt,
  createChildSession,
  deleteSession,
  fetchMessages,
  fetchSnapshot,
  getSessionDirectory,
  listSessions,
  promptSession,
  requestFailure,
  snapshotOutcome,
  updateSessionTitle,
  withRetry,
} from "../src/client.js"

const RETRIES_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRIES"
const BACKOFF_ENV = "OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRY_BACKOFF_MS"

let tmpDir

test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-client-contract-"))
  setSettingsPath(join(tmpDir, "agent-intercom.json"))
  // A budget small enough to spend inside a test's timeout, and large enough
  // that a retry that is taken is visible in the call count.
  process.env[RETRIES_ENV] = "2"
  process.env[BACKOFF_ENV] = "1"
  resetSettings()
})

test.afterEach(() => {
  delete process.env[RETRIES_ENV]
  delete process.env[BACKOFF_ENV]
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// The envelope shape the SDK client really resolves with on a failure.
function envelope(status, name = "Error", message = "refused") {
  return { error: { name, data: { message } }, request: {}, response: { status } }
}

// A fake client whose one namespace method is programmable per call. `calls`
// counts the transport attempts, which is what a retry policy is read off.
function fakeClient(namespace, method, behavior) {
  const calls = []
  return {
    calls,
    [namespace]: {
      [method]: async (req) => {
        calls.push(req)
        return await behavior(calls.length, req)
      },
    },
  }
}

// ---- attempt -----------------------------------------------------------------

test("attempt: a delivered call answers ok with the payload unwrapped", async () => {
  assert.deepEqual(await attempt("op", async () => ({ data: { id: "ses_1" } })), {
    ok: true,
    data: { id: "ses_1" },
  })
  // The bare and empty shapes the client has also used.
  assert.deepEqual(await attempt("op", async () => undefined), { ok: true, data: undefined })
  assert.deepEqual(await attempt("op", async () => ({ id: "ses_2" })), {
    ok: true,
    data: { id: "ses_2" },
  })
  assert.deepEqual(
    await attempt("op", async () => ({ data: true, request: {}, response: { status: 204 } })),
    { ok: true, data: true },
  )
})

test("attempt: a resolved error envelope is a refused failure, not a success", async () => {
  const outcome = await attempt("deleteSession (session.delete)", async () => envelope(500, "InternalError", "boom"))
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.kind, "refused")
  assert.equal(outcome.error.status, 500)
  assert.equal(outcome.error.terminal, false)
  assert.match(outcome.error.message, /deleteSession \(session\.delete\) failed \(HTTP 500\): boom/)
})

test("attempt: a thrown transport error is indeterminate and never re-thrown", async () => {
  const outcome = await attempt("op", async () => {
    throw new Error("socket hang up")
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.kind, "indeterminate", "no response was seen")
  assert.equal(outcome.error.status, undefined)
  assert.equal(outcome.error.terminal, false)
  assert.equal(outcome.error.message, "socket hang up", "the thrower's message is kept")
})

test("attempt: a call that is not a function at all still folds into a value", async () => {
  // A client missing the namespace is the shape a misconfigured host gives.
  const outcome = await attempt("op", () => undefined.session.get())
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.kind, "indeterminate")
})

// ---- withRetry ---------------------------------------------------------------

test("withRetry: retries the kinds it is given and returns the eventual data", async () => {
  let calls = 0
  const data = await withRetry(
    "op",
    async () => {
      calls++
      if (calls === 1) return envelope(503, "ServerError", "restarting")
      if (calls === 2) throw new Error("socket hang up")
      return { data: "landed" }
    },
    { retries: 3, backoffMs: 1, retryKinds: ["refused", "indeterminate"] },
  )
  assert.equal(data, "landed")
  assert.equal(calls, 3)
})

test("withRetry: a kind outside retryKinds is not retried", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        "op",
        async () => {
          calls++
          throw new Error("socket hang up")
        },
        { retries: 3, backoffMs: 1, retryKinds: ["refused"] },
      ),
    /socket hang up/,
  )
  assert.equal(calls, 1, "an indeterminate failure is not retried under a refused-only policy")
})

test("withRetry: shouldRetry narrows the policy further", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        "op",
        async () => {
          calls++
          return envelope(503, "ServerError", "restarting")
        },
        {
          retries: 2,
          backoffMs: 1,
          retryKinds: ["refused"],
          shouldRetry: (err) => err.status === 429,
        },
      ),
    (err) => err.status === 503,
  )
  assert.equal(calls, 1)
})

test("withRetry: a terminal failure breaks out whatever the policy says", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        "op",
        async () => {
          calls++
          return envelope(404, "NotFoundError", "gone")
        },
        { retries: 5, backoffMs: 1, retryKinds: ["refused", "indeterminate"] },
      ),
    (err) => err.terminal === true && err.status === 404,
  )
  assert.equal(calls, 1)
})

test("withRetry: retries counts RE-tries, and the last error is what is thrown", async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        "op",
        async () => {
          calls++
          return envelope(500, "InternalError", `boom ${calls}`)
        },
        { retries: 2, backoffMs: 1 },
      ),
    /boom 3/,
  )
  assert.equal(calls, 3, "1 initial attempt + 2 retries")
})

// ---- promptSession: the required write ---------------------------------------

test("promptSession: a refused 5xx is retried and the prompt still lands", async () => {
  const client = fakeClient("session", "promptAsync", async (n) =>
    n < 3 ? envelope(502, "BadGatewayError", "upstream") : { data: undefined, response: { status: 204 } },
  )
  await promptSession(client, { sessionID: "ses_a", agent: "developer", prompt: "task" })
  assert.equal(client.calls.length, 3)
})

test("promptSession: throws once the retry budget is spent, carrying the status", async () => {
  const client = fakeClient("session", "promptAsync", async () => envelope(500, "InternalError", "boom"))
  await assert.rejects(
    () => promptSession(client, { sessionID: "ses_b", prompt: "task" }),
    (err) => {
      assert.equal(err.status, 500)
      assert.equal(err.kind, "refused")
      assert.match(err.message, /promptSession \(session\.promptAsync\)/)
      return true
    },
  )
  assert.equal(client.calls.length, 3, "1 initial attempt + the 2 retries the budget allows")
})

test("promptSession: a thrown transport error is not retried — the prompt may have landed", async () => {
  // promptAsync is not idempotent: a second delivery starts a second turn in
  // the child. Where no response was seen, the duplicate risk outweighs the
  // retry.
  const client = fakeClient("session", "promptAsync", async () => {
    throw new Error("socket hang up")
  })
  await assert.rejects(
    () => promptSession(client, { sessionID: "ses_c", prompt: "task" }),
    /socket hang up/,
  )
  assert.equal(client.calls.length, 1)
})

test("promptSession: a 404 is not retried and throws at once", async () => {
  const client = fakeClient("session", "promptAsync", async () =>
    envelope(404, "NotFoundError", "Session not found: ses_d"),
  )
  await assert.rejects(
    () => promptSession(client, { sessionID: "ses_d", prompt: "task" }),
    (err) => err.terminal === true && err.status === 404,
  )
  assert.equal(client.calls.length, 1)
})

test("promptSession: a delivered prompt resolves and posts exactly once", async () => {
  const client = fakeClient("session", "promptAsync", async () => ({
    data: undefined,
    response: { status: 204 },
  }))
  await promptSession(client, { sessionID: "ses_e", agent: "developer", prompt: "task" })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].path.id, "ses_e")
  assert.equal(client.calls[0].body.agent, "developer")
})

// ---- the reported writes -----------------------------------------------------

const REPORTED_WRITES = [
  {
    name: "deleteSession",
    method: "delete",
    call: (client) => deleteSession(client, "ses_w"),
  },
  {
    name: "archiveSession",
    method: "update",
    call: (client) => archiveSession(client, "ses_w"),
  },
  {
    name: "updateSessionTitle",
    method: "update",
    call: (client) => updateSessionTitle(client, "ses_w", "a title"),
  },
]

for (const write of REPORTED_WRITES) {
  test(`${write.name}: true only where the server confirmed it`, async () => {
    const client = fakeClient("session", write.method, async () => ({ data: {} }))
    assert.equal(await write.call(client), true)
    assert.equal(client.calls.length, 1)
  })

  test(`${write.name}: false on a refused request, and no retry`, async () => {
    const client = fakeClient("session", write.method, async () => envelope(500, "InternalError", "boom"))
    assert.equal(await write.call(client), false, "a refused write is reported as not done")
    assert.equal(client.calls.length, 1, "a reported write never spends a retry budget")
  })

  test(`${write.name}: false on a thrown transport error, and never throws`, async () => {
    const client = fakeClient("session", write.method, async () => {
      throw new Error("socket hang up")
    })
    assert.equal(await write.call(client), false)
    assert.equal(client.calls.length, 1)
  })
}

test("abortSession: an unconfirmed abort and a refused one both read false", async () => {
  const confirmed = fakeClient("session", "abort", async () => ({ data: true }))
  assert.equal(await abortSession(confirmed, "ses_x"), true)

  // A server answer of `false` means "not confirmed", not "the request
  // failed" — and the callers treat it the same way as a refusal.
  const unconfirmed = fakeClient("session", "abort", async () => ({ data: false }))
  assert.equal(await abortSession(unconfirmed, "ses_x"), false)

  const refused = fakeClient("session", "abort", async () => envelope(500, "InternalError", "boom"))
  assert.equal(await abortSession(refused, "ses_x"), false)
  assert.equal(refused.calls.length, 1, "no retry")

  const thrown = fakeClient("session", "abort", async () => {
    throw new Error("socket hang up")
  })
  assert.equal(await abortSession(thrown, "ses_x"), false)
})

// ---- the best-effort reads ---------------------------------------------------

test("getSessionDirectory: undefined on a refused read, and nothing is cached", async () => {
  const refused = fakeClient("session", "get", async () => envelope(500, "InternalError", "boom"))
  assert.equal(await getSessionDirectory(refused, "ses_dir_1"), undefined)

  // The failure must not have poisoned the cache: a later successful read
  // still reaches the server and answers.
  const ok = fakeClient("session", "get", async () => ({ data: { directory: "/tmp/project" } }))
  assert.equal(await getSessionDirectory(ok, "ses_dir_1"), "/tmp/project")
  assert.equal(ok.calls.length, 1)
})

test("getSessionDirectory: an envelope reaches the same value a throw reaches", async () => {
  const thrown = fakeClient("session", "get", async () => {
    throw new Error("socket hang up")
  })
  assert.equal(await getSessionDirectory(thrown, "ses_dir_2"), undefined)
})

test("listSessions: an empty array on a refused read, so a sweep does nothing", async () => {
  const refused = fakeClient("session", "list", async () => envelope(500, "InternalError", "boom"))
  assert.deepEqual(await listSessions(refused), [])

  const thrown = fakeClient("session", "list", async () => {
    throw new Error("socket hang up")
  })
  assert.deepEqual(await listSessions(thrown), [])

  const ok = fakeClient("session", "list", async () => ({ data: [{ id: "ses_1" }] }))
  assert.deepEqual(await listSessions(ok), [{ id: "ses_1" }])
})

test("fetchMessages: an empty array on a refused read", async () => {
  const refused = fakeClient("session", "messages", async () => envelope(500, "InternalError", "boom"))
  assert.deepEqual(await fetchMessages(refused, "ses_m"), [])

  const thrown = fakeClient("session", "messages", async () => {
    throw new Error("socket hang up")
  })
  assert.deepEqual(await fetchMessages(thrown, "ses_m"), [])
})

test("fetchSnapshot: a 404 means gone, every other failure means unavailable", async () => {
  const gone = fakeClient("session", "messages", async () =>
    envelope(404, "NotFoundError", "Session not found: ses_s"),
  )
  const goneSnapshot = await fetchSnapshot(gone, "ses_s")
  assert.deepEqual(goneSnapshot, { messageCount: 0 })
  assert.equal(snapshotOutcome(goneSnapshot), "gone")

  // A transient server error must NOT read as a deleted session: the caller
  // that acts on "gone" destroys a retained handle over it.
  const server = fakeClient("session", "messages", async () => envelope(500, "InternalError", "boom"))
  const serverSnapshot = await fetchSnapshot(server, "ses_s")
  assert.deepEqual(serverSnapshot, {})
  assert.equal(snapshotOutcome(serverSnapshot), "unavailable")

  const thrown = fakeClient("session", "messages", async () => {
    throw new Error("The operation was aborted due to timeout")
  })
  const thrownSnapshot = await fetchSnapshot(thrown, "ses_s")
  assert.deepEqual(thrownSnapshot, {})
  assert.equal(snapshotOutcome(thrownSnapshot), "unavailable")
})

test("fetchSnapshot: a session that answered is read as it always was", async () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
    {
      info: { role: "assistant", tokens: { input: 10, output: 5 } },
      parts: [{ type: "text", text: "done" }],
    },
  ]
  const client = fakeClient("session", "messages", async () => ({ data: messages }))
  const snapshot = await fetchSnapshot(client, "ses_ok")
  assert.equal(snapshot.messageCount, 2)
  assert.equal(snapshot.result, "done")
  assert.equal(snapshot.ctxTokens, 15)
  assert.equal(snapshotOutcome(snapshot), "ok")

  // An EMPTY session that answered is still "gone", unchanged.
  const empty = fakeClient("session", "messages", async () => ({ data: [] }))
  assert.equal(snapshotOutcome(await fetchSnapshot(empty, "ses_empty")), "gone")
})

// ---- createChildSession ------------------------------------------------------

test("createChildSession: undefined on a refused create, the id on a successful one", async () => {
  const refused = fakeClient("session", "create", async () => envelope(400, "BadRequestError", "no such parent"))
  assert.equal(await createChildSession(refused, { parentID: "ses_p", title: "t" }), undefined)

  const ok = fakeClient("session", "create", async () => ({ data: { id: "ses_child" } }))
  assert.equal(await createChildSession(ok, { parentID: "ses_p", title: "t" }), "ses_child")
})

test("createChildSession: a thrown transport error still propagates to the caller", async () => {
  // Nothing was established about whether a session exists, and the callers
  // treat an exception as the abort of the sequence they are in the middle of.
  const thrown = fakeClient("session", "create", async () => {
    throw new Error("socket hang up")
  })
  await assert.rejects(
    () => createChildSession(thrown, { parentID: "ses_p", title: "t" }),
    /socket hang up/,
  )
})
