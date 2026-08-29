// Parity between the plugin's limit resolution (src/settings.js) and the
// sidebar's copy of it (tui/src/settings-file.ts).
//
// The TUI is a separate npm package and cannot import the plugin module, so it
// carries its own copy of the shared defaults, the env var names and the
// file > env > default order. Nothing at runtime notices when the two drift
// apart; these tests do, by pinning both sides at the same file and env. The
// two boolean keys are in it too: endlessMode and hideChatter are pinned here
// as booleans, the kind whose validator differs from the integer rule the
// others share.
//
// The role set itself is pinned the same way. The plugin derives it once, from
// AGENTS in src/agents.js: AGENT_NAMES (src/promptsfile.js) is every installed
// role, SPAWNABLE_ROLES (src/agents.js) is the spawn gate's closed set. The
// sidebar carries its own copy in tui/src/settings-file.ts and builds the
// prompt-file set, the ceiling cycler and the budget table out of it, so a role
// added to AGENTS that never reached the sidebar would give the user a spawn
// gate and a budget line the panel cannot show — and a name the sidebar offered
// beyond the set would let them tune a ceiling the gate refuses to spawn
// against.
//
// The per-agent context budget is pinned the same way, over the whole
// resolution chain: the plugin resolves it in contextBudgetFor and the sidebar
// in effectiveAgentContext, and a type whose ceiling the two disagree on would
// be enforced at one number and displayed at another.
//
// Run: node --test test/settings-defaults-parity.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SPAWNABLE_ROLES } from "../src/agents.js"
import { AGENT_NAMES } from "../src/promptsfile.js"
import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE,
  DEFAULT_HIDE_CHATTER,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_NESTED_SPAWNS,
  DEFAULT_MAX_SUBAGENTS,
  contextBudgetFor,
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import {
  AGENT_NAMES as TUI_AGENT_NAMES,
  DEFAULT_AGENT_CONTEXT as TUI_DEFAULT_AGENT_CONTEXT,
  DEFAULT_ENDLESS_CONTEXT as TUI_DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE as TUI_DEFAULT_ENDLESS_MODE,
  DEFAULT_HIDE_CHATTER as TUI_DEFAULT_HIDE_CHATTER,
  DEFAULT_MAX_CONTEXT as TUI_DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_NESTED_SPAWNS as TUI_DEFAULT_MAX_NESTED_SPAWNS,
  DEFAULT_MAX_SUBAGENTS as TUI_DEFAULT_MAX_SUBAGENTS,
  PROMPT_AGENT_FILES,
  SPAWNABLE_ROLES as TUI_SPAWNABLE_ROLES,
  effectiveAgentContext,
  readSettings,
  spawnableAgentNames,
  setSettingsPath as setTuiSettingsPath,
} from "../tui/src/settings-file.ts"

const dir = mkdtempSync(join(tmpdir(), "settings-parity-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  // Both sides read the same file, so the comparison is over one input.
  setSettingsPath(file)
  setTuiSettingsPath(file)
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE
  delete process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS
})

// Every setting both sides carry, as each resolves it right now. The plugin
// caches for TTL_MS, so its cache is dropped first.
function bothSides() {
  resetSettings()
  const plugin = getSettings()
  const tui = readSettings()
  return [
    {
      maxSubagents: plugin.maxSubagents,
      maxContext: plugin.maxContext,
      maxContextSource: plugin.maxContextSource,
      agentContext: plugin.agentContext,
      endlessMode: plugin.endlessMode,
      endlessContext: plugin.endlessContext,
      maxNestedSpawns: plugin.maxNestedSpawns,
      hideChatter: plugin.hideChatter,
    },
    tui,
  ]
}

// The budget both sides resolve for one agent type, plus the TUI's own verdict
// on whether that type carries a value of its own — the ★ on the sidebar row.
function budgetBothSides(agent) {
  resetSettings()
  const plugin = contextBudgetFor(agent)
  const tui = effectiveAgentContext(readSettings(), agent)
  return [plugin, tui]
}

// Asserts the two halves agree on one type's ceiling and that it comes from
// where the case expects.
function assertBudget(agent, value, source) {
  const [plugin, tui] = budgetBothSides(agent)
  assert.equal(plugin, value)
  assert.equal(tui.value, value)
  assert.equal(tui.source, source)
}

test("the two modules carry the same built-in defaults", () => {
  assert.equal(DEFAULT_MAX_SUBAGENTS, TUI_DEFAULT_MAX_SUBAGENTS)
  assert.equal(DEFAULT_MAX_CONTEXT, TUI_DEFAULT_MAX_CONTEXT)
  assert.equal(DEFAULT_ENDLESS_MODE, TUI_DEFAULT_ENDLESS_MODE)
  assert.equal(DEFAULT_ENDLESS_CONTEXT, TUI_DEFAULT_ENDLESS_CONTEXT)
  assert.equal(DEFAULT_HIDE_CHATTER, TUI_DEFAULT_HIDE_CHATTER)
  assert.equal(DEFAULT_MAX_NESTED_SPAWNS, TUI_DEFAULT_MAX_NESTED_SPAWNS)
  assert.deepEqual(DEFAULT_AGENT_CONTEXT, TUI_DEFAULT_AGENT_CONTEXT)
})

test("the two modules carry the same role set", () => {
  assert.deepEqual(TUI_AGENT_NAMES, AGENT_NAMES)
  assert.deepEqual(TUI_SPAWNABLE_ROLES, [...SPAWNABLE_ROLES])
})

test("the budget table names exactly the spawnable roles", () => {
  assert.deepEqual(Object.keys(DEFAULT_AGENT_CONTEXT), [...SPAWNABLE_ROLES])
  assert.deepEqual(Object.keys(TUI_DEFAULT_AGENT_CONTEXT), [...SPAWNABLE_ROLES])
})

test("there is one prompt template file per installed role", () => {
  assert.deepEqual(
    PROMPT_AGENT_FILES,
    AGENT_NAMES.map((name) => `${name}.md`),
  )
})

// The sidebar's ceiling cycler is fed from opencode's own agent listing, which
// resolves far more than this plugin's roles — its primaries, the hidden
// helpers, and every model wrapper a project declares. Only the spawnable roles
// may reach the cycler: a ceiling for any other name would govern nothing,
// because the spawn gate refuses that name, and the first ceiling edit writes
// the whole cycler list into the settings file.
test("the ceiling list keeps only the spawnable roles of an opencode listing", () => {
  const listing = [
    { name: "build", mode: "primary" },
    { name: "orchestrator", mode: "primary" },
    { name: "general", mode: "subagent" },
    { name: "coder", mode: "subagent" },
    { name: "m3", mode: "subagent" },
    { name: "researcher", mode: "subagent" },
  ]
  assert.deepEqual(spawnableAgentNames(listing), ["coder", "researcher"])
})

test("the ceiling list survives a listing that is missing fields", () => {
  assert.deepEqual(spawnableAgentNames([]), [])
  assert.deepEqual(
    spawnableAgentNames([null, {}, { mode: "subagent" }, { name: "planner" }]),
    ["planner"],
  )
})

// A role the plugin installs is spawnable and gets a ceiling row as soon as
// opencode reports it, whatever mode the listing gives it — the gate reads the
// name, not the mode. The orchestrator is the one installed role that is not
// spawnable and must never appear.
test("every spawnable role of a full listing reaches the ceiling list", () => {
  const listing = AGENT_NAMES.map((name) => ({
    name,
    mode: name === "orchestrator" ? "primary" : "subagent",
  }))
  assert.deepEqual(spawnableAgentNames(listing), [...SPAWNABLE_ROLES])
})

test("with neither file nor env both resolve the built-in defaults", () => {
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    maxContext: DEFAULT_MAX_CONTEXT,
    maxContextSource: "default",
    agentContext: {},
    endlessMode: DEFAULT_ENDLESS_MODE,
    endlessContext: DEFAULT_ENDLESS_CONTEXT,
    maxNestedSpawns: DEFAULT_MAX_NESTED_SPAWNS,
    hideChatter: DEFAULT_HIDE_CHATTER,
  })
  assert.deepEqual(tui, plugin)
})

test("with env alone both resolve the env value", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER = "1"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS = "3"
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 4,
    maxContext: 70000,
    maxContextSource: "env",
    agentContext: {},
    endlessMode: true,
    endlessContext: 300000,
    maxNestedSpawns: 3,
    hideChatter: true,
  })
  assert.deepEqual(tui, plugin)
})

test("with file and env both let the file win", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER = "1"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS = "3"
  writeFileSync(
    file,
    JSON.stringify({
      maxSubagents: 2,
      maxContext: 95000,
      endlessMode: false,
      endlessContext: 120000,
      maxNestedSpawns: 1,
      hideChatter: false,
    }),
  )
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 2,
    maxContext: 95000,
    maxContextSource: "file",
    agentContext: {},
    endlessMode: false,
    endlessContext: 120000,
    maxNestedSpawns: 1,
    hideChatter: false,
  })
  assert.deepEqual(tui, plugin)
})

test("both reject the same file values and fall back to env or default", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: -1, maxContext: "lots", hideChatter: "yes" }),
  )
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 4,
    maxContext: DEFAULT_MAX_CONTEXT,
    maxContextSource: "default",
    agentContext: {},
    endlessMode: DEFAULT_ENDLESS_MODE,
    endlessContext: DEFAULT_ENDLESS_CONTEXT,
    maxNestedSpawns: DEFAULT_MAX_NESTED_SPAWNS,
    hideChatter: DEFAULT_HIDE_CHATTER,
  })
  assert.deepEqual(tui, plugin)
})

test("both keep 0 as a value in its own right", () => {
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: 0, maxContext: 0, endlessContext: 0, maxNestedSpawns: 0 }),
  )
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 0,
    maxContext: 0,
    maxContextSource: "file",
    agentContext: {},
    endlessMode: DEFAULT_ENDLESS_MODE,
    endlessContext: 0,
    maxNestedSpawns: 0,
    hideChatter: DEFAULT_HIDE_CHATTER,
  })
  assert.deepEqual(tui, plugin)
})

test("both resolve maxNestedSpawns file > env > default and reject the same values", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS = "5"
  const [envOnly, tuiEnvOnly] = bothSides()
  assert.equal(envOnly.maxNestedSpawns, 5, "env over the built-in default")
  assert.deepEqual(tuiEnvOnly, envOnly)

  // Same integer rule as every other limit: a fraction and a negative are both
  // dropped on both sides, leaving the env resolution standing.
  for (const bad of [1.5, -1, "2", null]) {
    writeFileSync(file, JSON.stringify({ maxNestedSpawns: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.maxNestedSpawns, 5, `${bad} must be rejected by both`)
    assert.deepEqual(tui, plugin)
  }

  // 0 is a value in its own right on both sides: nesting switched off.
  writeFileSync(file, JSON.stringify({ maxNestedSpawns: 0 }))
  const [off, tuiOff] = bothSides()
  assert.equal(off.maxNestedSpawns, 0)
  assert.deepEqual(tuiOff, off)
})

test("both take endlessMode from the file only as a real boolean", () => {
  writeFileSync(file, JSON.stringify({ endlessMode: true }))
  const [on, tuiOn] = bothSides()
  assert.equal(on.endlessMode, true)
  assert.deepEqual(tuiOn, on)

  // "true", 1 and null are not booleans: both sides leave the env-or-default
  // resolution standing, the way a bad number leaves a limit standing.
  for (const bad of ["true", 1, null]) {
    writeFileSync(file, JSON.stringify({ endlessMode: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.endlessMode, DEFAULT_ENDLESS_MODE)
    assert.deepEqual(tui, plugin)
  }
})

test("both let the file's endlessMode win over the env var", () => {
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "0"
  writeFileSync(file, JSON.stringify({ endlessMode: true }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.endlessMode, true)
  assert.deepEqual(tui, plugin)
})

test("both read the endlessMode env var as 1/0 and ignore anything else", () => {
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "0"
  const [off, tuiOff] = bothSides()
  assert.equal(off.endlessMode, false)
  assert.deepEqual(tuiOff, off)

  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "yes"
  const [plugin, tui] = bothSides()
  assert.equal(plugin.endlessMode, DEFAULT_ENDLESS_MODE)
  assert.deepEqual(tui, plugin)
})

test("both take hideChatter from the file only as a real boolean", () => {
  writeFileSync(file, JSON.stringify({ hideChatter: true }))
  const [on, tuiOn] = bothSides()
  assert.equal(on.hideChatter, true)
  assert.deepEqual(tuiOn, on)

  for (const bad of ["true", 1, null]) {
    writeFileSync(file, JSON.stringify({ hideChatter: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.hideChatter, DEFAULT_HIDE_CHATTER)
    assert.deepEqual(tui, plugin)
  }
})

test("both let the file's hideChatter win over the env var", () => {
  process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER = "0"
  writeFileSync(file, JSON.stringify({ hideChatter: true }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.hideChatter, true)
  assert.deepEqual(tui, plugin)
})

test("both read the hideChatter env var as 1/0 and ignore anything else", () => {
  process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER = "1"
  const [on, tuiOn] = bothSides()
  assert.equal(on.hideChatter, true)
  assert.deepEqual(tuiOn, on)

  process.env.OPENCODE_AGENT_INTERCOM_HIDE_CHATTER = "yes"
  const [plugin, tui] = bothSides()
  assert.equal(plugin.hideChatter, DEFAULT_HIDE_CHATTER)
  assert.deepEqual(tui, plugin)
})

test("both keep the two booleans apart", () => {
  // One switch on and the other off must not read as one state: the file's
  // validators are per key on both sides.
  writeFileSync(file, JSON.stringify({ endlessMode: true, hideChatter: false }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.endlessMode, true)
  assert.equal(plugin.hideChatter, false)
  assert.deepEqual(tui, plugin)

  // A rejected value for one leaves the other standing.
  writeFileSync(file, JSON.stringify({ endlessMode: "true", hideChatter: true }))
  const [mixed, tuiMixed] = bothSides()
  assert.equal(mixed.endlessMode, DEFAULT_ENDLESS_MODE)
  assert.equal(mixed.hideChatter, true)
  assert.deepEqual(tuiMixed, mixed)
})

test("both resolve an agent's own entry ahead of everything else", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  writeFileSync(
    file,
    JSON.stringify({ maxContext: 95000, agentContext: { coder: 120000 } }),
  )
  assertBudget("coder", 120000, "agent")
})

test("both let the flat legacy key govern every type without an own entry", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 95000, agentContext: { coder: 120000 } }))
  // planner has a built-in default of its own; the user's flat number outranks
  // it, which is what keeps a pre-existing file governing as it did.
  assertBudget("planner", 95000, "inherited")
  assertBudget("coder", 120000, "agent")
})

test("both let the env var govern every type without an own entry", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  writeFileSync(file, JSON.stringify({ agentContext: { coder: 120000 } }))
  assertBudget("researcher", 70000, "inherited")
  assertBudget("coder", 120000, "agent")
})

test("both fall back to the built-in table with neither file nor env", () => {
  for (const [agent, value] of Object.entries(DEFAULT_AGENT_CONTEXT)) {
    assertBudget(agent, value, "inherited")
  }
})

test("both give a name the table does not know the flat default", () => {
  // The provisional type of a subagent the spawn tool has not upgraded yet, and
  // any agent a project defines itself.
  assertBudget("subagent", DEFAULT_MAX_CONTEXT, "inherited")
  assertBudget("orchestrator", DEFAULT_MAX_CONTEXT, "inherited")
})

test("both take 0 as a real per-type value, not as unset", () => {
  writeFileSync(file, JSON.stringify({ agentContext: { coder: 0 } }))
  assertBudget("coder", 0, "agent")
  // The sibling keeps its built-in default: a 0 is one type's, not the map's.
  assertBudget("planner", DEFAULT_AGENT_CONTEXT.planner, "inherited")
})

test("both take a flat 0 as disabling every unconfigured type", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 0, agentContext: { coder: 60000 } }))
  assertBudget("planner", 0, "inherited")
  assertBudget("coder", 60000, "agent")
})

test("both drop a malformed entry and keep the rest of the map", () => {
  writeFileSync(
    file,
    JSON.stringify({
      agentContext: { coder: 120000, planner: "lots", debugger: -1, reviewer: 1.5 },
    }),
  )
  assertBudget("coder", 120000, "agent")
  assertBudget("planner", DEFAULT_AGENT_CONTEXT.planner, "inherited")
  assertBudget("debugger", DEFAULT_AGENT_CONTEXT.debugger, "inherited")
  assertBudget("reviewer", DEFAULT_AGENT_CONTEXT.reviewer, "inherited")
})

test("both ignore an agentContext that is not a plain object", () => {
  for (const bad of [[60000], "60000", 60000, null]) {
    writeFileSync(file, JSON.stringify({ agentContext: bad }))
    const [plugin, tui] = bothSides()
    assert.deepEqual(plugin.agentContext, {})
    assert.deepEqual(tui, plugin)
    assertBudget("coder", DEFAULT_AGENT_CONTEXT.coder, "inherited")
  }
})
