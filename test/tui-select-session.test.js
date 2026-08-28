// The TUI view switch (src/client.js: selectTuiSession), which points the
// interactive TUI at the session the handoff just created.
//
// Two routes to one server endpoint, and the tests pin what the plugin cannot
// see from the outside: that a call the server refused is NOT reported as a
// success, and that the session id is carried in both argument shapes the two
// generated clients disagree about (`{ sessionID }` flat for the v2 client,
// which maps it into the body itself; `{ body: { sessionID } }` for a
// root-style one).
//
// Run: node --test --test-timeout=4000 test/tui-select-session.test.js

import test, { afterEach } from "node:test"
import assert from "node:assert/strict"

import { selectTuiSession, setServerUrl } from "../src/client.js"

const SID = "ses_new_primary"
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setServerUrl("")
})

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
