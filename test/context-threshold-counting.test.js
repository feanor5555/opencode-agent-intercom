// The comparison path the endless/plain-handoff threshold rides on.
//
// Two things are pinned here:
//   1. the counted figure — `latestContextTokens` (src/context-figure.js)
//      counts reasoning tokens, so the number the threshold is tested against
//      is the number the TUI displays (input + output + reasoning +
//      cache.read + cache.write), while an in-flight step (no output yet —
//      the selection opencode itself makes) is walked past even when it
//      already carries reasoning, and the compaction stop still answers
//      undefined;
//   2. the two silent holes closed with a log line each:
//      - the snapshot fetch that yields no figure (src/hooks.js records the
//        undefined and says so), and the later turn where a positive
//        threshold fails `shouldTriggerPrimaryHandoff` against no cached
//        figure (src/registry.js);
//      - the paused primary that arms nothing (both the transform branch in
//        src/hooks.js and the guard in scheduleEndlessIfNeeded, src/registry.js).
//
// LOG_PATH is read at module load (src/log.js), so the debug log is redirected
// by setting OPENCODE_AGENT_INTERCOM_DEBUG_LOG before the first dynamic import.
// Nothing here writes the machine's own ~/.cache log.
//
// Run: node --test --test-timeout=8000 test/context-threshold-counting.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const logDir = mkdtempSync(join(tmpdir(), "intercom-ctx-threshold-log-"))
const logFile = join(logDir, "debug.log")
process.env.OPENCODE_AGENT_INTERCOM_DEBUG_LOG = logFile
process.env.OPENCODE_AGENT_INTERCOM_DEBUG = "1"
// The pause map publishes to $HOME/.cache; keep it off the machine's own file.
process.env.HOME = logDir

const { fetchSnapshot } = await import("../src/client.js")
const {
  recordPrimaryContext,
  shouldTriggerPrimaryHandoff,
  scheduleEndlessIfNeeded,
  pauseEndless,
  hasEndlessPending,
} = await import("../src/registry.js")
const { resetState } = await import("../src/state.js")

function logText() {
  try {
    return readFileSync(logFile, "utf8")
  } catch {
    return ""
  }
}

function msgWithTokens(tokens, extra = {}) {
  return { info: { role: "assistant", tokens, ...extra }, parts: [] }
}

function clientReturning(messages) {
  return { session: { messages: async () => ({ data: messages }) } }
}

// ---------------------------------------------------------------------------
// 1. The counted figure includes reasoning
// ---------------------------------------------------------------------------

test("latestContextTokens counts reasoning into the figure (fetchSnapshot.ctxTokens)", async () => {
  const snap = await fetchSnapshot(
    clientReturning([
      msgWithTokens({ input: 10 }),
      msgWithTokens({ input: 100, output: 5, reasoning: 4000, cache: { read: 10, write: 2 } }),
    ]),
    "s-reason",
  )
  // 100 + 5 + 4000 + 10 + 2 — the sum the TUI sidebar and prompt bar show.
  assert.equal(snap.ctxTokens, 4117)
})

test("an in-flight step carrying only reasoning is not a figure", async () => {
  const snap = await fetchSnapshot(
    clientReturning([
      msgWithTokens({ input: 200, output: 8, reasoning: 300 }),
      msgWithTokens({ input: 0, output: 0, reasoning: 42, cache: { read: 0, write: 0 } }),
    ]),
    "s-inflight",
  )
  // The newest message is mid-turn: it has emitted no output yet, so under
  // opencode's own selection it is walked past — even carrying reasoning.
  // The returned figure is the completed turn's, reasoning counted:
  // 200 + 8 + 300 = 508.
  assert.equal(snap.ctxTokens, 508)
})

test("the compaction stop still answers undefined with reasoning present", async () => {
  const snap = await fetchSnapshot(
    clientReturning([
      msgWithTokens({ input: 5000, reasoning: 2000 }),
      msgWithTokens({ input: 1, reasoning: 1 }, { summary: true }),
    ]),
    "s-compacted",
  )
  assert.equal(snap.ctxTokens, undefined)
})

test("a threshold of 4117 crosses on a 4117 figure the display also shows", () => {
  resetState()
  recordPrimaryContext("s-cross", 4117)
  assert.equal(shouldTriggerPrimaryHandoff("s-cross", 4118), false)
  assert.equal(shouldTriggerPrimaryHandoff("s-cross", 4117), true)
})

// ---------------------------------------------------------------------------
// 2a. The no-figure hole: a positive threshold armed against no cached figure
// ---------------------------------------------------------------------------

test("shouldTriggerPrimaryHandoff logs when a threshold stands armed against no figure", () => {
  resetState()
  // No measurement at all, then one recorded as undefined (the shape a
  // snapshot with no completed assistant step leaves behind).
  assert.equal(shouldTriggerPrimaryHandoff("s-nofig", 80_000), false)
  recordPrimaryContext("s-nofig-2", undefined)
  assert.equal(shouldTriggerPrimaryHandoff("s-nofig-2", 80_000), false)

  const text = logText()
  assert.match(
    text,
    /primary threshold armed but no cached context figure \{"sessionID":"s-nofig","threshold":80000,"cached":"absent"\}/,
  )
  assert.match(
    text,
    /primary threshold armed but no cached context figure \{"sessionID":"s-nofig-2","threshold":80000,"cached":"absent"\}/,
  )
})

test("a positive threshold does not log for a disabled threshold or a numeric figure", () => {
  resetState()
  writeFileSync(logFile, "")
  recordPrimaryContext("s-quiet", 500)
  assert.equal(shouldTriggerPrimaryHandoff("s-quiet", 0), false)
  assert.equal(shouldTriggerPrimaryHandoff("s-missing-threshold", 80_000) === false, true)
  // s-missing-threshold has no figure either — that one must log; assert the
  // pair apart so this line pins both halves.
  assert.doesNotMatch(logText(), /"sessionID":"s-quiet"/)
  assert.match(logText(), /"sessionID":"s-missing-threshold"/)
})

// ---------------------------------------------------------------------------
// 2b. The paused primary: endless arms nothing, and says so
// ---------------------------------------------------------------------------

test("scheduleEndlessIfNeeded names the pause instead of returning false in silence", () => {
  resetState()
  const SID = "s-paused-gate"
  recordPrimaryContext(SID, 100_000)
  pauseEndless(SID, "no open points left — paused for this session")

  assert.equal(scheduleEndlessIfNeeded(SID, 50_000), false)
  assert.equal(hasEndlessPending(SID), false)

  assert.match(
    logText(),
    /endless: cycle cannot arm — paused for this session \{"sessionID":"s-paused-gate","threshold":50000,"reason":"no open points left — paused for this session"\}/,
  )
})

test("an unpaused over-threshold primary arms with no pause line", () => {
  resetState()
  writeFileSync(logFile, "")
  const SID = "s-unpaused"
  recordPrimaryContext(SID, 100_000)
  assert.equal(scheduleEndlessIfNeeded(SID, 50_000), true)
  assert.doesNotMatch(logText(), /cycle cannot arm/)
})
