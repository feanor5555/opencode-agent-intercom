// Pure orchestrator-handoff orchestration. Exercises the drain-guarded
// sequence in src/handoff.js against a recording fake `deps`. The test
// imports ONLY handoff.js + node builtins, so the suite cannot hang on a
// real opencode runtime.
//
// Sequence under test (src/handoff.js module header):
//   beginDrain → gather (steps/goal) → createSession → bindDrainTarget →
//   doc summaries → reparent → getInFlightSubagents(newID) → format/write →
//   promptAsync (kickoff) → flushDrain → archiveSession(old) → forgetPrimary.
//
// Run: node --test --test-timeout=2000 test/handoff.test.js

import test from "node:test"
import assert from "node:assert/strict"

import { performPrimaryHandoff } from "../src/handoff.js"

// ---- recording fake factory -------------------------------------------------

function makeDeps(overrides = {}) {
  const log = [] // ordered list of ["name", arg0, arg1, ...]

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

    beginDrain: () => {
      call("beginDrain")
    },
    bindDrainTarget: (newID) => {
      call("bindDrainTarget", newID)
    },
    flushDrain: async () => {
      call("flushDrain")
      return 0
    },
    abortDrain: async () => {
      call("abortDrain")
      return 0
    },
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
    // Default fake returns a canned four-section block (three doc summaries
    // + the Session-Verlauf history block) so the happy-path tests see
    // everything embedded in the kickoff. Specific tests override via
    // `overrides.docSummaries`.
    promptOldPrimaryForDocSummaries: async () => {
      call("promptOldPrimaryForDocSummaries")
      return overrides.docSummaries ?? [
        "## PROJECT.md — project index (default fake)",
        "",
        "## TODO.md — open task list (default fake)",
        "",
        "## ARCHITECTURE.md — architecture facts (default fake)",
        "",
        "## Session-Verlauf — session history (default fake)",
      ].join("\n")
    },
    reparent: async (fromID, toID) => {
      call("reparent", fromID, toID)
      return reparentedCount
    },
    deleteSession: async (sessionID) => {
      call("deleteSession", sessionID)
    },
    archiveSession: async (sessionID) => {
      call("archiveSession", sessionID)
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

const HAPPY_PATH_ORDER = [
  "beginDrain",
  "getPlannedSteps",
  "getLastUserGoal",
  "createSession",
  "bindDrainTarget",
  "promptOldPrimaryForDocSummaries",
  "reparent",
  "getInFlightSubagents",
  "formatPrimarySummary",
  "writePrimarySummary",
  "promptAsync",
  "flushDrain",
  "archiveSession",
  "forgetPrimary",
]

// ---- tests -----------------------------------------------------------------

test("performPrimaryHandoff runs the drain-guarded sequence in the right order", async () => {
  const deps = makeDeps()
  const result = await performPrimaryHandoff(deps)

  assert.deepEqual(order(deps._log), HAPPY_PATH_ORDER)

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

test("archiveSession and forgetPrimary run AFTER reparent, both with primarySessionID", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iReparent = idx("reparent")
  const iArchive = idx("archiveSession")
  const iForget = idx("forgetPrimary")

  assert.ok(iReparent >= 0 && iArchive > iReparent, "archiveSession must come after reparent")
  assert.ok(iForget > iReparent, "forgetPrimary must come after reparent")

  // The old primary is ARCHIVED, never deleted — a delete would cascade over
  // still-live reparented children (FK-constraint failure → skipped auto-tick).
  assert.ok(
    !deps._log.some((e) => e[0] === "deleteSession"),
    "old primary is archived, not deleted, on the happy path",
  )
  assert.deepEqual(deps._log[iArchive], ["archiveSession", "primary-1"])
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

test("(a) reparent completes BEFORE the kickoff is composed and sent; the in-flight list is read post-reparent with the NEW id", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iReparent = idx("reparent")
  const iInFlight = idx("getInFlightSubagents")
  const iFormat = idx("formatPrimarySummary")
  const iPrompt = idx("promptAsync")

  assert.ok(iReparent >= 0, "reparent ran")
  assert.ok(
    iReparent < iInFlight && iInFlight < iFormat && iFormat < iPrompt,
    `expected reparent < getInFlightSubagents < format < promptAsync, got ` +
      `${iReparent} < ${iInFlight} < ${iFormat} < ${iPrompt}`,
  )

  // The in-flight list is keyed by the NEW session id — post-reparent truth,
  // not the handoff-start snapshot.
  assert.deepEqual(deps._log[iInFlight], ["getInFlightSubagents", "orch2"])
})

test("(a) kickoff announces the POST-reparent in-flight state: a subagent that finished mid-handoff is not listed", async () => {
  // Live-verified nuance 1: the kickoff used to render the handoff-START
  // snapshot, announcing a subagent as re-parented whose result had already
  // been delivered elsewhere. Now the list is read AFTER reparent — a
  // subagent that finished during the doc-summary wait (simulated by
  // mutating the array the getInFlightSubagents fake returns) must be gone
  // from the announcement.
  const inFlightArr = [
    { handle: "explore#1", agent: "explore", task: "accept criteria" },
    { handle: "coder#1", agent: "coder", task: "fix the bug" },
  ]
  const deps = makeDeps({ inFlight: inFlightArr })
  deps.promptOldPrimaryForDocSummaries = async () => {
    deps._log.push(["promptOldPrimaryForDocSummaries"])
    // explore#1 finishes while the old primary produces its summaries — the
    // wake path removes it from the registry (its notice goes to the drain).
    inFlightArr.shift()
    return "## PROJECT.md — p\n\n## TODO.md — t\n\n## ARCHITECTURE.md — a"
  }

  await performPrimaryHandoff(deps)

  const message = deps._log.find((e) => e[0] === "promptAsync")[2]
  assert.ok(!message.includes("explore#1"), "finished subagent must NOT be announced as re-parented")
  assert.ok(message.includes("coder#1"), "still-running subagent stays announced")
  assert.ok(
    message.includes("(1 Subagent(s) wurden re-parented)"),
    "stand line counts the post-reparent list, not the start snapshot",
  )
})

test("flushDrain runs AFTER the kickoff promptAsync and BEFORE the old session is archived", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iPrompt = idx("promptAsync")
  const iFlush = idx("flushDrain")
  const iArchive = idx("archiveSession")

  assert.ok(iPrompt >= 0 && iFlush > iPrompt, "flushDrain must come after the kickoff")
  assert.ok(iArchive > iFlush, "old session is archived only after the buffer was flushed")
  assert.ok(!order(deps._log).includes("abortDrain"), "success path never aborts the drain")
})

test("bindDrainTarget is called with the new session id, right after createSession", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iCreate = idx("createSession")
  const iBind = idx("bindDrainTarget")
  const iDoc = idx("promptOldPrimaryForDocSummaries")
  assert.ok(iCreate < iBind && iBind < iDoc, "bind sits between createSession and the doc-summary wait")
  assert.deepEqual(deps._log[iBind], ["bindDrainTarget", "orch2"])
})

test("promptAsync (kickoff) embeds the summary markdown AND the three per-file doc summaries", async () => {
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

  // The new orchestrator is fresh — it gets the per-file summaries from
  // #1's final turn instead of a re-read directive. The three headings
  // must be present, AND the old "Lies jetzt PROJECT.md …" re-read string
  // must NOT be present (that path is gone).
  for (const heading of [
    "## PROJECT.md —",
    "## TODO.md —",
    "## ARCHITECTURE.md —",
  ]) {
    assert.ok(
      message.includes(heading),
      `kickoff message must contain heading ${heading}`,
    )
  }
  assert.ok(
    !message.includes("Lies jetzt PROJECT.md, TODO.md und ARCHITECTURE.md"),
    "kickoff message must NOT contain the old re-read directive",
  )
})

test("promptOldPrimaryForDocSummaries is called once, between createSession and promptAsync", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const idx = (name) => deps._log.findIndex((e) => e[0] === name)
  const iCreate = idx("createSession")
  const iDoc = idx("promptOldPrimaryForDocSummaries")
  const iPrompt = idx("promptAsync")

  assert.ok(iCreate >= 0, "createSession ran")
  assert.ok(iDoc >= 0, "promptOldPrimaryForDocSummaries ran")
  assert.ok(iPrompt >= 0, "promptAsync ran")

  // Sequence: createSession -> promptOldPrimaryForDocSummaries -> promptAsync.
  // Order is the point — #1's final turn must complete (and the summaries
  // be validated) BEFORE the new orchestrator is prompted with them.
  assert.ok(
    iCreate < iDoc && iDoc < iPrompt,
    `expected createSession < promptOldPrimaryForDocSummaries < promptAsync, got ` +
      `${iCreate} < ${iDoc} < ${iPrompt}`,
  )
})

test("kickoff message embeds the raw text returned by promptOldPrimaryForDocSummaries", async () => {
  // Custom three-section text from the fake — proves the wire-through
  // (not a coincidence with the default fake's text).
  const docSummaries = [
    "## PROJECT.md — the project is about an OpenCode plugin intercom.",
    "",
    "## TODO.md — currently building doc-summaries for the handoff.",
    "",
    "## ARCHITECTURE.md — handoff is a fresh orchestrator with no prior state.",
  ].join("\n")
  const deps = makeDeps({ docSummaries })

  await performPrimaryHandoff(deps)

  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  const message = promptCall[2]

  // Every non-empty line of the canned summaries must be embedded verbatim.
  for (const line of docSummaries.split("\n")) {
    if (line.trim().length === 0) continue
    assert.ok(
      message.includes(line),
      `kickoff must embed line from docSummaries: ${line.slice(0, 60)}…`,
    )
  }
})

test("EDGE CASE: promptOldPrimaryForDocSummaries throws -> kickoff falls back to placeholder block", async () => {
  // Provider down, session already torn down, LLM timeout — any of those
  // surfaces as a thrown error from the dep. The handoff must catch it
  // and use a well-formed three-section placeholder so the kickoff is
  // always sendable.
  const deps = makeDeps()
  deps.promptOldPrimaryForDocSummaries = async () => {
    deps._log.push(["promptOldPrimaryForDocSummaries"])
    throw new Error("provider 503")
  }
  const result = await performPrimaryHandoff(deps)

  // The handoff still completes end-to-end — reparent / flush / archive /
  // forget still ran (the error in the dep must not abort the sequence).
  const names = order(deps._log)
  assert.ok(names.includes("reparent"))
  assert.ok(names.includes("flushDrain"))
  assert.ok(names.includes("archiveSession"))
  assert.ok(names.includes("forgetPrimary"))
  assert.ok(!names.includes("abortDrain"), "doc-summary fallback is not a handoff failure")
  assert.equal(result.newSessionID, "orch2")

  // The kickoff message uses the fallback block, not the default fake's text.
  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  const message = promptCall[2]
  for (const heading of [
    "## PROJECT.md — (nicht verfügbar)",
    "## TODO.md — (nicht verfügbar)",
    "## ARCHITECTURE.md — (nicht verfügbar)",
  ]) {
    assert.ok(
      message.includes(heading),
      `fallback kickoff must contain placeholder ${heading}`,
    )
  }

  // The history block rides on the same reply that just failed — there is
  // no fallback text for it, the kickoff simply omits it.
  assert.ok(
    !message.includes("## Session-Verlauf"),
    "failed doc-summaries turn must not leave a Session-Verlauf block behind",
  )
})

test("kickoff embeds the Session-Verlauf history block from the old primary's reply", async () => {
  const deps = makeDeps()
  await performPrimaryHandoff(deps)

  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  const message = promptCall[2]
  assert.ok(
    message.includes("## Session-Verlauf — session history (default fake)"),
    "kickoff must contain the Session-Verlauf block with its heading",
  )
  // The block sits between the summary markdown and the doc summaries —
  // its heading must appear before the PROJECT.md heading.
  const iHist = message.indexOf("## Session-Verlauf")
  const iProject = message.indexOf("## PROJECT.md")
  assert.ok(
    iHist >= 0 && iProject > iHist,
    "Session-Verlauf block precedes the doc summaries in the kickoff",
  )
})

test("EDGE CASE: reply WITHOUT a Session-Verlauf section -> handoff completes, block omitted, docs kept", async () => {
  // A model that ignores the fourth section must not break anything: the
  // three doc summaries are still embedded and the history block is
  // simply absent (no fallback text, no empty heading).
  const docSummaries = [
    "## PROJECT.md — project index (no history)",
    "",
    "## TODO.md — open task list (no history)",
    "",
    "## ARCHITECTURE.md — architecture facts (no history)",
  ].join("\n")
  const deps = makeDeps({ docSummaries })

  const result = await performPrimaryHandoff(deps)
  assert.equal(result.newSessionID, "orch2")

  const names = deps._log.map((e) => e[0])
  assert.ok(names.includes("reparent"))
  assert.ok(names.includes("archiveSession"))
  assert.ok(names.includes("forgetPrimary"))

  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  const message = promptCall[2]
  assert.ok(message.includes("## PROJECT.md — project index (no history)"))
  assert.ok(
    !message.includes("## Session-Verlauf"),
    "kickoff must omit the Session-Verlauf block when the reply lacks it",
  )
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
  assert.deepEqual(order(deps._log), HAPPY_PATH_ORDER)

  assert.equal(result.newSessionID, "orch2")
  // reparented count when nothing was in-flight: 0
  assert.equal(result.reparented, 0)
  assert.equal(typeof result.summaryMarkdown, "string")

  // The summary itself still has well-formed sections. An empty goal (no
  // real user message in the old session — e.g. only plugin notices) renders
  // an EXPLICIT placeholder, not a bare "Letztes Ziel: " that invites a
  // small model to invent a goal.
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.equal(
    fmt.stand,
    "Letztes Ziel: (kein echtes Nutzer-Ziel in der Session-History gefunden — siehe Geplante Schritte / TODO.md)",
  )
  assert.equal(fmt.notes.length, 1) // just the header line
  assert.ok(fmt.notes[0].includes("Diese Subagents liefern jetzt"))
  assert.deepEqual(fmt.plannedSteps, [])

  // Kickoff message still present, still embeds the three per-file
  // doc summaries from the default fake.
  const promptCall = deps._log.find((e) => e[0] === "promptAsync")
  for (const heading of [
    "## PROJECT.md —",
    "## TODO.md —",
    "## ARCHITECTURE.md —",
  ]) {
    assert.ok(
      promptCall[2].includes(heading),
      `kickoff must contain heading ${heading}`,
    )
  }
})

test("REGRESSION: getInFlightSubagents returning a Promise (real registryMutex.runExclusive) — handoff completes", async () => {
  // Root cause: in production, deps.getInFlightSubagents IS the real
  // `inFlightSubagentsFor` from src/registry.js, which returns a Promise
  // (registryMutex.runExclusive). handoff.js must `await` it — a missing
  // `await` makes `inFlight.map` throw and aborts the renewal on every turn.
  const inFlightArr = [
    { handle: "researcher#1", agent: "researcher", task: "scan the repo" },
  ]
  const deps = makeDeps({ inFlight: inFlightArr })
  deps.getInFlightSubagents = async (parentID) => {
    deps._log.push(["getInFlightSubagents", parentID])
    // Real helper resolves via registryMutex.runExclusive — small async gap.
    await Promise.resolve()
    return inFlightArr
  }

  // Must not throw. Without the fix this resolves to a rejected promise
  // (`TypeError: inFlight.map is not a function` inside performPrimaryHandoff).
  const result = await performPrimaryHandoff(deps)

  // The full sequence ran end-to-end — createSession + promptAsync reached.
  assert.deepEqual(order(deps._log), HAPPY_PATH_ORDER)

  // Return value is well-formed.
  assert.equal(result.newSessionID, "orch2")
  assert.equal(result.reparented, 1)
  assert.equal(typeof result.summaryMarkdown, "string")

  // The summary actually consumed the resolved (not Promise) array —
  // proves `await` resolved, not just that we survived.
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.ok(fmt.stand.includes("(1 Subagent(s) wurden re-parented)"),
    "stand line must reference the resolved array length, not Promise")
  assert.ok(fmt.notes.some((n) => n.includes("researcher#1")),
    "notes must include the entry from the resolved array")

  // createSession + promptAsync must both be present (the ones the bug
  // prevented from running).
  const iCreate = deps._log.findIndex((e) => e[0] === "createSession")
  const iPrompt = deps._log.findIndex((e) => e[0] === "promptAsync")
  assert.ok(iCreate >= 0, "createSession must run after the await fix")
  assert.ok(iPrompt > iCreate, "promptAsync must run after createSession")
})

test("EDGE CASE: goal set but inFlight empty — stand line omits the reparented count", async () => {
  const deps = makeDeps({ inFlight: [] })
  await performPrimaryHandoff(deps)
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.equal(fmt.stand, "Letztes Ziel: ship the feature")
  assert.ok(!fmt.stand.includes("re-parented"))
})

test("getLastUserGoal returning a Promise (real session.messages fetch) — goal lands in the stand line", async () => {
  // In production getLastUserGoal is async: the transform-hook input has no
  // `messages` field, so hooks.js fetches the old primary's history via the
  // session API. handoff.js must await the dep — a Promise leaking into the
  // stand line would render "Letztes Ziel: [object Promise]".
  const deps = makeDeps()
  deps.getLastUserGoal = async () => {
    deps._log.push(["getLastUserGoal"])
    await Promise.resolve()
    return "goal fetched from session messages"
  }
  await performPrimaryHandoff(deps)
  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.ok(
    fmt.stand.includes("Letztes Ziel: goal fetched from session messages"),
    `stand line must carry the awaited goal, got: ${fmt.stand}`,
  )
  assert.ok(!fmt.stand.includes("[object Promise]"))
})

test("EDGE CASE: getLastUserGoal throws — handoff still completes end-to-end with an empty goal", async () => {
  // The goal lookup is best-effort (a failed session.messages fetch, a torn
  // down session). It must NEVER fail the handoff — reparent / delete /
  // forget still run and the stand line degrades to an empty goal.
  const deps = makeDeps()
  deps.getLastUserGoal = async () => {
    deps._log.push(["getLastUserGoal"])
    throw new Error("session.messages 404")
  }
  const result = await performPrimaryHandoff(deps)
  assert.equal(result.newSessionID, "orch2")

  const names = deps._log.map((e) => e[0])
  for (const step of ["createSession", "promptAsync", "reparent", "flushDrain", "archiveSession", "forgetPrimary"]) {
    assert.ok(names.includes(step), `${step} must still run after a failed goal lookup`)
  }

  const fmt = deps._log.find((e) => e[0] === "formatPrimarySummary")[1]
  assert.ok(
    fmt.stand.startsWith("Letztes Ziel: "),
    "stand line stays well-formed with an empty goal",
  )
})

// ---- failure path: revert + drain abort -------------------------------------

test("(e) kickoff promptAsync throws — reparent reverted, orphan new session deleted, drain aborted, old primary untouched", async () => {
  const deps = makeDeps()
  deps.promptAsync = async (sessionID, message) => {
    deps._log.push(["promptAsync", sessionID, message])
    throw new Error("kickoff transport down")
  }

  await assert.rejects(() => performPrimaryHandoff(deps), /kickoff transport down/)

  const names = order(deps._log)
  // Revert discipline: un-reparent (new → old), delete the ORPHANED new
  // session (never the old one), abort the drain. No flush, no forget.
  const reparentCalls = deps._log.filter((e) => e[0] === "reparent")
  assert.equal(reparentCalls.length, 2, "reparent ran forward and reverted")
  assert.deepEqual(reparentCalls[0], ["reparent", "primary-1", "orch2"])
  assert.deepEqual(reparentCalls[1], ["reparent", "orch2", "primary-1"])

  const deleteCalls = deps._log.filter((e) => e[0] === "deleteSession")
  assert.deepEqual(deleteCalls, [["deleteSession", "orch2"]],
    "only the orphaned NEW session is deleted; the old primary survives a failed handoff")

  assert.ok(names.includes("abortDrain"), "failure path aborts the drain (buffer handed back)")
  assert.ok(!names.includes("flushDrain"), "no flush on failure")
  assert.ok(!names.includes("forgetPrimary"), "old primary stays tracked for the retry")

  // Order: revert-reparent before abortDrain, both after the failed prompt.
  const iPrompt = deps._log.findIndex((e) => e[0] === "promptAsync")
  const iRevert = deps._log.findIndex(
    (e, i) => e[0] === "reparent" && i > iPrompt,
  )
  const iAbort = names.indexOf("abortDrain")
  assert.ok(iRevert > iPrompt && iAbort > iRevert)
})

test("(e) createSession throws — drain aborted, nothing reparented, nothing deleted", async () => {
  const deps = makeDeps()
  deps.createSession = async () => {
    deps._log.push(["createSession"])
    throw new Error("session API 500")
  }

  await assert.rejects(() => performPrimaryHandoff(deps), /session API 500/)

  const names = order(deps._log)
  assert.ok(names.includes("beginDrain"))
  assert.ok(names.includes("abortDrain"), "drain aborted so the buffer cannot leak")
  assert.ok(!names.includes("bindDrainTarget"), "no new session to bind")
  assert.ok(!names.includes("reparent"))
  assert.ok(!names.includes("deleteSession"))
  assert.ok(!names.includes("promptAsync"))
  assert.ok(!names.includes("forgetPrimary"))
})

test("post-kickoff failures do NOT revert: a failing old-session archive still finishes the handoff", async () => {
  // Once the kickoff is delivered the new session is live — reverting past
  // that point (deleting #2) would be strictly worse than a zombie old
  // session. archiveSession failure is logged and the sequence proceeds to
  // forgetPrimary and returns the result.
  const deps = makeDeps()
  deps.archiveSession = async (sessionID) => {
    deps._log.push(["archiveSession", sessionID])
    throw new Error("archive hiccup")
  }

  const result = await performPrimaryHandoff(deps)
  assert.equal(result.newSessionID, "orch2")

  const names = order(deps._log)
  assert.ok(names.includes("forgetPrimary"), "forgetPrimary still runs")
  assert.ok(!names.includes("abortDrain"), "no revert after the point of no return")
  // Only ONE reparent (forward) — no revert.
  assert.equal(deps._log.filter((e) => e[0] === "reparent").length, 1)
})
