// WHERE the per-turn notice sits on the message array opencode is about to
// convert into the provider request.
//
// A subagent has exactly one user message — its task prompt, message 0 —
// because opencode files tool results as parts of the ASSISTANT message. The
// notice therefore travels in a carrier message appended at the TAIL of the
// array, next to the model's latest work, and every band goes that same way.
// The primary keeps its placement on its last user message, which is the tail
// at the start of a turn and is memoised for the steps of its tool loop.
//
// Run: node --test test/turn-notice-placement.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, aborted } from "../src/state.js"
import { trackPrimary } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-placement-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// A budget of 10000 tokens for `coder`: the plan band opens at 7000
// (CTX_NEAR_BUDGET), the reserve band at 9000 (CTX_STOP_RESERVE) and the
// lockdown — or the compaction HOLD — at 10000.
const BUDGET = 10000
const PLAN_AT = 7000
const RESERVE_AT = 9000

function makeCtx({ ctxTokens = 1000 } = {}) {
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
      summarize: async () => ({ data: true }),
      messages: async () => ({
        data: [
          { info: { role: "assistant", tokens: { input: ctxTokens, output: 0 } }, parts: [] },
        ],
      }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

// Spawns one `coder` subagent whose session reports `ctxTokens`, with the
// budget armed and compaction off unless the caller asks for it.
async function subagentAt(ctxTokens, { compaction = false, maxNestedSpawns } = {}) {
  writeFileSync(
    settingsFile,
    JSON.stringify({
      agentContext: { coder: BUDGET },
      agentCompaction: { coder: compaction },
      ...(maxNestedSpawns == null ? {} : { maxNestedSpawns }),
    }),
  )
  resetSettings()
  const { ctx, created } = makeCtx({ ctxTokens })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  return { hooks, sessionID: created[created.length - 1] }
}

// The shape a subagent's array has on every request after its first: the task
// prompt as message 0, then the assistant messages that carry the tool results.
function subagentHistory(sessionID, steps = 3) {
  const messages = [
    {
      info: { id: "msg_task", role: "user", sessionID, time: { created: 1 } },
      parts: [{ type: "text", text: "task" }],
    },
  ]
  for (let i = 1; i <= steps; i += 1) {
    messages.push({
      info: { id: `msg_a${i}`, role: "assistant", sessionID, time: { created: 1 + i } },
      parts: [
        { type: "tool", tool: "read", state: { status: "completed", output: `out ${i}` } },
      ],
    })
  }
  return messages
}

// The shape a primary's array has at the start of a turn: its user message last.
function primaryTurn(messageID) {
  return [
    {
      info: { id: "msg_p0", role: "user", sessionID: PRIMARY, time: { created: 1 } },
      parts: [{ type: "text", text: "earlier turn" }],
    },
    {
      info: { id: "msg_pa", role: "assistant", sessionID: PRIMARY, time: { created: 2 } },
      parts: [{ type: "text", text: "earlier answer" }],
    },
    {
      info: { id: messageID, role: "user", sessionID: PRIMARY, time: { created: 3 } },
      parts: [{ type: "text", text: "this turn" }],
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

test("a subagent gets the notice at the TAIL, not on its message 0", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const messages = subagentHistory(sessionID)
  const before = messages.length
  await run(hooks, messages)

  assert.equal(messages.length, before + 1, "no carrier was appended at the tail")
  const carrier = messages[messages.length - 1]
  assert.match(carrier.parts[0].text, /WRAP UP NOW/)
  assert.equal(
    messages[0].parts.length,
    1,
    "the task prompt must keep the single part it came with",
  )
  assert.equal(messages[0].parts[0].text, "task")
})

test("the carrier is what opencode's conversion turns into a model message", async () => {
  // MessageV2.toModelMessages emits a user-role message out of every part with
  // type "text", a non-empty text and no `ignored` flag; `synthetic` is not
  // read there. Anything else on the array is dropped silently.
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  const carrier = messages[messages.length - 1]
  assert.equal(carrier.info.role, "user")
  assert.equal(carrier.info.sessionID, sessionID)
  assert.notEqual(carrier.info.id, "msg_task", "the carrier needs an id of its own")
  assert.equal(carrier.parts.length, 1)
  const part = carrier.parts[0]
  assert.equal(part.type, "text")
  assert.equal(part.ignored, undefined)
  assert.equal(part.synthetic, true)
  assert.equal(part.messageID, carrier.info.id)
  assert.equal(part.sessionID, sessionID)
  assert.ok(part.text.length > 0)
})

test("the history ahead of the carrier is left byte-identical, so the cached prefix holds", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const messages = subagentHistory(sessionID)
  const snapshot = JSON.parse(JSON.stringify(messages))
  await run(hooks, messages)

  assert.deepEqual(
    messages.slice(0, snapshot.length),
    snapshot,
    "the notice must add to the end and change nothing before it",
  )
})

test("transforming the same subagent array twice leaves ONE carrier", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const messages = subagentHistory(sessionID)
  const before = messages.length
  await run(hooks, messages)
  await run(hooks, messages)

  assert.equal(messages.length, before + 1, "the second pass appended a second carrier")
  const carriers = messages.filter((m) => (m.parts ?? []).some((p) => p?.synthetic))
  assert.equal(carriers.length, 1)
  assert.equal(carriers[0].parts.length, 1, "the second pass must replace the part, not add one")
  assert.match(carriers[0].parts[0].text, /WRAP UP NOW/)
})

test("a subagent's FIRST request keeps the notice on the user message — it is already the tail", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const messages = [
    {
      info: { id: "msg_task", role: "user", sessionID, time: { created: 1 } },
      parts: [{ type: "text", text: "task" }],
    },
  ]
  await run(hooks, messages)

  assert.equal(messages.length, 1, "no carrier is needed, and two user messages in a row are not")
  assert.equal(messages[0].parts.length, 2)
  assert.match(messages[0].parts[1].text, /WRAP UP NOW/)
})

test("the primary keeps its placement: the notice stays on its last user message", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  trackPrimary(PRIMARY)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  const messages = primaryTurn("msg_p1")
  await run(hooks, messages)

  assert.equal(messages.length, 3, "nothing may be appended to a primary's array")
  const carrier = messages[2]
  assert.equal(carrier.info.id, "msg_p1")
  assert.equal(carrier.parts.length, 2)
  assert.equal(carrier.parts[1].synthetic, true)
  assert.equal(carrier.parts[1].messageID, "msg_p1")
  assert.match(carrier.parts[1].text, /researcher#1/)
  assert.equal(syntheticText(messages.slice(0, 2)), "", "nothing on the earlier messages")
})

test("the primary keeps its placement mid tool-loop, with assistant messages behind it", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  trackPrimary(PRIMARY)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  const messages = primaryTurn("msg_p1")
  messages.push({
    info: { id: "msg_pa2", role: "assistant", sessionID: PRIMARY, time: { created: 4 } },
    parts: [{ type: "tool", tool: "list", state: { status: "completed", output: "…" } }],
  })
  await run(hooks, messages)

  assert.equal(messages.length, 4, "the primary's block must not move to the tail")
  assert.equal(messages[2].parts.length, 2)
  assert.equal(messages[2].parts[1].synthetic, true)
  assert.equal(messages[3].parts.length, 1, "the trailing assistant message stays untouched")
})

// One route for all of them: whatever contextLimitNotice returns, plus the
// abort notice, arrives in the same carrier at the same place.
test("every band goes the same way — plan, reserve, HOLD and the lockdown STOP", async () => {
  const bands = [
    { name: "plan", tokens: PLAN_AT + 100, compaction: false, marker: /PLAN YOUR HANDOVER/ },
    { name: "reserve", tokens: RESERVE_AT + 100, compaction: false, marker: /WRAP UP NOW/ },
    { name: "hold", tokens: BUDGET + 100, compaction: true, marker: /⏳ HOLD/ },
    { name: "stop", tokens: BUDGET + 100, compaction: false, marker: /🛑 STOP\./ },
  ]
  for (const band of bands) {
    resetState()
    resetTurnNotices()
    const { hooks, sessionID } = await subagentAt(band.tokens, { compaction: band.compaction })
    const messages = subagentHistory(sessionID)
    const before = messages.length
    await run(hooks, messages)

    assert.equal(messages.length, before + 1, `${band.name}: no carrier at the tail`)
    const carrier = messages[messages.length - 1]
    assert.equal(carrier.info.role, "user", `${band.name}: the carrier must be a user message`)
    assert.match(carrier.parts[0].text, band.marker, `${band.name}: wrong text in the carrier`)
    assert.equal(syntheticText(messages.slice(0, before)), "", `${band.name}: text left on the history`)
  }
})

test("the abort notice travels in the same carrier", async () => {
  const { hooks, sessionID } = await subagentAt(1000)
  aborted.add(sessionID)
  const messages = subagentHistory(sessionID)
  await run(hooks, messages)

  const carrier = messages[messages.length - 1]
  assert.match(carrier.parts[0].text, /ABORTED/)
  assert.equal(messages[0].parts.length, 1)
})

test("no notice, no carrier: a quiet subagent turn leaves the array as it was", async () => {
  // Below the plan band and with the nested quota line switched off, the hook
  // has nothing to say — and then it must not touch the array at all.
  const { hooks, sessionID } = await subagentAt(PLAN_AT - 1000, { maxNestedSpawns: 0 })
  const messages = subagentHistory(sessionID)
  const snapshot = JSON.parse(JSON.stringify(messages))
  await run(hooks, messages)

  assert.deepEqual(messages, snapshot)
})
