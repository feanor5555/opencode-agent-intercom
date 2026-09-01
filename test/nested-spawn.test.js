// The spawn path for a subagent caller (concept: role-delegation-and-web-access,
// step S5): the gate that decides whether a nested spawn happens at all, the
// blocking behaviour that makes the child's ending the caller's tool result, and
// the two pieces of session bookkeeping a nested child needs.
//
// `spawn` is granted to six of the nine roles (planner, coder, debugger,
// reviewer, documenter, researcher); grounder, designer and gitter keep
// `spawn: "deny"`. What each grantee may NAME comes from NESTED_SPAWN_TARGETS
// (agents.js): the five non-web roles reach the researcher, the researcher
// reaches the grounder.
// The tests that drive the ADMITTED path still open it through a config
// override on the caller's role — rung 1 of checkSpawnPermission's resolution —
// so both rungs stay pinned and a later change to the plugin's own map cannot
// silently take these cases with it.
//
// Run: node --test test/nested-spawn.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import {
  entryForSession,
  upsertSession,
  countActiveSubagents,
  nestedQuotaDecision,
  chargeNestedSpawn,
} from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { teardownSubagent } from "../src/teardown.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { createPermissionGuard, resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings, getSettings } from "../src/settings.js"
import { hasLiveChildren, settleChildWaiter } from "../src/childwait.js"
import {
  AGENTS,
  NESTED_SPAWN_TARGETS,
  nestedSpawnTargets,
  SPAWNABLE_ROLES,
} from "../src/agents.js"

// The two sides of the S6 grant. Held here as well as in test/plugin.test.js
// because the gate and the permission map are two different things to get
// wrong: the map says who holds the tool, this file says what the gate does
// with that.
const DELEGATING_ROLES = [
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "researcher",
]
const NON_DELEGATING_ROLES = ["grounder", "designer", "gitter"]

const PRIMARY = "ses_primary"
const primaryCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-nested-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

function withSettings(obj) {
  writeFileSync(settingsFile, JSON.stringify(obj))
  resetSettings()
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

// The project override that opens `spawn` on the named roles — rung 1 of
// checkSpawnPermission. For the five roles S6 grants it is the same decision
// their own map already reaches; stated explicitly so the case under test is
// the nested path itself and not which rung admitted the caller.
function configAllowingSpawn(...roles) {
  const agent = {}
  for (const role of roles) agent[role] = { permission: { spawn: "allow" } }
  return agent
}

// `promptAsync` carries an `agent` in its body when it is a SPAWN and carries
// none when it is a wake notice (client.js: promptSession vs postNotice). That
// is the discriminator the carry-forward tests need — a nested child's parent
// is itself a session this harness created, so "was it created here?" cannot
// tell the two apart.
function makeCtx({ messages = [], agentConfig = {} } = {}) {
  let counter = 0
  const created = []
  const deleted = []
  const notices = []
  const prompts = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        const id = opts?.path?.id
        if (opts?.body?.agent) prompts.push(id)
        else notices.push({ id, text: opts?.body?.parts?.[0]?.text ?? "" })
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: messages }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    deleted,
    notices,
    prompts,
  }
}

function assistantReply(text, tokens = 4321) {
  return [
    {
      info: { role: "assistant", tokens: { input: tokens, output: 0 } },
      parts: [{ type: "text", text }],
    },
  ]
}

function settledOrPending(promise) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r("pending"), 20))])
}

// Polls until `fn()` is truthy or the budget runs out. The nested spawn crosses
// several awaits (config, session.get, app.agents, session.create) before its
// child exists, and a fixed sleep would either be flaky or slow.
async function until(fn, what, budgetMs = 1000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// The caller of a nested spawn: a live subagent session with a registry entry.
// Registered directly rather than spawned, so a test can name the role it wants
// without the orchestrator's own gate getting in the way.
function subagentCaller(sessionID, agent) {
  upsertSession(sessionID, { agent, prompt: "its own task", parentID: PRIMARY, directory: fixtureDir })
  return { sessionID, agent, messageID: "m2" }
}

// ---- the gate: which caller may nest at all -------------------------------

test("the caller gate splits the nine roles exactly as the grant does", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const roles = Object.entries(AGENTS)
    .filter(([, def]) => def.mode === "subagent")
    .map(([name]) => name)
  assert.equal(roles.length, 9, "expected 9 subagent roles")
  assert.deepEqual(
    roles.slice().sort(),
    [...DELEGATING_ROLES, ...NON_DELEGATING_ROLES].sort(),
    "a new subagent role must be placed on one side of the grant here",
  )

  // The three that may not delegate: the caller gate is the first check, so
  // they never reach the target check and no session is created for them.
  for (const role of NON_DELEGATING_ROLES) {
    const callerCtx = subagentCaller(`ses_caller_${role}`, role)
    const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "look it up" }, callerCtx)
    assert.match(
      res.output,
      /^You are a subagent — you cannot spawn other agents\./,
      `${role} must keep the refusal it has today`,
    )
  }

  // The six that may: they pass the caller gate. Probed with `coder`, a target
  // no role's set carries, so the assertion stays on the gate and nothing
  // blocks on a live child — reaching the target refusal is proof the caller
  // was admitted, and the refusal names that caller's own allowed set.
  for (const role of DELEGATING_ROLES) {
    const callerCtx = subagentCaller(`ses_caller_${role}`, role)
    const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: "do it" }, callerCtx)
    const [target] = nestedSpawnTargets(role)
    assert.match(
      res.output,
      new RegExp(`a "${role}" may spawn "${target}" and nothing else`),
      `${role} must be past the caller gate — it holds spawn`,
    )
  }

  assert.deepEqual(created, [], "no refusal on either side may create a session")
})

test("the refusal text for a denied role is unchanged, word for word", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  // designer keeps `spawn: "deny"`, so it gets exactly the sentence every
  // subagent got while no role could spawn at all.
  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "x" },
    subagentCaller("ses_designer", "designer"),
  )
  assert.equal(
    res.output,
    "You are a subagent — you cannot spawn other agents. If this task needs another " +
      "agent, name it and what it should do in your final reply; the orchestrator decides " +
      "and spawns it.",
  )
})

test("a role neither the config nor the plugin defines cannot nest — the gate fails closed", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "x" },
    subagentCaller("ses_custom", "some-project-agent"),
  )
  assert.match(res.output, /^You are a subagent/)
  assert.deepEqual(created, [])
})

test("checkSpawnPermission: config decides, then the plugin's map, then deny", async () => {
  const { ctx } = makeCtx({ agentConfig: { orchestrator: { permission: { spawn: "deny" } } } })
  const guard = createPermissionGuard(ctx.client)
  // rung 1: the config's explicit deny wins over a role whose own map allows.
  assert.match(await guard.checkSpawnPermission("orchestrator"), /permission\.spawn/)
  // rung 2: a role the config does not decide for falls to the plugin's map —
  // deny for the three that carry `spawn: "deny"`, allow for the six grants (an
  // absent key resolves to allow).
  assert.match(await guard.checkSpawnPermission("designer"), /permission\.spawn/)
  assert.match(await guard.checkSpawnPermission("grounder"), /permission\.spawn/)
  assert.equal(await guard.checkSpawnPermission("planner"), null)
  assert.equal(await guard.checkSpawnPermission("researcher"), null)
  // rung 3: a role neither side defines.
  assert.match(await guard.checkSpawnPermission("nobody"), /not a role this plugin defines/)
  assert.equal(await guard.checkSpawnPermission(""), "the calling agent could not be identified")
})

test("an ABSENT permission.spawn key allows — the shape S6 gives a delegating role", async () => {
  const { ctx } = makeCtx()
  const guard = createPermissionGuard(ctx.client)
  // The orchestrator's map carries no `spawn` key at all; that absence is what
  // planner/coder/debugger/reviewer/documenter/researcher get by dropping
  // NO_SPAWN.
  assert.equal(AGENTS.orchestrator.permission?.spawn, undefined)
  assert.equal(await guard.checkSpawnPermission("orchestrator"), null)
})

// ---- the gate: what an admitted caller may ask for -------------------------

test("a permitted caller may spawn a researcher and nothing else", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("planner") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  for (const agent of ["coder", "planner", "designer", "gitter", "grounder"]) {
    const res = await hooks.tool.spawn.execute({ agent, prompt: "do it" }, callerCtx)
    assert.match(res.output, /a "planner" may spawn "researcher" and nothing else/)
    assert.match(res.output, new RegExp(`you\\s+asked for a "${agent}"`))
  }
  assert.deepEqual(created, [], "a refused target creates no session")
  assert.equal(entryForSession("ses_planner").nestedSpawns, 0, "a refused target costs no quota")
})

// The researcher's own set: the grounder alone. The role holds `spawn` through
// its permission map now, so the caller gate admits it and the target check is
// what bounds it — including against the role it is itself.
test("a researcher may spawn a grounder and nothing else", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("researcher") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_researcher", "researcher")

  for (const agent of ["researcher", "coder", "planner", "designer", "gitter"]) {
    const res = await hooks.tool.spawn.execute({ agent, prompt: "do it" }, callerCtx)
    assert.match(res.output, /a "researcher" may spawn "grounder" and nothing else/)
    assert.match(res.output, new RegExp(`you\\s+asked for a "${agent}"`))
  }
  assert.deepEqual(created, [], "a refused target creates no session")
  assert.equal(entryForSession("ses_researcher").nestedSpawns, 0)
})

// The grounder is the end of the chain: it carries `spawn: "deny"`, so it never
// reaches the target check at all, and its target set is empty on both sides.
test("a grounder may spawn nothing — the chain ends there", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  assert.deepEqual([...nestedSpawnTargets("grounder")], [])
  assert.equal(AGENTS.grounder.permission?.spawn, "deny")

  for (const agent of ["researcher", "grounder", "coder"]) {
    const res = await hooks.tool.spawn.execute(
      { agent, prompt: "do it" },
      subagentCaller("ses_grounder", "grounder"),
    )
    assert.match(res.output, /^You are a subagent — you cannot spawn other agents\./)
  }
  assert.deepEqual(created, [])
})

// The other branch of the target refusal: a role admitted by its permission map
// (a project override can do this) that the target table names no set for is
// told plainly that it may spawn nothing, instead of being pointed at a target.
test("a caller with no target set is told it may spawn nothing", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("gitter") })
  const hooks = await plugin(ctx)
  assert.deepEqual([...nestedSpawnTargets("gitter")], [])

  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "look it up" },
    subagentCaller("ses_gitter", "gitter"),
  )
  assert.match(res.output, /a "gitter" may spawn nothing at all — you asked for a "researcher"/)
  assert.match(res.output, /name the agent and what it should do in your final reply/i)
  assert.deepEqual(created, [])
})

// The table and the permission maps are two ways of saying the same thing and
// must not drift: a role that holds `spawn` has somewhere to send it, and a
// role that does not holds no entry here.
test("the target table and the permission maps name the same delegating roles", () => {
  assert.deepEqual(Object.keys(NESTED_SPAWN_TARGETS).sort(), [...DELEGATING_ROLES].sort())
  for (const role of DELEGATING_ROLES) {
    const targets = nestedSpawnTargets(role)
    assert.ok(targets.length > 0, `${role} holds spawn and must have a target`)
    for (const target of targets) {
      assert.ok(SPAWNABLE_ROLES.includes(target), `${target} must be a spawnable plugin role`)
    }
  }
  for (const role of NON_DELEGATING_ROLES) {
    assert.deepEqual([...nestedSpawnTargets(role)], [], `${role} denies spawn and names no target`)
  }
  // The chain terminates: no target of a target of a target exists.
  for (const targets of Object.values(NESTED_SPAWN_TARGETS)) {
    for (const target of targets) {
      for (const second of nestedSpawnTargets(target)) {
        assert.deepEqual([...nestedSpawnTargets(second)], [], `${second} must end the chain`)
      }
    }
  }
})

test("the closed type gate leaves the nested researcher target alone", async () => {
  // The spawn gate accepts only the plugin's own roles and every role now
  // carries `hidden: true`. Every target the table names is one of them, so a
  // nested spawn's target passes the gate untouched.
  for (const targets of Object.values(NESTED_SPAWN_TARGETS)) {
    for (const target of targets) {
      assert.ok(SPAWNABLE_ROLES.includes(target), `${target} is a plugin role`)
      assert.equal(AGENTS[target].hidden, true, `${target} is hidden all the same`)
    }
  }

  const { ctx, created } = makeCtx({
    messages: assistantReply("the answer"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "look it up" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })

  const res = await pending
  assert.doesNotMatch(res.output, /Spawn refused/)
  assert.match(res.output, /the answer/)
})

test("a nested spawn carrying a task-id prefix is refused", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("coder") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_coder", "coder")

  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "T7: find the current stable version" },
    callerCtx,
  )
  assert.match(res.output, /a nested spawn carries no task id/)
  assert.match(res.output, /"T7"/)
  assert.match(res.output, /stays yours to finish/)
  assert.deepEqual(created, [])
})

// ---- the gate: the per-run quota ------------------------------------------

test("the per-run quota is charged on admission and refuses past its limit", async () => {
  withSettings({ maxNestedSpawns: 2, maxSubagents: 5 })
  const { ctx, created } = makeCtx({
    messages: assistantReply("looked it up"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  for (let i = 1; i <= 2; i++) {
    const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: `q${i}` }, callerCtx)
    const childID = await until(() => created[i - 1], `child ${i}`)
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
    await pending
    assert.equal(entryForSession("ses_planner").nestedSpawns, i)
  }

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "q3" }, callerCtx)
  assert.match(res.output, /already started 2 of the 2 researcher spawns/)
  assert.match(res.output, /the quota does not reset/)
  assert.equal(created.length, 2, "the third spawn creates no session")
})

test("maxNestedSpawns: 0 switches nesting off entirely", async () => {
  withSettings({ maxNestedSpawns: 0 })
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("planner") })
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "q" },
    subagentCaller("ses_planner", "planner"),
  )
  assert.match(res.output, /nested spawns are switched off/)
  assert.match(res.output, /maxNestedSpawns = 0/)
  assert.deepEqual(created, [])
})

test("the quota is per run: a primary caller has none, and a fresh entry starts at zero", () => {
  assert.deepEqual(nestedQuotaDecision(PRIMARY, 2), {
    used: 0,
    limit: 2,
    disabled: false,
    refused: false,
  })
  subagentCaller("ses_a", "planner")
  assert.equal(nestedQuotaDecision("ses_a", 2).refused, false)
  assert.equal(chargeNestedSpawn("ses_a"), 1)
  assert.equal(chargeNestedSpawn("ses_a"), 2)
  assert.equal(nestedQuotaDecision("ses_a", 2).refused, true)
  assert.equal(chargeNestedSpawn(PRIMARY), 0, "a primary has no entry to charge")
  // A second run of the same role is a second entry and starts clean.
  subagentCaller("ses_b", "planner")
  assert.equal(nestedQuotaDecision("ses_b", 2).used, 0)
})

test("maxNestedSpawns resolves file > env > default like every other knob", () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS
  resetSettings()
  assert.equal(getSettings().maxNestedSpawns, 2, "the default")

  process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS = "3"
  resetSettings()
  assert.equal(getSettings().maxNestedSpawns, 3, "env over the default")

  withSettings({ maxNestedSpawns: 0 })
  assert.equal(getSettings().maxNestedSpawns, 0, "the file over env, and 0 survives")

  withSettings({ maxNestedSpawns: -1 })
  assert.equal(getSettings().maxNestedSpawns, 3, "a negative value is dropped, env stands")
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS
  resetSettings()
})

// ---- the blocking behaviour ----------------------------------------------

test("the nested spawn does not return until its child ends, and returns the child's reply", async () => {
  const { ctx, created, deleted } = makeCtx({
    messages: assistantReply("Node 24.9 is the current stable release."),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "current stable node" },
    callerCtx,
  )
  const childID = await until(() => created[0], "the child session")
  await until(() => entryForSession(childID), "the child's registry entry")

  assert.equal(await settledOrPending(pending), "pending", "the caller is still blocked")
  assert.equal(hasLiveChildren("ses_planner"), true, "the caller has a live child")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })

  const res = await pending
  assert.match(res.output, /Node 24\.9 is the current stable release\./)
  assert.match(res.output, /finished and is gone/)
  assert.match(res.output, /it cannot be asked again/)
  assert.equal(res.metadata.nested, true)
  assert.equal(res.metadata.status, "completed")
  assert.equal(hasLiveChildren("ses_planner"), false, "the waiter is gone")
  assert.deepEqual(deleted, [childID], "the child's session is torn down, the caller's is not")
})

test("the caller's own spawn reservation is released before it blocks", async () => {
  const { ctx, created } = makeCtx({
    messages: assistantReply("answer"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await until(() => hasLiveChildren("ses_planner"), "the block")

  // Two live entries — the caller and its child — and no reservation on top.
  // A reservation held across the whole child run would count the child twice
  // in the cap figure and keep the quiesce predicate off zero.
  assert.equal(countActiveSubagents(), 2)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  await pending
  assert.equal(countActiveSubagents(), 1, "only the caller is left")
})

test("the concurrency cap does not gate a nested spawn — the default of 1 is not a deadlock", async () => {
  withSettings({ maxSubagents: 1 })
  const { ctx, created } = makeCtx({
    messages: assistantReply("answer"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  // The orchestrator's one slot is taken by the planner it spawned.
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "plan it" }, primaryCtx)
  const plannerID = created[0]
  const callerCtx = { sessionID: plannerID, agent: "planner", messageID: "m2" }

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[1], "the nested child")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  const res = await pending
  assert.match(res.output, /finished and is gone/)

  // The orchestrator, on the other hand, is still capped.
  const refused = await hooks.tool.spawn.execute({ agent: "coder", prompt: "code it" }, primaryCtx)
  assert.match(refused.output, /Subagent limit reached/)
})

test("every ending of the child renders as a tool result the caller can read", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("planner") })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const cases = [
    [{ status: "error", detail: "provider refused" }, /failed — provider refused/],
    [{ status: "aborted" }, /was aborted/],
    [{ status: "timeout", detail: "no activity for 90000 ms" }, /timed out for inactivity/],
    [{ status: "expired" }, /may still be running/],
    [{ status: "ended" }, /ended before it could reply/],
    [{ status: "abandoned" }, /plugin's state was reset/],
  ]
  for (const [outcome, expected] of cases) {
    withSettings({ maxNestedSpawns: cases.length })
    const before = created.length
    const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
    const childID = await until(() => created[before], "the child session")
    await until(() => hasLiveChildren("ses_planner"), "the block")
    settleChildWaiter(childID, outcome)
    const res = await pending
    assert.match(res.output, expected)
    assert.match(res.output, /You have no result from it/)
    assert.equal(res.metadata.status, outcome.status)
  }
})

test("a child that is never prompted leaves no waiter behind", async () => {
  const { ctx, created } = makeCtx({ agentConfig: configAllowingSpawn("planner") })
  ctx.client.session.promptAsync = async (opts) => {
    if (opts?.body?.agent) throw new Error("prompt rejected by the server")
    return { data: undefined }
  }
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  assert.match(res.output, /^spawn failed: prompt rejected by the server/)
  assert.equal(created.length, 1, "the session was created before the prompt failed")
  assert.equal(
    hasLiveChildren("ses_planner"),
    false,
    "a waiter left behind would hold the caller's idle open for the rest of its run",
  )
})

// ---- carry-forward 1: a blocked caller is not woken as well ----------------

test("the child's completion reaches the blocked caller once — as the tool result, not as a notice", async () => {
  const { ctx, created, notices } = makeCtx({
    messages: assistantReply("THE ANSWER"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  const res = await pending

  assert.match(res.output, /THE ANSWER/)
  assert.deepEqual(notices, [], "no wake notice may be posted into any session")
})

test("the same holds for an ending with no result: the error notice is not posted either", async () => {
  const { ctx, notices } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")
  upsertSession("ses_child", { agent: "researcher", parentID: "ses_planner" })

  await teardownSubagent(
    ctx.client,
    { sessionID: "ses_child", handle: "researcher#1", parentID: "ses_planner", agent: "researcher" },
    { notice: "researcher#1 failed", label: "test" },
  )
  assert.deepEqual(notices, [], "a subagent parent takes its child's ending as a tool result")
})

test("a primary parent still gets its wake notice — the drop is scoped to a subagent parent", async () => {
  const { ctx, notices } = makeCtx()
  const hooks = await plugin(ctx)
  upsertSession("ses_child", { agent: "researcher", parentID: PRIMARY })

  await teardownSubagent(
    ctx.client,
    { sessionID: "ses_child", handle: "researcher#1", parentID: PRIMARY, agent: "researcher" },
    { notice: "researcher#1 failed", label: "test" },
  )
  assert.deepEqual(
    notices.map((n) => n.id),
    [PRIMARY],
  )
})

// ---- carry-forward 2: the nested child is registered at session.created ----

test("session.created under a SUBAGENT parent auto-registers the child", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  subagentCaller("ses_planner", "planner")

  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_nested", parentID: "ses_planner", title: "look it up" } },
    },
  })
  const entry = entryForSession("ses_nested")
  assert.ok(entry, "without this the child is untracked until upsertSession, and the watchdog exemption does not hold")
  assert.equal(entry.parentID, "ses_planner")
})

test("session.created under a parent the plugin does not know is still ignored", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "ses_stranger", parentID: "ses_unknown", title: "t" } },
    },
  })
  assert.equal(entryForSession("ses_stranger"), undefined)
})

test("the nested child is tracked before its spawn returns, so the caller is watchdog-exempt at once", async () => {
  const { ctx, created } = makeCtx({
    messages: assistantReply("answer"),
    agentConfig: configAllowingSpawn("planner"),
  })
  const hooks = await plugin(ctx)
  const callerCtx = subagentCaller("ses_planner", "planner")

  // The event arrives while the spawn is still in flight, exactly as opencode
  // fires it during the `session.create` await.
  const origCreate = ctx.client.session.create
  ctx.client.session.create = async (...args) => {
    const res = await origCreate(...args)
    await hooks.event({
      event: {
        type: "session.created",
        properties: { info: { id: res.data.id, parentID: "ses_planner", title: "q" } },
      },
    })
    return res
  }

  const pending = hooks.tool.spawn.execute({ agent: "researcher", prompt: "q" }, callerCtx)
  const childID = await until(() => created[0], "the child session")
  await until(() => hasLiveChildren("ses_planner"), "the block")

  const child = entryForSession(childID)
  assert.ok(child, "tracked")
  assert.equal(child.agent, "researcher", "the provisional entry is upgraded to the real role")
  assert.equal(child.parentID, "ses_planner")

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: childID } } })
  await pending
})
