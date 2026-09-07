// The endless-mode cycle executor (src/endless.js): the quiesce wait and its
// timeout on virtual time, prepare / arm / wind-down turn / settle / confirm,
// the V1–V7 confirmation each failing in isolation with a snapshot restore and
// no handoff, the fallback that starts the wind-down subagent when the permit
// went unconsumed, the settlement gate, the explicit-empty and no-progress
// stops, and the kickoff block that carries the todo file's own text.
//
// runEndlessCycle is fully dependency-injected, so the whole cycle runs here
// with no client, no network and no timers: `sleep`/`now` are virtual and every
// live dependency is a recording fake. The parse and the confirmation are the
// REAL ones (parseTasks / splitSections / interpretWindDownReply), so the
// fixtures below are real fenced todo files and the V-checks read them exactly
// as production does.
//
// Run: node --test --test-timeout=5000 test/endless-cycle.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"

import { resetState, endlessProgress } from "../src/state.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  setEndlessCooldown,
  endlessCooldownActive,
  pauseEndless,
  isEndlessPaused,
  recordEndlessCycle,
} from "../src/registry.js"
import {
  runEndlessCycle,
  verifyWindDown,
  endlessKickoffBlock,
  cutTodoText,
  writeRejectedWindDown,
  KICKOFF_TODO_MAX_CHARS,
  ENDLESS_MAX_STALLED_CYCLES,
} from "../src/endless.js"
import { parseTasks, splitSections } from "../src/todofile.js"
import { interpretWindDownReply } from "../src/handoff.js"
import { WIND_DOWN_SUBAGENT_CONTRACT } from "../src/prompts.js"
import { cacheDir } from "../src/log.js"

const SID = "ses-endless-cycle"
const NEW_SID = "ses-endless-cycle-new"

test.beforeEach(() => resetState())

// A real fenced todo file: human prose outside the markers, task lines inside.
const OUT_HEAD = "# Project notes\n\nSome prose a human wrote.\n"
function fenced(taskLines, nextId) {
  return (
    OUT_HEAD +
    "\n## Intercom tasks\n<!-- intercom:begin -->\n" +
    taskLines.join("\n") +
    `\n<!-- intercom: next-id ${nextId} -->\n<!-- intercom:end -->\n`
  )
}

const SNAP = fenced(["- T1: do the thing"], "T2")
// V3 differs, V4 outside identical, V5 holds, and no carried title changes: T1 kept, T2 added.
const FRESH = fenced(["- T1: do the thing", "- T2: another open item"], "T3")

const LEGACY_TASK = "- T1: guard-denied-native-task\n  accept: noop"
const LEGACY_SNAPSHOT =
  `${LEGACY_TASK}\n\n## Intercom tasks\n<!-- intercom:begin -->\n<!-- intercom:end -->\n`
const MOVED_WITH_SEPARATOR =
  `\n## Intercom tasks\n<!-- intercom:begin -->\n${LEGACY_TASK}\n<!-- intercom:end -->\n`
const MOVED_WITHOUT_SEPARATOR =
  `## Intercom tasks\n<!-- intercom:begin -->\n${LEGACY_TASK}\n<!-- intercom:end -->\n`
const LEGACY_LEFT_STANDING =
  `${LEGACY_SNAPSHOT.slice(0, LEGACY_SNAPSHOT.indexOf("<!-- intercom:begin -->") + "<!-- intercom:begin -->".length)}\n${LEGACY_TASK}\n<!-- intercom:end -->\n`
const MOVED_WITHOUT_TRAILING_NEWLINE = MOVED_WITHOUT_SEPARATOR.slice(0, -1)
const MOVED_WITH_ADDED_TRAILING_NEWLINE = `${MOVED_WITHOUT_TRAILING_NEWLINE}\n`
const FRESH_WITHOUT_TRAILING_NEWLINE = FRESH.slice(0, -1)

function settled(status = "completed") {
  return Promise.resolve({ status, childSessionID: "ses-child", parentSessionID: SID })
}

// The new-API deps, coherent by default toward a "complete" outcome. Every
// field is overridable so each test can fail exactly one gate.
function baseIo(overrides = {}) {
  const log = []
  const primarySessionID = overrides.primarySessionID || SID
  markEndlessPending(primarySessionID)
  const io = {
    _log: log,
    primarySessionID,
    claim: () => claimPendingEndless(primarySessionID),
    release: () => releaseEndless(primarySessionID),
    setCooldown: () => setEndlessCooldown(primarySessionID),
    dropRetained: async () => log.push("dropRetained"),
    countActive: () => 0,
    isQuiesced: async () => {
      log.push("isQuiesced")
      return true
    },
    prepare: () => {
      log.push("prepare")
      return {
        fileName: "TODO.md",
        content: SNAP,
        hash: "sha-snap",
        tasks: parseTasks(SNAP),
        driftCount: 0,
      }
    },
    armWindDown: () => {
      log.push("arm")
      return { token: "permit-token" }
    },
    disarmWindDown: () => log.push("disarm"),
    windDownTurn: async () => {
      log.push("windDownTurn")
      return "## WIND-DOWN DONE — 2 open"
    },
    windDownPermit: () => ({ consumed: true, childSessionID: "ses-child", settlement: settled() }),
    startWindDownSubagent: async () => {
      log.push("startWindDownSubagent")
      return { childSessionID: "ses-child", settlement: settled() }
    },
    settleWindDown: async (child) => {
      log.push("settleWindDown")
      const outcome = await child.settlement
      return outcome.status === "expired"
        ? { ok: false, reason: "did not settle" }
        : { ok: true, outcome }
    },
    reread: () => ({ name: "TODO.md", content: FRESH }),
    interpretReply: interpretWindDownReply,
    restoreSnapshot: (content) => log.push(`restore:${content === SNAP}`),
    parseTasks,
    splitSections,
    performHandoff: async (args) => {
      log.push("performHandoff")
      io._handoff = args
      return { newSessionID: NEW_SID }
    },
    cycleNumber: 1,
    maxCycles: 10,
    pause: (id, reason) => pauseEndless(id, reason),
    recordCycle: recordEndlessCycle,
    toast: () => {},
    quiesceTimeoutMs: 600_000,
    pollMs: 500,
    sleep: async () => {},
    now: () => 0,
    ...overrides,
  }
  return io
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test("a confirmed wind-down replaces the primary and records the ids", async () => {
  const io = baseIo()
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.equal(res.newSessionID, NEW_SID)
  assert.deepEqual(res.openIds, ["T1", "T2"])
  assert.equal(res.openBefore, 1)
  assert.equal(res.openAfter, 2)
  assert.ok(io._log.includes("performHandoff"))
  // The permit is disarmed on every exit.
  assert.ok(io._log.includes("disarm"))
  // The kickoff carries the confirmed file's own text and the reply.
  assert.ok(io._handoff.extraKickoffBlock.includes("do the thing"))
  assert.equal(io._handoff.docSummariesText, "## WIND-DOWN DONE — 2 open")
})

test("the drop runs before the quiesce wait", async () => {
  const io = baseIo()
  await runEndlessCycle(io)
  assert.deepEqual(io._log.slice(0, 2), ["dropRetained", "isQuiesced"])
})

test("a second idle event does not claim an already-claimed cycle", async () => {
  markEndlessPending(SID)
  assert.equal(claimPendingEndless(SID), true)
  const io = baseIo()
  assert.equal(await runEndlessCycle(io), null)
})

// ---------------------------------------------------------------------------
// Quiesce
// ---------------------------------------------------------------------------

test("a quiesce timeout abandons and arms the cooldown", async () => {
  let clock = 0
  const io = baseIo({
    isQuiesced: async () => false,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    quiesceTimeoutMs: 1000,
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "quiesce")
  assert.equal(endlessCooldownActive(SID), true)
  assert.ok(!io._log.includes("performHandoff"))
  assert.ok(io._log.includes("disarm"))
})

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

test("a prepare that throws abandons before a turn is spent", async () => {
  const io = baseIo({
    prepare: () => {
      throw new Error("several todo files")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "prepare")
  assert.ok(!io._log.includes("windDownTurn"))
})

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

test("the cycle ceiling pauses and replaces nothing", async () => {
  const io = baseIo({ cycleNumber: 11, maxCycles: 10 })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "ceiling")
  assert.equal(isEndlessPaused(SID), true)
  assert.ok(!io._log.includes("prepare"))
  assert.ok(!io._log.includes("dropRetained"))
})

// ---------------------------------------------------------------------------
// The fallback: an unconsumed permit disarms first, then the plugin spawns
// ---------------------------------------------------------------------------

test("an unconsumed permit disarms before the plugin starts the subagent itself", async () => {
  const io = baseIo({
    windDownTurn: async () => {
      throw new Error("no shaped reply in the window")
    },
    windDownPermit: () => ({ consumed: false }),
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  const disarmAt = io._log.indexOf("disarm")
  const startAt = io._log.indexOf("startWindDownSubagent")
  assert.ok(disarmAt >= 0 && startAt >= 0 && disarmAt < startAt, "disarm precedes the fallback spawn")
})

test("a fallback that cannot start a child abandons", async () => {
  const io = baseIo({
    windDownTurn: async () => {
      throw new Error("no shaped reply")
    },
    windDownPermit: () => ({ consumed: false }),
    startWindDownSubagent: async () => {
      throw new Error("createChildSession returned no session id")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "wind-down")
  assert.ok(!io._log.includes("performHandoff"))
})

// ---------------------------------------------------------------------------
// The settlement gate
// ---------------------------------------------------------------------------

test("a shaped reply while the child is unsettled does not reach confirm", async () => {
  const io = baseIo({
    windDownPermit: () => ({ consumed: true, childSessionID: "ses-child", settlement: settled("expired") }),
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "wind-down")
  assert.ok(!io._log.includes("performHandoff"))
})

test("confirmation waits for the child settlement, not the shaped orchestrator reply", async () => {
  let resolveChild
  const childSettlement = new Promise((resolve) => {
    resolveChild = resolve
  })
  let settleCalled = false
  let rereadCalls = 0
  const io = baseIo({
    windDownPermit: () => ({
      consumed: true,
      childSessionID: "ses-child",
      settlement: childSettlement,
    }),
    settleWindDown: async (child) => {
      settleCalled = true
      return { ok: true, outcome: await child.settlement }
    },
    reread: () => {
      rereadCalls += 1
      return { name: "TODO.md", content: FRESH }
    },
  })

  const running = runEndlessCycle(io)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(settleCalled, true, "the cycle is waiting on the child")
  assert.equal(rereadCalls, 0, "the shaped reply does not start confirmation")
  assert.ok(!io._log.includes("performHandoff"))

  resolveChild({ status: "completed" })
  const res = await running
  assert.equal(res.outcome, "complete")
  assert.equal(rereadCalls, 1)
})

test("a child that settled errored still confirms when the file verifies", async () => {
  const io = baseIo({
    windDownPermit: () => ({ consumed: true, childSessionID: "ses-child", settlement: settled("error") }),
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
})

// ---------------------------------------------------------------------------
// Confirm: V1–V7, each failing in isolation
// ---------------------------------------------------------------------------

test("V1: a renamed todo file abandons without a handoff", async () => {
  const io = baseIo({ reread: () => ({ name: "TODO.markdown", content: FRESH }) })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
  assert.ok(!io._log.includes("performHandoff"))
})

test("V1: a todo file that no longer resolves abandons", async () => {
  const io = baseIo({
    reread: () => {
      throw new Error("several todo files")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
})

test("V1: a resolved todo path that is not a regular file abandons", async () => {
  const io = baseIo({
    reread: () => {
      throw new Error("TODO.md is not a regular file")
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
  assert.ok(!io._log.includes("performHandoff"))
})

test("V3: an unchanged file with no `no change` reply is restored and abandons", async () => {
  const io = baseIo({
    reread: () => ({ name: "TODO.md", content: SNAP }),
    windDownTurn: async () => "## WIND-DOWN DONE — 1 open",
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
  assert.ok(io._log.includes("restore:true"), "the snapshot content was restored")
  assert.ok(!io._log.includes("performHandoff"))
})

test("V3: an unchanged file WITH a `no change` reply is accepted", async () => {
  const io = baseIo({
    reread: () => ({ name: "TODO.md", content: SNAP }),
    windDownTurn: async () => "## WIND-DOWN DONE — no change",
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.deepEqual(res.openIds, ["T1"])
})

test("V4: a changed line OUTSIDE the markers is restored and abandons", async () => {
  const tampered = FRESH.replace("Some prose a human wrote.", "Some prose a subagent rewrote.")
  const io = baseIo({ reread: () => ({ name: "TODO.md", content: tampered }) })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
  assert.ok(io._log.includes("restore:true"))
  assert.ok(!io._log.includes("performHandoff"))
})

test("V5: a duplicate id is restored and abandons", async () => {
  const dup = fenced(["- T1: do the thing", "- T1: a clashing duplicate"], "T2")
  const io = baseIo({ reread: () => ({ name: "TODO.md", content: dup }) })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "confirm")
  assert.ok(io._log.includes("restore:true"))
})

test("V6: an existing id may receive a stale-title update across cycles", async () => {
  // The first cycle starts with an accumulated file and completes T50. T51's
  // title is stale after that completion, so the second cycle updates T51 in
  // place instead of inventing a new id.
  const accumulated = fenced(
    [
      "- T50: Merge hygiene slices into reviews/code-hygiene.md",
      "- T51: Merge hygiene slices into reviews/code-hygiene.md then delete slices",
      "- T52: review the final hygiene notes",
    ],
    "T53",
  )
  const afterFirstCycle = fenced(
    [
      "- T51: Merge hygiene slices into reviews/code-hygiene.md then delete slices",
      "- T52: review the final hygiene notes",
    ],
    "T53",
  )
  const afterSecondCycle = fenced(
    [
      "- T51: Delete leftover hygiene slices (merge already in reviews/code-hygiene.md)",
      "- T52: review the final hygiene notes",
    ],
    "T53",
  )
  let current = accumulated
  let next = afterFirstCycle
  const restores = []
  const logPath = join(cacheDir(), "debug.log")
  const before = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0
  const cycleOverrides = {
    prepare: () => ({
      fileName: "TODO.md",
      content: current,
      hash: "sha-snap",
      tasks: parseTasks(current),
      driftCount: 0,
    }),
    reread: () => {
      current = next
      next = afterSecondCycle
      return { name: "TODO.md", content: current }
    },
    windDownTurn: async () => "## WIND-DOWN DONE — 2 open",
    restoreSnapshot: (content) => {
      restores.push(content)
      current = content
    },
  }
  const firstIo = baseIo(cycleOverrides)
  const first = await runEndlessCycle(firstIo)
  assert.equal(first.outcome, "complete")
  assert.deepEqual(parseTasks(current).map((task) => task.id), ["T51", "T52"])

  // The successor primary runs the second cycle against the first cycle's
  // output as its snapshot.
  const secondIo = baseIo({ ...cycleOverrides, primarySessionID: NEW_SID })
  const second = await runEndlessCycle(secondIo)
  assert.equal(second.outcome, "complete")
  assert.deepEqual(parseTasks(current).map((task) => task.id), ["T51", "T52"])
  assert.equal(restores.length, 0, "the accepted title update is not restored")

  const delta = (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").slice(before)
  assert.match(delta, /endless: wind-down task title changed — V6 observation/)
  assert.match(delta, /"id":"T51"/)
  assert.ok(delta.includes('"oldTitle":"Merge hygiene slices into reviews/code-hygiene.md then delete slices"'))
  assert.ok(delta.includes('"newTitle":"Delete leftover hygiene slices (merge already in reviews/code-hygiene.md)"'))
})

test("V7: a reply count that disagrees with the parse is logged but not fatal", async () => {
  const logPath = join(cacheDir(), "debug.log")
  const before = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0
  const io = baseIo({ windDownTurn: async () => "## WIND-DOWN DONE — 99 open" })
  const res = await runEndlessCycle(io)
  const after = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const delta = after.slice(before)

  assert.equal(res.outcome, "complete")
  assert.deepEqual(res.openIds, ["T1", "T2"])
  assert.match(delta, /endless: wind-down reply count disagrees with the parse — the parse wins/)
  assert.match(delta, /"replyCount":99/)
  assert.match(delta, /"parseCount":2/)
})

// ---------------------------------------------------------------------------
// Nothing left to do
// ---------------------------------------------------------------------------

test("an empty file with a `nothing open` reply pauses instead of starting a session", async () => {
  const empty = fenced([], "T2")
  const io = baseIo({
    reread: () => ({ name: "TODO.md", content: empty }),
    windDownTurn: async () => "## WIND-DOWN DONE — nothing open",
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "no-open-points")
  assert.equal(isEndlessPaused(SID), true)
  assert.ok(!io._log.includes("performHandoff"))
})

// ---------------------------------------------------------------------------
// The no-progress bound, id-keyed
// ---------------------------------------------------------------------------

test("no inherited id leaving the file over the streak pauses the NEW primary", async () => {
  recordEndlessCycle([], ["T1"])
  recordEndlessCycle(["T1"], ["T1"])
  assert.equal(endlessProgress.stalledCycles, 1)

  // This cycle finds [T1] and leaves [T1,T2] — T1 never left, so it is the
  // second consecutive stall.
  const io = baseIo()
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.ok(res.stalledCycles >= ENDLESS_MAX_STALLED_CYCLES)
  assert.equal(isEndlessPaused(NEW_SID), true, "the pause lands on the session that inherited the loop")
  assert.equal(isEndlessPaused(SID), false)
  assert.ok(io._log.includes("performHandoff"), "the cycle past the save is not undone by the bound")
})

// ---------------------------------------------------------------------------
// verifyWindDown as a pure function
// ---------------------------------------------------------------------------

test("verifyWindDown reads the file, never the reply's claims", () => {
  const snapshot = { content: SNAP, tasks: parseTasks(SNAP) }
  const v = verifyWindDown(
    snapshot,
    { content: FRESH, replyNoChange: false, replyNothingOpen: false, replyCount: 2 },
    { splitSections, parseTasks },
  )
  assert.equal(v.v3, true)
  assert.equal(v.v4, true)
  assert.equal(v.v5, true)
  assert.equal(v.v6, true)
  assert.equal(v.empty, false)
  assert.deepEqual(v.openIds, ["T1", "T2"])
  assert.equal(v.countMismatch, false)
})

test("verifyWindDown flags an outside change as a V4 failure", () => {
  const snapshot = { content: SNAP, tasks: parseTasks(SNAP) }
  const tampered = FRESH.replace("Some prose a human wrote.", "rewritten prose")
  const v = verifyWindDown(
    snapshot,
    { content: tampered, replyNoChange: false, replyNothingOpen: false, replyCount: null },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, false)
})

test("V4 accepts a moved legacy block with its separator blank left", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    { content: MOVED_WITH_SEPARATOR, replyNoChange: false, replyNothingOpen: false, replyCount: 1 },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, true)
})

test("V4 accepts a moved legacy block with its separator blank deleted", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    { content: MOVED_WITHOUT_SEPARATOR, replyNoChange: false, replyNothingOpen: false, replyCount: 1 },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, true)
})

test("V4 rejects a legacy block left standing beside its migrated copy", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    { content: LEGACY_LEFT_STANDING, replyNoChange: false, replyNothingOpen: false, replyCount: 2 },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, false)
})

test("V4 accepts a correct migration that drops the trailing newline", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    {
      content: MOVED_WITHOUT_TRAILING_NEWLINE,
      replyNoChange: false,
      replyNothingOpen: false,
      replyCount: 1,
    },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, true)
})

test("V4 accepts a correct migration that adds the trailing newline", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    {
      content: MOVED_WITH_ADDED_TRAILING_NEWLINE,
      replyNoChange: false,
      replyNothingOpen: false,
      replyCount: 1,
    },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4, true)
})

test("an accepted rewrite is written back with one trailing newline", async () => {
  const writes = []
  const io = baseIo({
    reread: () => ({ name: "TODO.md", content: FRESH_WITHOUT_TRAILING_NEWLINE }),
    restoreSnapshot: (content) => writes.push(content),
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.deepEqual(writes, [FRESH])
})

test("V4 exposes the failed conjunct and line-level comparison", () => {
  const v = verifyWindDown(
    { content: LEGACY_SNAPSHOT, tasks: parseTasks(LEGACY_SNAPSHOT) },
    { content: LEGACY_LEFT_STANDING, replyNoChange: false, replyNothingOpen: false, replyCount: 2 },
    { splitSections, parseTasks },
  )
  assert.equal(v.v4Details.markerValid, true)
  assert.equal(v.v4Details.sequenceValid, false)
  assert.equal(v.v4Details.firstDifference.index, 0)
  assert.equal(v.v4Details.firstDifference.expectedLine, JSON.stringify(""))
  assert.equal(v.v4Details.firstDifference.actualLine, JSON.stringify(LEGACY_TASK.split("\n")[0]))
  assert.equal(v.v4Details.expectedLength, 3)
  assert.equal(v.v4Details.actualLength, 5)
  assert.deepEqual(v.v4Details.migratedBlockIndices, [0, 1])
})

test("the wind-down contract licenses only the task-block migration outside the markers", () => {
  assert.match(WIND_DOWN_SUBAGENT_CONTRACT, /one exception is the exact migration/)
  assert.match(WIND_DOWN_SUBAGENT_CONTRACT, /delete that whole block from where it stood/)
  assert.match(WIND_DOWN_SUBAGENT_CONTRACT, /blank line may stay or be deleted/)
  assert.match(WIND_DOWN_SUBAGENT_CONTRACT, /no other outside line may change/)
})

test("rejected wind-down content is filed verbatim", () => {
  const content = "rejected rewrite\\nwith trailing detail\\n"
  const result = writeRejectedWindDown(content, "ses-endless-cycle-test")
  assert.equal(result.error, null)
  assert.ok(result.path)
  try {
    assert.equal(readFileSync(result.path, "utf8"), content)
  } finally {
    unlinkSync(result.path)
  }
})

// ---------------------------------------------------------------------------
// The kickoff carrier
// ---------------------------------------------------------------------------

test("endlessKickoffBlock carries the file text verbatim when it fits", () => {
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", todoFileText: SNAP, truncated: false })
  assert.ok(block.includes("do the thing"))
  assert.ok(block.includes("TODO.md as it stands now"))
  assert.ok(!block.includes("have a subagent read the rest"))
})

test("endlessKickoffBlock tells the successor to read the rest when the text was cut", () => {
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", todoFileText: "partial", truncated: true })
  assert.ok(block.includes("have a subagent read the rest"))
})

test("endlessKickoffBlock falls back to a read instruction when no text could be read", () => {
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", todoFileText: "", truncated: false })
  assert.ok(block.includes("could not read"))
  assert.ok(block.includes("read it in full"))
})

test("cutTodoText cuts on a block boundary and flags the truncation", () => {
  const short = "- T1: a\n\n- T2: b\n"
  assert.deepEqual(cutTodoText(short, 1000), { text: short, truncated: false })

  const big = "AAAA\n\n" + "B".repeat(KICKOFF_TODO_MAX_CHARS)
  const cut = cutTodoText(big)
  assert.equal(cut.truncated, true)
  assert.ok(cut.text.length <= KICKOFF_TODO_MAX_CHARS)
  assert.ok(!cut.text.includes("B"), "cut at the blank line before the long block")
})
