// Reuse: putting a follow-up to a subagent that has already finished and is
// being held, instead of spawning a fresh one that never saw the work.
//
// What is pinned here:
//   - the admission gate, term by term (G1 a figure at all, G2 the type's reuse
//     ceiling, G3 the context budget carrying the follow-up, G4 half the budget
//     for a further task) and which term binds per configuration;
//   - the three outcomes of the snapshot fetch the gate runs on: a figure, a
//     failed fetch (refuse, keep the session), an empty message list (refuse
//     and drop the entry);
//   - the revival: the entry goes back to running under the same handle, takes
//     a concurrency slot through the same cap as a spawn, and is refused when
//     no slot is free;
//   - the completion notice of a reused run says which run it was and labels
//     its cumulative figure, and the session faces the retention decision again;
//   - `list` shows retained entries as their own state, and they count as
//     active nowhere;
//   - with `maxRetainedSubagents` at its default of 0 the tool does not exist
//     and `list` is byte-identical to what it has always returned.
//
// Run: node --test test/subagent-reuse.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  countActiveSubagents,
  countRetainedSubagents,
  isActiveEntry,
  entryLifecycle,
  reuseAdmission,
  RETAIN_TASK_SHARE,
  REUSE_QUESTION,
  REUSE_TASK,
  LIFECYCLE_RETAINED,
  LIFECYCLE_RUNNING,
} from "../src/registry.js"
import { snapshotOutcome } from "../src/client.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-reuse-"))
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

// A fake opencode client. `messages` is a mutable holder so a test can change
// what the session reports between the run's idle and the reuse's own fetch —
// which is the whole reason the gate refetches. `fail` makes session.messages
// throw, the transport failure fetchSnapshot answers with {}.
function makeCtx({ messages = [] } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
  const prompts = []
  const state = { messages, fail: false }
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
        const text = (opts?.body?.parts ?? []).map((p) => p.text ?? "").join("")
        prompts.push({ id, agent: opts?.body?.agent, text })
        if (!created.includes(id)) notices.push(text)
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => {
        if (state.fail) throw new Error("connection reset")
        return { data: state.messages }
      },
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    deleted,
    notices,
    prompts,
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

// Spawns one planner, ends it, and leaves it retained. Returns its session id
// and handle.
async function retainOne(hooks, created, agent = "planner") {
  await hooks.tool.spawn.execute({ agent, prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  await idle(hooks, sessionID)
  const entry = entryForSession(sessionID)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED, "the fixture must actually retain")
  return { sessionID, handle: entry.handle }
}

// ---- the gate, term by term -------------------------------------------------

// The defaults every case below is measured against: a 100000-token budget per
// agent type and a 70000-token reuse ceiling.
const DEFAULTS = { ceiling: 70000, budget: 100000 }

test("G1: the gate refuses rather than evaluate a ceiling against a missing figure", () => {
  for (const bad of [undefined, null, NaN, "40000", 0, -1, Infinity]) {
    const v = reuseAdmission(bad, DEFAULTS)
    assert.equal(v.admit, false, `${String(bad)} is not a context figure`)
    assert.equal(v.term, "G1")
    assert.equal(v.reason, "no-context")
  }
  // A reuse ceiling of 0 needs no branch of its own: G1 already refuses every
  // non-positive context, so no real session is ever at or below 0.
  const never = reuseAdmission(1, { ceiling: 0, budget: 100000 })
  assert.equal(never.admit, false)
  assert.equal(never.term, "G2", "0 means never reuse this type, not no limit")
})

test("G2: the reuse ceiling is inclusive and is the term that binds in the normal case", () => {
  assert.equal(reuseAdmission(1, DEFAULTS).admit, true)
  assert.equal(reuseAdmission(70000, DEFAULTS).admit, true, "at the ceiling, admitted")
  const over = reuseAdmission(70001, DEFAULTS)
  assert.equal(over.admit, false)
  assert.equal(over.term, "G2", "under its budget, over the user's ceiling")
  assert.equal(over.limit, 70000, "the refusal can name the number it was decided against")

  // A healthy run between the ceiling and the budget: never STOP-injected,
  // never over budget, and still refused. That is requirement 2, not a defect.
  assert.equal(reuseAdmission(85000, DEFAULTS).term, "G2")
})

test("G3: the budget binds where it is lower than the ceiling, and it carries the follow-up", () => {
  const tight = { ceiling: 70000, budget: 50000 }
  assert.equal(reuseAdmission(40000, { ...tight, pkgTokens: 1000 }).admit, true)
  const overBudget = reuseAdmission(49999, { ...tight, pkgTokens: 1 })
  assert.equal(overBudget.admit, false)
  assert.equal(overBudget.term, "G3", "the prompt is what tips it over")
  assert.equal(overBudget.limit, 50000)

  // At a high context G3 is far stricter than the spawn-time package gate: a
  // 20000-token package is well under 40% of a 100000 budget and still does not
  // fit beside 69000 tokens of history.
  const noRoom = reuseAdmission(69000, { ...DEFAULTS, pkgTokens: 35000 })
  assert.equal(noRoom.term, "G3")

  // A ceiling set above the budget is inert rather than rejected: G3 refuses
  // what the ceiling lets through.
  const wide = { ceiling: 150000, budget: 100000 }
  assert.equal(reuseAdmission(99000, { ...wide, pkgTokens: 500 }).admit, true)
  assert.equal(reuseAdmission(120000, wide).term, "G3")

  // Where the budget is disabled with 0 the term falls away and the ceiling is
  // the only rule — the one configuration in which a high ceiling means
  // something.
  assert.equal(reuseAdmission(120000, { ceiling: 150000, budget: 0 }).admit, true)
  assert.equal(reuseAdmission(150001, { ceiling: 150000, budget: 0 }).term, "G2")
})

test("G4: a further task must be under half the budget; a question must not", () => {
  const share = 100000 * RETAIN_TASK_SHARE
  assert.equal(share, 50000)

  // The primary case. A follow-up question at 60000 is admitted — refusing it
  // would refuse the reuse in exactly the situation the feature exists for.
  assert.equal(reuseAdmission(60000, { ...DEFAULTS, mode: REUSE_QUESTION }).admit, true)
  assert.equal(reuseAdmission(60000, DEFAULTS).admit, true, "question is the default mode")

  // The secondary case, at the same figure.
  const task = reuseAdmission(60000, { ...DEFAULTS, mode: REUSE_TASK })
  assert.equal(task.admit, false)
  assert.equal(task.term, "G4")
  assert.equal(task.limit, 50000)

  assert.equal(reuseAdmission(50000, { ...DEFAULTS, mode: REUSE_TASK }).admit, true, "inclusive")
  assert.equal(reuseAdmission(50001, { ...DEFAULTS, mode: REUSE_TASK }).term, "G4")

  // With no budget there is no share to take, and G4 falls back to G2 — the
  // type's own ceiling is then the only number that exists.
  assert.equal(
    reuseAdmission(69000, { ceiling: 70000, budget: 0, mode: REUSE_TASK }).admit,
    true,
  )

  // The share follows a budget a user lowers for one type, where a hard figure
  // would silently exceed that type's whole budget.
  assert.equal(reuseAdmission(21000, { ceiling: 70000, budget: 40000, mode: REUSE_TASK }).term, "G4")
})

// ---- the three outcomes of the snapshot fetch --------------------------------

test("snapshotOutcome tells a failed fetch from a session that has no messages left", () => {
  assert.equal(snapshotOutcome({}), "unavailable", "fetchSnapshot answers {} on any failure")
  assert.equal(snapshotOutcome(undefined), "unavailable")
  assert.equal(snapshotOutcome({ messageCount: 0 }), "gone", "a session that answered with nothing")
  assert.equal(snapshotOutcome({ messageCount: 2, ctxTokens: 10 }), "ok")
})

test("a fetch that fails refuses the reuse and leaves the session held", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, state } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)

  state.fail = true
  const res = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)

  assert.match(res.output, /Reuse refused/)
  assert.match(res.output, /still held/, "the session is not disposed of over a transport failure")
  assert.equal(
    entryLifecycle(entryForSession(sessionID)),
    LIFECYCLE_RETAINED,
    "and the stale figure is never substituted for the one it could not read",
  )
})

test("a session with no messages left refuses the reuse and drops the entry", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, state } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)

  state.messages = []
  const res = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)

  assert.match(res.output, /no longer exists/)
  assert.equal(entryForSession(sessionID), undefined, "the handle stops being offered")
  assert.equal(countRetainedSubagents(), 0)
})

test("a figure is what the gate runs on, freshly fetched and never the stored one", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, prompts, state } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)
  assert.equal(entryForSession(sessionID).ctxTokens, 20000, "what was true when the run ended")

  // The user opened the retained session in the TUI and typed into it: the
  // session is now far over the ceiling while the entry still says 20000.
  state.messages = assistantReply("R", 90000)
  const res = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)

  assert.match(res.output, /G2: reuse ceiling/, "decided on the fetched figure, not the stored one")
  assert.match(res.output, /90.0k/)
  assert.match(res.output, /70.0k/)
  assert.equal(prompts.filter((p) => p.id === sessionID).length, 1, "only the original spawn")
})

// ---- the refusals name their term -------------------------------------------

test("each refusing term names itself, its figures, and spawn as the way forward", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, state } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { handle } = await retainOne(hooks, created)

  state.messages = assistantReply("R", 60000)
  const g4 = await hooks.tool.reuse.execute(
    { subagent: handle, prompt: "now fix the other file too", mode: REUSE_TASK },
    toolCtx,
  )
  assert.match(g4.output, /G4: room for a further task/)
  assert.match(g4.output, /50.0k/, "half the budget, named")
  assert.match(g4.output, /mode "question"/, "and the way to ask a question instead")
  assert.match(g4.output, /spawn a fresh subagent/)

  // The same session and the same figure, asked as a question: admitted.
  const ok = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)
  assert.match(ok.output, /Follow-up sent/)
})

// ---- the revival and the cap -------------------------------------------------

test("an accepted reuse re-prompts the same session under the same handle", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted, prompts } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)
  const spawnedAt = entryForSession(sessionID).spawnedAt

  const res = await hooks.tool.reuse.execute(
    { subagent: handle, prompt: "which of the two did you mean?" },
    toolCtx,
  )

  assert.match(res.output, /Follow-up sent to "planner#1"/)
  assert.match(res.output, /run 2 of that session/)
  assert.equal(res.metadata.reuse, true)
  assert.equal(res.metadata.run, 2)
  assert.equal(res.metadata.handle, handle, "the handle is unchanged — that is the point")
  assert.deepEqual(created, [sessionID], "no session was created")
  assert.deepEqual(deleted, [])

  const sent = prompts.filter((p) => p.id === sessionID)
  assert.equal(sent.length, 2, "the same session was prompted a second time")
  assert.equal(sent[1].text, "which of the two did you mean?", "no project snapshot prepended")
  assert.equal(sent[1].agent, "planner", "under the same role")

  const entry = entryForSession(sessionID)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RUNNING, "back to running for this turn")
  assert.equal(entry.status, "busy")
  assert.equal(entry.dispatched, false, "so the idle path wakes the parent again")
  assert.equal(entry.retainedAt, undefined, "the window is over")
  assert.equal(entry.runs, 2)
  assert.equal(entry.spawnedAt, spawnedAt, "the age column keeps telling the truth")
  assert.equal(isActiveEntry(entry), true, "and it takes a slot again")
  assert.equal(countActiveSubagents(), 1)
  assert.equal(countRetainedSubagents(), 0)
})

test("the concurrency cap gates a revival exactly as it gates a spawn", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 1 })
  const { ctx, created, prompts } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)

  // The one slot is now taken by a fresh subagent.
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "y" }, toolCtx)
  assert.equal(countActiveSubagents(), 1)

  const refused = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which?" }, toolCtx)
  assert.match(refused.output, /subagent limit reached \(1\/1/)
  assert.match(refused.output, /takes a slot exactly as a spawn does/)
  assert.match(refused.output, /stays held/)
  assert.equal(prompts.filter((p) => p.id === sessionID).length, 1, "nothing was sent")
  assert.equal(
    entryLifecycle(entryForSession(sessionID)),
    LIFECYCLE_RETAINED,
    "a refused revival leaves the entry exactly as it was",
  )

  // The slot frees up and the same call is admitted.
  await idle(hooks, created[1])
  const ok = await hooks.tool.reuse.execute({ subagent: handle, prompt: "which?" }, toolCtx)
  assert.match(ok.output, /Follow-up sent/)
})

test("reuse refuses an unknown handle, another primary's, and a running subagent", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { handle } = await retainOne(hooks, created)

  assert.match(
    (await hooks.tool.reuse.execute({ subagent: "planner#9", prompt: "q" }, toolCtx)).output,
    /Unknown subagent/,
  )
  const foreign = await hooks.tool.reuse.execute(
    { subagent: handle, prompt: "q" },
    { ...toolCtx, sessionID: "ses_other_primary" },
  )
  assert.match(foreign.output, /Unknown subagent/, "foreign ownership does not leak")

  await hooks.tool.spawn.execute({ agent: "coder", prompt: "y" }, toolCtx)
  const running = entryForSession(created[1]).handle
  const res = await hooks.tool.reuse.execute({ subagent: running, prompt: "q" }, toolCtx)
  assert.match(res.output, /still running/)
  assert.match(res.output, /woken automatically/)
})

// ---- how a reused run finishes ----------------------------------------------

test("the completion notice of a reused run names the run and labels its figure", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, notices, state } = makeCtx({ messages: assistantReply("FIRST", 20000) })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)
  assert.match(notices[0], /has finished and been destroyed/)
  assert.match(notices[0], /📏 run-size: /, "run 1's caption is what it has always been")

  await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)
  state.messages = assistantReply("THE ANSWER", 31000)
  await idle(hooks, sessionID)

  assert.equal(notices.length, 2, "a reused run wakes the primary exactly as a spawned one does")
  const notice = notices[1]
  assert.match(notice, /"planner#1" \(planner\) — follow-up run 2 of that session has finished/)
  assert.match(notice, /THE ANSWER/)
  assert.match(notice, /📏 run-size \(run 2, cumulative over the session\)/)

  // And the session faces the retention decision again, on a fresh window.
  const entry = entryForSession(sessionID)
  assert.equal(entryLifecycle(entry), LIFECYCLE_RETAINED)
  assert.ok(entry.retainedAt > 0, "the window is per retention, not per session")
  assert.equal(entry.runs, 2)
  assert.equal(countActiveSubagents(), 0, "and the slot is free again")
})

test("a reused run whose result no longer fits the ceiling is delivered and then deleted", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted, notices, state } = makeCtx({
    messages: assistantReply("FIRST", 20000),
  })
  const hooks = await plugin(ctx)
  const { sessionID, handle } = await retainOne(hooks, created)

  await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)
  state.messages = assistantReply("THE ANSWER", 85000)
  await idle(hooks, sessionID)

  assert.equal(notices.length, 2, "the answer still reaches the orchestrator")
  assert.deepEqual(deleted, [sessionID], "the run that grew past the ceiling is not held again")
  assert.equal(entryForSession(sessionID), undefined)
})

// ---- list --------------------------------------------------------------------

test("list shows retained entries as their own state, with what a follow-up needs", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created } = makeCtx({ messages: assistantReply("R", 31000) })
  const hooks = await plugin(ctx)
  await retainOne(hooks, created)

  let listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /^No active subagents\./, "a retained entry is not an active one")
  assert.match(listed.output, /RETAINED/)
  assert.match(listed.output, /planner#1 {2}\[retained] {2}planner {2}ctx:31.0k {2}(?:59|60)m left/)
  assert.match(listed.output, /session:ses_sub1/)
  assert.match(listed.output, /reuse\("<handle>", "<question>"\)/, "and how to address it")

  // A running subagent beside it: the two states stay separate blocks.
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "y" }, toolCtx)
  listed = await hooks.tool.list.execute({}, toolCtx)
  const [first] = listed.output.split("\n")
  assert.match(first, /^coder#1 {2}\[busy]/, "the running rows stay exactly as they were")
  assert.match(listed.output, /\n\nRETAINED/)
  assert.equal(countActiveSubagents(), 1, "and the retained one counts nowhere")
})

test("a reused subagent is a running row again while its follow-up runs", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  const { handle } = await retainOne(hooks, created)

  await hooks.tool.reuse.execute({ subagent: handle, prompt: "which one?" }, toolCtx)
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /^planner#1 {2}\[busy]/)
  assert.doesNotMatch(listed.output, /RETAINED/)
})

// ---- inert at the default ----------------------------------------------------

test("with retention off there is no reuse tool and list is what it has always been", async () => {
  const { ctx, created } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  assert.equal(hooks.tool.reuse, undefined, "the tool is not even offered")
  assert.doesNotMatch(hooks.tool.list.description, /RETAINED|reuse/)

  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  const sessionID = created[0]
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /^planner#1 {2}\[busy]/)
  assert.doesNotMatch(listed.output, /RETAINED/)

  await idle(hooks, sessionID)
  const after = await hooks.tool.list.execute({}, toolCtx)
  assert.equal(after.output, "No active subagents.", "nothing is retained, so nothing is shown")
})

// A retained entry left over from a session in which retention was on, read by
// a `list` that now runs with it off: the section is gated on the setting, so
// the tool surface never depends on a state the user switched off.
test("with retention off a retained entry is not rendered either", async () => {
  withSettings({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created } = makeCtx({ messages: assistantReply("R", 20000) })
  const hooks = await plugin(ctx)
  await retainOne(hooks, created)

  withSettings({ maxRetainedSubagents: 0 })
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.equal(listed.output, "No active subagents.")

  // And the tool, registered while retention was on, refuses at run time.
  const res = await hooks.tool.reuse.execute({ subagent: "planner#1", prompt: "q" }, toolCtx)
  assert.match(res.output, /switched off for this installation/)
})
