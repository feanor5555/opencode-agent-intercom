// Work-package sizing (src/tools.js gate, src/notices.js feedback).
//
// The gate measures the text a spawn actually sends — the project snapshot the
// plugin prepends plus the orchestrator's prompt — with the chars/4 estimator
// in src/format.js, and compares it to `contextBudgetFor(agent)`: over the
// refuse share the spawn is rejected before a session exists, over the warn
// share it goes through with the figures appended. A budget of 0 disables the
// gate for that type. The completion notice reports the finished run against
// the same per-type budget.
//
// The gate half drives the real plugin factory with a mock client, the way
// test/endless-spawn-freeze.test.js does. Sizes are built relative to the live
// project snapshot (`packageOf`), so the assertions sit exactly on the bars
// rather than near them.
//
// The same file covers the two other halves of the sizing path: the agent-type
// gate (`spawn` accepts the plugin's own subagent roles and NOTHING else —
// refusing an agent opencode does resolve for what it is, be it a primary, a
// hidden internal or a project's own agent, and anything else by name) and the
// limits block the orchestrator reads before it writes a prompt, which renders
// each budget with its fixed overhead and the headroom left over.
//
// Run: node --test --test-timeout=5000 test/spawn-size.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { countActiveSubagents, entryForSession } from "../src/registry.js"
import { projectContext, resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings, PACKAGE_WARN_SHARE, PACKAGE_REFUSE_SHARE } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { completionNotice } from "../src/notices.js"
import { estimateTokens } from "../src/format.js"
import { SPAWNABLE_ROLES } from "../src/agents.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-size-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function withSettings(obj) {
  writeFileSync(settingsFile, JSON.stringify(obj))
  resetSettings()
}

// A prompt whose package — snapshot + separator + prompt — estimates to exactly
// `tokens`. The snapshot is cached per directory for the whole test, so the
// value measured here is the value the gate measures.
function packageOf(tokens) {
  const ctxBlock = projectContext(fixtureDir)
  const overhead = ctxBlock ? ctxBlock.length + 2 : 0
  const chars = tokens * 4 - overhead
  assert.ok(chars > 0, "fixture snapshot is larger than the requested package")
  return "x".repeat(chars)
}

// `serverAgents` is what `client.app.agents()` reports — opencode's own
// resolution, which includes built-ins that never appear in `config.agent`.
// Left undefined the mock has NO `app` namespace at all, the shape every other
// test's mock client has: the reader must then fail soft to an empty list.
function makeCtx({ agentConfig = {}, serverAgents } = {}) {
  let counter = 0
  const created = []
  const prompted = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (req) => {
        prompted.push(req)
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  if (serverAgents) client.app = { agents: async () => ({ data: serverAgents }) }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, prompted }
}

const toolCtx = { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" }

// coder: 100000 built-in budget → warn above 20.0k, refuse above 40.0k.
const CODER_BUDGET = 100000
const CODER_WARN = CODER_BUDGET * PACKAGE_WARN_SHARE
const CODER_REFUSE = CODER_BUDGET * PACKAGE_REFUSE_SHARE

test("the shares the gate enforces are the ones the guide states", () => {
  assert.equal(PACKAGE_WARN_SHARE, 0.2)
  assert.equal(PACKAGE_REFUSE_SHARE, 0.4)
})

test("a package below the warn share spawns with no size line", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: packageOf(CODER_WARN - 1000) },
    toolCtx,
  )
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.doesNotMatch(res.output, /Package size/)
  assert.deepEqual(created, ["ses_sub1"])
})

test("a package exactly at the warn share still carries no size line", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: packageOf(CODER_WARN) }, toolCtx)
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.doesNotMatch(res.output, /Package size/)
  assert.deepEqual(created, ["ses_sub1"])
})

test("a package above the warn share spawns and reports size, budget and headroom", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: packageOf(CODER_WARN + 1000) },
    toolCtx,
  )
  assert.match(res.output, /Spawned subagent "coder#1"/, "the spawn still goes through")
  assert.match(res.output, /Package size: ~21\.0k of the 100\.0k coder budget/)
  assert.match(res.output, /over the 20% target of 20\.0k/)
  assert.match(res.output, /79\.0k left for the subagent's own work/)
  assert.deepEqual(created, ["ses_sub1"], "the session was created")
})

test("a package exactly at the refuse share is still allowed", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: packageOf(CODER_REFUSE) },
    toolCtx,
  )
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.match(res.output, /Package size: ~40\.0k of the 100\.0k coder budget/)
  assert.deepEqual(created, ["ses_sub1"])
})

test("a package above the refuse share is refused, naming size, budget, bar and the split", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const before = countActiveSubagents()

  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: packageOf(CODER_REFUSE + 1000) },
    toolCtx,
  )
  assert.match(res.output, /^Spawn refused: the work package is ~41\.0k tokens \(estimated/)
  assert.match(res.output, /over the 40% bar of 40\.0k for a coder/)
  assert.match(res.output, /whose context budget is 100\.0k/)
  assert.match(res.output, /SPLIT this work into smaller packages/)
  assert.match(res.output, /file path/, "the alternative to inline content is named")
  assert.match(res.output, /at or under 20% of the budget \(20\.0k for a coder\)/)
  assert.deepEqual(created, [], "no session was created")
  assert.equal(countActiveSubagents(), before, "no slot was taken")
})

test("the bars follow the spawned type's own budget, not one shared number", async () => {
  // The built-in table gives every type the same budget, so the two types are
  // driven apart here by a configured ceiling — the case is that the gate reads
  // the SPAWNED type's budget, not one number shared across types.
  withSettings({ agentContext: { designer: 30000 } })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  // 20.0k: under coder's 40.0k bar (budget 100000), over designer's 12.0k bar
  // (configured 30000) — the same package, two verdicts.
  const pkg = packageOf(20000)

  const designer = await hooks.tool.spawn.execute({ agent: "designer", prompt: pkg }, toolCtx)
  assert.match(designer.output, /Spawn refused: the work package is ~20\.0k/)
  assert.match(designer.output, /over the 40% bar of 12\.0k for a designer/)
  assert.match(designer.output, /whose context budget is 30\.0k/)

  const coder = await hooks.tool.spawn.execute({ agent: "coder", prompt: pkg }, toolCtx)
  assert.match(coder.output, /Spawned subagent "coder#1"/)
  assert.deepEqual(created, ["ses_sub1"], "only the coder spawn created a session")
})

test("a budget of 0 disables the gate for that type instead of refusing everything", async () => {
  withSettings({ agentContext: { gitter: 0 } })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "gitter", prompt: packageOf(200000) }, toolCtx)
  assert.match(res.output, /Spawned subagent "gitter#1"/)
  assert.doesNotMatch(res.output, /Spawn refused/)
  assert.doesNotMatch(res.output, /Package size/)
  assert.deepEqual(created, ["ses_sub1"])
})

test("a configured budget moves the bars with it", async () => {
  withSettings({ agentContext: { coder: 10000 } })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  // 4.5k is far under the built-in coder bar of 40.0k but over the 4.0k bar of
  // the configured 10000-token budget.
  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: packageOf(4500) }, toolCtx)
  assert.match(res.output, /Spawn refused: the work package is ~4\.5k/)
  assert.match(res.output, /over the 40% bar of 4\.0k for a coder/)
  assert.deepEqual(created, [])
})

test("the gate measures the project snapshot the plugin prepends, not the prompt alone", async () => {
  const snapshotTokens = estimateTokens(projectContext(fixtureDir))
  assert.ok(snapshotTokens > 10, "the fixture snapshot is not empty")
  // A budget whose refuse bar sits just below the snapshot on its own: a
  // one-line prompt then crosses it, which can only happen if the snapshot is
  // part of the measured package.
  const budget = Math.floor((snapshotTokens - 4) / PACKAGE_REFUSE_SHARE)
  withSettings({ agentContext: { coder: budget } })
  assert.ok(
    estimateTokens("do x") < budget * PACKAGE_REFUSE_SHARE,
    "the prompt on its own is far under the bar",
  )

  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: "do x" }, toolCtx)
  assert.match(res.output, /Spawn refused: the work package is/)
  assert.deepEqual(created, [])
})

test("the text sent to the subagent is the text that was measured", async () => {
  const { ctx, prompted } = makeCtx()
  const hooks = await plugin(ctx)

  const pkg = packageOf(CODER_WARN + 1000)
  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: pkg }, toolCtx)
  assert.match(res.output, /Package size: ~21\.0k/)
  assert.equal(
    estimateTokens(prompted[0].body.parts[0].text),
    CODER_WARN + 1000,
    "the package the notice reports is the prompt that went out",
  )
})

// --- the completion notice: the finished run against the type's own budget ---

function sizeLine(agent, ctxTokens, packageTokens) {
  const notice = completionNotice(
    "coder#1",
    agent,
    "done",
    "ses_primary",
    undefined,
    ctxTokens,
    packageTokens,
  )
  const line = notice.split("\n").find((l) => l.startsWith("📏"))
  return line ?? ""
}

test("a finished run is reported against the budget of its own agent type", () => {
  assert.match(sizeLine("coder", 20000), /run-size: 20\.0k of the 100\.0k coder budget — ok\./)
})

test("the same figure is ok for one type and over for another", () => {
  // 20.0k: a fifth of coder's built-in 100000, two thirds of the 30000 the
  // designer is configured with.
  withSettings({ agentContext: { designer: 30000 } })
  assert.match(sizeLine("coder", 20000), /— ok\./)
  assert.match(sizeLine("designer", 20000), /20\.0k of the 30\.0k designer budget — over 60% of it/)
  assert.match(sizeLine("designer", 20000), /Scope the next spawn in this area tighter/)
})

test("a run at or over 90% of the budget reads as too big", () => {
  assert.match(sizeLine("coder", 90000), /90\.0k of the 100\.0k coder budget — at 90% of it or beyond/)
  assert.match(sizeLine("coder", 90000), /SPLIT the next spawn/)
  assert.match(sizeLine("coder", 89000), /— over 60% of it/, "just under the hard bar is the soft verdict")
})

test("a budget of 0 prints the figure with no verdict", () => {
  withSettings({ agentContext: { gitter: 0 } })
  const line = sizeLine("gitter", 41000)
  assert.match(line, /run-size: 41\.0k tokens \(no context budget set for gitter\)\./)
  assert.doesNotMatch(line, /SPLIT|ok\.|over/)
})

test("an unknown run size produces no size line at all", () => {
  assert.equal(sizeLine("coder", undefined), "")
  assert.equal(sizeLine("coder", 0), "")
})

test("a type the built-in table does not name is measured against the default budget", () => {
  // DEFAULT_MAX_CONTEXT = 100000 → soft bar 60.0k.
  assert.match(sizeLine("scribe", 70000), /70\.0k of the 100\.0k scribe budget — over 60% of it/)
})

test("the registry entry a spawn leaves behind still carries the orchestrator's prompt", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "small job" }, toolCtx)
  assert.equal(
    entryForSession("ses_sub1").prompt,
    "small job",
    "the entry holds the orchestrator's prompt, without the snapshot",
  )
})

test("the package figure the gate measured is kept on the entry for the wake notice", async () => {
  const { ctx, prompted } = makeCtx()
  const hooks = await plugin(ctx)

  await hooks.tool.spawn.execute({ agent: "coder", prompt: packageOf(5000) }, toolCtx)
  const entry = entryForSession("ses_sub1")
  assert.equal(entry.packageTokens, 5000)
  assert.equal(
    entry.packageTokens,
    estimateTokens(prompted[0].body.parts[0].text),
    "the stored figure is the size of the text that went out",
  )
})

test("the finished run is named beside the package that started it", () => {
  const line = sizeLine("coder", 20000, 3100)
  assert.match(line, /run-size: 20\.0k of the 100\.0k coder budget/)
  assert.match(line, /your package was 3\.1k of it/)
  assert.match(line, /— ok\./)
})

test("a run at 92k for a coder reads as too big and points at both correctives", () => {
  // 92.0k is 92% of the 100000 coder budget — past the 90% bar.
  const line = sizeLine("coder", 92000, 40000)
  assert.match(line, /run-size: 92\.0k of the 100\.0k coder budget/)
  assert.match(line, /your package was 40\.0k of it/)
  assert.match(line, /at 90% of it or beyond/)
  assert.match(line, /SPLIT the next spawn/)
  assert.match(line, /package figure is itself a large share of the budget/)
})

test("a run whose package was never sized reports the run alone", () => {
  const line = sizeLine("coder", 20000)
  assert.match(line, /run-size: 20\.0k of the 100\.0k coder budget — ok\./)
  assert.doesNotMatch(line, /your package/)
})

test("with the budget disabled the package figure is still reported", () => {
  withSettings({ agentContext: { gitter: 0 } })
  const line = sizeLine("gitter", 41000, 2500)
  assert.match(line, /run-size: 41\.0k tokens, your package was 2\.5k of it \(no context budget set for gitter\)\./)
})

// --- the agent-type gate: only types that carry a visible ceiling ------------

test("an unknown agent type is refused by name, with the available types listed", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "cod3r", prompt: "fix the parser" }, toolCtx)
  assert.match(res.output, /^Spawn refused: "cod3r" is not an agent type this project has/)
  assert.match(res.output, /Available types: .*\bcoder\b/)
  assert.match(res.output, /\bresearcher\b/)
  assert.deepEqual(created, [], "no session was created")
  assert.equal(entryForSession("ses_sub1"), undefined)
})

test("the available types are the plugin's nine subagent roles and nothing else", async () => {
  const { ctx } = makeCtx({
    agentConfig: { scribe: { description: "writes" } },
    serverAgents: OPENCODE_BUILTINS,
  })
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "cod3r", prompt: "x" }, toolCtx)
  const listed = /Available types: ([^.]+)\./.exec(res.output)[1].split(", ")
  assert.deepEqual(listed, [...SPAWNABLE_ROLES].sort())
  assert.deepEqual(
    [...SPAWNABLE_ROLES].sort(),
    ["coder", "debugger", "designer", "documenter", "gitter", "grounder", "planner", "researcher", "reviewer"],
  )
})

test("every one of the plugin's roles spawns", async () => {
  withSettings({ maxSubagents: 0 }) // unlimited: all nine run in one go
  const { ctx, created } = makeCtx({ serverAgents: OPENCODE_BUILTINS })
  const hooks = await plugin(ctx)

  for (const agent of SPAWNABLE_ROLES) {
    const res = await hooks.tool.spawn.execute({ agent, prompt: "do the work" }, toolCtx)
    assert.match(res.output, new RegExp(`Spawned subagent "${agent}#\\d+"`))
  }
  assert.equal(created.length, SPAWNABLE_ROLES.length)
})

test("an agent the project's own config defines is refused for not being a plugin role", async () => {
  const { ctx, created } = makeCtx({ agentConfig: { scribe: { description: "writes" } } })
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "scribe", prompt: "write it up" }, toolCtx)
  assert.match(
    res.output,
    /^Spawn refused: "scribe" is an agent this opencode instance defines, but not one of the roles this plugin installs — only those can be spawned, so no subagent was started\./,
  )
  assert.doesNotMatch(
    res.output,
    /is not an agent type this project has/,
    "the project HAS it — the refusal must not claim otherwise",
  )
  assert.doesNotMatch(res.output, /Available types: .*\bscribe\b/)
  assert.deepEqual(created, [], "no session was created")
  assert.equal(entryForSession("ses_sub1"), undefined)
})

// opencode's own agent table as the server reports it (1.18.25,
// packages/opencode/src/agent/agent.ts): two primaries, two subagents, three
// hidden internals. None of them appears in `config.agent` — the server builds
// them before the project config is folded in.
const OPENCODE_BUILTINS = [
  { name: "build", mode: "primary", builtIn: true },
  { name: "plan", mode: "primary", builtIn: true },
  { name: "general", mode: "subagent", builtIn: true },
  { name: "explore", mode: "subagent", builtIn: true },
  { name: "compaction", mode: "primary", hidden: true, builtIn: true },
  { name: "title", mode: "primary", hidden: true, builtIn: true },
  { name: "summary", mode: "primary", hidden: true, builtIn: true },
]

test("a subagent the server resolves is refused for not being a plugin role", async () => {
  const { ctx, created } = makeCtx({ serverAgents: OPENCODE_BUILTINS })
  const hooks = await plugin(ctx)

  for (const agent of ["general", "explore"]) {
    const res = await hooks.tool.spawn.execute({ agent, prompt: "look into it" }, toolCtx)
    assert.match(
      res.output,
      new RegExp(
        `^Spawn refused: "${agent}" is an agent this opencode instance defines, but not one of ` +
          `the roles this plugin installs`,
      ),
    )
  }
  assert.deepEqual(created, [], "opencode's own subagents are not spawn targets")
})

test("the orchestrator cannot be spawned — it is the primary, not a role to delegate to", async () => {
  const { ctx, created } = makeCtx({ serverAgents: OPENCODE_BUILTINS })
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "orchestrator", prompt: "x" }, toolCtx)
  assert.match(
    res.output,
    /^Spawn refused: "orchestrator" is this plugin's primary role — the one you are running as — not a subagent to delegate to, so no subagent was started\./,
  )
  assert.doesNotMatch(
    res.output,
    /is not an agent type this project has/,
    "the plugin installs it — the refusal must not claim otherwise",
  )
  assert.doesNotMatch(
    res.output,
    /opencode's/,
    "it is this plugin's own role, not one opencode brings",
  )
  assert.doesNotMatch(res.output, /Available types: .*\borchestrator\b/)
  assert.deepEqual(created, [])
})

test("the orchestrator is refused as the plugin's own role even with no server list", async () => {
  // The fail-soft path of config.js: `app.agents` is missing, so the kind map
  // is empty. Classification off AGENTS still names the true reason instead of
  // reporting the plugin's own role as a name the project does not have.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const res = await hooks.tool.spawn.execute({ agent: "orchestrator", prompt: "x" }, toolCtx)
  assert.match(
    res.output,
    /^Spawn refused: "orchestrator" is this plugin's primary role — the one you are running as — not a subagent to delegate to, so no subagent was started\./,
  )
  assert.deepEqual(created, [])
})

test("a primary agent the server resolves is refused for being primary, not for being unknown", async () => {
  const { ctx, created } = makeCtx({ serverAgents: OPENCODE_BUILTINS })
  const hooks = await plugin(ctx)

  for (const agent of ["build", "plan"]) {
    const res = await hooks.tool.spawn.execute({ agent, prompt: "do the work" }, toolCtx)
    assert.match(
      res.output,
      new RegExp(`^Spawn refused: "${agent}" is a primary agent, ` +
        `not a type that can run as a subagent, so no subagent was started\\.`),
    )
    assert.doesNotMatch(
      res.output,
      /is not an agent type this project has/,
      "the project HAS it — the refusal must not claim otherwise",
    )
    assert.match(res.output, /Available types: .*\bcoder\b/, "the reachable types are still named")
  }
  assert.deepEqual(created, [], "no session was created for either primary")
  assert.equal(entryForSession("ses_sub1"), undefined)
})

test("a hidden agent the server resolves is refused for being hidden", async () => {
  const { ctx, created } = makeCtx({
    serverAgents: [...OPENCODE_BUILTINS, { name: "internal", mode: "subagent", hidden: true }],
  })
  const hooks = await plugin(ctx)

  // `compaction` is hidden AND primary; `internal` is hidden alone, so the
  // hidden half of the classification is pinned independently of the mode half.
  const res = await hooks.tool.spawn.execute({ agent: "internal", prompt: "x" }, toolCtx)
  assert.match(
    res.output,
    /^Spawn refused: "internal" is a hidden agent, not a type that can run as a subagent, so no subagent was started\./,
  )
  const compaction = await hooks.tool.spawn.execute({ agent: "compaction", prompt: "x" }, toolCtx)
  assert.match(
    compaction.output,
    /^Spawn refused: "compaction" is a primary agent, not a type that can run as a subagent, so no subagent was started\./,
  )
  assert.doesNotMatch(compaction.output, /Available types: .*\bcompaction\b/)
  assert.deepEqual(created, [])
})

test("a client with no app namespace still gates on the plugin's roles", async () => {
  // Every other unit-test mock client has no `app`. The classifier must fail
  // soft to an empty list rather than throw, or it takes the whole spawn path
  // down — and the closed list decides regardless of what it can read.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)

  const refused = await hooks.tool.spawn.execute({ agent: "general", prompt: "x" }, toolCtx)
  assert.match(refused.output, /^Spawn refused: "general" is not an agent type this project has/)
  const ok = await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  assert.match(ok.output, /Spawned subagent "coder#1"/)
  assert.deepEqual(created, ["ses_sub1"])
})

test("an app.agents that fails still gates on the plugin's roles", async () => {
  const { ctx, created } = makeCtx({ agentConfig: { scribe: {} } })
  ctx.client.app = {
    agents: async () => {
      throw new Error("connection refused")
    },
  }
  const hooks = await plugin(ctx)

  const ok = await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  assert.match(ok.output, /Spawned subagent "coder#1"/, "the spawn path survives the failure")
  // The config half of the classification still answers, the server half does not.
  const scribe = await hooks.tool.spawn.execute({ agent: "scribe", prompt: "x" }, toolCtx)
  assert.match(scribe.output, /^Spawn refused: "scribe" is an agent this opencode instance defines/)
  const refused = await hooks.tool.spawn.execute({ agent: "explore", prompt: "x" }, toolCtx)
  assert.match(refused.output, /^Spawn refused: "explore" is not an agent type this project has/)
  assert.deepEqual(created, ["ses_sub1"])
})

// --- the limits block: budget, fixed overhead, headroom ----------------------

// "12.3k" / "847" as rendered by format.tokens, back to a number.
function parseTokens(text) {
  return text.endsWith("k") ? Math.round(parseFloat(text) * 1000) : Number(text)
}

// The three figures of one type's entry in the limits block.
function limitsEntry(block, agent) {
  const m = new RegExp(`${agent} ([0-9.]+k?) \\(−([0-9.]+k?) fixed → ([0-9.]+k?)\\)`).exec(block)
  if (!m) return null
  return { budget: parseTokens(m[1]), fixed: parseTokens(m[2]), headroom: parseTokens(m[3]) }
}

async function limitsBlock(hooks) {
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  return out.system.join("")
}

test("each budget in the limits block carries its fixed overhead and the headroom left", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const block = await limitsBlock(hooks)
  const coder = limitsEntry(block, "coder")
  assert.ok(coder, "the coder entry renders budget, fixed overhead and headroom")
  assert.equal(coder.budget, CODER_BUDGET)
  assert.ok(coder.fixed > 0, "the fixed overhead is not zero — guides and snapshot are counted")
  assert.ok(coder.headroom < coder.budget, "headroom is less than the bare budget")
  assert.ok(
    Math.abs(coder.budget - coder.fixed - coder.headroom) <= 200,
    "headroom is the budget minus the overhead, within the rendering's rounding",
  )
  assert.match(block, /fixed overhead every spawn of that type carries before your own words/)
})

test("the fixed overhead follows what the type actually gets injected", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const block = await limitsBlock(hooks)
  // designer gets no outline guide (OUTLINE_DISABLED_AGENTS), coder does.
  assert.ok(
    limitsEntry(block, "designer").fixed < limitsEntry(block, "coder").fixed,
    "a type with fewer injected blocks carries less fixed overhead",
  )
})

test("a disabled budget stays 'off' and gets no headroom figure", async () => {
  withSettings({ agentContext: { gitter: 0 } })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const block = await limitsBlock(hooks)
  assert.match(block, /gitter off/)
  assert.equal(limitsEntry(block, "gitter"), null)
})

test("the limits block lists the plugin's roles and nothing else", async () => {
  const { ctx } = makeCtx({
    agentConfig: { scribe: {}, orchestrator: {} },
    serverAgents: OPENCODE_BUILTINS,
  })
  const hooks = await plugin(ctx)

  const block = await limitsBlock(hooks)
  for (const agent of SPAWNABLE_ROLES) {
    assert.ok(limitsEntry(block, agent), `${agent} carries a budget`)
  }
  assert.doesNotMatch(block, /orchestrator \d/, "the primary is not a spawnable subagent")
  assert.equal(block.match(/coder \d/g).length, 1, "each role is listed once")
  // The block is the closed list the gate accepts — nothing the gate refuses
  // gets a budget in it, or the orchestrator would read it as spawnable.
  for (const refused of ["scribe", "general", "explore", "build", "plan", "compaction", "title", "summary"]) {
    assert.equal(limitsEntry(block, refused), null, `${refused} is not offered as a budget`)
  }
})

test("the limits block does not depend on the server list", async () => {
  const { ctx } = makeCtx({ agentConfig: { scribe: {} } })
  const hooks = await plugin(ctx)

  const block = await limitsBlock(hooks)
  for (const agent of SPAWNABLE_ROLES) assert.ok(limitsEntry(block, agent), `${agent} is listed`)
  assert.equal(limitsEntry(block, "scribe"), null)
  assert.equal(limitsEntry(block, "general"), null)
})
