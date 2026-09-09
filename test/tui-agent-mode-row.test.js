// Unit tests for the sidebar's `mode` row: the orchestrator/solo switch
// (tui/src/agent-mode.ts, written through tui/src/settings-file.ts into
// ~/.config/opencode/agent-intercom.json under the key `agentMode`).
//
// Every other switch in that panel is live — the plugin re-reads the settings
// file while it runs — so a click on one of them is cheap to take back. This one
// is not: the plugin latches `agentMode` at load, and the value written reaches
// only an opencode that is started again afterwards. So the row is a two-step
// question, and what is pinned here is that it stays one: the first click arms
// and writes NOTHING, only the second click inside the window writes, and an
// arming that has expired arms again instead of switching.
//
// The write itself is the read-modify-write every setting of this panel goes
// through: the value flipped is the one on disk at that moment, and no other key
// of the file is touched.
//
// Needs Node >= 22.18 for the .ts import.
//
// Run: node --test --test-timeout=5000 test/tui-agent-mode-row.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AGENT_MODES,
  AGENT_MODE_CELL_W,
  AGENT_MODE_CONFIRM_MS,
  AGENT_MODE_NOTE_LINES,
  DEFAULT_AGENT_MODE,
  agentModeNoteLines,
  agentModeRowCell,
  armingAfterAgentModeTimeout,
  decideAgentModeSwitch,
  isAgentMode,
  isAgentModeArmed,
  otherAgentMode,
} from "../tui/src/agent-mode.ts"
import {
  readAgentMode,
  readSettings,
  setAgentMode,
  setSettingsPath,
  toggleAgentMode,
  toggleEndlessMode,
} from "../tui/src/settings-file.ts"
import { ROW_NOTE_INDENT } from "../tui/src/subagent-label.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-agent-mode-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setSettingsPath(file)
})

const onDisk = () => JSON.parse(readFileSync(file, "utf8"))

// The row as the panel drives it: one click, against the arming it is holding
// and the clock the panel reads. Returns the arming the panel keeps afterwards
// and the mode now on disk, which is what its signal is set from.
function click(armed, nowMs) {
  const decision = decideAgentModeSwitch(armed, nowMs)
  if (decision.kind === "switch") {
    return { armed: undefined, mode: toggleAgentMode(), wrote: true }
  }
  return { armed: decision.armed, mode: readAgentMode(), wrote: false }
}

// ---------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------

test("the row has exactly two values and the orchestrator pattern is the default", () => {
  assert.deepEqual([...AGENT_MODES], ["orchestrator", "solo"])
  assert.equal(DEFAULT_AGENT_MODE, "orchestrator")
  assert.equal(otherAgentMode("orchestrator"), "solo")
  assert.equal(otherAgentMode("solo"), "orchestrator")
})

test("only the two exact strings count as a mode", () => {
  for (const mode of AGENT_MODES) assert.equal(isAgentMode(mode), true)
  for (const bad of ["Solo", "ORCHESTRATOR", "", " solo", 0, 1, true, null, undefined, {}, ["solo"]]) {
    assert.equal(isAgentMode(bad), false, `accepted ${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// Armed, confirmed, disarmed
// ---------------------------------------------------------------------------

test("the first click arms the row and writes nothing", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 2 }))

  const first = click(undefined, 1000)

  assert.equal(first.wrote, false)
  assert.deepEqual(first.armed, { armedAt: 1000 })
  assert.equal(isAgentModeArmed(first.armed, 1000), true)
  // The mode is untouched, and the key is not even in the file yet.
  assert.equal(first.mode, "orchestrator")
  assert.deepEqual(onDisk(), { maxSubagents: 2 })
})

test("the second click inside the window switches and writes the other value", () => {
  const first = click(undefined, 1000)
  const second = click(first.armed, 1000 + AGENT_MODE_CONFIRM_MS - 1)

  assert.equal(second.wrote, true)
  assert.equal(second.mode, "solo")
  assert.equal(second.armed, undefined)
  assert.deepEqual(onDisk(), { agentMode: "solo" })
  assert.equal(readAgentMode(), "solo")
})

test("a click after the window has passed arms again instead of switching", () => {
  const first = click(undefined, 1000)
  const late = click(first.armed, 1000 + AGENT_MODE_CONFIRM_MS)

  assert.equal(late.wrote, false)
  assert.deepEqual(late.armed, { armedAt: 1000 + AGENT_MODE_CONFIRM_MS })
  assert.equal(readAgentMode(), "orchestrator")
  assert.equal(existsSync(file), false, "an armed row wrote a file")

  // And the click after THAT one, inside the fresh window, switches.
  const confirm = click(late.armed, 1000 + AGENT_MODE_CONFIRM_MS + 1)
  assert.equal(confirm.wrote, true)
  assert.equal(confirm.mode, "solo")
})

test("a disarmed row starts the question over rather than switching", () => {
  const first = click(undefined, 1000)
  // Escape, or any other interaction in the sidebar: the panel drops the
  // arming and hands undefined to the next click.
  const afterDisarm = click(undefined, 1000 + 10)

  assert.equal(afterDisarm.wrote, false)
  assert.deepEqual(afterDisarm.armed, { armedAt: 1010 })
  assert.equal(readAgentMode(), "orchestrator")
  assert.notEqual(first.armed, undefined)
})

test("the arming lives exactly to the confirm window and a clock jump does not expire it", () => {
  const armed = { armedAt: 1000 }
  assert.equal(isAgentModeArmed(armed, 1000), true)
  assert.equal(isAgentModeArmed(armed, 1000 + AGENT_MODE_CONFIRM_MS - 1), true)
  assert.equal(isAgentModeArmed(armed, 1000 + AGENT_MODE_CONFIRM_MS), false)
  // Stamped in the future by a clock that jumped: still live, not expired.
  assert.equal(isAgentModeArmed(armed, 900), true)
  assert.equal(isAgentModeArmed(undefined, 1000), false)

  assert.deepEqual(armingAfterAgentModeTimeout(armed, 1000 + 10), armed)
  assert.equal(armingAfterAgentModeTimeout(armed, 1000 + AGENT_MODE_CONFIRM_MS), undefined)
  assert.equal(armingAfterAgentModeTimeout(undefined, 1000), undefined)
})

// ---------------------------------------------------------------------------
// What the row and its note show
// ---------------------------------------------------------------------------

test("the cell shows the value in effect, and the pending one while armed", () => {
  assert.equal(agentModeRowCell("orchestrator").trimEnd(), "[orchestrator]")
  assert.equal(agentModeRowCell("solo").trimEnd(), "[solo]")
  assert.equal(agentModeRowCell("orchestrator", true).trimEnd(), "[solo?]")
  assert.equal(agentModeRowCell("solo", true).trimEnd(), "[orchestrator?]")
  // One width for every state, so the row does not jump as it is clicked.
  for (const mode of AGENT_MODES) {
    for (const armed of [false, true]) {
      assert.equal(
        agentModeRowCell(mode, armed).length,
        AGENT_MODE_CELL_W,
        `${mode}/${armed} does not fill the cell`,
      )
    }
  }
})

test("the note under an armed row names the restart and asks for the second click", () => {
  const lines = agentModeNoteLines(42)
  assert.equal(lines.length, AGENT_MODE_NOTE_LINES.length)
  for (const line of lines) assert.ok(line.startsWith(ROW_NOTE_INDENT), `not indented: ${line}`)
  const text = lines.join(" ")
  assert.match(text, /opencode restart/)
  assert.match(text, /click again/)
  // Cut to the panel, the way the endless pause's cause is.
  for (const line of agentModeNoteLines(20)) assert.ok(line.length <= 20)
  assert.deepEqual(agentModeNoteLines(4), [])
})

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

test("the switch writes only its own key and leaves the rest as it found it", () => {
  writeFileSync(
    file,
    JSON.stringify({
      maxSubagents: 2,
      endlessMode: false,
      searxngUrl: "http://host:8080",
    }),
  )

  assert.equal(toggleAgentMode(), "solo")

  assert.deepEqual(onDisk(), {
    maxSubagents: 2,
    endlessMode: false,
    searxngUrl: "http://host:8080",
    agentMode: "solo",
  })
})

test("the switch flips the value the file holds, not the panel's copy", () => {
  // Mount: the panel reads the default into its signal.
  writeFileSync(file, JSON.stringify({}))
  assert.equal(readAgentMode(), "orchestrator")

  // Set to solo outside the panel, by hand.
  writeFileSync(file, JSON.stringify({ agentMode: "solo" }))

  // A flip of the panel's stale copy would have written "solo" a second time.
  assert.equal(toggleAgentMode(), "orchestrator")
  assert.deepEqual(onDisk(), { agentMode: "orchestrator" })
})

test("a value the plugin would not accept reads as the default and is dropped by the next write", () => {
  writeFileSync(file, JSON.stringify({ agentMode: "Solo", maxSubagents: 2 }))
  assert.equal(readAgentMode(), DEFAULT_AGENT_MODE)

  // A write of another setting must not leave a mode standing that is not in
  // effect while the row shows the default.
  toggleEndlessMode()
  assert.equal("agentMode" in onDisk(), false)
})

test("an unreadable file leaves the mode at the default and the file untouched", () => {
  writeFileSync(file, "{ not json")
  assert.equal(readAgentMode(), DEFAULT_AGENT_MODE)
  assert.equal(toggleAgentMode(), DEFAULT_AGENT_MODE)
  assert.equal(readFileSync(file, "utf8"), "{ not json")
})

test("setAgentMode writes the value it is given and the key stays absent until it does", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 2 }))
  assert.equal("agentMode" in onDisk(), false)

  assert.equal(setAgentMode("solo"), "solo")
  assert.deepEqual(onDisk(), { maxSubagents: 2, agentMode: "solo" })

  assert.equal(setAgentMode("solo"), "solo")
  assert.deepEqual(onDisk(), { maxSubagents: 2, agentMode: "solo" })
})

// ---------------------------------------------------------------------------
// It is not one of the live settings
// ---------------------------------------------------------------------------

test("agentMode is no member of the settings the panel resolves live", () => {
  writeFileSync(file, JSON.stringify({ agentMode: "solo" }))
  const settings = readSettings()
  assert.equal("agentMode" in settings, false)
  // ...and the live settings are untouched by it: the row over agentMode says
  // it needs a restart, the rows over these do not.
  assert.equal(settings.endlessMode, true)
  assert.equal(readAgentMode(), "solo")
})

test("a live setting written afterwards keeps the mode the user chose", () => {
  assert.equal(toggleAgentMode(), "solo")
  toggleEndlessMode()
  assert.equal(readAgentMode(), "solo")
  assert.equal(onDisk().endlessMode, false)
})
