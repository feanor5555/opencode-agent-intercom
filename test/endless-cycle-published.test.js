// The published step of a running endless cycle (src/endlesscycle.js), and that
// every write of the two cycle latches carries it (src/registry.js), with the
// cycle's own step reports in between (runEndlessCycle's `onStep`,
// src/endless.js).
//
// The latches are the authority; the file exists so the sidebar can show
// `[restarting]` with the step beneath it. What is pinned here is the mirror:
// set on mark and claim, moved by the cycle through quiesce / wind-down /
// successor, and taken off on every way a cycle ends — the successor taking
// over (forgetPrimary), an abandon (releaseEndless), a dropped latch
// (cancelPendingEndless), a self-stop (release, then the pause) — and for a
// session opencode deleted.
//
// Everything runs under a temporary HOME, so the file under test is never the
// machine's own ~/.cache/opencode-agent-intercom/endless-cycles.json.
//
// Run: node --test --test-timeout=5000 test/endless-cycle-published.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "intercom-cyclefile-"))
process.env.HOME = HOME

const { resetState, deletedSessions } = await import("../src/state.js")
const {
  endlessCycleFilePath,
  readPublishedEndlessCycles,
  publishEndlessCycleStep,
  pruneDeadEndlessCycles,
  ENDLESS_CYCLE_STEPS,
} = await import("../src/endlesscycle.js")
const { readPublishedEndlessPauses } = await import("../src/endlesspause.js")
const {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  cancelPendingEndless,
  forgetPrimary,
  noteEndlessStep,
  forgetEndlessStep,
  setEndlessCooldown,
  pauseEndless,
  recordEndlessCycle,
} = await import("../src/registry.js")
const { runEndlessCycle } = await import("../src/endless.js")
const { parseTasks, splitSections } = await import("../src/todofile.js")
const { interpretWindDownReply } = await import("../src/handoff.js")

mkdirSync(join(HOME, ".cache", "opencode-agent-intercom"), { recursive: true })

const PRIMARY = "ses_cycle_primary"
const SUCCESSOR = "ses_cycle_successor"
const OTHER = "ses_cycle_other"

const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

function fileBody() {
  return JSON.parse(readFileSync(endlessCycleFilePath(), "utf8"))
}

test.beforeEach(() => {
  resetState()
  writeFileSync(endlessCycleFilePath(), "{}\n")
  writeFileSync(join(HOME, ".cache", "opencode-agent-intercom", "endless-pauses.json"), "{}\n")
})

// ---------------------------------------------------------------------------
// The latches
// ---------------------------------------------------------------------------

test("the file lives in the plugin's own cache dir", () => {
  assert.equal(
    endlessCycleFilePath(),
    join(HOME, ".cache", "opencode-agent-intercom", "endless-cycles.json"),
  )
})

test("setting the latch publishes the `turn` step under this pid", () => {
  const before = Date.now()
  assert.equal(markEndlessPending(PRIMARY), true)
  const entry = readPublishedEndlessCycles()[PRIMARY]
  assert.ok(entry, "nothing was published for the latched session")
  assert.equal(entry.step, "turn")
  assert.equal(entry.pid, process.pid)
  assert.ok(entry.at >= before)
})

test("claiming the latch moves the entry to `quiesce`", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  assert.equal(readPublishedEndlessCycles()[PRIMARY].step, "quiesce")
})

test("noteEndlessStep moves the step and carries the running count for quiesce only", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  noteEndlessStep(PRIMARY, "quiesce", { running: 2 })
  assert.equal(fileBody()[PRIMARY].running, 2)
  noteEndlessStep(PRIMARY, "wind-down", { running: 5 })
  const entry = fileBody()[PRIMARY]
  assert.equal(entry.step, "wind-down")
  assert.equal("running" in entry, false, "a count outside quiesce was published")
  noteEndlessStep(PRIMARY, "successor")
  assert.equal(fileBody()[PRIMARY].step, "successor")
})

test("an unchanged step and count costs no write, a changed count does", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  assert.equal(noteEndlessStep(PRIMARY, "quiesce", { running: 2 }), true)
  const at = fileBody()[PRIMARY].at
  assert.equal(noteEndlessStep(PRIMARY, "quiesce", { running: 2 }), false)
  assert.equal(noteEndlessStep(PRIMARY, "quiesce", { running: 1 }), true)
  assert.equal(fileBody()[PRIMARY].running, 1)
  assert.equal(fileBody()[PRIMARY].at, at, "a count change moved the step's own start")
})

test("a step reported for a session holding no latch publishes nothing", () => {
  assert.equal(noteEndlessStep(PRIMARY, "quiesce", { running: 1 }), false)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("an unknown step publishes nothing", () => {
  markEndlessPending(PRIMARY)
  assert.equal(noteEndlessStep(PRIMARY, "bogus"), false)
  assert.equal(fileBody()[PRIMARY].step, "turn")
})

test("releaseEndless takes the entry off (abandon)", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  releaseEndless(PRIMARY)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
  assert.equal(noteEndlessStep(PRIMARY, "wind-down"), false, "a late report came back after the release")
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("cancelPendingEndless takes a dropped latch off, and leaves an executing cycle standing", () => {
  markEndlessPending(PRIMARY)
  assert.equal(cancelPendingEndless(PRIMARY), true)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)

  markEndlessPending(OTHER)
  claimPendingEndless(OTHER)
  assert.equal(cancelPendingEndless(OTHER), false)
  assert.equal(readPublishedEndlessCycles()[OTHER].step, "quiesce")
})

test("forgetPrimary takes the replaced primary's entry off (successor took over)", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  noteEndlessStep(PRIMARY, "successor")
  forgetPrimary(PRIMARY)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("each session keeps its own entry", () => {
  markEndlessPending(PRIMARY)
  markEndlessPending(OTHER)
  releaseEndless(PRIMARY)
  cancelPendingEndless(PRIMARY)
  assert.deepEqual(Object.keys(fileBody()), [OTHER])
})

test("a deleted session's entry goes, and no later report brings it back", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  deletedSessions.set(PRIMARY, Date.now())
  forgetEndlessStep(PRIMARY)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
  assert.equal(noteEndlessStep(PRIMARY, "quiesce", { running: 1 }), false)
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("an entry whose writer is gone is dropped by the next write", () => {
  writeFileSync(
    endlessCycleFilePath(),
    JSON.stringify({ ses_dead: { step: "quiesce", running: 3, at: 1, pid: deadPid } }),
  )
  markEndlessPending(PRIMARY)
  assert.deepEqual(Object.keys(fileBody()), [PRIMARY])
})

test("pruneDeadEndlessCycles keeps the live writer and drops the gone one", () => {
  const out = pruneDeadEndlessCycles(
    { a: { step: "turn", at: 1, pid: 10 }, b: { step: "turn", at: 1, pid: 20 } },
    (pid) => pid === 10,
  )
  assert.deepEqual(Object.keys(out), ["a"])
})

test("a broken or foreign file reads as nothing published and is replaced on the next write", () => {
  writeFileSync(endlessCycleFilePath(), "{ not json")
  assert.deepEqual(readPublishedEndlessCycles(), {})
  writeFileSync(endlessCycleFilePath(), JSON.stringify({ x: { step: "nope", pid: process.pid } }))
  assert.deepEqual(readPublishedEndlessCycles(), {})
  writeFileSync(endlessCycleFilePath(), "{ not json")
  assert.equal(publishEndlessCycleStep(PRIMARY, "turn"), true)
  assert.equal(fileBody()[PRIMARY].step, "turn")
})

test("the steps are the four the panel knows", () => {
  assert.deepEqual([...ENDLESS_CYCLE_STEPS], ["turn", "quiesce", "wind-down", "successor"])
})

test("no temp file is left beside the published one", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  releaseEndless(PRIMARY)
  const leftovers = readdirSync(join(HOME, ".cache", "opencode-agent-intercom")).filter((f) =>
    f.endsWith(".tmp"),
  )
  assert.deepEqual(leftovers, [])
})

// ---------------------------------------------------------------------------
// The cycle's own step reports
// ---------------------------------------------------------------------------

const HEAD = "# Project notes\n"
function fenced(taskLines, nextId) {
  return (
    HEAD +
    "\n## Intercom tasks\n<!-- intercom:begin -->\n" +
    taskLines.join("\n") +
    `\n<!-- intercom: next-id ${nextId} -->\n<!-- intercom:end -->\n`
  )
}
const SNAP = fenced(["- T1: do the thing"], "T2")
const FRESH = fenced(["- T1: do the thing", "- T2: another open item"], "T3")

// Every dependency records the step standing in the file at the moment the
// cycle calls it, so the sequence the panel would have seen is asserted.
function cycleIo(overrides = {}) {
  const seen = []
  const at = (label) => seen.push(`${label}:${readPublishedEndlessCycles()[PRIMARY]?.step ?? "-"}`)
  let polls = 0
  markEndlessPending(PRIMARY)
  const io = {
    _seen: seen,
    primarySessionID: PRIMARY,
    claim: () => claimPendingEndless(PRIMARY),
    release: () => releaseEndless(PRIMARY),
    setCooldown: () => setEndlessCooldown(PRIMARY),
    countActive: () => Math.max(0, 2 - polls),
    claimWindDown: async () => {
      const entry = readPublishedEndlessCycles()[PRIMARY]
      seen.push(`claimWindDown:${entry?.step}:${entry?.running}`)
      polls += 1
      return polls > 2
    },
    prepare: () => {
      at("prepare")
      return { fileName: "TODO.md", content: SNAP, hash: "h", tasks: parseTasks(SNAP), driftCount: 0 }
    },
    armWindDown: () => ({ token: "t" }),
    windDownTurn: async () => {
      at("windDownTurn")
      return "## WIND-DOWN DONE — 2 open"
    },
    windDownPermit: () => ({
      consumed: true,
      childSessionID: "ses-child",
      settlement: Promise.resolve({ status: "completed" }),
    }),
    startWindDownSubagent: async () => ({ childSessionID: "ses-child", settlement: Promise.resolve({}) }),
    settleWindDown: async (child) => {
      at("settle")
      return { ok: true, outcome: await child.settlement }
    },
    reread: () => ({ name: "TODO.md", content: FRESH }),
    interpretReply: interpretWindDownReply,
    parseTasks,
    splitSections,
    performHandoff: async () => {
      at("performHandoff")
      forgetPrimary(PRIMARY)
      return { newSessionID: SUCCESSOR }
    },
    maxCycles: 10,
    pause: (id, reason) => pauseEndless(id, reason),
    recordCycle: recordEndlessCycle,
    onStep: (step, detail) => noteEndlessStep(PRIMARY, step, detail),
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  }
  return io
}

test("a completed cycle walks the file through every step and leaves nothing behind", async () => {
  const io = cycleIo()
  assert.equal(readPublishedEndlessCycles()[PRIMARY].step, "turn")
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.deepEqual(io._seen, [
    "claimWindDown:quiesce:2",
    "claimWindDown:quiesce:1",
    "claimWindDown:quiesce:0",
    "prepare:wind-down",
    "windDownTurn:wind-down",
    "settle:wind-down",
    "performHandoff:successor",
  ])
  assert.deepEqual(readPublishedEndlessCycles(), {}, "the successor took over and the entry stayed")
})

test("an abandoned cycle takes the entry off", async () => {
  let clock = 0
  const io = cycleIo({
    claimWindDown: async () => false,
    countActive: () => 0,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    quiesceTimeoutMs: 1000,
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "quiesce")
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("a failed handoff abandons from the successor step and takes the entry off", async () => {
  const io = cycleIo({
    performHandoff: async () => {
      throw new Error("no session")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "handoff")
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
})

test("a self-stop swaps the entry for the pause", async () => {
  const io = cycleIo({ cycleNumber: 11, maxCycles: 10 })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "ceiling")
  assert.equal(readPublishedEndlessCycles()[PRIMARY], undefined)
  assert.ok(readPublishedEndlessPauses()[PRIMARY], "the pause was not published")
})

test("a reporter that throws does not touch the cycle", async () => {
  const io = cycleIo({
    onStep: () => {
      throw new Error("disk gone")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
})

test("no step is reported where no reporter is wired", async () => {
  const io = cycleIo()
  delete io.onStep
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.ok(io._seen.every((s) => !s.includes("wind-down") && !s.includes("successor")))
})
