// The two ways endless mode can stop, and the line between them.
//
//   - The USER switches it off in the sidebar. That is a decision about the
//     installation: it is written to ~/.config/opencode/agent-intercom.json and
//     outlives the session, the process and the restart.
//   - The MODE stops ITSELF — the cycle ceiling, the no-progress bound, a cycle
//     that found nothing left to do. That is a decision about one run, and it
//     writes NOTHING. `endlessMode` is on by default, so a self-stop that
//     persisted `false` would silently disable that default for good on its
//     first firing.
//
// What a self-stop leaves behind is a runtime pause on ONE primary session
// (registry.pauseEndless): it holds the still-over-threshold primary back from
// re-arming the latch on its very next turn, and it dies with that session, so
// the orchestrator that takes over has the mode available again.
//
// The cycle-level coverage of each stop lives in test/endless-cycle.test.js and
// the hook-level coverage in test/endless-wiring.test.js; what is pinned here
// is the file on disk after each stop, the pause's own semantics, and that the
// user's half of the switch still writes.
//
// Run: node --test --test-timeout=5000 test/endless-pause.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetState, endlessProgress, endlessPauses } from "../src/state.js"
import {
  markEndlessPending,
  claimPendingEndless,
  releaseEndless,
  setEndlessCooldown,
  pauseEndless,
  isEndlessPaused,
  endlessPauseReason,
  clearEndlessPause,
  scheduleEndlessIfNeeded,
  scheduleHandoffIfNeeded,
  hasHandoffPending,
  recordPrimaryContext,
  recordEndlessCycle,
  forgetPrimary,
  beginHandoffDrain,
  bindHandoffDrainTarget,
  flushHandoffDrain,
  handoffGeneration,
} from "../src/registry.js"
import { runEndlessCycle, ENDLESS_MAX_STALLED_CYCLES } from "../src/endless.js"
import {
  getSettings,
  setSettingsPath,
  resetSettings,
  primaryContextThreshold,
} from "../src/settings.js"
import { addTask, listOpen, TodoFileMissingError } from "../src/todofile.js"
import {
  setSettingsPath as setTuiSettingsPath,
  readSettings as readTuiSettings,
  toggleEndlessMode,
} from "../tui/src/settings-file.ts"

const SID = "ses-endless-pause"
const NEW_SID = "ses-endless-pause-new"

// The settings file as a user with a hand-tuned installation has it: endless
// mode explicitly on, plus keys no self-stop may touch.
const USER_FILE = {
  endlessMode: true,
  maxSubagents: 3,
  searxngUrl: "http://searx:8080",
  unknownKeyTheUserAdded: 42,
}

test.beforeEach(() => {
  resetState()
  resetSettings()
})

function tempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-endless-pause-"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

// A settings file the server half resolves from, plus a byte-and-mtime
// snapshot of it. A self-stop must leave both standing.
function settingsFixture(content = USER_FILE) {
  const file = join(tempProject(), "agent-intercom.json")
  writeFileSync(file, JSON.stringify(content, null, 2) + "\n")
  setSettingsPath(file)
  resetSettings()
  const st = statSync(file)
  return { file, bytes: readFileSync(file, "utf8"), stamp: `${st.mtimeMs}:${st.size}` }
}

function assertUntouched(fixture, what) {
  const st = statSync(fixture.file)
  assert.equal(readFileSync(fixture.file, "utf8"), fixture.bytes, `${what}: the file changed`)
  assert.equal(`${st.mtimeMs}:${st.size}`, fixture.stamp, `${what}: the file was rewritten`)
  resetSettings()
  assert.equal(
    getSettings().endlessMode,
    true,
    `${what}: the mode reads off after a stop that must not persist`,
  )
}

// One cycle wired the way handoffwiring.js wires it, with the REAL pause and
// the REAL todo file, virtual time and a recording handoff.
function makeCycle({ directory, overrides = {} } = {}) {
  const state = { handoffCalls: [], toasts: [], clock: 0 }
  markEndlessPending(SID)
  const io = {
    primarySessionID: SID,
    claim: () => claimPendingEndless(SID),
    release: () => releaseEndless(SID),
    setCooldown: () => setEndlessCooldown(SID),
    isQuiesced: async () => true,
    countActive: () => 0,
    requestOpenPoints: async () =>
      "## OPEN POINTS\n\n- Finish the migration script\n  accept: it exits 0\n",
    addTask: (point) => addTask(directory, point),
    listOpen: () => {
      try {
        return listOpen(directory)
      } catch (err) {
        if (err instanceof TodoFileMissingError && err.kind === "missing") return []
        throw err
      }
    },
    todoFileName: () => "TODO.md",
    performHandoff: async (args) => {
      state.handoffCalls.push(args)
      return { newSessionID: NEW_SID }
    },
    cycleNumber: 1,
    maxCycles: 10,
    pause: (id, reason) => pauseEndless(id, reason),
    recordCycle: (n) => recordEndlessCycle(n),
    toast: (t) => state.toasts.push(t),
    quiesceTimeoutMs: 600_000,
    pollMs: 500,
    sleep: async (ms) => {
      state.clock += ms
    },
    now: () => state.clock,
    ...overrides,
  }
  return { io, state }
}

// ---------------------------------------------------------------------------
// Each self-stop: the settings file stays byte-identical
// ---------------------------------------------------------------------------

test("the cycle ceiling pauses and leaves the settings file untouched", async () => {
  const fixture = settingsFixture()
  const { io, state } = makeCycle({
    directory: tempProject(),
    overrides: { cycleNumber: 11, maxCycles: 10 },
  })

  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "ceiling")
  assert.equal(state.handoffCalls.length, 0)
  assertUntouched(fixture, "the ceiling")
  assert.equal(isEndlessPaused(SID), true)
  assert.match(endlessPauseReason(SID), /cycle ceiling reached \(10\/10\)/)
})

test("nothing left to do pauses and leaves the settings file untouched", async () => {
  const fixture = settingsFixture()
  const { io, state } = makeCycle({
    directory: tempProject(),
    overrides: { requestOpenPoints: async () => "## OPEN POINTS\n" },
  })

  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "no-open-points")
  assert.equal(state.handoffCalls.length, 0)
  assertUntouched(fixture, "nothing left to do")
  assert.equal(isEndlessPaused(SID), true)
  assert.match(endlessPauseReason(SID), /no open points left/)
})

test("the no-progress bound pauses the NEW primary and leaves the settings file untouched", async () => {
  const fixture = settingsFixture()
  const dir = tempProject({ "TODO.md": "- T1: still open\n" })
  // The streak the bound reads: two earlier cycles that already found the same
  // one open task, so the cycle below is the second consecutive stall.
  recordEndlessCycle(1)
  recordEndlessCycle(1)
  const { io, state } = makeCycle({ directory: dir })

  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "complete")
  assert.equal(state.handoffCalls.length, 1, "a cycle past the save is not undone by the bound")
  assert.ok(res.stalledCycles >= ENDLESS_MAX_STALLED_CYCLES)
  assertUntouched(fixture, "the no-progress bound")
  assert.equal(
    isEndlessPaused(NEW_SID),
    true,
    "the bound fires after the replacement, so the pause goes on the session that inherited the loop",
  )
  assert.equal(isEndlessPaused(SID), false, "the retired primary schedules nothing either way")
  assert.equal(
    endlessProgress.stalledCycles,
    0,
    "the streak that ended this run is not inherited by the next one",
  )
})

test("an abandoned cycle neither writes nor pauses — it arms the cooldown", async () => {
  const fixture = settingsFixture()
  const { io } = makeCycle({
    directory: tempProject(),
    overrides: {
      isQuiesced: async () => false,
      quiesceTimeoutMs: 0,
    },
  })

  const res = await runEndlessCycle(io)

  assert.equal(res.outcome, "abandoned")
  assertUntouched(fixture, "an abandoned cycle")
  assert.equal(isEndlessPaused(SID), false, "an abandon is a retry after the cooldown, not a stop")
})

// ---------------------------------------------------------------------------
// The user's half of the switch still persists
// ---------------------------------------------------------------------------

test("the user's switch-off in the sidebar writes the file and the server half reads it", () => {
  const fixture = settingsFixture()
  setTuiSettingsPath(fixture.file)

  assert.equal(readTuiSettings().endlessMode, true)
  const merged = toggleEndlessMode()

  assert.equal(merged.endlessMode, false, "the sidebar flips the value the file holds")
  const onDisk = JSON.parse(readFileSync(fixture.file, "utf8"))
  assert.equal(onDisk.endlessMode, false, "a user switch-off persists")
  assert.equal(onDisk.maxSubagents, 3, "and carries every other key over untouched")
  assert.equal(onDisk.unknownKeyTheUserAdded, 42)

  resetSettings()
  assert.equal(getSettings().endlessMode, false, "the server half resolves the user's decision")
  assert.equal(
    primaryContextThreshold(),
    getSettings().maxPrimaryContext,
    "and the plain handoff owns the threshold again",
  )
})

// ---------------------------------------------------------------------------
// What the pause itself does
// ---------------------------------------------------------------------------

test("the pause suppresses the re-arm within the session and lifts on demand", () => {
  settingsFixture()
  recordPrimaryContext(SID, 300_000)
  assert.equal(scheduleEndlessIfNeeded(SID, 250_000), true, "an unpaused primary arms")
  resetState()

  recordPrimaryContext(SID, 300_000)
  pauseEndless(SID, "no open points left — paused for this session")
  assert.equal(
    scheduleEndlessIfNeeded(SID, 250_000),
    false,
    "the primary is still over the threshold and must not loop on the next idle",
  )
  assert.equal(scheduleEndlessIfNeeded(SID, 250_000), false, "on every following turn too")

  clearEndlessPause(SID)
  assert.equal(scheduleEndlessIfNeeded(SID, 250_000), true, "and the mode is available again")
})

test("a new primary session starts with the mode available", () => {
  pauseEndless(SID, "cycle ceiling reached (10/10) — paused for this session")
  recordPrimaryContext(NEW_SID, 300_000)

  assert.equal(isEndlessPaused(NEW_SID), false, "the pause is keyed by session, not by process")
  assert.equal(scheduleEndlessIfNeeded(NEW_SID, 250_000), true)
})

test("the pause dies with the primary a handoff retired", () => {
  pauseEndless(SID, "no open points left — paused for this session")
  assert.equal(isEndlessPaused(SID), true)

  // What the handoff's step 9 runs on the session it replaced.
  forgetPrimary(SID)

  assert.equal(isEndlessPaused(SID), false)
  assert.equal(endlessPauseReason(SID), "")
})

test("a pause resets the cross-cycle progress record", () => {
  recordEndlessCycle(4)
  recordEndlessCycle(4)
  assert.equal(endlessProgress.stalledCycles, 1)

  pauseEndless(SID, "cycle ceiling reached (10/10) — paused for this session")

  assert.equal(endlessProgress.stalledCycles, 0)
  assert.equal(
    endlessProgress.lastOpenTasks,
    null,
    "the record measures one run of the mode, and this run has stopped",
  )
})

// ---------------------------------------------------------------------------
// What the pause does NOT stop: the session's relief from its own context
// ---------------------------------------------------------------------------

test("a paused primary is handed to the plain handoff, and nothing is written to get there", () => {
  const fixture = settingsFixture({
    ...USER_FILE,
    maxPrimaryContext: 80000,
    endlessContext: 250000,
  })
  recordPrimaryContext(SID, 100_000)

  // Unpaused: endlessContext owns the threshold, and 100k is under it — this is
  // the state the pause must not leave standing, because the cycle it waits for
  // is the one thing a paused primary never runs.
  assert.equal(primaryContextThreshold({ endlessPaused: isEndlessPaused(SID) }), 250_000)
  assert.equal(
    scheduleHandoffIfNeeded(SID, primaryContextThreshold({ endlessPaused: isEndlessPaused(SID) })),
    false,
  )

  pauseEndless(SID, "cycle ceiling reached (10/10) — paused for this session")

  const threshold = primaryContextThreshold({ endlessPaused: isEndlessPaused(SID) })
  assert.equal(threshold, 80_000, "the plain threshold owns a paused primary")
  assert.equal(scheduleHandoffIfNeeded(SID, threshold), true, "and 100k is over it")
  assert.equal(hasHandoffPending(SID), true)
  assert.equal(
    scheduleEndlessIfNeeded(SID, 250_000),
    false,
    "while the cycle stays refused — the pause bounds the loop, not the handoff",
  )
  assertUntouched(fixture, "a paused primary handed to the plain handoff")
})

test("the pause is in-process only — nothing on disk carries it into a fresh process", () => {
  const fixture = settingsFixture()
  recordPrimaryContext(SID, 300_000)
  pauseEndless(SID, "no open points left — paused for this session")

  assert.equal(endlessPauses.size, 1, "the whole record of the stop is one map row")
  assertUntouched(fixture, "the pause itself")

  // What a restart leaves: the process state is gone, the file never held it.
  resetState()
  resetSettings()

  assert.equal(isEndlessPaused(SID), false)
  assert.equal(getSettings().endlessMode, true)
  assert.equal(
    primaryContextThreshold({ endlessPaused: isEndlessPaused(SID) }),
    getSettings().endlessContext,
    "a fresh process arms endless mode again — the stop bound one run, not the installation",
  )
})

test("the successor of a paused primary inherits the cycle ceiling's count", () => {
  // The pause dies with the session the plain handoff retires, so the successor
  // has the mode available again — by design. What keeps that from being a way
  // around the ceiling: every handoff, plain or endless, records the redirect
  // (buildPrimaryHandoffDeps supplies the same drain to both paths), and
  // handoffGeneration counts the chain, so the successor's first cycle is
  // counted against endlessMaxCycles rather than starting from one.
  pauseEndless(SID, "cycle ceiling reached (10/10) — paused for this session")
  assert.equal(handoffGeneration(SID), 1)

  // What the plain handoff runs on the way out: open the drain, bind the new
  // primary, flush.
  beginHandoffDrain(SID)
  bindHandoffDrainTarget(SID, NEW_SID)
  flushHandoffDrain(SID)
  forgetPrimary(SID)

  assert.equal(isEndlessPaused(NEW_SID), false, "the successor has the mode again")
  assert.equal(
    handoffGeneration(NEW_SID),
    2,
    "and the chain it continues is one generation longer, so the ceiling keeps counting",
  )
})
