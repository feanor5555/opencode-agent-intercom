// Parity between the plugin's limit resolution (src/settings.js) and the
// sidebar's copy of it (tui/src/settings-file.ts).
//
// The TUI is a separate npm package and cannot import the plugin module, so it
// carries its own copy of the shared defaults, the env var names and the
// file > env > default order. Nothing at runtime notices when the two drift
// apart; these tests do, by pinning both sides at the same file and env. The
// endless keys are in it too: endlessMode is the file's only boolean and is the
// one key whose validator differs from the integer rule the others share.
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

import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS,
  contextBudgetFor,
  getSettings,
  resetSettings,
  setSettingsPath,
} from "../src/settings.js"
import {
  DEFAULT_AGENT_CONTEXT as TUI_DEFAULT_AGENT_CONTEXT,
  DEFAULT_ENDLESS_CONTEXT as TUI_DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE as TUI_DEFAULT_ENDLESS_MODE,
  DEFAULT_MAX_CONTEXT as TUI_DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS as TUI_DEFAULT_MAX_SUBAGENTS,
  effectiveAgentContext,
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
  assert.deepEqual(DEFAULT_AGENT_CONTEXT, TUI_DEFAULT_AGENT_CONTEXT)
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
  })
  assert.deepEqual(tui, plugin)
})

test("with env alone both resolve the env value", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 4,
    maxContext: 70000,
    maxContextSource: "env",
    agentContext: {},
    endlessMode: true,
    endlessContext: 300000,
  })
  assert.deepEqual(tui, plugin)
})

test("with file and env both let the file win", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE = "1"
  process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT = "300000"
  writeFileSync(
    file,
    JSON.stringify({
      maxSubagents: 2,
      maxContext: 95000,
      endlessMode: false,
      endlessContext: 120000,
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
  })
  assert.deepEqual(tui, plugin)
})

test("both reject the same file values and fall back to env or default", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS = "4"
  writeFileSync(file, JSON.stringify({ maxSubagents: -1, maxContext: "lots" }))
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 4,
    maxContext: DEFAULT_MAX_CONTEXT,
    maxContextSource: "default",
    agentContext: {},
    endlessMode: DEFAULT_ENDLESS_MODE,
    endlessContext: DEFAULT_ENDLESS_CONTEXT,
  })
  assert.deepEqual(tui, plugin)
})

test("both keep 0 as a value in its own right", () => {
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: 0, maxContext: 0, endlessContext: 0 }),
  )
  const [plugin, tui] = bothSides()
  assert.deepEqual(plugin, {
    maxSubagents: 0,
    maxContext: 0,
    maxContextSource: "file",
    agentContext: {},
    endlessMode: DEFAULT_ENDLESS_MODE,
    endlessContext: 0,
  })
  assert.deepEqual(tui, plugin)
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
