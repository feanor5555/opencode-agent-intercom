// The sidebar's `endless mode` row when the mode has stopped ITSELF
// (tui/src/endless-pause-file.ts, rendered in tui/src/tui.tsx).
//
// The row is a switch over a setting, and a self-stop is not a setting: it
// pauses the mode for ONE primary session, in the main plugin's process,
// writing nothing. A panel that reads the settings file alone therefore shows
// `[on]` for a session whose loop has stopped — the misreading this row state
// exists to end. So the plugin publishes the pause to a file and the panel
// reads it back, and the crossing between the two is pinned here end to end:
// what src/endlesspause.js writes is what tui/src/endless-pause-file.ts reads.
//
// The pid on each entry is the whole staleness rule: a pause dies with the
// process that set it, while the opencode session outlives that process and can
// be resumed by an instance that has no pause for it.
//
// Needs Node >= 22.18 for the .ts import.
//
// Run: node --test --test-timeout=5000 test/tui-endless-pause-row.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME = mkdtempSync(join(tmpdir(), "intercom-pauserow-"))
process.env.HOME = HOME
mkdirSync(join(HOME, ".cache", "opencode-agent-intercom"), { recursive: true })

const { pauseEndless, clearEndlessPause } = await import("../src/registry.js")
const { endlessPauseFilePath: pluginPausePath } = await import(
  "../src/endlesspause.js"
)
const {
  endlessRowCell,
  endlessRowState,
  parseEndlessPauses,
  pauseCause,
  pauseForSession,
  pauseRowNote,
  readEndlessPauses,
  setEndlessPausePath,
  PAUSE_NOTE_INDENT,
} = await import("../tui/src/endless-pause-file.ts")

setEndlessPausePath(pluginPausePath())

const PRIMARY = "ses_primary"
const ROUTE = "ses_route"
const ALIVE = () => true
const DEAD = () => false

// The three sentences the mode's own stops publish (src/endless.js), as they
// read at runtime.
const NO_POINTS = "no open points left — paused for this session"
const CEILING = "cycle ceiling reached (10/10) — paused for this session"
const NO_PROGRESS =
  "no task completed over 2 cycles at 3 open task(s) — paused for the new session"

const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

const pause = (over = {}) => ({ reason: NO_POINTS, at: 1, pid: 1, ...over })

// ---------------------------------------------------------------------------
// The crossing: what the plugin writes is what the panel reads
// ---------------------------------------------------------------------------

test("a self-stop in the plugin reaches the panel as a paused row with its cause", () => {
  pauseEndless(PRIMARY, NO_POINTS)
  const published = readEndlessPauses()
  const mine = pauseForSession(published, [PRIMARY, ROUTE])
  assert.ok(mine, "the panel read no pause for the session the plugin paused")
  assert.equal(mine.reason, NO_POINTS)
  assert.equal(mine.pid, process.pid)
  assert.equal(endlessRowState(true, mine), "paused")
  assert.equal(endlessRowCell(endlessRowState(true, mine)), "[paused]")
  assert.equal(pauseRowNote(mine.reason, 44), `${PAUSE_NOTE_INDENT}no open points left`)
})

test("clearing the pause puts the row back on the switch", () => {
  pauseEndless(PRIMARY, NO_POINTS)
  clearEndlessPause(PRIMARY)
  const mine = pauseForSession(readEndlessPauses(), [PRIMARY])
  assert.equal(mine, undefined)
  assert.equal(endlessRowState(true, mine), "on")
  assert.equal(endlessRowCell(endlessRowState(true, mine)), "[on] ")
})

test("a file that is not there reads as nothing paused", () => {
  const gone = join(HOME, "no-such-dir", "endless-pauses.json")
  setEndlessPausePath(gone)
  try {
    assert.equal(readEndlessPauses().size, 0)
  } finally {
    setEndlessPausePath(pluginPausePath())
  }
})

test("a file that does not parse reads as nothing paused", () => {
  const broken = join(HOME, "broken.json")
  writeFileSync(broken, "{ not json")
  setEndlessPausePath(broken)
  try {
    assert.equal(readEndlessPauses().size, 0)
  } finally {
    setEndlessPausePath(pluginPausePath())
    rmSync(broken)
  }
})

// ---------------------------------------------------------------------------
// Which entries count
// ---------------------------------------------------------------------------

test("an entry whose writer is gone is not a pause", () => {
  const raw = { [PRIMARY]: { reason: NO_POINTS, at: 1, pid: deadPid } }
  assert.equal(parseEndlessPauses(raw).size, 0)
  assert.equal(parseEndlessPauses(raw, ALIVE).size, 1)
})

test("only entries shaped like a pause are read", () => {
  const pauses = parseEndlessPauses(
    {
      ses_ok: { reason: CEILING, at: 7, pid: 2 },
      ses_no_pid: { reason: CEILING, at: 7 },
      ses_bad_pid: { reason: CEILING, at: 7, pid: "2" },
      ses_zero_pid: { reason: CEILING, at: 7, pid: 0 },
      ses_number: 42,
      ses_null: null,
      ses_array: [],
    },
    ALIVE,
  )
  assert.deepEqual([...pauses.keys()], ["ses_ok"])
})

test("a published entry without reason or time still counts as a pause", () => {
  const pauses = parseEndlessPauses({ [PRIMARY]: { pid: 3 } }, ALIVE)
  assert.deepEqual(pauses.get(PRIMARY), { reason: "", at: 0, pid: 3 })
})

test("a body that is not an object reads as nothing paused", () => {
  for (const raw of [null, undefined, 42, "x", [1, 2]]) {
    assert.equal(parseEndlessPauses(raw, ALIVE).size, 0, `read ${JSON.stringify(raw)}`)
  }
})

test("a dead writer is dropped even where the entry is otherwise whole", () => {
  assert.equal(
    parseEndlessPauses({ [PRIMARY]: { reason: NO_POINTS, at: 1, pid: 9 } }, DEAD).size,
    0,
  )
})

// ---------------------------------------------------------------------------
// Which session the row is about
// ---------------------------------------------------------------------------

test("the orchestrator's pause wins over the route session's", () => {
  const pauses = new Map([
    [PRIMARY, pause({ reason: NO_POINTS })],
    [ROUTE, pause({ reason: CEILING })],
  ])
  assert.equal(pauseForSession(pauses, [PRIMARY, ROUTE])?.reason, NO_POINTS)
})

test("the route session answers where the orchestrator has no pause", () => {
  const pauses = new Map([[ROUTE, pause({ reason: NO_PROGRESS })]])
  assert.equal(pauseForSession(pauses, [PRIMARY, ROUTE])?.reason, NO_PROGRESS)
})

test("undefined session ids are skipped and an unpaused panel gets nothing", () => {
  const pauses = new Map([[ROUTE, pause()]])
  assert.equal(pauseForSession(pauses, [undefined, undefined]), undefined)
  assert.equal(pauseForSession(new Map(), [PRIMARY, ROUTE]), undefined)
})

// ---------------------------------------------------------------------------
// The row itself
// ---------------------------------------------------------------------------

test("the three states of the row", () => {
  assert.equal(endlessRowState(true, undefined), "on")
  assert.equal(endlessRowState(false, undefined), "off")
  assert.equal(endlessRowState(true, pause()), "paused")
})

test("the switch being off outranks a pause left standing", () => {
  // The user's switch-off is the younger statement, and it is what makes the
  // plugin clear the pause on the primary's next turn.
  assert.equal(endlessRowState(false, pause()), "off")
  assert.equal(endlessRowCell(endlessRowState(false, pause())), "[off]")
})

test("each state has its own cell text", () => {
  assert.equal(endlessRowCell("on"), "[on] ")
  assert.equal(endlessRowCell("off"), "[off]")
  assert.equal(endlessRowCell("paused"), "[paused]")
})

test("the cause is the half of the reason the row does not already say", () => {
  assert.equal(pauseCause(NO_POINTS), "no open points left")
  assert.equal(pauseCause(CEILING), "cycle ceiling reached (10/10)")
  assert.equal(pauseCause(NO_PROGRESS), "no task completed over 2 cycles at 3 open task(s)")
})

test("a reason with no cause half is shown whole", () => {
  assert.equal(pauseCause("stopped"), "stopped")
})

test("the note is cut to the panel and is empty without a reason", () => {
  // 24 columns less the 4-column indent and the 2 the box keeps: 18 for the
  // cause, of which the ellipsis takes one.
  assert.equal(pauseRowNote(NO_PROGRESS, 24), `${PAUSE_NOTE_INDENT}no task completed…`)
  assert.equal(pauseRowNote("", 44), "")
  assert.equal(pauseRowNote(NO_POINTS, 4), "")
})

test("the note falls back to the standard panel width before the first layout", () => {
  assert.equal(pauseRowNote(NO_POINTS, undefined), `${PAUSE_NOTE_INDENT}no open points left`)
})
