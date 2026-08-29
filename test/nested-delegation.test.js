// What step S6 of the role-delegation concept adds on top of the nested spawn
// path (test/nested-spawn.test.js drives the path itself):
//
//   - the grant: five subagent roles hold `spawn`, three do not, and
//     `mayDelegate` is derived from the permission maps rather than listed by
//     hand, so the prompt a role is given cannot drift from the tool it holds;
//   - the prompts: exactly one of the two delegation blocks reaches a subagent's
//     system prompt, picked by whether that role may delegate AND whether
//     nesting is switched on at all;
//   - the reduced limits block a delegating role is shown in place of the
//     orchestrator's, and its three figures;
//   - the remaining nested-spawn quota, which is NOT one of them: it counts
//     down inside the run, so it rides on the last user message instead of the
//     cached system prompt;
//   - the accounting: `nestedRuns` / `nestedTokens` on the caller's entry, and
//     the `⤷ nested:` line they produce on the caller's own completion notice.
//
// Run: node --test test/nested-delegation.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, aborted } from "../src/state.js"
import { entryForSession, upsertSession, chargeNestedRun } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  setSettingsPath,
  resetSettings,
  contextBudgetFor,
  PACKAGE_WARN_SHARE,
  PACKAGE_REFUSE_SHARE,
} from "../src/settings.js"
import { AGENTS, NESTED_SPAWN_TARGET, mayDelegate } from "../src/agents.js"
import { SUBAGENT_DELEGATION_GUIDE, SUBAGENT_NO_SPAWN_GUIDE } from "../src/prompts.js"
import { completionNotice } from "../src/notices.js"
import { tokens as fmtTokens, percent } from "../src/format.js"

// The two sides of the grant, by name. Kept literal rather than derived, so a
// role that changes side has to be moved here deliberately.
const DELEGATING_ROLES = ["planner", "coder", "debugger", "reviewer", "documenter"]
const NON_DELEGATING_ROLES = ["researcher", "designer", "gitter"]

const PRIMARY = "ses_primary"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-deleg-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function withSettings(obj) {
  writeFileSync(settingsFile, JSON.stringify(obj))
  resetSettings()
}

function makeCtx({ messages = [], agentConfig = {} } = {}) {
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
      messages: async () => ({ data: messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

function assistantReply(text, tokens) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

async function until(fn, what, budgetMs = 1000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// A live subagent session with a registry entry, the shape the system-prompt
// hook and the spawn gate both read the caller's role off.
function subagentCaller(sessionID, agent) {
  upsertSession(sessionID, {
    agent,
    prompt: "its own task",
    parentID: PRIMARY,
    directory: fixtureDir,
  })
  return { sessionID, agent, messageID: "m2" }
}

// The system prompt the plugin assembles for one session, joined into one
// string — the same drive test/spawn-size.test.js uses for the primary's block.
async function systemPromptFor(hooks, sessionID) {
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system.join("")
}

// The per-turn text the plugin hangs off the last user message of a session —
// where the blocks that move inside a run live. The quota line is one of them.
async function turnNotice(hooks, sessionID, messageID = "msg_user1") {
  const messages = [
    { info: { id: messageID, role: "user", sessionID }, parts: [{ type: "text", text: "task" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}

// ---- the grant -------------------------------------------------------------

test("mayDelegate is derived from the permission maps and matches the grant", () => {
  for (const role of DELEGATING_ROLES) {
    assert.equal(mayDelegate(role), true, `${role} must be able to delegate`)
  }
  for (const role of NON_DELEGATING_ROLES) {
    assert.equal(mayDelegate(role), false, `${role} must not be able to delegate`)
  }
  // It is a fact about SUBAGENT roles only: the primary is not one of them, and
  // a role the plugin does not define is not either — the caller gate that uses
  // this must fail closed on both.
  assert.equal(AGENTS.orchestrator.mode, "primary")
  assert.equal(mayDelegate("orchestrator"), false, "the orchestrator is not a delegating subagent")
  assert.equal(mayDelegate("some-project-agent"), false)
  assert.equal(mayDelegate(undefined), false)
})

test("the nesting target is the one role that keeps web access and denies spawn", () => {
  assert.equal(NESTED_SPAWN_TARGET, "researcher")
  // This pair is what bounds the nesting depth at one level with no counter:
  // the only reachable target is a role that can never have children.
  assert.equal(mayDelegate(NESTED_SPAWN_TARGET), false)
  assert.notEqual(AGENTS[NESTED_SPAWN_TARGET].permission?.websearch, "deny")
})

// ---- the prompts: exactly one of the two blocks ----------------------------

test("a delegating role gets the delegation guide and not the no-spawn one", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  const prompt = await systemPromptFor(hooks, "ses_planner")
  assert.ok(prompt.includes(SUBAGENT_DELEGATION_GUIDE), "the delegation guide is injected")
  assert.ok(!prompt.includes(SUBAGENT_NO_SPAWN_GUIDE), "the two blocks are mutually exclusive")
  assert.match(prompt, /spawn\("researcher", prompt\)/)
})

test("a non-delegating role gets the no-spawn guide, word for word as before", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_designer", "designer")

  const prompt = await systemPromptFor(hooks, "ses_designer")
  assert.ok(prompt.includes(SUBAGENT_NO_SPAWN_GUIDE), "the no-spawn guide is injected")
  assert.ok(!prompt.includes(SUBAGENT_DELEGATION_GUIDE))
  assert.match(prompt, /You cannot spawn agents\./)
})

test("with maxNestedSpawns: 0 a granted role is told it does not delegate", async () => {
  // Every nested spawn is refused before a session exists, so the delegation
  // guide would describe a call that cannot succeed — and neither it nor the
  // limits block below is paid for.
  withSettings({ maxNestedSpawns: 0 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  const prompt = await systemPromptFor(hooks, "ses_planner")
  assert.ok(prompt.includes(SUBAGENT_NO_SPAWN_GUIDE))
  assert.ok(!prompt.includes(SUBAGENT_DELEGATION_GUIDE))
  assert.doesNotMatch(prompt, /nested spawns left this run/i)
  // And not on the message either: the quota line and the block that explains
  // it are switched off by the one condition, so a role told it does not
  // delegate is not handed a count of spawns it cannot make.
  assert.doesNotMatch(
    await turnNotice(hooks, "ses_planner"),
    /nested spawns left this run/i,
  )
})

test("the primary gets neither block — both are subagent-only", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const prompt = await systemPromptFor(hooks, PRIMARY)
  assert.ok(!prompt.includes(SUBAGENT_DELEGATION_GUIDE))
  assert.ok(!prompt.includes(SUBAGENT_NO_SPAWN_GUIDE))
})

// ---- the reduced limits block ---------------------------------------------

test("a delegating role's limits block carries its three figures and nothing more", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  const prompt = await systemPromptFor(hooks, "ses_planner")
  assert.match(prompt, /📐 agent-intercom: limits on the work you delegate\./)
  // 1. its own budget — the ceiling the whole run is measured against.
  assert.match(
    prompt,
    new RegExp(`Your own context budget: ${fmtTokens(contextBudgetFor("planner"))} `),
  )
  // 2. the researcher's budget with fixed overhead and headroom, in the same
  //    `60.0k (−12.4k fixed → 47.6k)` shape the primary's block uses.
  const m = /researcher ([0-9.]+k?) \(−([0-9.]+k?) fixed → ([0-9.]+k?)\)/.exec(prompt)
  assert.ok(m, "the researcher entry renders budget, fixed overhead and headroom")
  assert.equal(m[1], fmtTokens(contextBudgetFor("researcher")))
  // 3. the two package shares the size gate applies to a nested spawn too.
  assert.match(prompt, new RegExp(`at or under ${percent(PACKAGE_WARN_SHARE)}`))
  assert.match(prompt, new RegExp(`over ${percent(PACKAGE_REFUSE_SHARE)} the spawn is REFUSED`))
  // And NOT the quota: it is the one figure that moves inside the run, so it is
  // kept out of the element the provider caches.
  assert.doesNotMatch(prompt, /nested spawns left this run/i)
  // Nothing from the orchestrator's own block: a subagent can act on none of it.
  assert.doesNotMatch(prompt, /coder \d/, "no full per-type budget table")
  assert.doesNotMatch(prompt, /hideChatter/)
})

// ---- the quota line: on the message, not in the system prompt --------------

test("the quota line reaches a delegating role on the last user message", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  const notice = await turnNotice(hooks, "ses_planner")
  assert.match(notice, /agent-intercom: nested spawns left this run: 2 of 2\./)
  assert.match(notice, /The quota does not reset\./)
})

test("the quota figure counts down live within the run", async () => {
  const { ctx, created } = makeCtx({
    messages: assistantReply("looked it up", 4321),
    agentConfig: {},
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  assert.match(await turnNotice(hooks, "ses_planner"), /nested spawns left this run: 2 of 2\./)

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  await pending

  // Same user message id: the count-down may not be memoised per turn, or a
  // one-shot subagent — which lives its whole life under one user message —
  // would keep reading the figure it was given before it spent anything.
  assert.match(await turnNotice(hooks, "ses_planner"), /nested spawns left this run: 1 of 2\./)
  // And the system prompt did not move with it — that is the whole point of
  // where the line now sits.
  assert.doesNotMatch(await systemPromptFor(hooks, "ses_planner"), /nested spawns left this run/i)
})

test("a non-delegating role gets no quota line on its message", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_designer", "designer")

  assert.doesNotMatch(await turnNotice(hooks, "ses_designer"), /nested spawns left this run/i)
})

test("the primary gets no quota line — the per-run quota is a subagent's", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  assert.doesNotMatch(await turnNotice(hooks, PRIMARY), /nested spawns left this run/i)
})

test("an aborted delegating subagent is not handed a spawn allowance on the way out", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")
  aborted.add("ses_planner")

  const notice = await turnNotice(hooks, "ses_planner")
  assert.match(notice, /ABORTED/)
  assert.doesNotMatch(notice, /nested spawns left this run/i)
})

test("a non-delegating role gets no limits block at all", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_gitter", "gitter")

  const prompt = await systemPromptFor(hooks, "ses_gitter")
  assert.doesNotMatch(prompt, /limits on the work you delegate/)
})

test("a researcher budget of 0 reads as off instead of a headroom figure", async () => {
  withSettings({ agentContext: { researcher: 0 } })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_coder", "coder")

  const prompt = await systemPromptFor(hooks, "ses_coder")
  assert.match(prompt, /researcher off \(no context budget set/)
  assert.doesNotMatch(prompt, /researcher [0-9.]+k? \(−/)
})

// ---- the accounting: nestedRuns / nestedTokens -----------------------------

test("chargeNestedRun books runs and tokens on the caller's entry", () => {
  subagentCaller("ses_planner", "planner")
  const entry = entryForSession("ses_planner")
  assert.equal(entry.nestedRuns, 0, "a fresh entry starts at zero")
  assert.equal(entry.nestedTokens, 0)

  assert.deepEqual(chargeNestedRun("ses_planner", 12000), { runs: 1, tokens: 12000 })
  assert.deepEqual(chargeNestedRun("ses_planner", 3000), { runs: 2, tokens: 15000 })
  assert.equal(entry.nestedRuns, 2)
  assert.equal(entry.nestedTokens, 15000)
})

test("a run whose child reported no token figure still counts as a run", () => {
  // An ending with no result — error, abort, timeout — carries no snapshot. The
  // run happened and cost the caller its wait; only the token sum stays short.
  subagentCaller("ses_planner", "planner")
  assert.deepEqual(chargeNestedRun("ses_planner", undefined), { runs: 1, tokens: 0 })
  assert.deepEqual(chargeNestedRun("ses_planner", 0), { runs: 2, tokens: 0 })
  assert.deepEqual(chargeNestedRun("ses_planner", 5000), { runs: 3, tokens: 5000 })
})

test("a primary caller has no entry to charge — its children are not nested runs", () => {
  assert.deepEqual(chargeNestedRun(PRIMARY, 9000), { runs: 0, tokens: 0 })
  assert.equal(entryForSession(PRIMARY), undefined)
})

test("the counters are per run: a second entry of the same role starts clean", () => {
  subagentCaller("ses_a", "planner")
  chargeNestedRun("ses_a", 7000)
  subagentCaller("ses_b", "planner")
  assert.equal(entryForSession("ses_b").nestedRuns, 0)
  assert.equal(entryForSession("ses_b").nestedTokens, 0)
})

test("an ended nested spawn is booked on the caller's entry as the waiter resolves", async () => {
  const { ctx, created } = makeCtx({ messages: assistantReply("the answer", 8000) })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  await pending

  const entry = entryForSession("ses_planner")
  assert.equal(entry.nestedRuns, 1, "the ended child is booked as one run")
  assert.equal(entry.nestedTokens, 8000, "what the child burned in its own session")
  // nestedSpawns is the QUOTA counter and is a different number: it counts
  // spawns admitted, this one counts endings that came back.
  assert.equal(entry.nestedSpawns, 1)
})

// ---- the notice line -------------------------------------------------------

function nestedLine(nested) {
  const notice = completionNotice(
    "planner#1",
    "planner",
    "done",
    PRIMARY,
    undefined,
    20000,
    undefined,
    nested,
  )
  return notice.split("\n").find((l) => l.startsWith("⤷ nested:")) ?? ""
}

test("the nested line reports the runs and their token cost", () => {
  assert.equal(
    nestedLine({ runs: 2, tokens: 31400 }),
    "⤷ nested: 2 runs, ~31.4k tokens (not counted in the figure above).",
  )
  assert.match(nestedLine({ runs: 1, tokens: 9000 }), /^⤷ nested: 1 run, ~9\.0k tokens/)
})

test("runs with no token figure say so instead of reading as free", () => {
  assert.match(nestedLine({ runs: 1, tokens: 0 }), /1 run, token cost not reported by the child/)
})

test("a run that delegated nothing gets no line at all", () => {
  assert.equal(nestedLine({ runs: 0, tokens: 0 }), "")
  assert.equal(nestedLine(undefined), "", "the parameter is absent for every pre-S6 caller")
})

test("the nested cost sits outside the run-size verdict, below it", () => {
  const notice = completionNotice(
    "planner#1",
    "planner",
    "done",
    PRIMARY,
    undefined,
    20000,
    undefined,
    { runs: 2, tokens: 31400 },
  )
  const lines = notice.split("\n")
  const sizeAt = lines.findIndex((l) => l.startsWith("📏"))
  const nestedAt = lines.findIndex((l) => l.startsWith("⤷ nested:"))
  assert.ok(sizeAt >= 0 && nestedAt > sizeAt, "the nested line follows the run-size line")
  // The parent's own run is measured against the parent's own budget; folding
  // the child's spend in would make a well-scoped parent read as oversized.
  assert.match(lines[sizeAt], /run-size: 20\.0k of the 40\.0k planner budget/)
  assert.doesNotMatch(lines[sizeAt], /51\.4k/)
})

test("the caller's own completion notice carries what its nested runs cost", async () => {
  const { ctx, created } = makeCtx({ messages: assistantReply("the answer", 8000) })
  const hooks = await plugin(ctx)
  const notices = []
  ctx.client.session.promptAsync = async (opts) => {
    if (!opts?.body?.agent) notices.push(opts?.body?.parts?.[0]?.text ?? "")
    return { data: undefined }
  }
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  await pending

  // The caller now finishes. Its own wake notice goes to the primary parent.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_planner" } } })
  const wake = notices.find((t) => t.includes("has finished and been destroyed"))
  assert.ok(wake, "the primary parent is woken for its planner")
  assert.match(wake, /⤷ nested: 1 run, ~8\.0k tokens \(not counted in the figure above\)\./)
})
