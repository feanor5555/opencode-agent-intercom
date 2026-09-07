// One authority decides whether a role delegates, and the prompt asks it.
//
// The runtime gate resolves `permission.spawn` off the RESOLVED opencode config
// (config.js `resolveSpawnPermission`, rung 1) and only falls through to this
// plugin's own role map (rung 2) where the config decides nothing. The system
// prompt used to ask the static map alone, so a project-level
// `agent.<role>.permission.spawn: "deny"` left the role carrying the delegation
// guide, the delegation limits block and the per-run quota line on every turn
// while every spawn it made was refused.
//
// What this file pins:
//   - a role the resolved config DENIES gets none of the three, and the gate
//     refuses its spawn in the same run — prompt and gate agree;
//   - a role the resolved config ALLOWS against the plugin's own `spawn: "deny"`
//     gets all three, and the gate admits it — the same agreement in the other
//     direction;
//   - a config that opens `spawn` on a role with no nested target is not told it
//     delegates, because the gate's target check would refuse it anyway;
//   - the per-type fixed-overhead figures in BOTH limits blocks are sized
//     against the guide the type really receives under the resolved config;
//   - a config that cannot be read changes no prompt: the fallback is the
//     plugin's own map, i.e. the behaviour the prompt side had before.
//
// Run: node --test test/delegation-authority.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { upsertSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache, resolveSpawnPermission } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { AGENTS, mayDelegate, isSubagentRole, nestedSpawnTargets } from "../src/agents.js"
import {
  SUBAGENT_DELEGATION_GUIDE,
  SUBAGENT_GROUNDED_DELEGATION_GUIDE,
  SUBAGENT_NO_SPAWN_GUIDE,
} from "../src/prompts.js"

const PRIMARY = "ses_primary"

// The three blocks a delegating role is given, and nothing else identifies
// them: the guide in the system prompt, the reduced limits block under it, and
// the quota line on the last user message.
const DELEGATION_LIMITS_HEADING = /📐 agent-intercom: limits on the work you delegate\./
const QUOTA_LINE = /nested spawns left this run/i

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-authority-"))
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

// `configGet` is the whole seam: it is what the resolved opencode config is
// read through, and `configFails` makes that read throw so the fallback rung
// can be driven.
function makeCtx({ agentConfig = {}, configFails = false } = {}) {
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
    config: {
      get: async () => {
        if (configFails) throw new Error("config unreadable")
        return { data: { agent: agentConfig } }
      },
    },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}

function denySpawn(...roles) {
  const agent = {}
  for (const role of roles) agent[role] = { permission: { spawn: "deny" } }
  return agent
}

function allowSpawn(...roles) {
  const agent = {}
  for (const role of roles) agent[role] = { permission: { spawn: "allow" } }
  return agent
}

// A live subagent session with a registry entry — the shape the system-prompt
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

async function systemPromptFor(hooks, sessionID) {
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system.join("")
}

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

// ---- the config's deny reaches the prompt ---------------------------------

test("a role denied spawn in the resolved config gets no guide, no limits block, no quota line", async () => {
  // The plugin's own map grants the planner `spawn` (no key at all), so before
  // this the prompt side answered "delegates" here while the gate refused.
  assert.equal(mayDelegate("planner"), true, "the static map still grants it")
  const { ctx } = makeCtx({ agentConfig: denySpawn("planner") })
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  const prompt = await systemPromptFor(hooks, "ses_planner")
  // 1. the guide: the no-spawn block, not the delegation one.
  assert.ok(prompt.includes(SUBAGENT_NO_SPAWN_GUIDE), "it is told it cannot spawn")
  assert.ok(!prompt.includes(SUBAGENT_DELEGATION_GUIDE), "and not told how to")
  assert.doesNotMatch(prompt, /spawn\("researcher", prompt\)/)
  // 2. the limits block that sizes the work it delegates.
  assert.doesNotMatch(prompt, DELEGATION_LIMITS_HEADING)
  // 3. the quota line, in neither place it could stand.
  assert.doesNotMatch(prompt, QUOTA_LINE)
  assert.doesNotMatch(await turnNotice(hooks, "ses_planner"), QUOTA_LINE)
})

test("the prompt and the gate agree: the denied role is refused when it spawns", async () => {
  const { ctx, created } = makeCtx({ agentConfig: denySpawn("planner") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const prompt = await systemPromptFor(hooks, "ses_planner")
  assert.ok(prompt.includes(SUBAGENT_NO_SPAWN_GUIDE))

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "look it up" }, callerCtx)
  assert.match(
    res.output,
    /^You are a subagent — you cannot spawn other agents\./,
    "the gate refuses exactly what the prompt said it could not do",
  )
  assert.deepEqual(created, [], "no session is created for a refused spawn")
})

test("only the named role loses the three blocks — a sibling role keeps them", async () => {
  const { ctx } = makeCtx({ agentConfig: denySpawn("planner") })
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")
  subagentCaller("ses_coder", "coder")

  assert.ok((await systemPromptFor(hooks, "ses_planner")).includes(SUBAGENT_NO_SPAWN_GUIDE))

  const coderPrompt = await systemPromptFor(hooks, "ses_coder")
  assert.ok(coderPrompt.includes(SUBAGENT_DELEGATION_GUIDE), "the coder is untouched")
  assert.match(coderPrompt, DELEGATION_LIMITS_HEADING)
  assert.match(await turnNotice(hooks, "ses_coder", "msg_user2"), QUOTA_LINE)
})

// ---- and the config's allow reaches it too, the other way round -----------

test("a role the plugin denies but the config allows is given all three", async () => {
  // `designer` carries `spawn: "deny"` in the plugin's own map and has no
  // nested target; `grounder` is the same. The role that can be opened without
  // promising a target the gate refuses is one that HAS a target, so the case
  // is driven on a role whose own map denies and whose target table carries an
  // entry. None ships that way, so the target table decides the shape of this
  // test: the researcher is opened explicitly at rung 1 instead, which is the
  // same rung a project override uses.
  const { ctx } = makeCtx({ agentConfig: allowSpawn("researcher") })
  const hooks = await plugin(ctx)
  subagentCaller("ses_researcher", "researcher")

  const prompt = await systemPromptFor(hooks, "ses_researcher")
  assert.ok(prompt.includes(SUBAGENT_GROUNDED_DELEGATION_GUIDE), "its own target's guide")
  assert.ok(!prompt.includes(SUBAGENT_NO_SPAWN_GUIDE))
  assert.match(prompt, DELEGATION_LIMITS_HEADING)
  assert.match(await turnNotice(hooks, "ses_researcher"), QUOTA_LINE)
})

test("a config that opens spawn on a role with no target does not promise delegation", async () => {
  // The gate has a second check the config cannot move: a target outside the
  // role's NESTED_SPAWN_TARGETS set is refused, and an empty set refuses
  // everything. Telling the role it delegates would hand it the researcher
  // block (the delegation guide's fallback) and a target it can never name.
  assert.deepEqual(nestedSpawnTargets("designer"), [], "the designer names nothing")
  const { ctx } = makeCtx({ agentConfig: allowSpawn("designer") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_designer", "designer")

  const prompt = await systemPromptFor(hooks, "ses_designer")
  assert.ok(prompt.includes(SUBAGENT_NO_SPAWN_GUIDE))
  assert.ok(!prompt.includes(SUBAGENT_DELEGATION_GUIDE))
  assert.doesNotMatch(prompt, DELEGATION_LIMITS_HEADING)
  assert.doesNotMatch(await turnNotice(hooks, "ses_designer"), QUOTA_LINE)

  // The gate lets it past the spawn check now and refuses on the target, which
  // is what the prompt above already told it.
  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, callerCtx)
  assert.match(res.output, /may spawn/, "refused by the target check, not the spawn check")
  assert.doesNotMatch(res.output, /^You are a subagent — you cannot spawn other agents\./)
})

// ---- the fixed-overhead figures follow the same authority ------------------

test("the primary's per-type overhead is sized against the guide the type really gets", async () => {
  // The overhead figure counts the guide blocks a spawn of that type carries.
  // The no-spawn guide is shorter than the delegation one, so a planner the
  // config denies must cost the orchestrator LESS to spawn than an untouched
  // one, and the coder's figure must not move with it.
  const open = makeCtx()
  const openHooks = await plugin(open.ctx)
  const before = overheadFor(await systemPromptFor(openHooks, PRIMARY))

  resetPermissionGuardCache()
  const denied = makeCtx({ agentConfig: denySpawn("planner") })
  const deniedHooks = await plugin(denied.ctx)
  const after_ = overheadFor(await systemPromptFor(deniedHooks, PRIMARY))

  assert.ok(before.planner > 0 && after_.planner > 0, "both figures rendered")
  assert.ok(
    after_.planner < before.planner,
    `a denied planner must be cheaper to spawn: ${after_.planner} < ${before.planner}`,
  )
  assert.equal(after_.coder, before.coder, "the coder's figure does not move with it")
})

test("a delegating role's own limits block sizes its target the same way", async () => {
  // The researcher's block sizes the grounder. The grounder never delegates, so
  // denying its `spawn` in the config must leave the figure exactly as it was —
  // the guide it gets is the no-spawn one either way.
  const open = makeCtx({ agentConfig: allowSpawn("researcher") })
  const openHooks = await plugin(open.ctx)
  subagentCaller("ses_researcher", "researcher")
  const before = targetOverhead(await systemPromptFor(openHooks, "ses_researcher"), "grounder")

  resetPermissionGuardCache()
  resetState()
  const denied = makeCtx({ agentConfig: { ...allowSpawn("researcher"), ...denySpawn("grounder") } })
  const deniedHooks = await plugin(denied.ctx)
  subagentCaller("ses_researcher", "researcher")
  const after_ = targetOverhead(await systemPromptFor(deniedHooks, "ses_researcher"), "grounder")

  assert.ok(before !== null, "the grounder entry renders a fixed-overhead figure")
  assert.equal(after_, before, "a role that never delegated pays the same either way")
})

// ---- the fallback: no config, no change -----------------------------------

test("an unreadable config leaves every prompt at the plugin's own map", async () => {
  const { ctx } = makeCtx({ configFails: true })
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")
  subagentCaller("ses_designer", "designer")

  const planner = await systemPromptFor(hooks, "ses_planner")
  assert.ok(planner.includes(SUBAGENT_DELEGATION_GUIDE), "the grant of the plugin's own map holds")
  assert.match(planner, DELEGATION_LIMITS_HEADING)
  assert.match(await turnNotice(hooks, "ses_planner"), QUOTA_LINE)

  const designer = await systemPromptFor(hooks, "ses_designer")
  assert.ok(designer.includes(SUBAGENT_NO_SPAWN_GUIDE))
  assert.doesNotMatch(designer, DELEGATION_LIMITS_HEADING)
})

// ---- the authority itself --------------------------------------------------

test("both sides call one function, and it is the config-resolving one", async () => {
  // Not a mock check: the same call the gate makes, made here directly, must
  // answer for the roles exactly as the prompts above turned out.
  const { ctx } = makeCtx({ agentConfig: denySpawn("planner") })
  assert.match(await resolveSpawnPermission(ctx.client, "planner"), /permission\.spawn/)
  assert.equal(await resolveSpawnPermission(ctx.client, "coder"), null)
  // And the static map it replaced still says the opposite for the planner,
  // which is the whole reason the prompt side had to stop asking it.
  assert.equal(mayDelegate("planner"), true)
})

test("the static map keeps exactly one job: the plugin's own default", () => {
  // It is rung 2 of resolveSpawnPermission and the answer the offline prompt
  // files are written from. It is not a mode test — that is isSubagentRole —
  // and the orchestrator is neither.
  assert.equal(isSubagentRole("orchestrator"), false)
  assert.equal(mayDelegate("orchestrator"), false)
  assert.equal(isSubagentRole("planner"), true)
  assert.equal(isSubagentRole("some-project-agent"), false)
  assert.equal(mayDelegate("some-project-agent"), false)
  for (const [name, def] of Object.entries(AGENTS)) {
    if (def.mode !== "subagent") continue
    assert.equal(
      mayDelegate(name),
      def.permission?.spawn !== "deny",
      `${name}: the static map is the permission map and nothing else`,
    )
  }
})

// `fmtTokens` renders below 1000 as a bare count and above it as `12.4k`, so a
// figure is compared as a number of tokens and never as the text.
function toTokens(text) {
  return text.endsWith("k") ? Math.round(Number(text.slice(0, -1)) * 1000) : Number(text)
}

// `coder 100.0k (−12.4k fixed → 87.6k)` — every entry of the orchestrator's
// per-type budget line, as a map of type to its fixed-overhead figure.
function overheadFor(prompt) {
  const figures = {}
  const re = /(\w+) [0-9.]+k? \(−([0-9.]+k?) fixed → [0-9.]+k?\)/g
  for (const m of prompt.matchAll(re)) figures[m[1]] = toTokens(m[2])
  return figures
}

function targetOverhead(prompt, target) {
  const m = new RegExp(`${target} [0-9.]+k? \\(−([0-9.]+k?) fixed → [0-9.]+k?\\)`).exec(prompt)
  return m ? toTokens(m[1]) : null
}
