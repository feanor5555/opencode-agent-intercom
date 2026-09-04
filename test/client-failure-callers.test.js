// The CALLER side of the client failure contract (concepts/client-failure-contract.md
// §4, step 5): what each call site does with a request the opencode server
// refused. The client layer itself is pinned in test/client-failure-contract.test.js;
// this file drives the refusal through the tools, the teardown and the handoff
// wiring instead.
//
// The failure every case here uses is the one this client really produces: the
// SDK client opencode hands a plugin is built WITHOUT `throwOnError`, so a
// failed request does not reject — it RESOLVES with `{ error, request, response }`
// carrying the HTTP status. Before the contract these call sites could not see
// such an answer at all and reported the write as done.
//
// Every case uses a 4xx, which is `terminal`: no retry budget is spent, so the
// assertions are about the call site and not about a backoff.
//
// What is pinned here:
//   - spawn: a refused task prompt tears the child session down, settles the
//     caller's waiter and reaches guard() instead of reporting a running
//     subagent that will never answer;
//   - spawn: a refused session CREATE names its status in the tool output;
//   - reuse: a refused follow-up puts the entry back to retained on its
//     ORIGINAL window and republishes that window on the title;
//   - the handoff wiring: the deps it hands performPrimaryHandoff behave the
//     way handoff.js's failure-path tests (test/handoff.test.js) drive their
//     doubles — promptAsync REJECTS, createSession answers undefined,
//     deleteSession/archiveSession answer false;
//   - the DOC_SUMMARY prompt fails at once rather than polling out its 120 s
//     timeout to reach the same conclusion.
//
// Run: node --test test/client-failure-callers.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  upsertSession,
  countActiveSubagents,
  countRetainedSubagents,
  entryLifecycle,
  LIFECYCLE_RETAINED,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { hasLiveChildren } from "../src/childwait.js"
import { buildPrimaryHandoffDeps } from "../src/handoffwiring.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-callerfail-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// The envelope the SDK client resolves with on a refused request.
function refusal(status, name = "BadRequestError") {
  return { error: { name, message: "refused by the server" }, response: { status } }
}

// A fake opencode client whose failures are switchable at run time.
//
//   state.promptStatus — refuse session.promptAsync calls that carry an `agent`
//     in the body. That is exactly the promptSession sends (spawn task prompt,
//     reuse follow-up, handoff kickoff, DOC_SUMMARY prompt); a wake notice
//     carries none and keeps working, so a refused prompt cannot be confused
//     with a primary that stopped receiving notices.
//   state.createStatus — refuse session.create.
//   state.deleteStatus / state.updateStatus — refuse the reported writes.
function makeCtx({ messages = [], agentConfig = {} } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
  const prompts = []
  const titles = []
  const state = { messages, promptStatus: 0, createStatus: 0, deleteStatus: 0, updateStatus: 0 }
  const client = {
    session: {
      create: async () => {
        if (state.createStatus) return refusal(state.createStatus, "InternalError")
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        const id = opts?.path?.id
        const text = (opts?.body?.parts ?? []).map((p) => p.text ?? "").join("")
        if (opts?.body?.agent) {
          if (state.promptStatus) return refusal(state.promptStatus, "NotFoundError")
          prompts.push({ id, agent: opts.body.agent, text })
        } else {
          notices.push({ id, text })
        }
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        if (state.deleteStatus) return refusal(state.deleteStatus, "InternalError")
        return { data: true }
      },
      update: async (opts) => {
        if (state.updateStatus) return refusal(state.updateStatus, "InternalError")
        titles.push({ id: opts?.path?.id, title: opts?.body?.title })
        return { data: {} }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: state.messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    client,
    created,
    deleted,
    notices,
    prompts,
    titles,
    state,
  }
}

function assistantReply(text, tokens = 20000) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

const idle = (hooks, sessionID) =>
  hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

// ---- spawn (concept §4.1) ----------------------------------------------------

test("spawn: a refused task prompt reports the failure instead of a running subagent", async () => {
  const { ctx, created, deleted, state } = makeCtx()
  const hooks = await plugin(ctx)

  state.promptStatus = 404
  const res = await hooks.tool.spawn.execute({ agent: "planner", prompt: "do it" }, toolCtx)

  // guard() is the channel: the orchestrator asked for this spawn and is
  // waiting on the tool result, so the status reaches it there.
  assert.match(res.output, /^spawn failed: /)
  assert.match(res.output, /HTTP 404/, "the orchestrator is told WHY it may not re-spawn blindly")
  assert.doesNotMatch(
    res.output,
    /runs in the background/,
    "a child that was never prompted is never reported as running",
  )

  const sessionID = created[created.length - 1]
  assert.equal(typeof sessionID, "string", "the child session was created before the prompt")
  assert.deepEqual(deleted, [sessionID], "the orphaned child session is torn down")
  assert.equal(entryForSession(sessionID), undefined, "no registry entry survives")
  assert.equal(countActiveSubagents(), 0, "and no concurrency slot is held")
})

test("spawn (nested): a refused task prompt settles the caller's waiter", async () => {
  // The nested caller BLOCKS on its child. A waiter left in the map would make
  // it a session with a live child for the rest of its run — idle held, silence
  // excused, teardown waiting on a child that was never prompted.
  const { ctx, state } = makeCtx({
    agentConfig: { planner: { permission: { spawn: "allow" } } },
  })
  const hooks = await plugin(ctx)
  upsertSession("ses_planner", {
    agent: "planner",
    prompt: "its own task",
    parentID: PRIMARY,
    directory: fixtureDir,
  })
  const callerCtx = { sessionID: "ses_planner", agent: "planner", messageID: "m2" }

  state.promptStatus = 404
  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "look it up" },
    callerCtx,
  )

  assert.match(res.output, /^spawn failed: /)
  assert.equal(hasLiveChildren("ses_planner"), false, "the waiter was settled, not left open")
})

// ---- spawn: the create itself (concept §4.10, step 5) ------------------------

test("spawn: a refused session create names its status in the tool output", async () => {
  // createChildSession keeps answering undefined for a REFUSED create; the
  // reason travels beside it so the orchestrator can tell a refusal it will
  // meet again from a server that was briefly down.
  const { ctx, state } = makeCtx()
  const hooks = await plugin(ctx)

  state.createStatus = 503
  const res = await hooks.tool.spawn.execute({ agent: "planner", prompt: "do it" }, toolCtx)

  assert.match(res.output, /^Failed to create subagent session: /)
  assert.match(res.output, /HTTP 503/)
  assert.equal(countActiveSubagents(), 0)
})

// ---- reuse (concept §4.2) ----------------------------------------------------

test("reuse: a refused follow-up puts the entry back to retained on its original window", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, titles, state } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)

  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  await idle(hooks, sessionID)
  const retained = entryForSession(sessionID)
  assert.equal(entryLifecycle(retained), LIFECYCLE_RETAINED, "the fixture must actually retain")
  const handle = retained.handle
  const retainedAt = retained.retainedAt
  const titleAtRetention = titles[titles.length - 1]

  state.promptStatus = 404
  const res = await hooks.tool.reuse.execute({ subagent: handle, prompt: "and then?" }, toolCtx)

  assert.match(res.output, /^reuse failed: /)
  assert.match(res.output, /HTTP 404/)
  assert.doesNotMatch(res.output, /Follow-up sent/, "no run started, so none is reported")

  const after = entryForSession(sessionID)
  assert.equal(entryLifecycle(after), LIFECYCLE_RETAINED, "back to held, not left running")
  assert.equal(after.retainedAt, retainedAt, "on its ORIGINAL window, not a fresh one")
  assert.equal(countRetainedSubagents(), 1)
  assert.equal(countActiveSubagents(), 0, "the slot the revival took is given back")

  // The state on the title says what the registry says: the last title written
  // is the retention stamp again, not the running row the revival published.
  assert.deepEqual(titles[titles.length - 1], titleAtRetention)
})

// ---- the handoff wiring (concept §4.3, §4.7) ---------------------------------

test("the handoff wiring hands handoff.js a promptAsync that REJECTS on a refused kickoff", async () => {
  // This is the pin the concept asks for: test/handoff.test.js case (e) drives
  // the kickoff with a THROWING double and asserts the revert. The production
  // wiring has to be faithful to that double — a refused kickoff that merely
  // resolved would walk past the point of no return, archive the old primary
  // and reparent every in-flight subagent onto a session that was never
  // prompted.
  const { client, state } = makeCtx()
  const deps = await buildPrimaryHandoffDeps(client, PRIMARY, fixtureDir, "orchestrator")

  state.promptStatus = 404
  await assert.rejects(() => deps.promptAsync("ses_new", "kickoff"), /HTTP 404/)
})

test("the handoff wiring hands handoff.js a createSession that answers undefined on a refusal", async () => {
  const { client, state } = makeCtx()
  const deps = await buildPrimaryHandoffDeps(client, PRIMARY, fixtureDir, "orchestrator")

  state.createStatus = 503
  assert.equal(await deps.createSession({ agent: "orchestrator" }), undefined)
})

test("the handoff wiring's deleteSession and archiveSession answer false on a refusal", async () => {
  // Both are REPORTED writes and handoff.js proceeds either way; the boolean is
  // what makes the log line at each site truthful.
  const { client, state } = makeCtx()
  const deps = await buildPrimaryHandoffDeps(client, PRIMARY, fixtureDir, "orchestrator")

  state.deleteStatus = 500
  state.updateStatus = 500
  assert.equal(await deps.deleteSession("ses_orphan"), false)
  assert.equal(await deps.archiveSession(PRIMARY), false)

  state.deleteStatus = 0
  state.updateStatus = 0
  assert.equal(await deps.deleteSession("ses_orphan"), true)
  assert.equal(await deps.archiveSession(PRIMARY), true)
})

// ---- the DOC_SUMMARY prompt (concept §4.4) -----------------------------------

test("the DOC_SUMMARY prompt fails at once on a refusal instead of polling out its timeout", async () => {
  // Timing only, and in the right direction: before the contract a refused
  // prompt was invisible and the helper polled fetchSnapshot for the full
  // DOC_SUMMARIES_TIMEOUT_MS (120 s) to reach the same conclusion. The two
  // callers keep their deliberately asymmetric answers to the throw.
  const { client, state } = makeCtx({ messages: assistantReply("R", 100) })
  const deps = await buildPrimaryHandoffDeps(client, PRIMARY, fixtureDir, "orchestrator")

  state.promptStatus = 404
  const startedAt = Date.now()
  await assert.rejects(() => deps.promptOldPrimaryForDocSummaries(), /HTTP 404/)
  assert.ok(
    Date.now() - startedAt < 5000,
    "the refusal is the answer; nothing waits on the 120 s poll window",
  )
})
