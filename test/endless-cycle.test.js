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
import {
  runEndlessCycle,
  endlessKickoffBlock,
  ENDLESS_MAX_STALLED_CYCLES,
  KICKOFF_TASKS_MAX,
  KICKOFF_TASK_FIELD_MAX_CHARS,
} from "../src/endless.js"
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
    paused: [],
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
    pause: (id, reason) => {
      state.paused.push({ id, reason })
      return true
    },
    recordCycle: (found, left) => {
      state.recorded.push({ found, left })
      return { stalledCycles: 0, completed: null }
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
  assert.deepEqual(state.paused, [], "an abandoned cycle does not pause the mode")
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

// The paragraph the e2e kickoff check parses out of the block
// (test/e2e/endless-task.sh: `block.split("\n\n")[1]`) — the sentence naming
// the save, and the only place an id may come from THIS cycle's write.
function headParagraph(block) {
  const parts = block.split("## Endless mode — work off the todo file")[1].split("\n\n")
  return parts[1] ?? ""
}

test("the kickoff block names the confirmed ids, the confirmed count and the file", async () => {
  const dir = tempProject({ "todos.md": "- T7: an older task\n" })
  const { io, state } = makeCycle({ directory: dir })
  await runEndlessCycle(io)

  const { extraKickoffBlock, openPointsText } = state.handoffCalls[0]
  assert.match(extraKickoffBlock, /^## Endless mode — work off the todo file$/m)
  assert.match(extraKickoffBlock, /saved to todos\.md as 2 task\(s\): T8, T9\./)
  assert.doesNotMatch(
    headParagraph(extraKickoffBlock),
    /\bT7\b/,
    "the saving sentence names only ids the write returned",
  )
  assert.match(extraKickoffBlock, /DONE: T<n>/)
  assert.equal(
    openPointsText,
    REPLY,
    "the doc-summary turn is not asked for a second time — the text we already have is handed back",
  )
})

test("the kickoff carries the todo file's open tasks, not only its name", async () => {
  const dir = tempProject({
    "todos.md": "- T7: an older task\n  accept: the older criterion holds\n",
  })
  const { io, state } = makeCycle({ directory: dir })
  await runEndlessCycle(io)

  const { extraKickoffBlock } = state.handoffCalls[0]
  assert.match(extraKickoffBlock, /The tasks standing in todos\.md right now:/)
  // The pre-existing task the write did not produce is in the listing: the
  // successor primary holds no todo tool and cannot read the file itself.
  assert.match(extraKickoffBlock, /^- T7: an older task$/m)
  assert.match(extraKickoffBlock, /^ {2}accept: the older criterion holds$/m)
  assert.match(extraKickoffBlock, /^- T8: Finish the migration script$/m)
  assert.match(extraKickoffBlock, /^ {2}accept: `npm run migrate` exits 0$/m)
  assert.match(extraKickoffBlock, /^- T9: Write the rollback procedure$/m)
  // File order, which is feasibility order: the oldest task stays first.
  assert.ok(
    extraKickoffBlock.indexOf("- T7:") <
      extraKickoffBlock.indexOf("- T8:") &&
      extraKickoffBlock.indexOf("- T8:") < extraKickoffBlock.indexOf("- T9:"),
    "the listing keeps the file's own order",
  )
})

test("a cycle whose every point was deduped away still hands over the open tasks", async () => {
  // The gap the listing closes: the reply restates what already stands in the
  // file, so no id is written and the head paragraph has none to name.
  const dir = tempProject({
    "todos.md":
      "- T1: Finish the migration script\n  accept: `npm run migrate` exits 0\n" +
      "- T2: Write the rollback procedure\n  accept: the file exists\n",
  })
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.deepEqual(res.ids, [], "every point was already in the file")
  const { extraKickoffBlock } = state.handoffCalls[0]
  assert.match(extraKickoffBlock, /no new open points/)
  assert.match(extraKickoffBlock, /^- T1: Finish the migration script$/m)
  assert.match(extraKickoffBlock, /^- T2: Write the rollback procedure$/m)
})

test("endlessKickoffBlock: with no new points it states the file rather than an empty id list", () => {
  const block = endlessKickoffBlock({
    todoFileName: "TODO.md",
    ids: [],
    openTasks: [{ id: "T4", text: "an open task" }],
  })
  assert.match(block, /no new open points/)
  assert.doesNotMatch(block, /0 task\(s\)/)
  assert.match(block, /work that todo file off, top to bottom/)
  assert.match(block, /^- T4: an open task$/m)
})

test("endlessKickoffBlock: the listing stops at KICKOFF_TASKS_MAX and says how many it left", () => {
  const openTasks = Array.from({ length: KICKOFF_TASKS_MAX + 3 }, (_, i) => ({
    id: `T${i + 1}`,
    text: `task number ${i + 1}`,
  }))
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", ids: ["T1"], openTasks })
  assert.match(block, new RegExp(`^- T${KICKOFF_TASKS_MAX}: `, "m"))
  assert.doesNotMatch(block, new RegExp(`^- T${KICKOFF_TASKS_MAX + 1}: `, "m"))
  assert.match(block, /^- … and 3 further task\(s\) below these in the file\.$/m)
})

test("endlessKickoffBlock: a runaway task line is capped per field, not dumped whole", () => {
  const long = "x".repeat(KICKOFF_TASK_FIELD_MAX_CHARS + 500)
  const block = endlessKickoffBlock({
    todoFileName: "TODO.md",
    ids: ["T1"],
    openTasks: [{ id: "T1", text: long, accept: long }],
  })
  const titleLine = block.split("\n").find((l) => l.startsWith("- T1: "))
  const acceptLine = block.split("\n").find((l) => l.startsWith("  accept: "))
  assert.equal(titleLine.length, "- T1: ".length + KICKOFF_TASK_FIELD_MAX_CHARS)
  assert.equal(acceptLine.length, "  accept: ".length + KICKOFF_TASK_FIELD_MAX_CHARS)
  assert.ok(titleLine.endsWith("…"), "the cut is marked")
})

test("endlessKickoffBlock: with no readable task it names the way out the primary has", () => {
  const block = endlessKickoffBlock({ todoFileName: "TODO.md", ids: [], openTasks: [] })
  assert.match(block, /could not read any open task out of TODO\.md/)
  assert.match(block, /Have a subagent list the file/)
  assert.doesNotMatch(block, /The tasks standing in/)
})

test("endlessKickoffBlock: the saving sentence stays the second paragraph", () => {
  // Pinned because test/e2e/endless-task.sh parses exactly that paragraph and
  // fails on any T-id in it that this cycle's write did not return.
  const block = endlessKickoffBlock({
    todoFileName: "TODO.md",
    ids: ["T8"],
    openTasks: [{ id: "T7", text: "older" }, { id: "T8", text: "newer" }],
  })
  const head = headParagraph(block)
  assert.deepEqual(head.match(/\bT\d+\b/g), ["T8"])
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

test("nothing left to do: an empty point list and an empty todo file pause the mode", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { requestOpenPoints: async () => "## OPEN POINTS\n" },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "no-open-points")
  assert.equal(state.paused.length, 1, "the mode is paused, not switched off")
  assert.equal(state.paused[0].id, SID, "the pause is on the primary that stopped")
  assert.match(state.paused[0].reason, /no open points left/)
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
  assert.deepEqual(state.paused, [])
  assert.equal(state.handoffCalls.length, 1)
})

test("no progress: two consecutive cycles in which nothing was completed pause the NEW primary", async () => {
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      recordCycle: (found, left) => {
        state.recorded.push({ found, left })
        return { stalledCycles: ENDLESS_MAX_STALLED_CYCLES, completed: 0 }
      },
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.equal(state.handoffCalls.length, 1, "the cycle that is already past the save completes")
  assert.equal(state.paused.length, 1)
  assert.equal(
    state.paused[0].id,
    "ses-new-1",
    "the bound fires after the replacement, so it pauses the session that inherited the loop",
  )
  assert.equal(res.pausedSessionID, "ses-new-1")
  assert.deepEqual(
    state.recorded,
    [{ found: [], left: ["finish the migration script", "write the rollback procedure"] }],
    "the bound is handed both snapshots, normalised: the file as found and as left",
  )
  assert.match(state.toasts.at(-1).message, /no task completed over 2 cycles at 0 open task\(s\)/)
  assert.match(state.toasts.at(-1).message, /paused for the new session/)
})

test("the bound is handed the normalised title sets, not the counts", async () => {
  // The cycle starts with one task left over, saves two fresh points, and the
  // file ends at three. Both snapshots go to the record: the inherited set is
  // what the NEXT cycle is measured against, the left-behind set is what the
  // cycle after that inherits.
  const dir = tempProject({ "TODO.md": "- T5: Inherited   Work\n" })
  const { io, state } = makeCycle({ directory: dir })
  const res = await runEndlessCycle(io)

  assert.equal(res.openBefore, 1)
  assert.equal(res.openAfter, 3)
  assert.deepEqual(state.recorded, [
    {
      found: ["inherited work"],
      left: [
        "inherited work",
        "finish the migration script",
        "write the rollback procedure",
      ],
    },
  ])
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
    headParagraph(state.handoffCalls[0].extraKickoffBlock),
    /T7/,
    "the saving sentence names only what this cycle wrote",
  )
  assert.match(
    state.handoffCalls[0].extraKickoffBlock,
    /^- T7: finish {3}the Migration Script$/m,
    "the deduped task is still listed — it is open work the successor cannot read itself",
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
  assert.deepEqual(state.paused, [])
  assert.equal(state.handoffCalls.length, 1)
  assert.match(state.handoffCalls[0].extraKickoffBlock, /no new open points/)
})

// ---------------------------------------------------------------------------
// The bounds, continued
// ---------------------------------------------------------------------------

test("the cycle ceiling pauses the mode before anything is written or replaced", async () => {
  // The generation number starts at 1, so `maxCycles: 10` is spent once the
  // chain stands at generation 11 — ten cycles ran.
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: { cycleNumber: 11, maxCycles: 10 },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "ceiling")
  assert.equal(state.paused.length, 1)
  assert.equal(state.paused[0].id, SID)
  assert.equal(state.handoffCalls.length, 0)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(isEndlessFrozen(SID), false)
  assert.match(state.toasts.at(-1).message, /cycle ceiling reached \(10\/10\) — paused for this session/)
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

test("a stop that cannot pause still ends the cycle and reports it", async () => {
  // The pause is process-local state, so it cannot fail the way a disk write
  // could — but the cycle reports what it got rather than assuming success,
  // and a stop stands either way: the latch is released and the primary is not
  // replaced.
  const dir = tempProject()
  const { io, state } = makeCycle({
    directory: dir,
    overrides: {
      requestOpenPoints: async () => "## OPEN POINTS\n",
      pause: (id, reason) => {
        state.paused.push({ id, reason })
        return false
      },
    },
  })
  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "no-open-points")
  assert.equal(res.paused, false, "the caller learns the pause did not take")
  assert.equal(state.paused.length, 1, "the pause was attempted")
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
  assert.deepEqual(state.paused, [], "an abandoned cycle pauses nothing")
  assert.equal(endlessProgress.lastOpenTitles, null, "an abandoned cycle records no progress")
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
