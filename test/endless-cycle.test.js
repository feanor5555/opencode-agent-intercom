// The endless-mode cycle executor (src/endless.js): the quiesce wait and its
// timeout on virtual time, the save against a REAL temp directory through the
// real todofile writer, the read-back confirmation, the kickoff block, and the
// bounds that end the loop.
//
// runEndlessCycle is fully dependency-injected, so the whole cycle runs here
// with no client, no network and no timers: `sleep` and `now` are virtual and
// `performHandoff` is a recording fake. The one thing that is NOT faked is the
// todo file — the save step's whole point is that the write reached the disk,
// so it goes through src/todofile.js against a fresh temp directory, wired the
// way handoffwiring.js wires it.
//
// Run: node --test --test-timeout=5000 test/endless-cycle.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetState, endlessProgress } from "../src/state.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  setEndlessCooldown,
  endlessCooldownActive,
  isEndlessFrozen,
} from "../src/registry.js"
import { runEndlessCycle, endlessKickoffBlock, ENDLESS_MAX_STALLED_CYCLES } from "../src/endless.js"
import {
  addTask,
  listOpen,
  findTodoFile,
  TodoFileMissingError,
  CANONICAL_TODO_NAME,
} from "../src/todofile.js"

const SID = "ses-endless-cycle"

test.beforeEach(() => resetState())

function tempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-endless-"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

const REPLY = [
  "## OPEN POINTS",
  "",
  "- Finish the migration script",
  "  accept: `npm run migrate` exits 0",
  "- Write the rollback procedure",
  "  accept: the file exists",
].join("\n")

// The todo-file deps exactly as handoffwiring.js binds them: a directory with
// NO todo file is the greenfield state addTask creates over and reads as [];
// "several todo files" and "not a regular file" propagate.
function todoDeps(directory) {
  return {
    addTask: (point) => addTask(directory, point),
    listOpen: () => {
      try {
        return listOpen(directory)
      } catch (err) {
        if (err instanceof TodoFileMissingError && err.kind === "missing") return []
        throw err
      }
    },
    todoFileName: () => {
      try {
        return findTodoFile(directory).name
      } catch {
        return ""
      }
    },
  }
}

// A cycle driven with the real latch, virtual time and a recording handoff.
// `overrides` replaces any dep; `state` collects what the fakes observed.
function makeCycle({ directory, overrides = {} } = {}) {
  const state = {
    handoffCalls: [],
    toasts: [],
    switchedOff: 0,
    slept: 0,
    clock: 0,
    recorded: [],
  }
  markEndlessPending(SID)
  const io = {
    primarySessionID: SID,
    claim: () => claimPendingEndless(SID),
    release: () => releaseEndless(SID),
    setCooldown: () => setEndlessCooldown(SID),
    isQuiesced: async () => true,
    countActive: () => 0,
    requestOpenPoints: async () => REPLY,
    performHandoff: async (args) => {
      state.handoffCalls.push(args)
      return { newSessionID: "ses-new-1" }
    },
    cycleNumber: 1,
    maxCycles: 10,
    switchOff: () => {
      state.switchedOff += 1
      return true
    },
    recordCycle: (n) => {
      state.recorded.push(n)
      return { stalledCycles: 0 }
    },
    toast: (t) => state.toasts.push(t),
    quiesceTimeoutMs: 600_000,
    pollMs: 500,
    sleep: async (ms) => {
      state.slept += 1
      state.clock += ms
    },
    now: () => state.clock,
    ...(directory ? todoDeps(directory) : {}),
    ...overrides,
  }
  return { io, state }
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

test("an unclaimed latch is the whole gate: a second run returns null and does nothing", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({ directory: dir })
  const first = await runEndlessCycle(io)
  assert.equal(first.outcome, "complete")
  const second = await runEndlessCycle(io)
  assert.equal(second, null, "a duplicate idle event cannot start a second cycle")
  assert.equal(state.handoffCalls.length, 1)
})

// ---------------------------------------------------------------------------
// The save, against a real temp directory
// ---------------------------------------------------------------------------

test("greenfield: TODO.md is created with the points and the handoff runs", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.deepEqual(res.ids, ["T1", "T2"])
  assert.deepEqual(readdirSync(dir), [CANONICAL_TODO_NAME])
  const content = readFileSync(join(dir, CANONICAL_TODO_NAME), "utf8")
  assert.match(content, /- T1: Finish the migration script\n {2}accept: `npm run migrate` exits 0\n/)
  assert.match(content, /- T2: Write the rollback procedure\n {2}accept: the file exists\n/)
  assert.equal(state.handoffCalls.length, 1)
})

test("an existing todos.md is appended to, and no second todo file is created", async () => {
  const dir = tempProject({ "todos.md": "- T7: an older task\n  accept: it lands\n" })
  const { io } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.deepEqual(res.ids, ["T8", "T9"], "ids continue above the existing maximum")
  assert.deepEqual(readdirSync(dir), ["todos.md"], "no canonical TODO.md is created beside it")
  const content = readFileSync(join(dir, "todos.md"), "utf8")
  assert.match(content, /- T7: an older task/)
  assert.match(content, /- T8: Finish the migration script/)
  assert.equal(res.openBefore, 1)
  assert.equal(res.openAfter, 3)
})

// `todo.md` + `todos.md`, deliberately NOT `TODO.md` + `todos.md`: findTodoFile
// gives the canonical `TODO.md` precedence over a differently-cased sibling via
// its statSync fast path, so that pair resolves rather than erroring. "multiple"
// is for the variants among which no such precedence exists.
test("two todo files: the cycle abandons at save, neither file is written, no handoff", async () => {
  const dir = tempProject({
    "todo.md": "- T1: one\n",
    "todos.md": "- T1: another\n",
  })
  const before = { todo: readFileSync(join(dir, "todo.md"), "utf8"), todos: readFileSync(join(dir, "todos.md"), "utf8") }
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "save")
  assert.equal(state.handoffCalls.length, 0, "the primary is NOT replaced when the save failed")
  assert.equal(readFileSync(join(dir, "todo.md"), "utf8"), before.todo)
  assert.equal(readFileSync(join(dir, "todos.md"), "utf8"), before.todos)
  assert.deepEqual(readdirSync(dir).sort(), ["todo.md", "todos.md"], "no third file is created")
  assert.equal(isEndlessFrozen(SID), false, "the abandon lifts the spawn freeze")
  assert.equal(endlessCooldownActive(SID), true, "and arms the cooldown")
  assert.equal(state.switchedOff, 0, "an abandoned cycle does not switch the mode off")
})

test("a failed read-back confirmation abandons the cycle and never calls the handoff", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    // The write reports ids the file does not carry — the exact case the
    // confirmation exists for.
    overrides: { listOpen: () => [] },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "save")
  assert.match(res.reason, /T1,T2 missing from the todo file/)
  assert.equal(state.handoffCalls.length, 0)
  assert.equal(isEndlessFrozen(SID), false)
})

test("a reply without the OPEN POINTS heading abandons at save", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { requestOpenPoints: async () => "Sure! I have finished everything." },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.stage, "save")
  assert.match(res.reason, /no `## OPEN POINTS` heading/)
  assert.equal(state.handoffCalls.length, 0)
  assert.deepEqual(readdirSync(dir), [], "nothing is written when the reply is unusable")
})

test("a timed-out open-points turn abandons at save", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      requestOpenPoints: async () => {
        throw new Error("requestDocSummaries: timed out waiting for the old primary's shaped reply")
      },
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.stage, "save")
  assert.match(res.reason, /timed out/)
  assert.equal(state.handoffCalls.length, 0)
})

// ---------------------------------------------------------------------------
// The kickoff
// ---------------------------------------------------------------------------

test("the kickoff block names the confirmed ids, the confirmed count and the file", async () => {
  const dir = tempProject({ "todos.md": "- T7: an older task\n" })
  const { io, state } = makeCycle({ directory: dir })
  await runEndlessCycle(io)

  const { extraKickoffBlock, openPointsText } = state.handoffCalls[0]
  assert.match(extraKickoffBlock, /^## Endless mode — work off the todo file$/m)
  assert.match(extraKickoffBlock, /saved to todos\.md as 2 task\(s\): T8, T9\./)
  assert.doesNotMatch(extraKickoffBlock, /\bT7\b/, "only ids the write returned are named")
  assert.match(extraKickoffBlock, /DONE: T<n>/)
  assert.equal(
    openPointsText,
    REPLY,
    "the doc-summary turn is not asked for a second time — the text we already have is handed back",
  )
})

test("endlessKickoffBlock: with no new points it states the file rather than an empty id list", () => {
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", ids: [] })
  assert.match(block, /no new open points/)
  assert.doesNotMatch(block, /0 task\(s\)/)
  assert.match(block, /work that todo file off, top to bottom/)
})

// ---------------------------------------------------------------------------
// The quiesce wait
// ---------------------------------------------------------------------------

test("the cycle waits for quiesce before it asks for the open points", async () => {
  const dir = tempProject()
  let busyPolls = 3
  const order = []
  const { io } = makeCycle({
    directory: dir,
    overrides: {
      isQuiesced: async () => {
        order.push("poll")
        return busyPolls-- <= 0
      },
      requestOpenPoints: async () => {
        order.push("save")
        return REPLY
      },
    },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.equal(order.filter((s) => s === "poll").length, 4)
  assert.equal(order[order.length - 1], "save", "the save turn comes after the last poll")
})

test("quiesce timeout: the cycle abandons on virtual time, the freeze lifts, no session is created", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { isQuiesced: async () => false },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "quiesce")
  assert.match(res.reason, /still busy after 600000ms/)
  assert.equal(state.clock, 600_000, "the wait ran the full timeout of virtual time")
  assert.equal(state.slept, 1200, "600000ms at a 500ms poll")
  assert.equal(state.handoffCalls.length, 0, "no session was created")
  assert.deepEqual(readdirSync(dir), [], "and nothing was written")
  assert.equal(isEndlessFrozen(SID), false)
  assert.equal(endlessCooldownActive(SID), true)
  assert.equal(state.toasts.at(-1).variant, "error")
})

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

test("nothing left to do: an empty point list and an empty todo file switch the mode off", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { requestOpenPoints: async () => "## OPEN POINTS\n" },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "no-open-points")
  assert.equal(state.switchedOff, 1, "endlessMode is written false")
  assert.equal(state.handoffCalls.length, 0, "the session is not replaced")
  assert.equal(isEndlessFrozen(SID), false)
  assert.equal(endlessCooldownActive(SID), false, "a deliberate stop arms no retry cooldown")
  assert.equal(state.toasts.at(-1).variant, "success")
})

test("an empty point list with open tasks left still replaces the session", async () => {
  const dir = tempProject({ "TODO.md": "- T1: still open\n" })
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { requestOpenPoints: async () => "## OPEN POINTS\n" },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.outcome, "complete")
  assert.equal(state.switchedOff, 0)
  assert.equal(state.handoffCalls.length, 1)
})

test("no progress: two consecutive cycles with a non-falling count switch the mode off", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      recordCycle: (n) => {
        state.recorded.push(n)
        return { stalledCycles: ENDLESS_MAX_STALLED_CYCLES }
      },
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.equal(state.handoffCalls.length, 1, "the cycle that is already past the save completes")
  assert.equal(state.switchedOff, 1)
  assert.deepEqual(
    state.recorded,
    [0],
    "the bound reads the count the cycle FOUND (0 here), not the one its own write produced",
  )
  assert.match(state.toasts.at(-1).message, /no progress over 2 cycles at 0 open task\(s\)/)
})

test("a productive loop is not read as stalled: the recorded count is the one it inherited", async () => {
  // The steady state the old reading killed at cycle three: the cycle starts
  // with one task left over, saves two fresh points, and the file ends at
  // three. What the bound must compare across cycles is the 1, not the 3.
  const dir = tempProject({ "TODO.md": "- T5: inherited work\n" })
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.openBefore, 1)
  assert.equal(res.openAfter, 3)
  assert.deepEqual(state.recorded, [1])
})

// ---------------------------------------------------------------------------
// Points already standing in the file
// ---------------------------------------------------------------------------

test("a point whose title is already a task is not written a second time", async () => {
  const dir = tempProject({
    "todos.md": "- T7: finish   the Migration Script\n  accept: it lands\n",
  })
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.deepEqual(res.ids, ["T8"], "only the point the file did not carry is written")
  const content = readFileSync(join(dir, "todos.md"), "utf8")
  assert.equal(
    content.match(/Finish the migration script|finish   the Migration Script/gi).length,
    1,
    "the title stands exactly once — case and inner spacing do not make it a new task",
  )
  assert.match(content, /- T8: Write the rollback procedure/)
  assert.doesNotMatch(
    state.handoffCalls[0].extraKickoffBlock,
    /T7/,
    "the kickoff names only what this cycle wrote",
  )
  assert.match(state.handoffCalls[0].extraKickoffBlock, /1 task\(s\): T8\./)
})

test("a reply that restates the same point twice writes it once", async () => {
  const dir = tempProject()
  const { io } = makeCycle({
    directory: dir,
    overrides: {
      requestOpenPoints: async () =>
        ["## OPEN POINTS", "", "- Do the one thing", "- do the ONE thing", ""].join("\n"),
    },
  })
  const res = await runEndlessCycle(io)
  assert.deepEqual(res.ids, ["T1"])
})

test("a cycle whose points are all already in the file still replaces the session", async () => {
  const dir = tempProject({
    "TODO.md": "- T1: Finish the migration script\n- T2: Write the rollback procedure\n",
  })
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete", "there is open work left, so the mode does not stop")
  assert.deepEqual(res.ids, [])
  assert.equal(state.switchedOff, 0)
  assert.equal(state.handoffCalls.length, 1)
  assert.match(state.handoffCalls[0].extraKickoffBlock, /no new open points/)
})

// ---------------------------------------------------------------------------
// The bounds, continued
// ---------------------------------------------------------------------------

test("the cycle ceiling switches the mode off before anything is written or replaced", async () => {
  // The generation number starts at 1, so `maxCycles: 10` is spent once the
  // chain stands at generation 11 — ten cycles ran.
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { cycleNumber: 11, maxCycles: 10 },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "ceiling")
  assert.equal(state.switchedOff, 1)
  assert.equal(state.handoffCalls.length, 0)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(isEndlessFrozen(SID), false)
  assert.match(state.toasts.at(-1).message, /cycle ceiling reached \(10\/10\)/)
})

test("the ceiling grants exactly maxCycles cycles, and maxCycles 0 arms none at all", async () => {
  // The tenth cycle of a default `endlessMaxCycles: 10` runs at generation 10.
  const tenthDir = tempProject()
  const tenth = makeCycle({ directory: tenthDir, overrides: { cycleNumber: 10, maxCycles: 10 } })
  assert.equal((await runEndlessCycle(tenth.io)).outcome, "complete")

  // The edge the off-by-one turned into a silent off state: `maxCycles: 1`
  // means one cycle, not none.
  resetState()
  const singleDir = tempProject()
  const single = makeCycle({ directory: singleDir, overrides: { cycleNumber: 1, maxCycles: 1 } })
  assert.equal((await runEndlessCycle(single.io)).outcome, "complete")

  resetState()
  const spentDir = tempProject()
  const spent = makeCycle({ directory: spentDir, overrides: { cycleNumber: 2, maxCycles: 1 } })
  assert.equal((await runEndlessCycle(spent.io)).outcome, "ceiling")

  resetState()
  const noCeilingDir = tempProject()
  const none = makeCycle({ directory: noCeilingDir, overrides: { cycleNumber: 99, maxCycles: 0 } })
  assert.equal((await runEndlessCycle(none.io)).outcome, "complete")
})

test("a stop whose settings write failed still ends the cycle and reports it", async () => {
  // writeEndlessMode holds the value process-locally even when the disk write
  // is refused (settings.js), so the stop stands; what the cycle owes here is
  // an honest report of it rather than a silent success.
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      requestOpenPoints: async () => "## OPEN POINTS\n",
      switchOff: () => {
        state.switchedOff += 1
        return false
      },
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "no-open-points")
  assert.equal(res.switchedOff, false, "the caller learns the file was not written")
  assert.equal(state.switchedOff, 1, "the switch-off was attempted")
  assert.equal(state.handoffCalls.length, 0, "the session is not replaced")
  assert.equal(isEndlessFrozen(SID), false, "and the cycle is over either way")
})

test("a failed handoff abandons the cycle: the tasks stay written, the freeze lifts, the cooldown arms", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      performHandoff: async () => {
        throw new Error("session.create failed")
      },
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "handoff")
  assert.equal(res.reason, "session.create failed")
  assert.match(readFileSync(join(dir, CANONICAL_TODO_NAME), "utf8"), /- T1: Finish the migration script/)
  assert.equal(isEndlessFrozen(SID), false)
  assert.equal(endlessCooldownActive(SID), true)
  assert.equal(state.switchedOff, 0)
  assert.equal(endlessProgress.lastOpenTasks, null, "an abandoned cycle records no progress")
})

test("a handoff that returns no new session id abandons rather than reporting success", async () => {
  const dir = tempProject()
  const { io } = makeCycle({
    directory: dir,
    overrides: { performHandoff: async () => ({}) },
  })
  const res = await runEndlessCycle(io)
  assert.equal(res.stage, "handoff")
  assert.match(res.reason, /no new session/)
})
