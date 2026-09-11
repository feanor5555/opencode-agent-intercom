// The compaction driver: the ON side of the per-agent switch.
//
// opencode's automatic compaction is off in every session of this process, so
// an agent whose switch says on is compacted by the plugin itself. Four things
// are pinned here:
//
//   1. compactSession — the three model rungs, the empty session, the refused
//      request. It never throws.
//   2. The primary's idle-gated latch — claimed exactly once, released on every
//      exit, and the three-way relief order (endless > compaction > handoff)
//      expressed by the latch helpers the transform hook wires 1:1.
//   3. The subagent crossing — the switch, the cap, the open-question hold, the
//      latch and what a successful compaction leaves on the entry.
//   4. The watchdog's third window case and its precedence.
//
// Run: node --test test/compaction-driver.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  compactSession,
  maybeRunPendingCompaction,
  startSubagentCompaction,
  MAX_SUBAGENT_COMPACTIONS,
} from "../src/compaction.js"
import { resetState, pendingCompactions, compactionInProgress } from "../src/state.js"
import {
  recordPrimaryContext,
  recordSessionAgent,
  scheduleCompactionIfNeeded,
  scheduleHandoffIfNeeded,
  markCompactionPending,
  hasCompactionPending,
  claimPendingCompaction,
  releaseCompaction,
  cancelPendingCompaction,
  isCompactionInProgress,
  hasHandoffPending,
  cancelPendingHandoff,
  forgetPrimary,
  upsertSession,
} from "../src/registry.js"
import { watchdogLimit, _stopWatchdogForTests } from "../src/watchdog.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { setModelsPath } from "../src/llmmodel.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-compaction-driver-"))
const settingsFile = join(fixtureDir, "agent-intercom.json")
const modelsFile = join(fixtureDir, "llm-models.json")
setSettingsPath(settingsFile)
setModelsPath(modelsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

function writeSettings(obj) {
  writeFileSync(settingsFile, JSON.stringify(obj))
  resetSettings()
}

function writeModels(obj) {
  writeFileSync(modelsFile, JSON.stringify(obj))
}

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  rmSync(settingsFile, { force: true })
  rmSync(modelsFile, { force: true })
  resetSettings()
})

// A client whose session namespace records what it was asked to do. `messages`
// is what session.messages answers; `summarize` is the route's answer.
function makeClient({ messages = [], summarize = true } = {}) {
  const calls = { summarize: [], messages: 0 }
  return {
    calls,
    session: {
      messages: async () => {
        calls.messages += 1
        return messages
      },
      summarize: async (options) => {
        calls.summarize.push(options)
        if (summarize instanceof Error) throw summarize
        return summarize
      },
    },
    tui: { showToast: async () => true },
  }
}

const assistant = (fields = {}) => ({
  info: {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-opus-4",
    tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...fields,
  },
  parts: [{ type: "text", text: "work" }],
})

// ---------------------------------------------------------------------------
// 1. compactSession
// ---------------------------------------------------------------------------

test("compactSession: takes the model the caller already read, and makes no session read", async () => {
  const client = makeClient()
  const outcome = await compactSession(client, {
    sessionID: "ses_a",
    agent: "coder",
    model: { providerID: "openai", modelID: "gpt-5" },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, "compacted")
  assert.equal(client.calls.messages, 0, "rung 1 hit: the session was not read")
  assert.deepEqual(client.calls.summarize[0].path, { id: "ses_a" })
  assert.deepEqual(client.calls.summarize[0].body, { providerID: "openai", modelID: "gpt-5" })
})

test("compactSession: falls back to the session's newest assistant message", async () => {
  const client = makeClient({ messages: [assistant()] })
  const outcome = await compactSession(client, { sessionID: "ses_b", agent: "coder" })
  assert.equal(outcome.ok, true)
  assert.deepEqual(client.calls.summarize[0].body, {
    providerID: "anthropic",
    modelID: "claude-opus-4",
  })
})

test("compactSession: falls back to the agent's pin when the session names no model", async () => {
  writeModels({ coder: { providerID: "pinned", modelID: "pin-1" } })
  const client = makeClient({
    messages: [{ info: { role: "user" }, parts: [] }],
  })
  const outcome = await compactSession(client, { sessionID: "ses_c", agent: "coder" })
  assert.equal(outcome.ok, true)
  assert.deepEqual(client.calls.summarize[0].body, { providerID: "pinned", modelID: "pin-1" })
})

test("compactSession: a session with no messages is not compacted", async () => {
  const client = makeClient({ messages: [] })
  const outcome = await compactSession(client, { sessionID: "ses_d", agent: "coder" })
  assert.deepEqual(outcome, { ok: false, reason: "no-messages" })
  assert.equal(client.calls.summarize.length, 0)
})

test("compactSession: no model anywhere means no request", async () => {
  const client = makeClient({ messages: [{ info: { role: "user" }, parts: [] }] })
  const outcome = await compactSession(client, { sessionID: "ses_e", agent: "coder" })
  assert.deepEqual(outcome, { ok: false, reason: "no-model" })
  assert.equal(client.calls.summarize.length, 0)
})

test("compactSession: a half-filled pair is not a model", async () => {
  const client = makeClient({ messages: [{ info: { role: "user" }, parts: [] }] })
  const outcome = await compactSession(client, {
    sessionID: "ses_f",
    agent: "coder",
    model: { providerID: "openai", modelID: "" },
  })
  assert.equal(outcome.reason, "no-model")
})

test("compactSession: a refused request is reported, never thrown", async () => {
  const client = makeClient({ summarize: new Error("boom") })
  const outcome = await compactSession(client, {
    sessionID: "ses_g",
    agent: "coder",
    model: { providerID: "openai", modelID: "gpt-5" },
  })
  assert.deepEqual(outcome.ok, false)
  assert.equal(outcome.reason, "refused")
})

test("compactSession: an id-less call does nothing", async () => {
  const client = makeClient()
  assert.deepEqual(await compactSession(client, {}), { ok: false, reason: "no-session" })
  assert.equal(client.calls.summarize.length, 0)
})

// ---------------------------------------------------------------------------
// 2. The primary: the latch and the three-way order
// ---------------------------------------------------------------------------

const SID = "ses_primary"
const MAX = 80_000

test("primary: over the threshold schedules and starts nothing", () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), true)
  assert.equal(hasCompactionPending(SID), true)
  assert.equal(isCompactionInProgress(SID), false)
})

test("primary: below the threshold schedules nothing", () => {
  recordPrimaryContext(SID, MAX - 1)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), false)
  assert.equal(hasCompactionPending(SID), false)
})

test("primary: a second over-threshold turn does not re-schedule (one toast)", () => {
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), true)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), false)
  assert.equal(pendingCompactions.size, 1)
})

test("primary: the latch is claimed exactly once", () => {
  markCompactionPending(SID)
  assert.equal(claimPendingCompaction(SID), true)
  assert.equal(claimPendingCompaction(SID), false, "a duplicate idle claims nothing")
  assert.equal(isCompactionInProgress(SID), true)
  assert.equal(hasCompactionPending(SID), false)
})

test("primary: nothing can be scheduled while a compaction executes", () => {
  markCompactionPending(SID)
  claimPendingCompaction(SID)
  recordPrimaryContext(SID, MAX + 1)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), false)
  assert.equal(cancelPendingCompaction(SID), false, "an executing compaction is not cancelled")
  releaseCompaction(SID)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), true, "released: a fresh crossing arms again")
})

test("primary: the relief branches cancel each other's unclaimed latches", () => {
  recordPrimaryContext(SID, MAX + 1)
  // The switch was on at the last crossing and off at this one.
  scheduleCompactionIfNeeded(SID, MAX)
  assert.equal(cancelPendingCompaction(SID), true)
  assert.equal(scheduleHandoffIfNeeded(SID, MAX), true)
  assert.equal(hasCompactionPending(SID), false)
  assert.equal(hasHandoffPending(SID), true)
  // And back: the switch goes on again.
  assert.equal(cancelPendingHandoff(SID), true)
  assert.equal(scheduleCompactionIfNeeded(SID, MAX), true)
  assert.equal(hasHandoffPending(SID), false)
  assert.equal(hasCompactionPending(SID), true)
})

test("primary: forgetPrimary drops both compaction latches", () => {
  markCompactionPending(SID)
  claimPendingCompaction(SID)
  markCompactionPending("other")
  forgetPrimary(SID)
  assert.equal(compactionInProgress.has(SID), false)
  assert.equal(pendingCompactions.has(SID), false)
  assert.equal(pendingCompactions.has("other"), true, "another primary's latch is untouched")
})

test("maybeRunPendingCompaction: runs under the latch and releases it", async () => {
  const client = makeClient({ messages: [assistant()] })
  recordSessionAgent(SID, "orchestrator")
  markCompactionPending(SID)
  assert.equal(await maybeRunPendingCompaction(client, SID), true)
  assert.equal(client.calls.summarize.length, 1)
  assert.equal(isCompactionInProgress(SID), false, "released on the success path")
})

test("maybeRunPendingCompaction: without a latch it does nothing", async () => {
  const client = makeClient({ messages: [assistant()] })
  assert.equal(await maybeRunPendingCompaction(client, SID), false)
  assert.equal(client.calls.summarize.length, 0)
})

test("maybeRunPendingCompaction: a failed compaction releases the latch too", async () => {
  const client = makeClient({ messages: [assistant()], summarize: new Error("no route") })
  markCompactionPending(SID)
  assert.equal(await maybeRunPendingCompaction(client, SID), false)
  assert.equal(isCompactionInProgress(SID), false)
  // The consumed pending flag is NOT restored: a retry goes through a fresh
  // crossing rather than hot-looping on every idle.
  assert.equal(hasCompactionPending(SID), false)
})

// ---------------------------------------------------------------------------
// 3. The subagent crossing
// ---------------------------------------------------------------------------

function makeSubagent({ agent = "coder" } = {}) {
  const entry = upsertSession("ses_child", { prompt: "do it", parentID: SID })
  entry.agent = agent
  entry.ctxTokens = 100_000
  return entry
}

// Lets the detached half of startSubagentCompaction finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test("subagent: nothing starts while the switch is off", async () => {
  writeSettings({ compaction: false })
  const client = makeClient({ messages: [assistant()] })
  const entry = makeSubagent()
  assert.equal(startSubagentCompaction(client, entry, {}), false)
  await settle()
  assert.equal(client.calls.summarize.length, 0)
  assert.equal(entry.compactingSince, undefined)
  assert.equal(entry.compactions, 0)
})

test("subagent: the per-type entry beats the flat value", async () => {
  writeSettings({ compaction: false, agentCompaction: { coder: true } })
  const client = makeClient()
  const entry = makeSubagent({ agent: "coder" })
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    true,
  )
  assert.equal(entry.compactingSince > 0, true, "the latch is taken synchronously")
  await settle()
  assert.equal(client.calls.summarize.length, 1)
  assert.deepEqual(client.calls.summarize[0].body, { providerID: "p", modelID: "m" })
})

test("subagent: a successful compaction clears the figure and the escalation", async () => {
  writeSettings({ compaction: true })
  const client = makeClient()
  const entry = makeSubagent()
  entry.stopInjections = 2
  entry.budgetDenials = 7
  entry.notifiedParentOfLoop = true
  startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } })
  await settle()
  assert.equal(entry.compactingSince, undefined, "the latch is cleared")
  assert.equal(entry.ctxTokens, undefined, "the fill the compaction removed is not a figure")
  assert.equal(entry.stopInjections, 0)
  assert.equal(entry.budgetDenials, 0)
  assert.equal(entry.notifiedParentOfLoop, false)
  assert.equal(entry.compactions, 1)
})

test("subagent: a failed compaction keeps the figure and clears the latch", async () => {
  writeSettings({ compaction: true })
  const client = makeClient({ summarize: new Error("no route") })
  const entry = makeSubagent()
  startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } })
  await settle()
  assert.equal(entry.compactingSince, undefined)
  assert.equal(entry.ctxTokens, 100_000, "nothing was freed, so nothing is claimed")
  assert.equal(entry.compactions, 1, "the attempt counts against the cap")
})

test("subagent: a second crossing while one runs starts nothing further", async () => {
  writeSettings({ compaction: true })
  const client = makeClient()
  const entry = makeSubagent()
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    true,
  )
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    true,
    "in flight still reads as 'a compaction is running'",
  )
  await settle()
  assert.equal(client.calls.summarize.length, 1)
  assert.equal(entry.compactions, 1)
})

test("subagent: the cap hands the crossing back to the lockdown", async () => {
  writeSettings({ compaction: true })
  const client = makeClient()
  const entry = makeSubagent()
  for (let i = 0; i < MAX_SUBAGENT_COMPACTIONS; i++) {
    assert.equal(
      startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
      true,
      `compaction ${i + 1} of the cap`,
    )
    await settle()
  }
  assert.equal(entry.compactions, MAX_SUBAGENT_COMPACTIONS)
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    false,
    "past the cap the lockdown owns the crossing",
  )
  assert.equal(client.calls.summarize.length, MAX_SUBAGENT_COMPACTIONS)
})

test("subagent: a subagent blocked on its own question is not compacted", async () => {
  writeSettings({ compaction: true })
  const client = makeClient()
  const entry = makeSubagent()
  entry.pendingAsk = { id: "ask_1", question: "which one?", askedAt: Date.now() }
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    false,
  )
  await settle()
  assert.equal(client.calls.summarize.length, 0, "the waiter's session is left alone")
  assert.equal(entry.compactingSince, undefined)
  assert.equal(entry.compactions, 0, "a held crossing does not spend the cap")
  // Once the question is settled the next crossing may compact.
  entry.pendingAsk = undefined
  assert.equal(
    startSubagentCompaction(client, entry, { model: { providerID: "p", modelID: "m" } }),
    true,
  )
  await settle()
})

// ---------------------------------------------------------------------------
// 4. The watchdog window
// ---------------------------------------------------------------------------

const windows = { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: 660_000 }

test("watchdog: a compacting entry is measured against the tool-call window", () => {
  const entry = { toolCalls: new Map(), compactingSince: 1_000 }
  const limit = watchdogLimit(entry, windows)
  assert.equal(limit.kind, "compaction")
  assert.equal(limit.ms, 660_000)
  assert.equal(limit.setting, "maxSubagentToolCallMs")
  assert.equal(limit.since, 1_000, "counted from the start of the compaction")
})

test("watchdog: a tool call in flight still wins over a compaction", () => {
  const entry = {
    toolCalls: new Map([["c1", { tool: "bash", startedAt: 5_000 }]]),
    compactingSince: 1_000,
  }
  const limit = watchdogLimit(entry, windows)
  assert.equal(limit.kind, "tool-call")
  assert.equal(limit.since, 5_000)
})

test("watchdog: without the latch the silence window governs again", () => {
  const entry = { toolCalls: new Map() }
  const limit = watchdogLimit(entry, windows)
  assert.equal(limit.kind, "silence")
  assert.equal(limit.ms, 90_000)
})

test("watchdog: the compaction case honours a switched-off wide window", () => {
  const entry = { toolCalls: new Map(), compactingSince: 1_000 }
  const limit = watchdogLimit(entry, { maxSubagentAgeMs: 90_000, maxSubagentToolCallMs: 0 })
  assert.equal(limit.kind, "compaction")
  assert.equal(limit.ms, 0, "0 is 'off' and the sweep skips the entry entirely")
})
