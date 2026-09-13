// The sidebar's `run (min)` row and the line under it
// (tui/src/run-ceiling-row.ts, rendered in tui/src/tui.tsx).
//
// The row steps the flat `maxSubagentRunMs`, the watchdog's third window: the
// wall-clock ceiling on one subagent RUN. Its number does not stand on its own
// — the ceiling is the outermost of three windows, and the two inside it decide
// whether it leaves any room to act before it fires — so the row owes a line in
// three states:
//
//   the silence window is 0        → "the inactivity watchdog is off — no run
//                                     ceiling either"
//   ceiling <= the in-tool window  → "shorter than the in-tool window — one
//                                     long call is cut off"
//   less than one in-tool window
//   left after the wrap-up band    → "no room left for a handover"
//
// The first is the plugin's own ordering made visible: the run check lives
// inside the running branch behind the silence window (src/watchdog.js), so a
// user who switched that watchdog off has no run ceiling either, whatever this
// row shows.
//
// The parity of the value itself — that the plugin and the panel resolve the
// same ceiling — is pinned in test/settings-defaults-parity.test.js; what is
// pinned here is the row over that value.
//
// Needs Node >= 22.18 for the .ts import.
//
// Run: node --test test/tui-run-ceiling-row.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  NO_HANDOVER_ROOM_CAUSE,
  RUN_CEILING_NOTE_INDENT,
  RUN_WRAP_UP,
  SHORTER_THAN_IN_TOOL_CAUSE,
  WATCHDOG_OFF_CAUSE,
  runCeilingRowCause,
  runCeilingRowNote,
} from "../tui/src/run-ceiling-row.ts"
import {
  DEFAULT_MAX_SUBAGENT_RUN_MS,
  DEFAULT_MAX_SUBAGENT_TOOL_CALL_MS,
  readSettings,
  setSettingsPath,
} from "../tui/src/settings-file.ts"
import { ROW_NOTE_INDENT } from "../tui/src/subagent-label.ts"
import { RUN_WRAP_UP as PLUGIN_RUN_WRAP_UP } from "../src/settings.js"

const dir = mkdtempSync(join(tmpdir(), "run-ceiling-row-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setSettingsPath(file)
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_RUN_MS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_TOOL_CALL_MS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS
})

const write = (obj) => writeFileSync(file, JSON.stringify(obj))
const cause = () => runCeilingRowCause(readSettings())

// The share at which the plugin warns the subagent that its ceiling is coming.
// The panel's copy has to be the plugin's number: the handover room the note
// line is about is exactly what is left after it.
test("the panel carries the plugin's wrap-up share", () => {
  assert.equal(RUN_WRAP_UP, PLUGIN_RUN_WRAP_UP)
})

test("the shipped defaults need no line at all", () => {
  // 44 minutes against an 11-minute in-tool window: a quarter of the ceiling is
  // 11 minutes, which is exactly one such window, so the handover room holds.
  assert.equal(DEFAULT_MAX_SUBAGENT_RUN_MS * (1 - RUN_WRAP_UP), DEFAULT_MAX_SUBAGENT_TOOL_CALL_MS)
  assert.equal(cause(), "")
  assert.equal(runCeilingRowNote(readSettings()), "")
})

test("a ceiling of 0 is off and needs no line either", () => {
  write({ maxSubagentRunMs: 0 })
  assert.equal(cause(), "")
})

test("a ceiling inside the in-tool window says one long call is cut off", () => {
  write({ maxSubagentRunMs: 300000, maxSubagentToolCallMs: 600000 })
  assert.equal(cause(), SHORTER_THAN_IN_TOOL_CAUSE)

  // Equal counts: a call allowed the whole window reaches the ceiling first.
  write({ maxSubagentRunMs: 600000, maxSubagentToolCallMs: 600000 })
  assert.equal(cause(), SHORTER_THAN_IN_TOOL_CAUSE)
})

test("a ceiling with less than one in-tool window left says so", () => {
  // 20 minutes of ceiling leaves 5 after the wrap-up band, and one call may
  // take 11: the subagent can be inside a single call for the whole of its
  // handover room.
  write({ maxSubagentRunMs: 1200000, maxSubagentToolCallMs: 660000 })
  assert.equal(cause(), NO_HANDOVER_ROOM_CAUSE)

  // One minute more of in-tool window than a quarter of the ceiling is enough
  // to lose the guarantee; a quarter exactly keeps it.
  write({ maxSubagentRunMs: 2400000, maxSubagentToolCallMs: 600000 })
  assert.equal(cause(), "")
  write({ maxSubagentRunMs: 2400000, maxSubagentToolCallMs: 660000 })
  assert.equal(cause(), NO_HANDOVER_ROOM_CAUSE)
})

// The sharper statement wins: a ceiling inside the in-tool window has no
// handover room either, and saying both would be one line repeating itself.
test("a ceiling inside the in-tool window is named as that, not as the room", () => {
  write({ maxSubagentRunMs: 300000, maxSubagentToolCallMs: 600000 })
  assert.equal(cause(), SHORTER_THAN_IN_TOOL_CAUSE)
})

// The row is inert while the inactivity watchdog is off, because the run check
// sits inside the running branch behind it. That outranks both other lines: it
// is the difference between a tight ceiling and none at all.
test("the silence window at 0 takes the whole row out and says so", () => {
  write({ maxSubagentAgeMs: 0 })
  assert.equal(cause(), WATCHDOG_OFF_CAUSE)

  write({ maxSubagentAgeMs: 0, maxSubagentRunMs: 300000, maxSubagentToolCallMs: 600000 })
  assert.equal(cause(), WATCHDOG_OFF_CAUSE)

  write({ maxSubagentAgeMs: 0, maxSubagentRunMs: 0 })
  assert.equal(cause(), WATCHDOG_OFF_CAUSE)
})

test("the note sits at the one indent every settings-row note uses", () => {
  assert.equal(RUN_CEILING_NOTE_INDENT, ROW_NOTE_INDENT)

  write({ maxSubagentAgeMs: 0 })
  const note = runCeilingRowNote(readSettings(), 60)
  assert.equal(note, ROW_NOTE_INDENT + WATCHDOG_OFF_CAUSE)

  // A panel too narrow for the indent renders no line rather than a stub.
  assert.equal(runCeilingRowNote(readSettings(), 4), "")
})
