// Parity between the plugin's limit resolution (src/settings.js) and the
// sidebar's copy of it (tui/src/settings-file.ts).
//
// The TUI is a separate npm package and cannot import the plugin module, so it
// carries its own copy of the shared defaults, the env var names and the
// file > env > default order. Nothing at runtime notices when the two drift
// apart; these tests do, by pinning both sides at the same file and env. The
// two boolean keys are in it too: endlessMode and showAgentcom are pinned here
// as booleans, the kind whose validator differs from the integer rule the
// others share.
//
// The role set itself is pinned the same way. The plugin derives it once, from
// AGENTS in src/agents.js: AGENT_NAMES (src/promptsfile.js) is every installed
// role, SPAWNABLE_ROLES (src/agents.js) is the spawn gate's closed set. The
// sidebar carries its own copy in tui/src/agent-roles.ts and builds the
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
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_NESTED_SPAWNS,
  DEFAULT_MAX_RESULT_TOKENS,
  DEFAULT_MAX_RETAINED_SUBAGENTS,
  DEFAULT_MAX_REUSE_CONTEXT,
  DEFAULT_MAX_SUBAGENTS,
  DEFAULT_RETAINED_SUBAGENT_TTL_MS,
  DEFAULT_SHOW_AGENTCOM,
  contextBudgetFor,
  reuseCeilingFor,
  resultCeilingFor,
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import {
  AGENT_NAMES as TUI_AGENT_NAMES,
  DEFAULT_AGENT_CONTEXT as TUI_DEFAULT_AGENT_CONTEXT,
  PROMPT_AGENT_FILES,
  SPAWNABLE_ROLES as TUI_SPAWNABLE_ROLES,
  spawnableAgentNames,
} from "../tui/src/agent-roles.ts"
import {
  DEFAULT_ENDLESS_CONTEXT as TUI_DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE as TUI_DEFAULT_ENDLESS_MODE,
  DEFAULT_MAX_CONTEXT as TUI_DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_NESTED_SPAWNS as TUI_DEFAULT_MAX_NESTED_SPAWNS,
  DEFAULT_MAX_RESULT_TOKENS as TUI_DEFAULT_MAX_RESULT_TOKENS,
  DEFAULT_MAX_RETAINED_SUBAGENTS as TUI_DEFAULT_MAX_RETAINED_SUBAGENTS,
  DEFAULT_MAX_REUSE_CONTEXT as TUI_DEFAULT_MAX_REUSE_CONTEXT,
  DEFAULT_MAX_SUBAGENTS as TUI_DEFAULT_MAX_SUBAGENTS,
  DEFAULT_RETAINED_SUBAGENT_TTL_MS as TUI_DEFAULT_RETAINED_SUBAGENT_TTL_MS,
  DEFAULT_SHOW_AGENTCOM as TUI_DEFAULT_SHOW_AGENTCOM,
  effectiveAgentContext,
  effectiveResultTokens,
  effectiveReuseContext,
  readSettings,
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
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS
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
      maxRetainedSubagents: plugin.maxRetainedSubagents,
      retainedSubagentTtlMs: plugin.retainedSubagentTtlMs,
      maxReuseContext: plugin.maxReuseContext,
      reuseContext: plugin.reuseContext,
      maxResultTokens: plugin.maxResultTokens,
      resultTokens: plugin.resultTokens,
      showAgentcom: plugin.showAgentcom,
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

// The reuse ceiling both sides resolve for one agent type, plus the TUI's own
// verdict on whether the type carries a value of its own.
function ceilingBothSides(agent) {
  resetSettings()
  const plugin = reuseCeilingFor(agent)
  const tui = effectiveReuseContext(readSettings(), agent)
  return [plugin, tui]
}

// Asserts the two halves agree on one type's reuse ceiling and on where it came
// from.
function assertCeiling(agent, value, source) {
  const [plugin, tui] = ceilingBothSides(agent)
  assert.equal(plugin, value)
  assert.equal(tui.value, value)
  assert.equal(tui.source, source)
}

// The reply ceiling both sides resolve for one agent type, plus the TUI's own
// verdict on whether the type carries a value of its own.
function replyCeilingBothSides(agent) {
  resetSettings()
  const plugin = resultCeilingFor(agent)
  const tui = effectiveResultTokens(readSettings(), agent)
  return [plugin, tui]
}

// Asserts the two halves agree on one type's reply ceiling and on where it
// came from. Enforced at one number and displayed at another would mean a user
// tuning a row that governs nothing.
function assertReplyCeiling(agent, value, source) {
  const [plugin, tui] = replyCeilingBothSides(agent)
  assert.equal(plugin, value)
  assert.equal(tui.value, value)
  assert.equal(tui.source, source)
}

test("the two modules carry the same built-in defaults", () => {
  assert.equal(DEFAULT_MAX_SUBAGENTS, TUI_DEFAULT_MAX_SUBAGENTS)
  assert.equal(DEFAULT_MAX_CONTEXT, TUI_DEFAULT_MAX_CONTEXT)
  assert.equal(DEFAULT_ENDLESS_MODE, TUI_DEFAULT_ENDLESS_MODE)
  assert.equal(DEFAULT_ENDLESS_CONTEXT, TUI_DEFAULT_ENDLESS_CONTEXT)
  assert.equal(DEFAULT_SHOW_AGENTCOM, TUI_DEFAULT_SHOW_AGENTCOM)
  assert.equal(DEFAULT_MAX_NESTED_SPAWNS, TUI_DEFAULT_MAX_NESTED_SPAWNS)
  assert.equal(DEFAULT_MAX_RETAINED_SUBAGENTS, TUI_DEFAULT_MAX_RETAINED_SUBAGENTS)
  assert.equal(DEFAULT_RETAINED_SUBAGENT_TTL_MS, TUI_DEFAULT_RETAINED_SUBAGENT_TTL_MS)
  assert.equal(DEFAULT_MAX_REUSE_CONTEXT, TUI_DEFAULT_MAX_REUSE_CONTEXT)
  assert.equal(DEFAULT_MAX_RESULT_TOKENS, TUI_DEFAULT_MAX_RESULT_TOKENS)
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
//
// The `mode` the listing reports decides nothing: a project may override an
// installed role's `mode` to `primary`, and the gate still accepts the name, so
// the row stays. `coder` below is that case.
test("the ceiling list keeps only the spawnable roles of an opencode listing", () => {
  const listing = [
    { name: "build", mode: "primary" },
    { name: "orchestrator", mode: "primary" },
    { name: "general", mode: "subagent" },
    { name: "coder", mode: "primary" },
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
    maxRetainedSubagents: DEFAULT_MAX_RETAINED_SUBAGENTS,
    retainedSubagentTtlMs: DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    maxReuseContext: DEFAULT_MAX_REUSE_CONTEXT,
    reuseContext: {},
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    resultTokens: {},
    showAgentcom: DEFAULT_SHOW_AGENTCOM,
  })
  assert.deepEqual(tui, plugin)
})

test("with env alone both resolve the env value", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM = "0"
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
    maxRetainedSubagents: DEFAULT_MAX_RETAINED_SUBAGENTS,
    retainedSubagentTtlMs: DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    maxReuseContext: DEFAULT_MAX_REUSE_CONTEXT,
    reuseContext: {},
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    resultTokens: {},
    showAgentcom: false,
  })
  assert.deepEqual(tui, plugin)
})

test("with file and env both let the file win", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM = "0"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS = "3"
  writeFileSync(
    file,
    JSON.stringify({
      maxSubagents: 2,
      maxContext: 95000,
      endlessMode: false,
      endlessContext: 120000,
      maxNestedSpawns: 1,
      showAgentcom: true,
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
    maxRetainedSubagents: DEFAULT_MAX_RETAINED_SUBAGENTS,
    retainedSubagentTtlMs: DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    maxReuseContext: DEFAULT_MAX_REUSE_CONTEXT,
    reuseContext: {},
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    resultTokens: {},
    showAgentcom: true,
  })
  assert.deepEqual(tui, plugin)
})

test("both reject the same file values and fall back to env or default", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: -1, maxContext: "lots", showAgentcom: "yes" }),
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
    maxRetainedSubagents: DEFAULT_MAX_RETAINED_SUBAGENTS,
    retainedSubagentTtlMs: DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    maxReuseContext: DEFAULT_MAX_REUSE_CONTEXT,
    reuseContext: {},
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    resultTokens: {},
    showAgentcom: DEFAULT_SHOW_AGENTCOM,
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
    maxRetainedSubagents: DEFAULT_MAX_RETAINED_SUBAGENTS,
    retainedSubagentTtlMs: DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    maxReuseContext: DEFAULT_MAX_REUSE_CONTEXT,
    reuseContext: {},
    maxResultTokens: DEFAULT_MAX_RESULT_TOKENS,
    resultTokens: {},
    showAgentcom: DEFAULT_SHOW_AGENTCOM,
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

test("both take showAgentcom from the file only as a real boolean", () => {
  writeFileSync(file, JSON.stringify({ showAgentcom: false }))
  const [off, tuiOff] = bothSides()
  assert.equal(off.showAgentcom, false)
  assert.deepEqual(tuiOff, off)

  for (const bad of ["false", 0, null]) {
    writeFileSync(file, JSON.stringify({ showAgentcom: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.showAgentcom, DEFAULT_SHOW_AGENTCOM)
    assert.deepEqual(tui, plugin)
  }
})

test("both let the file's showAgentcom win over the env var", () => {
  process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM = "1"
  writeFileSync(file, JSON.stringify({ showAgentcom: false }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.showAgentcom, false)
  assert.deepEqual(tui, plugin)
})

test("both read the showAgentcom env var as 1/0 and ignore anything else", () => {
  process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM = "0"
  const [off, tuiOff] = bothSides()
  assert.equal(off.showAgentcom, false)
  assert.deepEqual(tuiOff, off)

  process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM = "no"
  const [plugin, tui] = bothSides()
  assert.equal(plugin.showAgentcom, DEFAULT_SHOW_AGENTCOM)
  assert.deepEqual(tui, plugin)
})

// A file still carrying the superseded key expresses nothing about this
// setting on either side: it is a rename, not an alias.
test("both ignore the superseded hideChatter key", () => {
  writeFileSync(file, JSON.stringify({ hideChatter: true }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.showAgentcom, DEFAULT_SHOW_AGENTCOM)
  assert.deepEqual(tui, plugin)
})

test("both keep the two booleans apart", () => {
  // One switch on and the other off must not read as one state: the file's
  // validators are per key on both sides.
  writeFileSync(file, JSON.stringify({ endlessMode: true, showAgentcom: false }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.endlessMode, true)
  assert.equal(plugin.showAgentcom, false)
  assert.deepEqual(tui, plugin)

  // A rejected value for one leaves the other standing.
  writeFileSync(file, JSON.stringify({ endlessMode: "true", showAgentcom: false }))
  const [mixed, tuiMixed] = bothSides()
  assert.equal(mixed.endlessMode, DEFAULT_ENDLESS_MODE)
  assert.equal(mixed.showAgentcom, false)
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

// The two retention keys the plugin gates the feature on. The sidebar carries
// them for the same reason it carries maxNestedSpawns: no row edits them yet,
// and a write that dropped a key the plugin honours would switch retention off
// behind the user's back.
test("both resolve the retention keys file > env > default and reject the same values", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS = "3"
  process.env.OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS = "900000"
  const [envOnly, tuiEnvOnly] = bothSides()
  assert.equal(envOnly.maxRetainedSubagents, 3, "env over the built-in default")
  assert.equal(envOnly.retainedSubagentTtlMs, 900000)
  assert.deepEqual(tuiEnvOnly, envOnly)

  writeFileSync(file, JSON.stringify({ maxRetainedSubagents: 2, retainedSubagentTtlMs: 120000 }))
  const [fromFile, tuiFromFile] = bothSides()
  assert.equal(fromFile.maxRetainedSubagents, 2, "the file wins over the env var")
  assert.equal(fromFile.retainedSubagentTtlMs, 120000)
  assert.deepEqual(tuiFromFile, fromFile)

  for (const bad of [1.5, -1, "2", null]) {
    writeFileSync(file, JSON.stringify({ maxRetainedSubagents: bad, retainedSubagentTtlMs: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.maxRetainedSubagents, 3, `${bad} must be rejected by both`)
    assert.equal(plugin.retainedSubagentTtlMs, 900000)
    assert.deepEqual(tui, plugin)
  }
})

// 0 means two different things on the two keys, and both sides have to read it
// the same way: on the capacity it is the off switch, on the window it is a
// value the floor lifts to 1 ms — nothing outside the plugin ever deletes a
// subagent session, so a window of 0 would be a session held forever.
test("both take a retention capacity of 0 as off and floor the window at 1 ms", () => {
  writeFileSync(file, JSON.stringify({ maxRetainedSubagents: 0, retainedSubagentTtlMs: 0 }))
  const [plugin, tui] = bothSides()
  assert.equal(plugin.maxRetainedSubagents, 0)
  assert.equal(plugin.retainedSubagentTtlMs, 1)
  assert.deepEqual(tui, plugin)
})

// The per-type reuse ceiling, pinned over its whole three-level chain the way
// the budget is pinned over its five: the plugin resolves it in reuseCeilingFor
// and the sidebar in effectiveReuseContext, and a type the two disagreed on
// would be admitted for reuse at one number and displayed at another.
test("both resolve the reuse ceiling keys file > env > default and reject the same values", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT = "50000"
  const [envOnly, tuiEnvOnly] = bothSides()
  assert.equal(envOnly.maxReuseContext, 50000, "env over the built-in default")
  assert.deepEqual(tuiEnvOnly, envOnly)

  writeFileSync(file, JSON.stringify({ maxReuseContext: 40000, reuseContext: { coder: 30000 } }))
  const [fromFile, tuiFromFile] = bothSides()
  assert.equal(fromFile.maxReuseContext, 40000, "the file wins over the env var")
  assert.deepEqual(fromFile.reuseContext, { coder: 30000 })
  assert.deepEqual(tuiFromFile, fromFile)

  for (const bad of [1.5, -1, "2", null]) {
    writeFileSync(file, JSON.stringify({ maxReuseContext: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.maxReuseContext, 50000, `${bad} must be rejected by both`)
    assert.deepEqual(tui, plugin)
  }
})

test("both resolve an agent's own reuse ceiling ahead of the flat one", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT = "50000"
  writeFileSync(file, JSON.stringify({ maxReuseContext: 40000, reuseContext: { coder: 90000 } }))
  assertCeiling("coder", 90000, "agent")
  assertCeiling("planner", 40000, "inherited")
})

test("both let the reuse ceiling env var govern every type without an own entry", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT = "50000"
  writeFileSync(file, JSON.stringify({ reuseContext: { coder: 90000 } }))
  assertCeiling("researcher", 50000, "inherited")
  assertCeiling("coder", 90000, "agent")
})

// There is no built-in per-type table behind this one: with neither file nor
// env every type — installed role or not — gets the same flat default.
test("both give every type the built-in reuse default with neither file nor env", () => {
  for (const agent of [...SPAWNABLE_ROLES, "subagent", "orchestrator"]) {
    assertCeiling(agent, DEFAULT_MAX_REUSE_CONTEXT, "inherited")
  }
})

test("both take a reuse ceiling of 0 as a real per-type value: never reuse this type", () => {
  writeFileSync(file, JSON.stringify({ reuseContext: { coder: 0 } }))
  assertCeiling("coder", 0, "agent")
  assertCeiling("planner", DEFAULT_MAX_REUSE_CONTEXT, "inherited")

  // A flat 0 says it of every type without an own entry.
  writeFileSync(file, JSON.stringify({ maxReuseContext: 0, reuseContext: { coder: 60000 } }))
  assertCeiling("planner", 0, "inherited")
  assertCeiling("coder", 60000, "agent")
})

test("both drop a malformed reuse entry and keep the rest of the map", () => {
  writeFileSync(
    file,
    JSON.stringify({
      reuseContext: { coder: 90000, planner: "lots", debugger: -1, reviewer: 1.5 },
    }),
  )
  assertCeiling("coder", 90000, "agent")
  for (const agent of ["planner", "debugger", "reviewer"]) {
    assertCeiling(agent, DEFAULT_MAX_REUSE_CONTEXT, "inherited")
  }
})

test("both ignore a reuseContext that is not a plain object", () => {
  for (const bad of [[60000], "60000", 60000, null]) {
    writeFileSync(file, JSON.stringify({ reuseContext: bad }))
    const [plugin, tui] = bothSides()
    assert.deepEqual(plugin.reuseContext, {})
    assert.deepEqual(tui, plugin)
    assertCeiling("coder", DEFAULT_MAX_REUSE_CONTEXT, "inherited")
  }
})

// The two maps are separate settings and neither reads the other: a budget for
// one type says nothing about its reuse ceiling, and a reuse ceiling above the
// budget is accepted as written on both sides rather than rejected or clamped.
test("both keep the budget map and the reuse map apart", () => {
  writeFileSync(
    file,
    JSON.stringify({ agentContext: { coder: 40000 }, reuseContext: { coder: 150000 } }),
  )
  assertBudget("coder", 40000, "agent")
  assertCeiling("coder", 150000, "agent")
  assertBudget("planner", DEFAULT_AGENT_CONTEXT.planner, "inherited")
  assertCeiling("planner", DEFAULT_MAX_REUSE_CONTEXT, "inherited")
})

// The reply token ceiling, pinned over its whole chain: the constant, the env
// var name, the flat key, the per-type map and the `0` that means no ceiling.
// The plugin cuts a subagent's reply at this number and the sidebar row edits
// it, so a divergence would let a user raise a ceiling that stays where it was.
test("both resolve the reply ceiling keys file > env > default and reject the same values", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS = "1200"
  const [envOnly, tuiEnvOnly] = bothSides()
  assert.equal(envOnly.maxResultTokens, 1200, "env over the built-in default")
  assert.deepEqual(tuiEnvOnly, envOnly)
  assertReplyCeiling("coder", 1200, "inherited")

  writeFileSync(file, JSON.stringify({ maxResultTokens: 3000, resultTokens: { coder: 20000 } }))
  const [fromFile, tuiFromFile] = bothSides()
  assert.equal(fromFile.maxResultTokens, 3000, "the file wins over the env var")
  assert.deepEqual(fromFile.resultTokens, { coder: 20000 })
  assert.deepEqual(tuiFromFile, fromFile)
  assertReplyCeiling("coder", 20000, "agent")
  assertReplyCeiling("planner", 3000, "inherited")

  for (const bad of [1.5, -1, "2", null]) {
    writeFileSync(file, JSON.stringify({ maxResultTokens: bad }))
    const [plugin, tui] = bothSides()
    assert.equal(plugin.maxResultTokens, 1200, `${bad} must be rejected by both`)
    assert.deepEqual(tui, plugin)
  }
})

test("both drop the same resultTokens entries and keep the rest of the map", () => {
  writeFileSync(
    file,
    JSON.stringify({ resultTokens: { coder: 8000, planner: -1, reviewer: 2.5, designer: "lots" } }),
  )
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin.resultTokens, { coder: 8000 })
  assert.deepEqual(tui, plugin)
  assertReplyCeiling("coder", 8000, "agent")
  for (const agent of ["planner", "reviewer", "designer"]) {
    assertReplyCeiling(agent, DEFAULT_MAX_RESULT_TOKENS, "inherited")
  }
})

test("both ignore a resultTokens that is not a plain object", () => {
  for (const bad of [[2000], "2000", 2000, null]) {
    writeFileSync(file, JSON.stringify({ resultTokens: bad }))
    const [plugin, tui] = bothSides()
    assert.deepEqual(plugin.resultTokens, {})
    assert.deepEqual(tui, plugin)
    assertReplyCeiling("coder", DEFAULT_MAX_RESULT_TOKENS, "inherited")
  }
})

test("both keep 0 as a reply ceiling in its own right, per type and flat", () => {
  writeFileSync(file, JSON.stringify({ resultTokens: { coder: 0 } }))
  assertReplyCeiling("coder", 0, "agent")
  assertReplyCeiling("planner", DEFAULT_MAX_RESULT_TOKENS, "inherited")

  writeFileSync(file, JSON.stringify({ maxResultTokens: 0, resultTokens: { coder: 4000 } }))
  assertReplyCeiling("planner", 0, "inherited")
  assertReplyCeiling("coder", 4000, "agent")
})

// The three per-type maps are separate settings and none reads another: a
// context budget says nothing about a reuse ceiling, and neither says anything
// about how much of that type's reply reaches the orchestrator.
test("both keep the reply map apart from the budget and reuse maps", () => {
  writeFileSync(
    file,
    JSON.stringify({
      agentContext: { coder: 40000 },
      reuseContext: { coder: 150000 },
      resultTokens: { coder: 20000 },
    }),
  )
  assertBudget("coder", 40000, "agent")
  assertCeiling("coder", 150000, "agent")
  assertReplyCeiling("coder", 20000, "agent")
  assertReplyCeiling("planner", DEFAULT_MAX_RESULT_TOKENS, "inherited")
})
