// The wrap-up band of the RUN clock, and the wake notice the reap behind it
// sends.
//
// The band fires from RUN_WRAP_UP (0.75) of the run ceiling on, out of the same
// per-turn path as the three context bands and onto the same tail carrier. It
// denies nothing and demands nothing: the plugin cannot tell a wait that is
// about to pay off from one that never will, so it announces the ceiling and
// names the two moves the subagent has — hand back with `Blocked:`, or `ask`
// the caller whether to keep waiting.
//
// The notice at the other end says which window fired. "No sign of life" is
// false on the run path — that subagent may have been working the whole time —
// and the orchestrator's next move differs.
//
// Run: node --test test/run-wrap-up-band.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { entryForSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { timeoutNotice } from "../src/notices.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-run-band-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// A ceiling of 40 minutes: the band opens at 30 minutes.
const CEILING = 2_400_000
const BAND_AT = 1_800_000

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx() {
  let counter = 0
  const created = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

// One spawned subagent whose run started `elapsedMs` ago, under `settings`.
async function runningFor(elapsedMs, settings = { maxSubagentRunMs: CEILING }) {
  writeFileSync(settingsFile, JSON.stringify(settings))
  resetSettings()
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  const entry = entryForSession(sessionID)
  entry.runStartedAt = Date.now() - elapsedMs
  return { hooks, sessionID, entry }
}

// The shape a subagent's array has after its first request: the task prompt as
// message 0, then the assistant messages carrying its tool results.
function subagentHistory(sessionID) {
  return [
    {
      info: { id: "msg_task", role: "user", sessionID, time: { created: 1 } },
      parts: [{ type: "text", text: "task" }],
    },
    {
      info: { id: "msg_a1", role: "assistant", sessionID, time: { created: 2 } },
      parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: "no file" } }],
    },
  ]
}

const run = (hooks, messages) =>
  hooks["experimental.chat.messages.transform"]({}, { messages })

// Every synthetic text the plugin left anywhere on the array.
const syntheticText = (messages) =>
  messages
    .flatMap((m) => m?.parts ?? [])
    .filter((p) => p?.synthetic)
    .map((p) => p.text)
    .join("")

// The other per-turn blocks — here the delegating role's nested-spawn quota —
// ride on the same carrier, so what is asserted is the absence of THIS band.
test("nothing is said below the band", async () => {
  const { hooks, sessionID, entry } = await runningFor(BAND_AT - 60_000)
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  assert.doesNotMatch(
    syntheticText(messages),
    /RUN CEILING/,
    "a run inside three quarters of its ceiling is left alone",
  )
  assert.equal(entry.runWarnings, 0)
})

test("from 0.75 on the band names the clock and the two moves", async () => {
  const { hooks, sessionID, entry } = await runningFor(BAND_AT + 60_000)
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  const text = syntheticText(messages)
  assert.match(text, /RUN CEILING AHEAD/)
  assert.match(text, /31 min of the 40 min run ceiling/)
  assert.match(text, /about 9 min left/)
  assert.match(text, /maxSubagentRunMs/)
  assert.match(text, /"Blocked:"/, "move 1: hand back with what it is waiting for")
  assert.match(text, /`ask\(\.\.\.\)`/, "move 2: put the question to the caller")
  assert.match(text, /Nothing is denied on this turn/)
  assert.equal(entry.runWarnings, 1, "the turn is counted")

  // It rides at the TAIL, where the subagent's latest work is — its message 0
  // is the task prompt and keeps the single part it came with.
  assert.equal(messages[0].parts.length, 1)
  assert.equal(messages[0].parts[0].text, "task")
  assert.match(messages[messages.length - 1].parts[0].text, /RUN CEILING AHEAD/)
})

test("the band denies nothing — the tool call of that same turn still runs", async () => {
  const { hooks, sessionID } = await runningFor(BAND_AT + 60_000)
  await run(hooks, subagentHistory(sessionID))

  const admitted = await hooks["tool.execute.before"]({
    tool: "bash",
    sessionID,
    callID: "c1",
  })
  assert.equal(admitted, undefined, "an admitted call returns without a refusal")
  assert.equal(entryForSession(sessionID).toolCalls.size, 1, "and is in flight")
})

test("the band re-fires on every crossing turn", async () => {
  const { hooks, sessionID, entry } = await runningFor(BAND_AT + 60_000)
  await run(hooks, subagentHistory(sessionID))
  await run(hooks, subagentHistory(sessionID))

  assert.equal(entry.runWarnings, 2, "the block lives one request and has to be said again")
})

test("a type with no ceiling is told of none", async () => {
  const { hooks, sessionID, entry } = await runningFor(BAND_AT + 60_000, { maxSubagentRunMs: 0 })
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  assert.doesNotMatch(syntheticText(messages), /RUN CEILING/)
  assert.equal(entry.runWarnings, 0)
})

// With the inactivity watchdog off the sweep's whole running branch is skipped,
// the run ceiling included, so a band here would announce a cut that is not
// coming.
test("the watchdog switched off takes the band with it", async () => {
  const { hooks, sessionID, entry } = await runningFor(BAND_AT + 60_000, {
    maxSubagentAgeMs: 0,
    maxSubagentRunMs: CEILING,
  })
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  assert.doesNotMatch(syntheticText(messages), /RUN CEILING/)
  assert.equal(entry.runWarnings, 0)
})

test("a per-type ceiling is what the band counts against", async () => {
  const { hooks, sessionID } = await runningFor(BAND_AT + 60_000, {
    maxSubagentRunMs: CEILING,
    agentRunMs: { researcher: 7_200_000 },
  })
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  assert.doesNotMatch(
    syntheticText(messages),
    /RUN CEILING/,
    "31 minutes is nothing against a two-hour ceiling",
  )
})

// ---- the wake notice --------------------------------------------------------

const entryFor = () => ({
  handle: "researcher#1",
  agent: "researcher",
  sessionID: "ses_sub1",
  lastActivity: "[tool: bash] sleep 20",
})

test("the timeout notice names the run ceiling rather than a silence", () => {
  const limit = { ms: 2_400_000, setting: "maxSubagentRunMs", kind: "run", since: 1 }
  const text = timeoutNotice(entryFor(), limit, 2_400_500, "", undefined)

  assert.match(text, /ran for 2401s \(limit 2400s, maxSubagentRunMs\) and was cut off on its run ceiling/)
  assert.doesNotMatch(text, /no sign of life/)
  assert.match(text, /nothing it did could renew it/)
  assert.match(text, /agentRunMs/, "the per-type escape hatch is named")
})

test("the two older windows keep their own wording", () => {
  const silence = timeoutNotice(
    entryFor(),
    { ms: 90_000, setting: "maxSubagentAgeMs", kind: "silence" },
    91_000,
    "",
    undefined,
  )
  assert.match(silence, /gave no sign of life for 91s/)

  const toolCall = timeoutNotice(
    entryFor(),
    { ms: 660_000, setting: "maxSubagentToolCallMs", kind: "tool-call", tool: "bash" },
    661_000,
    "",
    undefined,
  )
  assert.match(toolCall, /spent 661s inside a single `bash` tool call/)
})
