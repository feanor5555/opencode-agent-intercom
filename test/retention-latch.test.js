// Retention is in effect only where it was OFFERED at load AND is switched ON
// now. Both halves of that conjunction are pinned here, in all four
// combinations.
//
// Why it is a conjunction. opencode resolves an external plugin's tool map once,
// at instance bootstrap: whether the `reuse` tool exists at all is settled there
// and cannot be revised while the instance runs. Everything else reads the
// settings file live. Read live alone, a user who switches retention ON in a
// running instance gets subagents that are really held and a `list` that tells
// the orchestrator to call a tool its map does not carry — a state only one half
// of the plugin believes in.
//
// So:
//   - enabling retention needs an opencode restart. Until then nothing is
//     retained, nothing is listed as RETAINED, and no text names `reuse`;
//   - disabling it takes effect at the next settings read, in a process whose
//     tool map still carries `reuse`: no further subagent is held, the retained
//     section disappears, and the tool itself refuses every call.
//
// The one thing that does NOT follow the live setting is the tool surface and
// the texts that name it — the guide and the `list` description — because those
// have to describe the map that exists (test/retention-texts.test.js).
//
// Run: node --test test/retention-latch.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
} from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  entryLifecycle,
  countRetainedSubagents,
  LIFECYCLE_RETAINED,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  setSettingsPath,
  resetSettings,
  dropSettingsCacheKeepingLatch,
  retentionOffered,
  retentionActive,
  retentionCapacity,
} from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-latch-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

// The settings this process is LOADED with: the latch is dropped, so the next
// read decides afresh whether retention is offered at all.
function loadWith(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

// A settings edit made while the process runs: the file moves, the latch does
// not. This is the state a user's live edit really produces.
function switchTo(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  dropSettingsCacheKeepingLatch()
}

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx({ ctxTokens = 20000 } = {}) {
  let counter = 0
  const created = []
  const deleted = []
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
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", tokens: { input: ctxTokens, output: 0 } },
            parts: [{ type: "text", text: "R" }],
          },
        ],
      }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, deleted }
}

const idle = (hooks, sessionID) =>
  hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

// Spawns one subagent and ends it. Returns its session id — whether it is still
// in the registry afterwards is exactly what the tests below ask.
async function runOne(hooks, created, agent = "planner") {
  await hooks.tool.spawn.execute({ agent, prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  await idle(hooks, sessionID)
  return sessionID
}

// The primary's per-turn snapshot block.
async function turnNotice(hooks, sessionID, messageID) {
  const messages = [
    { info: { id: messageID, role: "user", sessionID }, parts: [{ type: "text", text: "task" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}

// The tool names the guard offers a primary that reached for something else.
async function refusalText(hooks) {
  try {
    await hooks["tool.execute.before"]({ tool: "read", sessionID: PRIMARY, callID: "c1" })
  } catch (err) {
    return err?.message ?? String(err)
  }
  throw new Error("the guard admitted a tool a primary may not call")
}

// ---- 1. the conjunction itself ----------------------------------------------

test("offered at load AND on now: retention is in effect, at the live capacity", () => {
  loadWith({ maxRetainedSubagents: 3 })
  assert.equal(retentionOffered(), true)
  assert.equal(retentionActive(), true)
  assert.equal(retentionCapacity(), 3)

  // A live edit of the NUMBER still takes effect — only the on/off step needs a
  // restart, because only that step changes the tool map.
  switchTo({ maxRetainedSubagents: 1 })
  assert.equal(retentionCapacity(), 1)
})

test("offered at load, switched off now: not in effect, capacity 0", () => {
  loadWith({ maxRetainedSubagents: 3 })
  assert.equal(retentionOffered(), true)
  switchTo({ maxRetainedSubagents: 0 })
  assert.equal(retentionOffered(), true, "the tool map cannot be revised mid-process")
  assert.equal(retentionActive(), false)
  assert.equal(retentionCapacity(), 0)
})

test("not offered at load, switched on now: not in effect, capacity 0", () => {
  loadWith({ maxRetainedSubagents: 0 })
  assert.equal(retentionOffered(), false)
  switchTo({ maxRetainedSubagents: 3 })
  assert.equal(retentionOffered(), false, "enabling retention needs a restart")
  assert.equal(retentionActive(), false)
  assert.equal(retentionCapacity(), 0, "no entry may be retained that no tool can address")
})

test("neither: the shipped default, in effect nowhere", () => {
  assert.equal(retentionOffered(), false)
  assert.equal(retentionActive(), false)
  assert.equal(retentionCapacity(), 0)
})

// ---- 2. what each combination does to a finished subagent --------------------

test("offered and on: a finished subagent is held and its session kept", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const sessionID = await runOne(hooks, created)

  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
  assert.deepEqual(deleted, [], "a held session is not deleted")
  assert.equal(countRetainedSubagents(), 1)
})

test("offered but switched off: the next subagent is destroyed like any other", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)

  switchTo({ maxRetainedSubagents: 0, maxSubagents: 4 })
  const sessionID = await runOne(hooks, created)

  assert.equal(entryForSession(sessionID), undefined, "nothing is held while retention is off")
  assert.deepEqual(deleted, [sessionID], "the session goes, immediately, as it always did")
})

test("switched on without a restart: nothing is held, because nothing could address it", async () => {
  loadWith({ maxRetainedSubagents: 0, maxSubagents: 4 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  assert.equal(hooks.tool.reuse, undefined, "the map was resolved without the tool")

  switchTo({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const sessionID = await runOne(hooks, created)

  assert.equal(
    entryForSession(sessionID),
    undefined,
    "a retained entry here would be addressable by no tool in this instance's map",
  )
  assert.deepEqual(deleted, [sessionID])
})

// ---- 3. what each combination shows the orchestrator -------------------------

test("switched on without a restart: list and the snapshot stay as they were", async () => {
  loadWith({ maxRetainedSubagents: 0, maxSubagents: 4 })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  switchTo({ maxRetainedSubagents: 3, maxSubagents: 4 })
  await runOne(hooks, created)

  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.equal(listed.output, "No active subagents.")
  assert.doesNotMatch(listed.output, /RETAINED/)

  const snapshot = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.equal(snapshot, "", "nothing running, nothing held, no block")

  assert.match(await refusalText(hooks), /Available orchestration tools: spawn, abort, list\./)
})

// Re-decided here: a `list` that runs after retention was switched off shows no
// retained section, and that is the same answer the conjunction gives at every
// other site — `reuse` refuses in the same breath, so a rendered section would
// hand the orchestrator handles that the tool named beside them turns down.
//
// The entry is not touched by the switch itself: nothing on the read paths
// evicts, so between the edit and the next watchdog tick a held entry is
// exactly as it was, only no longer offered. The tick is what ends it — see the
// capacity section below.
test("switched off: a retained entry is neither listed nor shown in the snapshot", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const sessionID = await runOne(hooks, created)
  assert.match((await hooks.tool.list.execute({}, toolCtx)).output, /RETAINED/)

  switchTo({ maxRetainedSubagents: 0, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.equal(listed.output, "No active subagents.")
  assert.equal(await turnNotice(hooks, PRIMARY, "msg_2"), "")

  const refused = await hooks.tool.reuse.execute({ subagent: "planner#1", prompt: "q" }, toolCtx)
  assert.match(refused.output, /switched off for this installation/)
  assert.match(await refusalText(hooks), /Available orchestration tools: spawn, abort, list\./)

  // Untouched by the read paths themselves — no sweep has run yet.
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
})

test("offered and on: the refusal names reuse among the orchestration tools", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  assert.ok(hooks.tool.reuse, "the map carries the tool")
  assert.match(await refusalText(hooks), /Available orchestration tools: spawn, abort, list, reuse\./)
})

// ---- 4. a capacity lowered while the process runs ----------------------------
//
// `maxRetainedSubagents` is read live, so lowering it changes the capacity at
// once — but the eviction on the idle path only runs after one more entry has
// JOINED the set, and at capacity 0 no entry ever joins it again. Without an
// enforcement on the clock, whatever was held under the old capacity would be
// stranded: a session standing open for the whole retention window, addressed
// by a handle `list` no longer offers and `reuse` refuses on the very capacity
// that stranded it. The watchdog sweep is where the new number reaches the
// existing set.

test("capacity lowered to 0 mid-process: the sweep releases the held entry", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const sessionID = await runOne(hooks, created)
  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)

  switchTo({ maxRetainedSubagents: 0, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  await sweepWatchdog()

  assert.equal(entryForSession(sessionID), undefined, "the entry is released, not stranded")
  assert.equal(countRetainedSubagents(), 0)
  assert.deepEqual(deleted, [sessionID], "and the opencode session goes with it")
  // Far inside the 1 h window: the TTL reap is not what did this.
  assert.equal(retentionCapacity(), 0)
})

test("capacity lowered but not to 0: the sweep drops only the surplus, oldest first", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const first = await runOne(hooks, created, "planner")
  entryForSession(first).retainedAt = Date.now() - 60_000
  const second = await runOne(hooks, created, "researcher")
  assert.equal(countRetainedSubagents(), 2)

  switchTo({ maxRetainedSubagents: 1, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  await sweepWatchdog()

  assert.deepEqual(deleted, [first], "the oldest retention loses the seat, as capacity always does")
  assert.equal(entryForSession(first), undefined)
  assert.equal(entryLifecycle(entryForSession(second)), LIFECYCLE_RETAINED)
  assert.equal(countRetainedSubagents(), 1)
})

test("a sweep at an unchanged capacity leaves the held set alone", async () => {
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const sessionID = await runOne(hooks, created)

  await sweepWatchdog()

  assert.equal(entryLifecycle(entryForSession(sessionID)), LIFECYCLE_RETAINED)
  assert.deepEqual(deleted, [], "room to spare is not a reason to drop anything")
})

// ---- 5. the refusal is on the record ----------------------------------------
//
// Every other refusal in reuseHandler writes a debug line, and this one used
// not to: a reuse turned down here left the log looking as though no reuse had
// been attempted at all, and the only record of it was inside opencode's own
// session store.

const debugLogPath = join(homedir(), ".cache", "opencode-agent-intercom", "debug.log")

// What the debug log gained while `run` was executing. Read as a byte range
// from the recorded offset, not as a slice of the decoded file: the log is
// append-only and grows to hundreds of MB, and a character offset would sit
// somewhere else entirely in a file that carries any multi-byte character.
// Empty where logging is switched off or the file does not exist, which the
// caller has to allow for.
async function loggedDuring(run) {
  const before = existsSync(debugLogPath) ? statSync(debugLogPath).size : 0
  await run()
  if (!existsSync(debugLogPath)) return ""
  const after = statSync(debugLogPath).size
  if (after <= before) return ""
  const buf = Buffer.alloc(after - before)
  const fd = openSync(debugLogPath, "r")
  try {
    readSync(fd, buf, 0, buf.length, before)
  } finally {
    closeSync(fd)
  }
  return buf.toString("utf8")
}

test("the retention-off refusal writes a debug line, like the other seven", async (t) => {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") {
    t.skip("debug logging is switched off for this run")
    return
  }
  loadWith({ maxRetainedSubagents: 3, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await runOne(hooks, created)
  switchTo({ maxRetainedSubagents: 0, maxSubagents: 4, retainedSubagentTtlMs: 3600000 })

  let refused
  const written = await loggedDuring(async () => {
    refused = await hooks.tool.reuse.execute({ subagent: "planner#1", prompt: "q" }, toolCtx)
  })

  assert.match(refused.output, /switched off for this installation/)
  assert.match(written, /reuse refused: retention switched off/)
  // The two facts that tell this refusal apart from the other seven and from
  // each other: which handle was asked for, and whether retention was ever
  // offered in this process or only switched off under it.
  assert.match(written, /"subagent":"planner#1"/)
  assert.match(written, /"offered":true/)
  assert.match(written, /"maxRetainedSubagents":0/)
})
