// The sidebar's `endless mode` row while a cycle is pending or running
// (tui/src/endless-cycle-file.ts read, tui/src/endless-pause-file.ts row
// states): `[restarting]` with the cycle's step on the line beneath, fed by the
// file src/endlesscycle.js writes. The crossing is pinned end to end — what the
// plugin's latches publish is what the panel reads — plus the drop rules that
// keep a stale entry from reading `[restarting]` forever.
//
// Needs Node >= 22.18 for the .ts import.
//
// Run: node --test --test-timeout=5000 test/tui-endless-cycle-row.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "intercom-cyclerow-"))
process.env.HOME = HOME
mkdirSync(join(HOME, ".cache", "opencode-agent-intercom"), { recursive: true })

const { resetState } = await import("../src/state.js")
const {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  forgetPrimary,
  noteEndlessStep,
} = await import("../src/registry.js")
const { endlessCycleFilePath: pluginCyclePath } = await import("../src/endlesscycle.js")
const {
  cycleForSession,
  parseEndlessCycles,
  readEndlessCycles,
  setEndlessCyclePath,
  endlessCycleFilePath,
} = await import("../tui/src/endless-cycle-file.ts")
const {
  cycleStepText,
  endlessRowCell,
  endlessRowLive,
  endlessRowNote,
  endlessRowState,
  PAUSE_NOTE_INDENT,
} = await import("../tui/src/endless-pause-file.ts")

setEndlessCyclePath(pluginCyclePath())

const PRIMARY = "ses_primary"
const ROUTE = "ses_route"
const ALIVE = () => true

const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

const cycle = (over = {}) => ({ step: "quiesce", at: 1, pid: 1, ...over })
const pause = { reason: "no open points left — paused for this session", at: 1, pid: 1 }

test.beforeEach(() => {
  resetState()
  writeFileSync(pluginCyclePath(), "{}\n")
})

// ---------------------------------------------------------------------------
// The crossing
// ---------------------------------------------------------------------------

test("the panel reads the file the plugin writes", () => {
  assert.equal(endlessCycleFilePath(), pluginCyclePath())
})

test("each step the plugin publishes reaches the row as `[restarting]` with its line", () => {
  const rowFor = () => {
    const mine = cycleForSession(readEndlessCycles(), [PRIMARY, ROUTE])
    const state = endlessRowState(true, undefined, false, mine)
    return [endlessRowCell(state), endlessRowNote(state, "", 60, mine)]
  }
  markEndlessPending(PRIMARY)
  assert.deepEqual(rowFor(), ["[restarting]", `${PAUSE_NOTE_INDENT}waiting for the turn to end`])
  claimPendingEndless(PRIMARY)
  noteEndlessStep(PRIMARY, "quiesce", { running: 3 })
  assert.deepEqual(rowFor(), ["[restarting]", `${PAUSE_NOTE_INDENT}waiting for subagents (3 running)`])
  noteEndlessStep(PRIMARY, "wind-down")
  assert.deepEqual(rowFor(), ["[restarting]", `${PAUSE_NOTE_INDENT}saving open points`])
  noteEndlessStep(PRIMARY, "successor")
  assert.deepEqual(rowFor(), ["[restarting]", `${PAUSE_NOTE_INDENT}starting fresh session`])
  forgetPrimary(PRIMARY)
  assert.deepEqual(rowFor(), ["[on] ", ""])
})

test("an abandoned cycle puts the row back on the switch", () => {
  markEndlessPending(PRIMARY)
  claimPendingEndless(PRIMARY)
  releaseEndless(PRIMARY)
  const mine = cycleForSession(readEndlessCycles(), [PRIMARY])
  assert.equal(mine, undefined)
  assert.equal(endlessRowState(true, undefined, false, mine), "on")
})

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("a missing, unparsable or non-object file reads as no cycle running", () => {
  setEndlessCyclePath(join(HOME, "no-such-dir", "endless-cycles.json"))
  try {
    assert.equal(readEndlessCycles().size, 0)
    const broken = join(HOME, "broken.json")
    writeFileSync(broken, "{ not json")
    setEndlessCyclePath(broken)
    assert.equal(readEndlessCycles().size, 0)
  } finally {
    setEndlessCyclePath(pluginCyclePath())
  }
  assert.equal(parseEndlessCycles([cycle()], ALIVE).size, 0)
  assert.equal(parseEndlessCycles(null, ALIVE).size, 0)
})

test("an entry whose writer is gone is not a running cycle", () => {
  writeFileSync(
    pluginCyclePath(),
    JSON.stringify({ [PRIMARY]: { step: "wind-down", at: 1, pid: deadPid } }),
  )
  const mine = cycleForSession(readEndlessCycles(), [PRIMARY])
  assert.equal(mine, undefined)
  assert.equal(endlessRowState(true, undefined, false, mine), "on")
})

test("only entries shaped like a cycle are read", () => {
  const read = parseEndlessCycles(
    {
      good: cycle({ running: 2 }),
      noPid: { step: "turn", at: 1 },
      badPid: cycle({ pid: -3 }),
      badStep: cycle({ step: "rebooting" }),
      badCount: cycle({ running: -1 }),
      notObject: "quiesce",
    },
    ALIVE,
  )
  assert.deepEqual([...read.keys()].sort(), ["badCount", "good"])
  assert.equal(read.get("good").running, 2)
  assert.equal("running" in read.get("badCount"), false)
})

test("the orchestrator's cycle wins over the route session's", () => {
  const cycles = new Map([
    [PRIMARY, cycle({ step: "wind-down" })],
    [ROUTE, cycle({ step: "turn" })],
  ])
  assert.equal(cycleForSession(cycles, [PRIMARY, ROUTE]).step, "wind-down")
  assert.equal(cycleForSession(cycles, [undefined, ROUTE]).step, "turn")
  assert.equal(cycleForSession(cycles, ["ses_none"]), undefined)
})

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

test("a running cycle outranks the switch and a pause, solo mode outranks it", () => {
  assert.equal(endlessRowState(true, undefined, false, cycle()), "restarting")
  assert.equal(endlessRowState(false, undefined, false, cycle()), "restarting")
  assert.equal(endlessRowState(true, pause, false, cycle()), "restarting")
  assert.equal(endlessRowState(true, undefined, true, cycle()), "solo")
  assert.equal(endlessRowState(true, pause, false, undefined), "paused")
})

test("the restarting row has its own cell and stays live", () => {
  assert.equal(endlessRowCell("restarting"), "[restarting]")
  assert.equal(endlessRowLive("restarting"), true)
})

test("the step lines", () => {
  assert.equal(cycleStepText(cycle({ step: "turn" })), "waiting for the turn to end")
  assert.equal(cycleStepText(cycle({ step: "quiesce", running: 2 })), "waiting for subagents (2 running)")
  assert.equal(cycleStepText(cycle({ step: "quiesce", running: 0 })), "waiting for subagents")
  assert.equal(cycleStepText(cycle({ step: "quiesce" })), "waiting for subagents")
  assert.equal(cycleStepText(cycle({ step: "wind-down" })), "saving open points")
  assert.equal(cycleStepText(cycle({ step: "successor" })), "starting fresh session")
})

test("the step line is cut to the panel and absent without a cycle", () => {
  const long = endlessRowNote("restarting", "", 20, cycle({ step: "quiesce", running: 12 }))
  assert.ok(long.startsWith(PAUSE_NOTE_INDENT))
  assert.ok(long.length <= 20, `the note ran past the panel: ${JSON.stringify(long)}`)
  assert.equal(endlessRowNote("restarting", "", 60, undefined), "")
  assert.equal(endlessRowNote("on", "", 60, cycle()), "")
})
