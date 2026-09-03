// The three texts that tell the orchestrator retention exists: the guide block
// in its system prompt, the completion notice of a run whose session was kept,
// and the per-turn snapshot of its subagents.
//
// Each is pinned in BOTH states, because the shipped default is
// `maxRetainedSubagents = 0` and at that default nothing is ever retained:
//
//   - retention off — every one of the three is byte for byte what it was
//     before the feature existed. The expected strings below are written out in
//     full rather than matched loosely, so a stray word cannot slip into a
//     prompt that a whole installation's prompt cache depends on;
//   - retention on — the new wording appears, carrying what the orchestrator
//     needs in order to act on it: the handle it can address, the window it has
//     left, and that the tool can refuse.
//
// The guide is decided on the LATCHED answer (settings.js `retentionOffered`),
// not the live setting, because whether the `reuse` tool exists at all was
// settled when opencode resolved the tool map. That is pinned here too.
//
// Run: node --test test/retention-texts.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  upsertSession,
  trackPrimary,
  entryForSession,
  LIFECYCLE_RETAINED,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import {
  guideBlocks,
  ORCHESTRATION_GUIDE,
  ORCHESTRATION_REUSE_GUIDE,
} from "../src/prompts.js"
import { completionNotice } from "../src/notices.js"

const PRIMARY = "ses_primary"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-rtexts-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// Retention minutes are floored, so keep fixture creation and rendering at the
// same instant instead of letting setup time cross a minute boundary.
const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z")

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

function withSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

beforeEach((t) => {
  t.mock.timers.enable({ apis: ["Date"], now: FIXED_NOW })
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx() {
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_child" } }),
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
  return { client, directory: fixtureDir, worktree: fixtureDir, project: {} }
}

// The stable system-prompt element of one session — where the guide blocks sit.
async function stableElement(hooks, sessionID) {
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system[0]
}

// The synthetic text the plugin pushes onto a turn: the primary's subagent
// snapshot. Each call needs its own message id — the block is memoised per turn.
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

// A running subagent of PRIMARY, straight through the registry.
function register(sessionID, { agent = "researcher", status = "busy" } = {}) {
  trackPrimary(PRIMARY)
  const entry = upsertSession(sessionID, {
    agent,
    prompt: "do x",
    parentID: PRIMARY,
    directory: fixtureDir,
  })
  entry.status = status
  return entry
}

// The same, moved into the state the idle path leaves a kept subagent in.
function retain(sessionID, { agent = "researcher", ctxTokens = 20000, ageMs = 0 } = {}) {
  const entry = register(sessionID, { agent, status: "idle" })
  entry.lifecycle = LIFECYCLE_RETAINED
  entry.retainedAt = Date.now() - ageMs
  entry.ctxTokens = ctxTokens
  return entry
}

// The age column moves with the clock; nothing else in the block does.
function normalizeAge(text) {
  return text.replace(/· \d+s/g, "· 0s")
}

// ---- 1. the orchestrator guide ----------------------------------------------

test("retention off: the orchestrator guide is ORCHESTRATION_GUIDE and nothing else", () => {
  assert.equal(guideBlocks({ primary: true }), ORCHESTRATION_GUIDE)
  assert.equal(guideBlocks({ primary: true, retention: false }), ORCHESTRATION_GUIDE)
  assert.doesNotMatch(ORCHESTRATION_GUIDE, /reuse|RETAINED|retained/)
})

test("retention on: the guide is the shipped one plus the reuse block, unchanged ahead of it", () => {
  const guide = guideBlocks({ primary: true, retention: true })
  assert.equal(guide, ORCHESTRATION_GUIDE + ORCHESTRATION_REUSE_GUIDE)
  assert.ok(
    guide.startsWith(ORCHESTRATION_GUIDE),
    "the block is appended — nothing ahead of it may move",
  )
})

test("the reuse block teaches the tool, the late follow-up, the alternative and the refusal", () => {
  const g = ORCHESTRATION_REUSE_GUIDE
  // the tool and where the handle comes from
  assert.match(g, /- reuse\(subagent, prompt, mode\?\)/)
  assert.match(g, /`list\(\)` shows which ones are still held, as RETAINED/)
  // that a finished subagent can be kept at all, and asked LATER
  assert.match(g, /Not every subagent is destroyed when it finishes/)
  assert.match(g, /it can be asked LATER, in a turn long after the one you were woken in/)
  // when a fresh spawn is the right choice instead
  assert.match(g, /Spawn a fresh subagent instead for work that is new/)
  assert.match(g, /a blocked task continues through a FRESH subagent/)
  // the two modes
  assert.match(g, /"question" \(the default\)/)
  assert.match(g, /"task" for a further related piece of work/)
  // that the gate can refuse, and on what grounds
  assert.match(g, /reuse can refuse — the session may be too large to be handed more, its window/)
  assert.match(g, /Each refusal names the rule and the figure it refused on/)
  assert.match(g, /spawn is always the way forward/)
})

test("retention off: the primary's system prompt carries no word about reuse", async () => {
  const hooks = await plugin(makeCtx())
  const element = await stableElement(hooks, PRIMARY)
  assert.ok(element.includes(ORCHESTRATION_GUIDE), "the shipped guide is there")
  assert.ok(!element.includes(ORCHESTRATION_REUSE_GUIDE))
  assert.doesNotMatch(element, /reuse\(/)
})

test("retention on: the primary's system prompt carries the reuse block", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const hooks = await plugin(makeCtx())
  const element = await stableElement(hooks, PRIMARY)
  assert.ok(element.includes(ORCHESTRATION_GUIDE))
  assert.ok(element.includes(ORCHESTRATION_REUSE_GUIDE))
})

test("a subagent is never told about reuse, whatever the setting says", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const hooks = await plugin(makeCtx())
  register("ses_sub1", { agent: "coder" })
  const element = await stableElement(hooks, "ses_sub1")
  assert.doesNotMatch(element, /reuse\(/)
  assert.match(element, /You are a one-shot subagent/, "its own run is one-shot either way")
})

test("the guide follows the latched answer, not a settings edit made after load", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const hooks = await plugin(makeCtx())
  assert.ok((await stableElement(hooks, PRIMARY)).includes(ORCHESTRATION_REUSE_GUIDE))

  // opencode resolved the tool map at load and keeps it: `reuse` still exists,
  // so the guide must keep naming it.
  writeFileSync(settingsFile, JSON.stringify({ maxRetainedSubagents: 0 }))
  assert.ok(hooks.tool.reuse, "the tool cannot be withdrawn from a running instance")
  assert.ok(
    (await stableElement(hooks, PRIMARY)).includes(ORCHESTRATION_REUSE_GUIDE),
    "the guide must not name a different tool surface than the map carries",
  )
})

// ---- 2. the completion notice ------------------------------------------------

const HEAD_DESTROYED =
  '🔔 agent-intercom: your subagent "researcher#1" (researcher) has finished and been destroyed.\n'
const TAIL_DESTROYED =
  "Use this to report back to the user. If you need more work in this area, spawn a fresh " +
  "subagent — the one above is gone."

function notice({ retained = false, ctxTokens = 20000, runs = 1 } = {}) {
  return completionNotice(
    "researcher#1",
    "researcher",
    "R",
    PRIMARY,
    null,
    ctxTokens,
    0,
    null,
    runs,
    retained,
  )
}

test("retention off: the completion notice is byte for byte what it has always been", () => {
  const text = notice()
  assert.ok(text.startsWith(HEAD_DESTROYED), text.slice(0, 200))
  assert.ok(text.includes(TAIL_DESTROYED))
  assert.doesNotMatch(text, /HELD|reuse\(/)
})

test("a session that was NOT kept still reads as destroyed, retention on or not", () => {
  withSettings({ maxRetainedSubagents: 3 })
  // the phase-2 revocation case: retention is enabled, this session was not kept
  const text = notice({ retained: false })
  assert.ok(text.startsWith(HEAD_DESTROYED))
  assert.ok(text.includes(TAIL_DESTROYED))
})

test("a kept session: the notice says held, names the handle and the window", () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 1800000 })
  const text = notice({ retained: true })
  assert.equal(
    text.startsWith(
      '🔔 agent-intercom: your subagent "researcher#1" (researcher) has finished. Its session ' +
        "is being HELD, not destroyed.\n",
    ),
    true,
    text.slice(0, 250),
  )
  assert.doesNotMatch(text, /been destroyed|the one above is gone/)
  assert.match(text, /The session is NOT gone: it still holds everything it read and did/)
  // still reachable, under which handle, for how long
  assert.match(text, /for the next 30 minutes/)
  assert.match(text, /reuse\("researcher#1", "<question>"\)/)
  assert.match(text, /After that window it is gone and only spawn is left/)
})

test("the window figure is read from the setting, not baked in", () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 3600000 })
  assert.match(notice({ retained: true }), /for the next 60 minutes/)
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 1 })
  assert.match(notice({ retained: true }), /for the next under a minute/)
})

test("the notice says whether a further task would be admitted too, or only a question", () => {
  withSettings({ maxRetainedSubagents: 3, agentContext: { researcher: 100000 } })
  // G4 is half the type's budget: 20k of 100k leaves room for a task
  assert.match(
    notice({ retained: true, ctxTokens: 20000 }),
    /A further related piece of work is admitted too, with mode: "task"\./,
  )
  // 60k of 100k does not
  assert.match(
    notice({ retained: true, ctxTokens: 60000 }),
    /Only a question: at this size a further piece of work \(mode: "task"\) is refused/,
  )
})

test("a blocked report is never dressed up as held", () => {
  withSettings({ maxRetainedSubagents: 3 })
  const text = completionNotice(
    "researcher#1",
    "researcher",
    "Blocked: the path does not exist",
    PRIMARY,
    null,
    20000,
    0,
    null,
    1,
    true,
  )
  assert.match(text, /came back BLOCKED and was destroyed/)
  assert.doesNotMatch(text, /HELD|reuse\(/)
})

// ---- 3. the per-turn snapshot ------------------------------------------------

const SNAPSHOT_SHIPPED =
  "\n\n---\n📋 agent-intercom: active subagents across all orchestrator sessions in this process " +
  "(the subagent cap is global). They are one-shot — a finished subagent disappears from this " +
  "list. To stop one, use `abort` (only on user request); for more work, spawn a fresh " +
  "subagent:\n" +
  "• researcher#1 (researcher) — busy · ? ctx · 0s" +
  "\n---\n"

test("retention off: the snapshot block is byte for byte what it has always been", async () => {
  const hooks = await plugin(makeCtx())
  register("ses_sub1")
  const text = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.equal(normalizeAge(text), SNAPSHOT_SHIPPED)
})

test("retention off: a retained entry is shown nowhere and the prose stays as it was", async () => {
  const hooks = await plugin(makeCtx())
  register("ses_sub1")
  retain("ses_sub2", { agent: "planner" })
  const text = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.equal(normalizeAge(text), SNAPSHOT_SHIPPED, "no second section, no changed prose")
  assert.doesNotMatch(text, /planner/)
})

test("retention on: retained subagents get their own section, in list's own words", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 3600000 })
  const hooks = await plugin(makeCtx())
  register("ses_sub1")
  retain("ses_sub2", { agent: "planner", ctxTokens: 21500, ageMs: 12 * 60000 })
  const text = await turnNotice(hooks, PRIMARY, "msg_1")

  // the running row is untouched
  assert.match(text, /• researcher#1 \(researcher\) — busy · \? ctx · \d+s/)
  // the prose no longer asserts the one-shot rule
  assert.doesNotMatch(text, /They are one-shot/)
  assert.match(
    text,
    /A finished subagent disappears from this list unless it is being held for a follow-up — those are listed under RETAINED below\./,
  )
  // the section, worded as `list` words it
  assert.match(
    text,
    /RETAINED — finished, NOT running, holding no slot\. Their sessions are still alive and still hold the work they did, so you can put a follow-up question to one with reuse\("<handle>", "<question>"\) until its window runs out\. After that it is gone and only spawn is left\./,
  )
  // the row: handle, type, the context the gate is decided on, the window left
  assert.match(text, /• planner#1 \(planner\) — retained · 21\.5k ctx · 48m left/)
})

test("retention on: a retained entry alone still renders the block", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 3600000 })
  const hooks = await plugin(makeCtx())
  retain("ses_sub1", { agent: "planner" })
  const text = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.match(text, /• none running/)
  assert.match(text, /• planner#1 \(planner\) — retained · 20\.0k ctx · 60m left/)
})

test("retention on with nothing at all: no block, exactly as before", async () => {
  withSettings({ maxRetainedSubagents: 3 })
  const hooks = await plugin(makeCtx())
  const text = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.equal(text, "")
})

test("a retained entry of another primary is marked, the way a running one is", async () => {
  withSettings({ maxRetainedSubagents: 3, retainedSubagentTtlMs: 3600000 })
  const hooks = await plugin(makeCtx())
  const entry = retain("ses_sub1", { agent: "planner" })
  entry.parentID = "ses_other_primary"
  trackPrimary(PRIMARY)
  const text = await turnNotice(hooks, PRIMARY, "msg_1")
  assert.match(text, /• planner#1 \(planner\) — retained · 20\.0k ctx · 60m left · \[other session\]/)
  assert.equal(entryForSession("ses_sub1").parentID, "ses_other_primary")
})
