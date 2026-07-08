// Slice 6a: pure orchestrator-handoff orchestration. Exercises the 9-step
// sequence in src/handoff.js against a recording fake `deps`. The test
// imports ONLY handoff.js + node builtins, so the suite cannot hang on a
// real opencode runtime.
//
// Run: node --test --test-timeout=2000 test/handoff.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { performPrimaryHandoff } from "../src/handoff.js"

// ---- recording fake factory -------------------------------------------------

function makeDeps(overrides = {}) {
  const log = [] // ordered list of "name" or ["name", arg0, arg1, ...]

  const call = (name, ...args) => {
    log.push([name, ...args])
  }

  const inFlight = overrides.inFlight ?? [
    { handle: "researcher#1", agent: "researcher", task: "scan the repo" },
    { handle: "coder#1", agent: "coder", task: "fix the bug" },
  ]
  const steps = overrides.steps ?? ["step A", "step B"]
  const goal = overrides.goal ?? "ship the feature"
  const reparentedCount = overrides.reparentedCount ?? inFlight.length

  const deps = {
    primarySessionID: "primary-1",
    directory: "/tmp/work",
    orchestratorAgentName: "orchestrator",

    getInFlightSubagents: (parentID) => {
      call("getInFlightSubagents", parentID)
      return inFlight
    },
    getPlannedSteps: (directory) => {
      call("getPlannedSteps", directory)
      return steps
    },
    getLastUserGoal: () => {
      call("getLastUserGoal")
      return goal
    },
    // Simple fake: stable, dependency-free markdown-ish render. Keeps the
    // test isolated from any future real formatPrimarySummary implementation.
    formatPrimarySummary: (s) => {
      call("formatPrimarySummary", s)
      const lines = []
      lines.push("## Stand")
      lines.push(s.stand)
      lines.push("")
      lines.push("## Notes")
      for (const n of s.notes) lines.push(`- ${n}`)
      lines.push("")
      lines.push("## Planned")
      for (const p of s.plannedSteps) lines.push(`- ${p}`)
      return lines.join("\n")
    },
    writePrimarySummary: (directory, md) => {
      call("writePrimarySummary", directory, md)
    },
    createSession: async (opts) => {
      call("createSession", opts)
      return "orch2"
    },
    promptAsync: async (sessionID, message) => {
      call("promptAsync", sessionID, message)
    },
    reparent: async (fromID, toID) => {
      call("reparent", fromID, toID)
      return reparentedCount
    },
    deleteSession: async (sessionID) => {
      call("deleteSession", sessionID)
    },
    forgetPrimary: (sessionID) => {
      call("forgetPrimary", sessionID)
    },

    // expose log
    _log: log,
  }

  return deps
}

const order = (log) => log.map((entry) => entry[0])

// ---- tests -----------------------------------------------------------------

test("performPrimaryHandoff runs the 9 steps in the right order", async () => {
  const deps = makeDeps()
  const result = await performPrimaryHandoff(deps)

  // 1-3: gather, format, write
  // 4-5: create, prompt
  // 6-8: reparent, delete, forget
  assert.deepEqual(order(deps._log), [
    "getInFlightSubagents",
    "getPlannedSteps",
    "getLastUserGoal",
    "formatPrimarySummary",
    "writePrimarySummary",
    "createSession",
    "promptAsync",
    "reparent",
    "deleteSession",
    "forgetPrimary",
  ])

  // shape of the return value
  assert.equal(result.newSessionID, "orch2")
  assert.equal(result.reparented, 2)
  assert.equal(typeof result.summaryMarkdown, "string")
  assert.ok(result.summaryMarkdown.length > 0)
})

test("reparent is called with (primarySessionID, newID)", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)
  const reparentCall = deps._log.find((e) => e[0] === "reparent")
  assert.deepEqual(reparentCall, ["reparent", "primary-1", "orch2"])
})

test("deleteSession and forgetPrimary run AFTER reparent, both with primarySessionID", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iReparent = idx("reparent")
  const iDelete = idx("deleteSession")
  const iForget = idx("forgetPrimary")

  assert.ok(iReparent >= 0 && iDelete > iReparent, "deleteSession must come after reparent")
  assert.ok(iForget > iReparent, "forgetPrimary must come after reparent")

  assert.deepEqual(deps._log[iDelete], ["deleteSession", "primary-1"])
  assert.deepEqual(deps._log[iForget], ["forgetPrimary", "primary-1"])
})

test("createSession runs BEFORE reparent and receives the orchestrator agent name", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const iCreate = deps._log.findIndex((e) => e[0] === "createSession")
  const iReparent = deps._log.findIndex((e) => e[0] === "reparent")
  assert.ok(iCreate >= 0 && iCreate < iReparent, "createSession must precede reparent")

  const createCall = deps._log[iCreate]
  assert.deepEqual(createCall, ["createSession", { agent: "orchestrator" }])
})

test("promptAsync (kickoff) embeds the summary markdown AND a directive to read canonical docs", async () => {
  const deps = makeDeps()
  const result = await performPrimaryHandoff(deps)

  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  assert.ok(promptCall, "promptAsync must be called")
  assert.equal(promptCall[1], "orch2", "prompted on the new session id")
  const message = promptCall[2]
  assert.equal(typeof message, "string")

  // The summary text itself is in the message verbatim.
  assert.ok(
    message.includes(result.summaryMarkdown),
    "kickoff message must contain the summary markdown verbatim",
  )

  // The new orchestrator is fresh — it must be told to rebuild context from
  // the canonical docs.
  for (const doc of ["PROJECT.md", "TODO.md", "ARCHITECTURE.md"]) {
    assert.ok(
      message.includes(doc),
      `kickoff message must reference ${doc}`,
    )
  }
})

test("summaryObject fed to formatPrimarySummary has the goal line, the inFlight notes, and plannedSteps", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")
  assert.ok(fmt, "formatPrimarySummary must be called")
  const s = fmt[1]
  assert.equal(typeof s.stand, "string")
  assert.ok(s.stand.includes("Letztes Ziel: ship the feature"))
  assert.ok(Array.isArray(s.notes))
  assert.ok(s.notes.length >= 3) // header + 2 inFlight
  assert.ok(s.notes.some((n) => n.includes("researcher#1")))
  assert.ok(s.notes.some((n) => n.includes("coder#1")))
  assert.deepEqual(s.plannedSteps, ["step A", "step B"])
})

test("writePrimarySummary receives the SAME markdown the kickoff embeds", async () => {
  const deps = makeDeps()
  const result = await performPrimaryHandoff(deps)
  const writeCall = deps._log.find((e) => e[0] === "writePrimarySummary")
  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  assert.deepEqual(writeCall, ["writePrimarySummary", "/tmp/work", result.summaryMarkdown])
  assert.ok(promptCall[2].includes(writeCall[2]))
})

test("EDGE CASE: empty inFlight + empty goal still produces a valid run", async () => {
  const deps = makeDeps({ inFlight: [], goal: "", steps: [] })
  const result = await performPrimaryHandoff(deps)

  // Same call order, same number of steps — robustness.
  assert.deepEqual(order(deps._log), [
    "getInFlightSubagents",
    "getPlannedSteps",
    "getLastUserGoal",
    "formatPrimarySummary",
    "writePrimarySummary",
    "createSession",
    "promptAsync",
    "reparent",
    "deleteSession",
    "forgetPrimary",
  ])

  assert.equal(result.newSessionID, "orch2")
  // reparented count when nothing was in-flight: 0
  assert.equal(result.reparented, 0)
  assert.equal(typeof result.summaryMarkdown, "string")

  // The summary itself still has well-formed sections.
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.equal(fmt.stand, "Letztes Ziel: ")
  assert.equal(fmt.notes.length, 1) // just the header line
  assert.ok(fmt.notes[0].includes("Diese Subagents liefern jetzt"))
  assert.deepEqual(fmt.plannedSteps, [])

  // Kickoff message still present, still references the canonical docs.
  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  for (const doc of ["PROJECT.md", "TODO.md", "ARCHITECTURE.md"]) {
    assert.ok(promptCall[2].includes(doc))
  }
})

test("EDGE CASE: goal set but inFlight empty — stand line omits the reparented count", async () => {
  const deps = makeDeps({ inFlight: [] })
  await performPrimaryHandoff(deps)
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.equal(fmt.stand, "Letztes Ziel: ship the feature")
  assert.ok(!fmt.stand.includes("re-parented"))
})
