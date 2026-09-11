// The `show agentcom` switch applied RETROACTIVELY: src/client.js
// (applyAgentcomVisibility, the PATCH sweep over a session's own notice parts)
// and src/agentcomsync.js (the observation of the flip that triggers it).
//
// Until now the switch was resolved at send time only — a notice posted while
// it was on carried no `synthetic` flag and could never be taken off the
// screen again. The sweep below rewrites that flag on the parts already in the
// session, in both directions.
//
// What the sweep leans on, verified live against opencode 1.18.27 and not
// re-derived here: `PATCH /session/{id}/message/{mid}/part/{pid}` takes the
// WHOLE part, accepts `synthetic` both ways, publishes `message.part.updated`
// and reaches the drawn TUI at once; the plugin's own parts are identifiable by
// `metadata.agentIntercom === true`, which survives storage; the route group is
// annotated experimental, so a missing or refused route has to degrade to
// leaving the notices as they are.
//
// The route is taken through the CLIENT'S OWN TRANSPORT, not through a bare
// `fetch` at `serverUrl`: on an interactive TUI instance that address is
// opencode's placeholder `http://localhost:4096` with nothing bound to it, so
// a sweep going that way could never have written a single part there. The bare
// `fetch` survives only for a client shape that exposes no transport at all.
// The three-way per-part outcome is read off `attempt`'s failure `kind`: an
// answered status is "refused", a request nothing answered is "unreachable",
// and both end the sweep alike while nothing has been written yet.
//
// Run: node --test --test-timeout=4000 test/agentcom-retroactive.test.js

import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  MAX_VISIBILITY_PATCHES,
  applyAgentcomVisibility,
  forgetSessionDirectory,
  isIntercomNoticePart,
  partRoute,
  promptSession,
  setServerUrl,
} from "../src/client.js"
import {
  resetAgentcomVisibilityWatch,
  startAgentcomVisibilityWatch,
  syncAgentcomVisibility,
} from "../src/agentcomsync.js"
import { primarySessions, resetState } from "../src/state.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const SID = "ses_primary"
const URL_BASE = "http://127.0.0.1:4711"
const realFetch = globalThis.fetch

let tmpDir
let settingsFile

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-agentcom-vis-"))
  settingsFile = join(tmpDir, "agent-intercom.json")
  setSettingsPath(settingsFile)
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  resetSettings()
  resetState()
  resetAgentcomVisibilityWatch()
  setServerUrl(URL_BASE)
})

afterEach(() => {
  globalThis.fetch = realFetch
  setServerUrl("")
  resetAgentcomVisibilityWatch()
  resetState()
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// Writes the shared settings file and drops the TTL cache, so the next
// getSettings() read sees the value — the same shape the companion TUI's write
// has from this process's point of view.
function setShowAgentcom(on) {
  writeFileSync(settingsFile, JSON.stringify({ showAgentcom: on }))
  resetSettings()
}

// One of this plugin's own postings, as `session.messages` hands it back.
function noticePart(id, { synthetic = false, messageID = "msg_1", text = "🔔 agent-intercom: x" } = {}) {
  return {
    id,
    sessionID: SID,
    messageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    metadata: { agentIntercom: true },
  }
}

// The client's own `patch` transport, recording every call and answering it the
// way the generated SDK client does when it was built WITHOUT `throwOnError`:
// a 2xx resolves `{ data, request, response }`, anything else resolves
// `{ error, request, response }` carrying the status. `throws` makes it reject
// instead, which is the transport-level failure — no response was seen.
function transportPatch(calls, { status = 200, statuses, throws = false } = {}) {
  let n = 0
  return async ({ url, body, headers }) => {
    const code = statuses ? (statuses[n] ?? statuses.at(-1)) : status
    n++
    calls.push({ url, method: "PATCH", body, headers })
    if (throws) throw new Error("ECONNREFUSED")
    if (code >= 200 && code < 300) return { data: {}, request: {}, response: { status: code } }
    return { error: { name: "BadRequestError" }, request: {}, response: { status: code } }
  }
}

// A client whose messages() returns the given message list, in the
// { data: [...] } envelope the SDK wraps responses in, and whose transport
// records the sweep's PATCHes into `calls` — the root-client shape, which keeps
// the transport on `_client`.
function clientWith(messages, calls = [], options = {}) {
  return {
    session: { messages: async () => ({ data: messages }) },
    _client: {
      patch: transportPatch(calls, options),
      getConfig: () => ({ baseUrl: URL_BASE }),
    },
  }
}

// A `fetch` that fails the test if anything calls it: the transport route must
// not fall back to the placeholder address.
function forbidFetch() {
  globalThis.fetch = async (url) => {
    throw new Error(`bare fetch must not be used, but was called for ${url}`)
  }
}

// Records every bare-`fetch` PATCH and answers each with `status` — the last
// resort, for a client shape carrying no transport.
function captureFetch(calls, { status = 200 } = {}) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) })
    return { ok: status >= 200 && status < 300, status }
  }
}

// --- the sweep itself -------------------------------------------------------

test("the marker decides what the sweep may touch", () => {
  assert.equal(isIntercomNoticePart(noticePart("prt_1")), true)
  assert.equal(
    isIntercomNoticePart({ ...noticePart("prt_1"), metadata: {} }),
    false,
    "a part without the marker is the user's or opencode's own",
  )
  assert.equal(isIntercomNoticePart({ ...noticePart("prt_1"), type: "tool" }), false)
  assert.equal(
    isIntercomNoticePart({ ...noticePart("prt_1"), id: undefined }),
    false,
    "without an id the part route cannot be addressed",
  )
  assert.equal(isIntercomNoticePart({ ...noticePart("prt_1"), messageID: "" }), false)
  assert.equal(isIntercomNoticePart(undefined), false)
})

test("hiding patches every visible notice part and leaves everything else alone", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    {
      info: { role: "user" },
      parts: [
        { id: "prt_user", sessionID: SID, messageID: "msg_1", type: "text", text: "a real user prompt" },
        noticePart("prt_visible"),
      ],
    },
    {
      info: { role: "user" },
      parts: [
        noticePart("prt_already_hidden", { synthetic: true, messageID: "msg_2" }),
        { id: "prt_tool", sessionID: SID, messageID: "msg_2", type: "tool", tool: "spawn", metadata: { agentIntercom: true } },
      ],
    },
  ], calls)

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 1, patched: 1, failed: 0, aborted: false })
  assert.equal(calls.length, 1, "only the part whose flag has to change is written")
  assert.equal(calls[0].method, "PATCH")
  assert.equal(
    calls[0].url,
    partRoute(SID, "msg_1", "prt_visible"),
    "the part route carries all three ids, relative to the client's base URL",
  )
  assert.equal(calls[0].url, `/session/${SID}/message/msg_1/part/prt_visible`)
  assert.equal(
    calls[0].headers?.["Content-Type"],
    "application/json",
    "the body is sent as JSON",
  )
  // The route's payload schema is the whole Part with additionalProperties:false —
  // the body must be the part as stored, with the one field replaced.
  assert.deepEqual(calls[0].body, {
    id: "prt_visible",
    sessionID: SID,
    messageID: "msg_1",
    type: "text",
    text: "🔔 agent-intercom: x",
    metadata: { agentIntercom: true },
    synthetic: true,
  })
})

test("showing again patches the hidden parts back with synthetic false", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    { info: { role: "user" }, parts: [noticePart("prt_a", { synthetic: true })] },
    { info: { role: "user" }, parts: [noticePart("prt_b", { synthetic: true, messageID: "msg_2" })] },
  ], calls)

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: false })

  assert.equal(outcome.patched, 2)
  assert.deepEqual(
    calls.map((c) => c.body.synthetic),
    [false, false],
    "the un-hide is an explicit false, not a dropped key",
  )
  assert.deepEqual(
    calls.map((c) => c.body.id),
    ["prt_b", "prt_a"],
    "newest first — the near end of the history is what is on screen",
  )
})

test("nothing stale means no request at all", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    { info: { role: "user" }, parts: [noticePart("prt_a", { synthetic: true })] },
  ], calls)

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 0, patched: 0, failed: 0, aborted: false })
  assert.equal(calls.length, 0)
})

test("a client with a transport needs no server URL at all", async () => {
  // The interactive TUI: opencode reports the placeholder nothing is bound to,
  // or nothing at all, and the client transport is the only route there is.
  setServerUrl("")
  const calls = []
  forbidFetch()
  const client = clientWith([{ info: { role: "user" }, parts: [noticePart("prt_a")] }], calls)

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 1, patched: 1, failed: 0, aborted: false })
  assert.equal(calls[0].url, `/session/${SID}/message/msg_1/part/prt_a`)
})

test("no transport and no server URL is the one case that writes nothing", async () => {
  setServerUrl("")
  const calls = []
  captureFetch(calls)
  const client = { session: { messages: async () => ({ data: [{ info: { role: "user" }, parts: [noticePart("prt_a")] }] }) } }

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 0, patched: 0, failed: 0, aborted: false })
  assert.equal(calls.length, 0)
})

test("a client without a transport still reaches a listening server directly", async () => {
  const calls = []
  captureFetch(calls)
  const client = { session: { messages: async () => ({ data: [{ info: { role: "user" }, parts: [noticePart("prt_a")] }] }) } }

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 1, patched: 1, failed: 0, aborted: false })
  assert.equal(calls[0].method, "PATCH")
  assert.equal(
    calls[0].url,
    `${URL_BASE}/session/${SID}/message/msg_1/part/prt_a`,
    "the last resort prefixes serverUrl itself",
  )
  assert.equal(calls[0].body.synthetic, true)
})

test("a session id of nothing is a no-op", async () => {
  const calls = []
  forbidFetch()
  const outcome = await applyAgentcomVisibility(clientWith([], calls), "", { hidden: true })
  assert.deepEqual(outcome, { stale: 0, patched: 0, failed: 0, aborted: false })
  assert.equal(calls.length, 0)
})

test("a route that is not there costs one request and leaves the notices as they are", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    {
      info: { role: "user" },
      parts: [noticePart("prt_a"), noticePart("prt_b"), noticePart("prt_c")],
    },
  ], calls, { status: 404 })

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(
    outcome,
    { stale: 3, patched: 0, failed: 1, aborted: true },
    "the experimental route may vanish on a future opencode — one refusal ends the sweep",
  )
  assert.equal(calls.length, 1, "no burst of doomed requests")
})

test("a status the client resolved rather than threw still counts as a refusal", async () => {
  // The client is built without `throwOnError`, so a 401 comes back as an
  // envelope and not as a rejection. Reading it as a transport failure would
  // mislabel a server that answered — and it is the label the log carries.
  const calls = []
  forbidFetch()
  const client = clientWith([
    { info: { role: "user" }, parts: [noticePart("prt_a"), noticePart("prt_b")] },
  ], calls, { status: 401 })

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(
    outcome,
    { stale: 2, patched: 0, failed: 1, aborted: true },
    "a denied auth ends the sweep exactly as an absent route does",
  )
  assert.equal(calls.length, 1)
})

test("a refusal after a part HAS been written costs only that part", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    {
      info: { role: "user" },
      parts: [noticePart("prt_a"), noticePart("prt_b"), noticePart("prt_c")],
    },
  ], calls, { statuses: [200, 400, 200] })

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 3, patched: 2, failed: 1, aborted: false })
  assert.equal(calls.length, 3, "the rest of the sweep still runs")
})

test("a transport failure is swallowed rather than thrown at the notice path", async () => {
  const calls = []
  forbidFetch()
  const client = clientWith([
    { info: { role: "user" }, parts: [noticePart("prt_a"), noticePart("prt_b")] },
  ], calls, { throws: true })

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(
    outcome,
    { stale: 2, patched: 0, failed: 1, aborted: true },
    "a request nothing answered ends the sweep the same way a refusal does",
  )
  assert.equal(calls.length, 1)
})

test("an unreadable message list leaves the sweep with nothing to do", async () => {
  const calls = []
  forbidFetch()
  const client = {
    session: { messages: async () => { throw new Error("timeout") } },
    _client: { patch: transportPatch(calls) },
  }

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.deepEqual(outcome, { stale: 0, patched: 0, failed: 0, aborted: false })
  assert.equal(calls.length, 0)
})

test("the sweep is bounded and keeps the newest parts", async () => {
  const calls = []
  forbidFetch()
  const total = MAX_VISIBILITY_PATCHES + 50
  const parts = Array.from({ length: total }, (_, i) => noticePart(`prt_${i}`))
  const client = clientWith([{ info: { role: "user" }, parts }], calls)

  const outcome = await applyAgentcomVisibility(client, SID, { hidden: true })

  assert.equal(outcome.stale, total, "every stale part is counted")
  assert.equal(outcome.patched, MAX_VISIBILITY_PATCHES, "the writes are capped")
  assert.equal(calls.length, MAX_VISIBILITY_PATCHES)
  assert.equal(calls[0].body.id, `prt_${total - 1}`, "the newest part is written first")
  const written = new Set(calls.map((c) => c.body.id))
  assert.equal(written.has(`prt_${total - MAX_VISIBILITY_PATCHES}`), true)
  assert.equal(written.has("prt_0"), false, "the oldest fall outside the cap")
})

// --- observing the flip -----------------------------------------------------

test("the first observation only records — nothing has flipped yet", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(false)
  primarySessions.add(SID)
  const client = clientWith([{ info: { role: "user" }, parts: [noticePart("prt_a")] }], calls)

  const result = await syncAgentcomVisibility(client)

  assert.equal(result.flipped, false)
  assert.equal(calls.length, 0, "a switch that was already off at start is not a flip")
})

test("switching the switch off hides what is already on screen", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(true)
  primarySessions.add(SID)
  primarySessions.add("ses_other_primary")
  const client = clientWith([{ info: { role: "user" }, parts: [noticePart("prt_a")] }], calls)

  await syncAgentcomVisibility(client)
  setShowAgentcom(false)
  const result = await syncAgentcomVisibility(client)

  assert.deepEqual(result, { flipped: true, hidden: true, sessions: 2 })
  assert.equal(calls.length, 2, "every tracked primary is swept")
  assert.deepEqual(
    calls.map((c) => c.body.synthetic),
    [true, true],
  )
})

test("switching it back on brings the hidden notices back", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(false)
  const client = clientWith([
    { info: { role: "user" }, parts: [noticePart("prt_a", { synthetic: true })] },
  ], calls)

  await syncAgentcomVisibility(client, { sessions: [SID] })
  setShowAgentcom(true)
  const result = await syncAgentcomVisibility(client, { sessions: [SID] })

  assert.deepEqual(result, { flipped: true, hidden: false, sessions: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.synthetic, false)
})

test("an unchanged switch sweeps nothing", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(true)
  const client = clientWith([{ info: { role: "user" }, parts: [noticePart("prt_a")] }], calls)

  await syncAgentcomVisibility(client, { sessions: [SID] })
  const second = await syncAgentcomVisibility(client, { sessions: [SID] })
  const third = await syncAgentcomVisibility(client, { sessions: [SID] })

  assert.equal(second.flipped, false)
  assert.equal(third.flipped, false)
  assert.equal(calls.length, 0)
})

test("a sweep that could not write is not retried on every tick", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(true)
  const client = clientWith(
    [{ info: { role: "user" }, parts: [noticePart("prt_a")] }],
    calls,
    { status: 404 },
  )

  await syncAgentcomVisibility(client, { sessions: [SID] })
  setShowAgentcom(false)
  await syncAgentcomVisibility(client, { sessions: [SID] })
  assert.equal(calls.length, 1, "the flip is attempted once")

  const again = await syncAgentcomVisibility(client, { sessions: [SID] })
  assert.equal(again.flipped, false, "the observed value advances even when the write failed")
  assert.equal(calls.length, 1)
})

test("one session's failure does not cost the others their sweep", async () => {
  const calls = []
  forbidFetch()
  let n = 0
  setShowAgentcom(true)
  const client = {
    session: {
      messages: async () => ({
        data: [{ info: { role: "user" }, parts: [noticePart("prt_a")] }],
      }),
    },
    _client: {
      patch: async ({ url, body }) => {
        n++
        if (n === 1) throw new Error("ECONNREFUSED")
        calls.push({ url, method: "PATCH", body })
        return { data: {}, request: {}, response: { status: 200 } }
      },
    },
  }

  await syncAgentcomVisibility(client, { sessions: ["ses_a", "ses_b"] })
  setShowAgentcom(false)
  const result = await syncAgentcomVisibility(client, { sessions: ["ses_a", "ses_b"] })

  assert.equal(result.sessions, 2)
  assert.equal(calls.length, 1, "the second session is still swept")
})

test("a session this process posted into is swept even before it calls a tool", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(true)
  const posted = []
  const swept = []
  const client = {
    session: {
      messages: async (req) => {
        swept.push(req?.path?.id)
        return { data: [{ info: { role: "user" }, parts: [noticePart("prt_a")] }] }
      },
      promptAsync: async (req) => {
        posted.push(req)
        return { data: undefined }
      },
    },
    _client: { patch: transportPatch(calls) },
  }

  // The handoff kickoff: a hideable prompt into a brand-new orchestrator
  // session that has never called one of the plugin's tools, so nothing tracks
  // it as a primary yet.
  await promptSession(client, { sessionID: "ses_fresh_primary", prompt: "kickoff", hideable: true })
  // The spawn task prompt: not hideable, lands in a subagent's session, and
  // the switch has never governed it.
  await promptSession(client, { sessionID: "ses_subagent", prompt: "task", hideable: false })
  assert.equal(posted.length, 2)

  await syncAgentcomVisibility(client)
  setShowAgentcom(false)
  const result = await syncAgentcomVisibility(client)

  assert.deepEqual(
    swept,
    ["ses_fresh_primary"],
    "the fresh primary is swept and the subagent session is not",
  )
  assert.equal(result.sessions, 1)
  assert.equal(calls.length, 1, "its one visible notice part is hidden")

  forgetSessionDirectory("ses_fresh_primary")
  forgetSessionDirectory("ses_subagent")
})

test("the watch starts once per process and never holds it open", () => {
  setShowAgentcom(true)
  const client = clientWith([])
  const first = startAgentcomVisibilityWatch(client, { intervalMs: 60000 })
  const second = startAgentcomVisibilityWatch(client, { intervalMs: 60000 })
  assert.equal(second, first, "the per-session factory call must not start a second loop")
  assert.equal(first.hasRef(), false, "an unref'd timer keeps opencode's process from hanging on it")
  resetAgentcomVisibilityWatch()
})

test("the watch seeds from the value in effect at start", async () => {
  const calls = []
  forbidFetch()
  setShowAgentcom(false)
  const client = clientWith([{ info: { role: "user" }, parts: [noticePart("prt_a")] }], calls)

  startAgentcomVisibilityWatch(client, { intervalMs: 60000 })
  const result = await syncAgentcomVisibility(client, { sessions: [SID] })

  assert.equal(result.flipped, false, "the state at start is not a flip")
  assert.equal(calls.length, 0)
})
