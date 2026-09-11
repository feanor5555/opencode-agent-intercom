// The sidebar's `compaction` row (tui/src/compaction-row.ts, rendered in
// tui/src/tui.tsx).
//
// The row is a per-agent switch over a setting, and unlike the other booleans
// in the panel its value alone does not say whether anything will happen: a
// compaction is driven by the plugin at a CONTEXT THRESHOLD. So the row resolves
// the armed threshold the same way the plugin does — endlessContext displacing
// maxPrimaryContext for the primary, the type's own budget for a subagent — and
// owes a line under itself in the three states where what the cell says cannot
// take effect:
//
//   on, nothing armed          → "no threshold armed — compaction never fires"
//   on, endless in effect      → "endless mode owns the primary threshold"
//   off, nothing else armed    → "no context relief armed — the session will overflow"
//
// The third is the ContextOverflowError made visible: opencode's own automatic
// compaction is off for the whole process, so a primary with no handoff
// threshold, no endless cycle and no compaction has nothing left to relieve it.
//
// The parity of the switch itself — that the plugin and the panel resolve the
// same value for a type — is pinned in test/settings-defaults-parity.test.js;
// what is pinned here is the row over that value.
//
// Needs Node >= 22.18 for the .ts import.
//
// Run: node --test test/tui-compaction-row.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ENDLESS_OWNS_CAUSE,
  NO_RELIEF_CAUSE,
  NO_THRESHOLD_CAUSE,
  compactionRowCause,
  compactionRowCell,
  compactionRowNote,
  compactionRowState,
  isPrimaryRole,
} from "../tui/src/compaction-row.ts"
import {
  DEFAULT_COMPACTION,
  DEFAULT_MAX_PRIMARY_CONTEXT,
  readSettings,
  setSettingsPath,
} from "../tui/src/settings-file.ts"
import { ROW_NOTE_INDENT } from "../tui/src/subagent-label.ts"

const dir = mkdtempSync(join(tmpdir(), "compaction-row-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setSettingsPath(file)
  delete process.env.OPENCODE_AGENT_INTERCOM_COMPACTION
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT
})

const write = (obj) => writeFileSync(file, JSON.stringify(obj))

// The row for one agent, off the file as it stands right now.
const stateFor = (agent, endlessInEffect = false) =>
  compactionRowState(readSettings(), agent, endlessInEffect)

test("the primary role is the one name outside the spawn gate's set", () => {
  assert.equal(isPrimaryRole("orchestrator"), true)
  assert.equal(isPrimaryRole("coder"), false)
  assert.equal(isPrimaryRole("researcher"), false)
})

test("an untouched agent shows the inherited default and no ★", () => {
  const state = stateFor("coder")
  assert.equal(state.on, DEFAULT_COMPACTION)
  assert.equal(state.source, "inherited")
  assert.equal(compactionRowCell(state), "[off]")
})

test("an agent with an entry of its own shows it and carries the ★ source", () => {
  write({ agentCompaction: { coder: true } })
  const own = stateFor("coder")
  assert.equal(own.on, true)
  assert.equal(own.source, "agent")
  assert.equal(compactionRowCell(own), "[on] ")

  // The type beside it keeps inheriting, so the ★ stays a statement about one
  // row and not about the map.
  const other = stateFor("reviewer")
  assert.equal(other.on, false)
  assert.equal(other.source, "inherited")
})

test("the flat key is what a type without an entry inherits", () => {
  write({ compaction: true, agentCompaction: { coder: false } })
  assert.deepEqual(
    [stateFor("reviewer").on, stateFor("reviewer").source],
    [true, "inherited"],
  )
  assert.deepEqual([stateFor("coder").on, stateFor("coder").source], [false, "agent"])
})

// The threshold half: which figure the row measures the switch against.

test("the primary's armed threshold is maxPrimaryContext while endless is not in effect", () => {
  assert.equal(stateFor("orchestrator").threshold, DEFAULT_MAX_PRIMARY_CONTEXT)
  write({ maxPrimaryContext: 40000 })
  assert.equal(stateFor("orchestrator").threshold, 40000)
})

test("endless mode in effect displaces the primary's threshold with endlessContext", () => {
  write({ maxPrimaryContext: 40000, endlessContext: 250000 })
  assert.equal(stateFor("orchestrator", true).threshold, 250000)
  assert.equal(stateFor("orchestrator", false).threshold, 40000)
})

test("a subagent's armed threshold is its own context budget", () => {
  write({ agentContext: { coder: 50000 } })
  assert.equal(stateFor("coder").threshold, 50000)
  // Endless mode is the primary's relief and moves no subagent threshold.
  assert.equal(stateFor("coder", true).threshold, 50000)
})

// The three note lines.

test("compaction on with no threshold armed says the driver is never reached", () => {
  write({ maxPrimaryContext: 0, agentCompaction: { orchestrator: true } })
  const state = stateFor("orchestrator")
  assert.equal(compactionRowCause(state), NO_THRESHOLD_CAUSE)
  assert.equal(compactionRowNote(state, 60), ROW_NOTE_INDENT + NO_THRESHOLD_CAUSE)
})

test("a subagent with a budget of 0 and compaction on says the same", () => {
  write({ agentContext: { coder: 0 }, agentCompaction: { coder: true } })
  assert.equal(compactionRowCause(stateFor("coder")), NO_THRESHOLD_CAUSE)
})

test("compaction on for the primary under a running endless mode says endless owns it", () => {
  write({ endlessContext: 250000, agentCompaction: { orchestrator: true } })
  assert.equal(compactionRowCause(stateFor("orchestrator", true)), ENDLESS_OWNS_CAUSE)
  // With the cycle not in effect the compaction owns the threshold and the row
  // owes nothing.
  assert.equal(compactionRowCause(stateFor("orchestrator", false)), "")
})

test("an endless cycle armed at 0 reads as no threshold, not as endless owning it", () => {
  write({ endlessContext: 0, agentCompaction: { orchestrator: true } })
  assert.equal(compactionRowCause(stateFor("orchestrator", true)), NO_THRESHOLD_CAUSE)
})

test("compaction off with nothing else armed says the primary will overflow", () => {
  write({ maxPrimaryContext: 0 })
  const state = stateFor("orchestrator")
  assert.equal(state.on, false)
  assert.equal(compactionRowCause(state), NO_RELIEF_CAUSE)
  assert.equal(compactionRowNote(state, 60), ROW_NOTE_INDENT + NO_RELIEF_CAUSE)
})

test("a handoff threshold is relief, so the off row says nothing", () => {
  write({ maxPrimaryContext: 80000 })
  assert.equal(compactionRowCause(stateFor("orchestrator")), "")
})

test("an endless cycle is relief too, so the off row says nothing", () => {
  write({ maxPrimaryContext: 0, endlessContext: 250000 })
  assert.equal(compactionRowCause(stateFor("orchestrator", true)), "")
})

test("a subagent with compaction off and no budget owes no line", () => {
  // Its run is bounded by the spawn that made it, not by this panel: the three
  // notes are about the reliefs this plugin drives.
  write({ agentContext: { coder: 0 } })
  assert.equal(compactionRowCause(stateFor("coder")), "")
})

test("a row with nothing to explain renders no note line at all", () => {
  write({ maxPrimaryContext: 80000, agentCompaction: { orchestrator: true } })
  assert.equal(compactionRowNote(stateFor("orchestrator"), 60), "")
})

test("the note is cut to what is left of the panel beside its indent", () => {
  write({ maxPrimaryContext: 0, agentCompaction: { orchestrator: true } })
  const note = compactionRowNote(stateFor("orchestrator"), 24)
  assert.ok(note.startsWith(ROW_NOTE_INDENT))
  assert.ok(note.length <= 24 - 2, `note fits the panel: ${JSON.stringify(note)}`)
  assert.ok(note.length < ROW_NOTE_INDENT.length + NO_THRESHOLD_CAUSE.length)
})

test("the env var is what an untouched file inherits on the row", () => {
  process.env.OPENCODE_AGENT_INTERCOM_COMPACTION = "1"
  const state = stateFor("coder")
  assert.equal(state.on, true)
  assert.equal(state.source, "inherited")
})
