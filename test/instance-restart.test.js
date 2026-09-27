// An opencode instance restart inside a running process.
//
// opencode can dispose a project's instance and build a new one for the same
// directory without the process going: the plugin module stays loaded, its
// registry with it, and the factory runs again. The dispose ends every running
// subagent of the old instance, most of them without an event this plugin
// sees. What is pinned here, on the sequence the live incident showed —
// factory, spawns, dispose, factory again — with no model call:
//
//   (a) every running subagent the restart ended is settled, whatever
//       `maxSubagentAgeMs` says: the entry leaves the registry, its slot is
//       free, its state is filed and its session deleted after that, nested
//       children first;
//   (b) the primary is woken ONCE, with a notice that names the instance
//       restart as the cause — not "aborted by user" — and a slots line that
//       counts what is really free; the ordinary outside-abort notice counts
//       the ending subagent out of its own slots line too;
//   (c) every wake notice carries the primary's own agent;
//   (d) a subagent error reported while the dispose hook's mark stands is left
//       to the reconcile: no notice and no delete while opencode may still be
//       writing into that session.
//
// Run: node --test test/instance-restart.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { entryForSession, upsertSession, countActiveSubagents } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import {
  _runPendingInstanceReconcileForTests,
  reconcileAfterInstanceRestart,
} from "../src/instancerestart.js"
import { deliverParentNotice, noticeAgentFor } from "../src/noticejournal.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-restart-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

// The live configuration of the incident: four slots, both watchdog windows off.
function liveSettings() {
  writeFileSync(
    settingsFile,
    JSON.stringify({ maxSubagents: 4, maxSubagentAgeMs: 0, maxSubagentToolCallMs: 0 }),
  )
  resetSettings()
}

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(join(fixtureDir, "work"), { recursive: true, force: true })
  liveSettings()
})

const textPart = (text) => ({ type: "text", text })

// A session whose last assistant message is the abort the dispose wrote.
function abortedRun(text) {
  return [
    { info: { role: "user" }, parts: [textPart("task")] },
    {
      info: {
        role: "assistant",
        tokens: { input: 100, output: 10 },
        time: { completed: 1 },
        error: { name: "MessageAbortedError", data: {} },
      },
      parts: [textPart(text)],
    },
  ]
}

// `calls` is one ordered log of every read and write the plugin made, so the
// order of a read against a delete can be asserted. `status` is what
// `session.status` answers; `messagesFor` what a session's read answers.
function makeCtx({ status = () => ({}), messagesFor = (id) => abortedRun(`partial work of ${id}`) } = {}) {
  let counter = 0
  const created = []
  const calls = []
  const posts = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        const id = opts?.path?.id
        calls.push(["prompt", id])
        posts.push({
          sessionID: id,
          agent: opts?.body?.agent,
          text: (opts?.body?.parts ?? []).map((p) => p.text).join("\n"),
        })
        return { data: undefined }
      },
      abort: async (opts) => {
        calls.push(["abort", opts?.path?.id])
        return { data: true }
      },
      delete: async (opts) => {
        calls.push(["delete", opts?.path?.id])
        return { data: true }
      },
      status: async () => {
        calls.push(["status"])
        return { data: status() }
      },
      get: async () => ({ data: { directory: fixtureDir } }),
      list: async () => ({ data: [] }),
      messages: async (opts) => {
        calls.push(["messages", opts?.path?.id])
        return { data: messagesFor(opts?.path?.id) }
      },
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  const ctx = { client, directory: fixtureDir, worktree: fixtureDir, project: {} }
  const wakes = () => posts.filter((p) => p.sessionID === PRIMARY)
  const deleted = () => calls.filter(([k]) => k === "delete").map(([, id]) => id)
  return { ctx, created, calls, posts, wakes, deleted }
}

async function spawn(hooks, created, agent, prompt = "x") {
  await hooks.tool.spawn.execute({ agent, prompt }, toolCtx)
  return created[created.length - 1]
}

// The primary's agent as opencode resolves it for its turn, recorded the way
// the live plugin records it: through the `chat.message` hook.
async function primaryTurnAs(hooks, agent) {
  await hooks["chat.message"]({ sessionID: PRIMARY, agent }, { message: { id: "m0" }, parts: [] })
}

// The incident's shape: two coders and a planner running under the primary,
// and a researcher nested under the planner.
async function incidentRuns(hooks, created) {
  const coderA = await spawn(hooks, created, "coder", "T11")
  const coderB = await spawn(hooks, created, "coder", "T14")
  const planner = await spawn(hooks, created, "planner", "plan R5")
  const researcher = "ses_nested_researcher"
  upsertSession(researcher, {
    agent: "researcher",
    prompt: "look it up",
    parentID: planner,
    directory: fixtureDir,
  })
  return { coderA, coderB, planner, researcher }
}

function ageRuns(...sessionIDs) {
  for (const id of sessionIDs) entryForSession(id).runStartedAt -= 10_000
}

// ---- the rebuild sequence: setup twice in one process -----------------------

test("the first factory run for a directory is the ordinary load and arms no reconcile", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await spawn(hooks, created, "coder")
  assert.equal(await _runPendingInstanceReconcileForTests(fixtureDir), undefined)
  assert.equal(countActiveSubagents(), 1, "the running subagent is untouched")
})

test("a second factory run settles every run the restart ended, with maxSubagentAgeMs 0", async () => {
  const { ctx, created, wakes, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await primaryTurnAs(hooks, "orchestrator")
  const runs = await incidentRuns(hooks, created)
  ageRuns(runs.coderA, runs.coderB, runs.planner, runs.researcher)
  assert.equal(countActiveSubagents(), 4, "the incident's four slots are taken")

  await plugin(ctx)
  const result = await _runPendingInstanceReconcileForTests(fixtureDir)

  assert.deepEqual(new Set(result.ended), new Set(Object.values(runs)))
  for (const id of Object.values(runs)) {
    assert.equal(entryForSession(id), undefined, `${id} must leave the registry`)
  }
  assert.equal(countActiveSubagents(), 0, "every slot is free")
  assert.deepEqual(new Set(deleted()), new Set(Object.values(runs)), "every ended session is deleted")

  const notices = wakes()
  assert.equal(notices.length, 1, "the primary is woken exactly once")
  const [wake] = notices
  assert.match(wake.text, /opencode restarted its instance/)
  assert.match(wake.text, /Nobody stopped them on purpose — not the user and not you/)
  assert.doesNotMatch(wake.text, /aborted by user/)
  assert.match(wake.text, /"coder#1"/)
  assert.match(wake.text, /"coder#2"/)
  assert.match(wake.text, /"planner#1"/)
  assert.match(wake.text, /Its nested subagent "researcher#1" ended with it\./)
  assert.match(wake.text, /partial work of ses_sub1/, "the rescued text rides on the notice")
  assert.match(wake.text, /Subagent slots: 0\/4 \(global, across all sessions\) — 4 free\./)
  assert.equal(wake.agent, "orchestrator", "the notice starts its turn as the primary's own agent")
})

test("the restart settles reads before deletes, and a nested child before its parent", async () => {
  const { ctx, created, calls } = makeCtx()
  const hooks = await plugin(ctx)
  const runs = await incidentRuns(hooks, created)
  ageRuns(runs.coderA, runs.coderB, runs.planner, runs.researcher)
  await plugin(ctx)
  await _runPendingInstanceReconcileForTests(fixtureDir)

  const at = (kind, id) => calls.findIndex(([k, s]) => k === kind && s === id)
  const firstDelete = calls.findIndex(([k]) => k === "delete")
  for (const id of Object.values(runs)) {
    const read = at("messages", id)
    assert.ok(read >= 0 && read < firstDelete, `${id} is read before any session is deleted`)
  }
  assert.ok(
    at("delete", runs.researcher) < at("delete", runs.planner),
    "the nested child is deleted before the parent whose delete would cascade over it",
  )
})

test("a run opencode reports running in the new instance is left alone", async () => {
  let busy = null
  const { ctx, created, wakes } = makeCtx({ status: () => (busy ? { [busy]: { type: "busy" } } : {}) })
  const hooks = await plugin(ctx)
  const coderA = await spawn(hooks, created, "coder")
  const coderB = await spawn(hooks, created, "coder")
  ageRuns(coderA, coderB)
  busy = coderB
  await plugin(ctx)
  const result = await _runPendingInstanceReconcileForTests(fixtureDir)
  assert.deepEqual(result.ended, [coderA])
  assert.deepEqual(result.left, [coderB])
  assert.ok(entryForSession(coderB), "the running subagent keeps its entry")
  assert.equal(countActiveSubagents(), 1)
  assert.match(wakes()[0].text, /ended your running subagent/)
  assert.match(wakes()[0].text, /Subagent slots: 1\/4 .* — 3 free\./)
})

test("a run started in the new instance is not the restart's to settle", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const old = await spawn(hooks, created, "coder")
  ageRuns(old)
  const loadedAt = Date.now() - 1000
  entryForSession(old).runStartedAt = loadedAt - 5000
  const fresh = await spawn(hooks, created, "coder")
  const result = await reconcileAfterInstanceRestart(ctx.client, { directory: fixtureDir, loadedAt })
  assert.deepEqual(result.ended, [old])
  assert.ok(entryForSession(fresh), "the run the new instance started keeps running")
})

// ---- the dispose event ------------------------------------------------------

test("an abort reported while the instance is disposing is left to the reconcile: no notice, no delete", async () => {
  const { ctx, created, wakes, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await primaryTurnAs(hooks, "orchestrator")
  const coder = await spawn(hooks, created, "coder")
  ageRuns(coder)

  await hooks.dispose()
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: coder, error: { name: "MessageAbortedError", data: {} } },
    },
  })
  assert.equal(wakes().length, 0, "nothing is posted into the primary while the instance is down")
  assert.deepEqual(deleted(), [], "the session opencode is still writing into is not deleted")
  assert.ok(entryForSession(coder), "the entry waits for the reconcile")

  const rebuilt = await plugin(ctx)
  assert.equal(typeof rebuilt.dispose, "function")
  await _runPendingInstanceReconcileForTests(fixtureDir)
  assert.deepEqual(deleted(), [coder])
  assert.equal(wakes().length, 1)
  assert.match(wakes()[0].text, /ended by the instance restart/)
  assert.doesNotMatch(wakes()[0].text, /aborted/)
  assert.equal(wakes()[0].agent, "orchestrator")
})

// opencode runs the dispose hook and the interruption of the runs side by side,
// so an abort can reach the plugin just before the mark is set.
test("an abort whose dispose mark lands during the quiescence wait is still left to the reconcile", async () => {
  const { ctx, created, wakes, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const coder = await spawn(hooks, created, "coder")
  ageRuns(coder)

  const handling = hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: coder, error: { name: "MessageAbortedError", data: {} } },
    },
  })
  await hooks.dispose()
  await handling
  assert.equal(wakes().length, 0, "no abort notice")
  assert.deepEqual(deleted(), [], "no delete")
  assert.equal(entryForSession(coder)?.errored, false, "the latch is released for the reconcile")

  await plugin(ctx)
  const result = await _runPendingInstanceReconcileForTests(fixtureDir)
  assert.deepEqual(result.ended, [coder])
  assert.match(wakes()[0].text, /ended by the instance restart/)
})

test("a dispose inside the settle window cancels the armed reconcile; the next load re-arms it", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const coder = await spawn(hooks, created, "coder")
  ageRuns(coder)
  const second = await plugin(ctx)
  await second.dispose()
  assert.equal(await _runPendingInstanceReconcileForTests(fixtureDir), undefined)
  assert.ok(entryForSession(coder), "nothing is settled against an instance that is going again")
  await plugin(ctx)
  const result = await _runPendingInstanceReconcileForTests(fixtureDir)
  assert.deepEqual(result.ended, [coder])
})

// ---- (b) and (c) on the ordinary paths --------------------------------------

test("an outside abort counts the ending subagent out of its own slots line", async () => {
  const { ctx, created, wakes } = makeCtx()
  const hooks = await plugin(ctx)
  const coderA = await spawn(hooks, created, "coder")
  await spawn(hooks, created, "coder")
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: coderA, error: { name: "MessageAbortedError", data: {} } },
    },
  })
  const [wake] = wakes()
  assert.match(wake.text, /Slot freed\./)
  assert.match(wake.text, /Subagent slots: 1\/4 \(global, across all sessions\) — 3 free\./)
})

test("every wake notice names the primary's own agent, recorded or defaulted", async () => {
  const { ctx, created, wakes } = makeCtx()
  const hooks = await plugin(ctx)
  const coder = await spawn(hooks, created, "coder")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: coder } } })
  assert.equal(wakes()[0].agent, "orchestrator", "no turn recorded yet: the plugin's default agent")

  await primaryTurnAs(hooks, "lead")
  assert.equal(noticeAgentFor(PRIMARY), "lead")
  await deliverParentNotice(ctx.client, PRIMARY, "🔔 agent-intercom: test")
  assert.equal(wakes()[1].agent, "lead", "a recorded agent wins over the default")
})
