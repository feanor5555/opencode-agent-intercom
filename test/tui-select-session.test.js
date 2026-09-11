// The TUI view switch (src/client.js: selectTuiSession), which points the
// interactive TUI at the session the handoff just created.
//
// Three routes to one server endpoint, and the tests pin what the plugin cannot
// see from the outside:
//   - a call the server refused is NOT reported as a success;
//   - the session id is carried in both argument shapes the two generated
//     clients disagree about (`{ sessionID }` flat for the v2 client, which maps
//     it into the body itself; `{ body: { sessionID } }` for a root-style one);
//   - where the resolved client exposes its own transport, the route is posted
//     THROUGH it and never through a bare `fetch` at `serverUrl` — on an
//     interactive TUI instance that address is opencode's placeholder
//     `http://localhost:4096`, which nothing is listening on;
//   - a failed post names the URL it tried and the class of the failure.
//
// Run: node --test --test-timeout=4000 test/tui-select-session.test.js

import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs"

import {
  PLACEHOLDER_SERVER_URL,
  lowLevelClient,
  selectTuiSession,
  setServerUrl,
} from "../src/client.js"

const SID = "ses_new_primary"
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setServerUrl("")
})

// A `fetch` that fails the test if anything calls it: used to prove a route was
// NOT taken, which is the whole point of the transport-first order.
function forbidFetch() {
  globalThis.fetch = async (url) => {
    throw new Error(`bare fetch must not be used, but was called for ${url}`)
  }
}

const debugLogPath = join(homedir(), ".cache", "opencode-agent-intercom", "debug.log")

// What the debug log gained while `run` was executing, read as a byte range from
// the recorded offset: the log is append-only and grows large, and a character
// offset would sit elsewhere in a file carrying any multi-byte character. Empty
// where logging is switched off or the file does not exist.
async function loggedDuring(run) {
  const before = existsSync(debugLogPath) ? statSync(debugLogPath).size : 0
  await run()
  if (!existsSync(debugLogPath)) return ""
  const after = statSync(debugLogPath).size
  if (after <= before) return ""
  const buf = Buffer.alloc(after - before)
  const fd = openSync(debugLogPath, "r")
  try {
    readSync(fd, buf, 0, buf.length, before)
  } finally {
    closeSync(fd)
  }
  return buf.toString("utf8")
}

test("a clean call reports success and carries the id in both argument shapes", async () => {
  const calls = []
  const client = {
    tui: {
      selectSession: async (parameters, options) => {
        calls.push({ parameters, options })
        return { data: true }
      },
    },
  }
  assert.equal(await selectTuiSession(client, SID), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].parameters.sessionID, SID, "the v2 client reads the id flat")
  assert.equal(calls[0].parameters.body.sessionID, SID, "a root-style client reads it from the body")
  assert.equal(calls[0].options.throwOnError, true, "a non-2xx has to reject rather than come back as data")
})

test("a result carrying an error is not a success — it falls through to the direct post", async () => {
  const posted = []
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  setServerUrl("http://127.0.0.1:4096/")
  const client = {
    // The shape the generated client returns for a 4xx when the caller did
    // not (or could not) ask for a throw: no rejection, an `error` field.
    tui: { selectSession: async () => ({ data: undefined, error: { name: "BadRequestError" } }) },
  }
  assert.equal(await selectTuiSession(client, SID), true)
  assert.deepEqual(posted, [
    { url: "http://127.0.0.1:4096/tui/select-session", body: { sessionID: SID } },
  ])
})

test("a rejected call with no server URL to fall back to reports failure", async () => {
  const client = {
    tui: {
      selectSession: async () => ({ error: { name: "BadRequestError" } }),
    },
  }
  assert.equal(
    await selectTuiSession(client, SID),
    false,
    "reporting true here would claim a view switch that never happened",
  )
})

test("a client without the method posts the route directly", async () => {
  const posted = []
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) })
    return { ok: false, status: 404 }
  }
  setServerUrl("http://127.0.0.1:4096")
  assert.equal(await selectTuiSession({ tui: {} }, SID), false, "a 404 is not a switch")
  assert.equal(posted[0].body.sessionID, SID)
})

test("no session id at all is a no-op", async () => {
  assert.equal(await selectTuiSession({ tui: {} }, ""), false)
})

// ---------------------------------------------------------------------------
// The client's own transport: the route that reaches an interactive TUI
// instance, where `serverUrl` is a placeholder nothing is bound to.
// ---------------------------------------------------------------------------

// A root-style generated client: the typed method is absent, the underlying
// HTTP client sits on `_client`.
function rootClient(post) {
  return { tui: {}, _client: { post, getConfig: () => ({ baseUrl: PLACEHOLDER_SERVER_URL }) } }
}

test("lowLevelClient finds the transport under both generated client shapes", () => {
  const post = async () => ({})
  assert.equal(lowLevelClient({ _client: { post } })?.post, post, "root client keeps it on _client")
  assert.equal(lowLevelClient({ client: { post } })?.post, post, "the v2 client keeps it on client")
  assert.equal(lowLevelClient({ tui: {} }), undefined, "neither shape present")
  assert.equal(lowLevelClient({ _client: {} }), undefined, "a transport that cannot post is not one")
  assert.equal(lowLevelClient(undefined), undefined)
})

test("lowLevelClient answers for the verb the caller names", () => {
  const post = async () => ({})
  const patch = async () => ({})
  // The agentcom visibility sweep needs PATCH, not POST — a shape that serves
  // only one of the two must not be handed over for the other.
  assert.equal(lowLevelClient({ _client: { post, patch } }, "patch")?.patch, patch)
  assert.equal(lowLevelClient({ client: { post, patch } }, "patch")?.patch, patch)
  assert.equal(
    lowLevelClient({ _client: { post } }, "patch"),
    undefined,
    "a transport without the verb is not one for this caller",
  )
  assert.equal(lowLevelClient({ _client: { patch } }), undefined, "the default verb stays post")
})

test("without the typed method the route goes through the client, not through serverUrl", async () => {
  const posted = []
  forbidFetch()
  // Exactly the situation the live stall was: opencode reports the placeholder
  // because the instance runs no HTTP listener, and the client is the only
  // thing that reaches the in-process server.
  setServerUrl(PLACEHOLDER_SERVER_URL)
  const client = rootClient(async (options) => {
    posted.push(options)
    return { data: true, response: { status: 200 } }
  })
  assert.equal(await selectTuiSession(client, SID), true)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].url, "/tui/select-session", "the route is posted relative to the client's base URL")
  assert.deepEqual(posted[0].body, { sessionID: SID })
  assert.equal(posted[0].throwOnError, true, "a non-2xx has to reject rather than come back as data")
})

test("the v2 client shape is carried too", async () => {
  const posted = []
  forbidFetch()
  setServerUrl(PLACEHOLDER_SERVER_URL)
  const client = { tui: {}, client: { post: async (o) => (posted.push(o), { data: true }) } }
  assert.equal(await selectTuiSession(client, SID), true)
  assert.deepEqual(posted[0].body, { sessionID: SID })
})

test("a typed method that fails falls through to the client transport, not to the bare post", async () => {
  const posted = []
  forbidFetch()
  setServerUrl(PLACEHOLDER_SERVER_URL)
  const client = {
    tui: { selectSession: async () => ({ error: { name: "BadRequestError" } }) },
    _client: { post: async (o) => (posted.push(o), { data: true }) },
  }
  assert.equal(await selectTuiSession(client, SID), true)
  assert.equal(posted.length, 1)
})

test("a transport that itself fails still falls through to the bare post", async () => {
  const posted = []
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  setServerUrl("http://127.0.0.1:4969")
  const client = rootClient(async () => {
    throw new Error("no route on this server")
  })
  assert.equal(await selectTuiSession(client, SID), true)
  assert.deepEqual(posted, [
    { url: "http://127.0.0.1:4969/tui/select-session", body: { sessionID: SID } },
  ])
})

test("a transport post the server refused is not reported as a switch", async () => {
  setServerUrl("")
  const client = rootClient(async () => ({ error: { name: "BadRequestError" }, response: { status: 400 } }))
  assert.equal(await selectTuiSession(client, SID), false)
})

// ---------------------------------------------------------------------------
// What a failure leaves in the log. The live stall logged a bare
// "Unable to connect" with neither the URL nor a reason class, which is why the
// address it tried could not be established afterwards.
// ---------------------------------------------------------------------------

test("a connect failure logs the URL, the reason class and that the address is the placeholder", async (t) => {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") {
    t.skip("debug logging is switched off for this run")
    return
  }
  globalThis.fetch = async () => {
    // Bun's wording for a refused connection — the message the live stall left.
    throw new Error("Unable to connect. Is the computer able to access the url?")
  }
  setServerUrl(PLACEHOLDER_SERVER_URL)
  let switched
  const written = await loggedDuring(async () => {
    switched = await selectTuiSession({ tui: {} }, SID)
  })
  assert.equal(switched, false)
  const line = written.split("\n").find((l) => l.includes("tui select-session post failed"))
  assert.ok(line, `no failure line in:\n${written}`)
  assert.ok(line.includes(`${PLACEHOLDER_SERVER_URL}/tui/select-session`), line)
  assert.ok(line.includes('"reason":"unreachable"'), line)
  assert.ok(line.includes('"placeholder":true'), line)
  assert.ok(line.includes(SID), line)
})

test("a refused post logs the status and names the reason as a refusal", async (t) => {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") {
    t.skip("debug logging is switched off for this run")
    return
  }
  globalThis.fetch = async () => ({ ok: false, status: 401 })
  setServerUrl("http://127.0.0.1:4969")
  const written = await loggedDuring(async () => {
    assert.equal(await selectTuiSession({ tui: {} }, SID), false)
  })
  const line = written.split("\n").find((l) => l.includes("tui select-session post failed"))
  assert.ok(line, `no failure line in:\n${written}`)
  assert.ok(line.includes('"status":401'), line)
  assert.ok(line.includes('"reason":"refused"'), line)
  assert.ok(line.includes("http://127.0.0.1:4969/tui/select-session"), line)
})

// ---------------------------------------------------------------------------
// The resolved address, logged once at plugin load.
// ---------------------------------------------------------------------------

test("setServerUrl logs the resolved address once, flagging opencode's placeholder", async (t) => {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") {
    t.skip("debug logging is switched off for this run")
    return
  }
  const client = rootClient(async () => ({ data: true }))
  const first = await loggedDuring(async () => {
    setServerUrl(new URL(`${PLACEHOLDER_SERVER_URL}/`), client)
  })
  const line = first.split("\n").find((l) => l.includes("server url resolved"))
  assert.ok(line, `no resolved line in:\n${first}`)
  assert.ok(line.includes(`"serverUrl":"${PLACEHOLDER_SERVER_URL}"`), `trailing slash not stripped: ${line}`)
  assert.ok(line.includes('"placeholder":true'), line)
  assert.ok(line.includes(`"clientBaseUrl":"${PLACEHOLDER_SERVER_URL}"`), line)
  assert.ok(line.includes('"clientRoutePost":true'), line)

  const again = await loggedDuring(async () => {
    setServerUrl(PLACEHOLDER_SERVER_URL, client)
  })
  assert.equal(
    again.split("\n").filter((l) => l.includes("server url resolved")).length,
    0,
    "the same address must not be logged a second time",
  )
})

test("a real listener address is not flagged as the placeholder", async (t) => {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") {
    t.skip("debug logging is switched off for this run")
    return
  }
  const written = await loggedDuring(async () => {
    setServerUrl("http://127.0.0.1:4969", { tui: {} })
  })
  const line = written.split("\n").find((l) => l.includes("server url resolved"))
  assert.ok(line, `no resolved line in:\n${written}`)
  assert.ok(line.includes('"placeholder":false'), line)
  assert.ok(line.includes('"clientRoutePost":false'), line)
})
