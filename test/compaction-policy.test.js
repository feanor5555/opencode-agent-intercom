// The global compaction policy: opencode's own automatic compaction is switched
// off in the resolved config, in BOTH agent modes and whatever the settings
// file says (applyCompactionPolicy, src/compaction.js).
//
// Two things are pinned here, and the second is the reason for the first:
//
//   1. The write itself — `compaction.auto` is false, every neighbouring key of
//      that object survives, a project that set `auto: true` loses, and a
//      second call changes nothing.
//   2. That the write reads NO setting. opencode latches its config at instance
//      bootstrap, so a global value derived from `compaction` /
//      `agentCompaction` would need an opencode restart to take effect, while
//      the per-agent switch is meant to be read live at every crossing. A value
//      that never enters this write is what makes that possible, so the file is
//      moved under the hook here and the write must not move with it.
//
// Run: node --test test/compaction-policy.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { applyCompactionPolicy } from "../src/compaction.js"
import { suppressBuiltinAgentTurns } from "../src/agents.js"
import { resetState } from "../src/state.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { resetOverrides } from "../src/overrides.js"
import {
  AGENT_MODE_ORCHESTRATOR,
  AGENT_MODE_SOLO,
  setSettingsPath,
  resetSettings,
  soloModeActive,
} from "../src/settings.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-compaction-policy-"))
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
  resetProjectContext()
  resetPermissionGuardCache()
  resetOverrides()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// The settings this process is LOADED with: the file is written and the latch
// dropped, so the next read decides the agent mode afresh.
function loadWith(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

const client = {
  session: {
    create: async () => ({ data: { id: "ses_x" } }),
    promptAsync: async () => ({ data: undefined }),
    abort: async () => ({ data: true }),
    delete: async () => ({ data: true }),
    update: async () => ({ data: {} }),
    status: async () => ({ data: {} }),
    get: async () => ({ data: { directory: fixtureDir } }),
    messages: async () => ({ data: [] }),
  },
  tui: { showToast: async () => ({ data: true }) },
  config: { get: async () => ({ data: { agent: {} } }) },
}

// The config as the whole hook chain leaves it, for the settings in hand.
async function hookConfig(config = { agent: {} }) {
  const hooks = await plugin({ client, directory: fixtureDir, worktree: fixtureDir, project: {} })
  await hooks.config(config)
  return config
}

// ===========================================================================
// the write itself
// ===========================================================================

test("the policy switches automatic compaction off", () => {
  const config = { agent: {} }
  applyCompactionPolicy(config)
  assert.deepEqual(config.compaction, { auto: false })
})

test("the policy keeps every neighbouring key of the compaction object", () => {
  const config = {
    compaction: { tail_turns: 15, prune: true, reserved: 4000, preserve_recent_tokens: 8000 },
  }
  applyCompactionPolicy(config)
  assert.deepEqual(config.compaction, {
    tail_turns: 15,
    prune: true,
    reserved: 4000,
    preserve_recent_tokens: 8000,
    auto: false,
  })
})

test("the plugin wins over a project that switched automatic compaction on", () => {
  // Not a default to be overridden: compaction is a user-facing setting of this
  // plugin from here on, and a project file that contradicted it would leave
  // the user's own switch saying something that is not in effect.
  const config = { compaction: { auto: true, tail_turns: 4 } }
  applyCompactionPolicy(config)
  assert.deepEqual(config.compaction, { auto: false, tail_turns: 4 })
})

test("a second call changes nothing", () => {
  const config = { compaction: { prune: true } }
  applyCompactionPolicy(config)
  const once = { ...config.compaction }
  applyCompactionPolicy(config)
  assert.deepEqual(config.compaction, once)
})

test("the policy touches nothing else in the config", () => {
  const config = { agent: { coder: { model: "cliproxy/small" } }, share: "manual" }
  applyCompactionPolicy(config)
  assert.deepEqual(config.agent, { coder: { model: "cliproxy/small" } })
  assert.equal(config.share, "manual")
})

test("the policy survives a config it cannot use", () => {
  for (const config of [null, undefined, "nope", 7]) {
    assert.doesNotThrow(() => applyCompactionPolicy(config))
  }
  // A non-object where an object is expected is replaced, not merged into.
  for (const bad of [[], "off", null, 7]) {
    const config = { compaction: bad }
    applyCompactionPolicy(config)
    assert.deepEqual(config.compaction, { auto: false }, `compaction: ${JSON.stringify(bad)}`)
  }
})

// ===========================================================================
// unconditional: both modes, every setting
// ===========================================================================

test("the config hook switches compaction off in orchestrator mode", async () => {
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR })
  assert.equal(soloModeActive(), false)
  const config = await hookConfig()
  assert.equal(config.compaction.auto, false)
})

test("the config hook switches compaction off in solo mode", async () => {
  loadWith({ agentMode: AGENT_MODE_SOLO })
  assert.equal(soloModeActive(), true)
  const config = await hookConfig()
  assert.equal(config.compaction.auto, false)
})

test("the config hook overrides a project's own compaction.auto", async () => {
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR })
  const config = await hookConfig({ agent: {}, compaction: { auto: true, tail_turns: 9 } })
  assert.equal(config.compaction.auto, false)
  assert.equal(config.compaction.tail_turns, 9)
})

// The point of the whole shape: the global write reads no per-agent value, so
// the row that carries that value stays live instead of needing a restart.
test("the global write is the same whatever the compaction settings say", async () => {
  for (const settings of [
    {},
    { compaction: true },
    { compaction: false },
    { compaction: true, agentCompaction: { orchestrator: true, coder: true } },
    { agentCompaction: { orchestrator: false } },
    { agentMode: AGENT_MODE_SOLO, compaction: true },
  ]) {
    loadWith(settings)
    const config = await hookConfig()
    assert.equal(
      config.compaction.auto,
      false,
      `settings ${JSON.stringify(settings)} must not move the global write`,
    )
  }
})

// ===========================================================================
// the split from the solo-mode suppression
// ===========================================================================

test("the solo-mode suppression of title and summary writes no compaction key", () => {
  loadWith({ agentMode: AGENT_MODE_SOLO })
  assert.equal(soloModeActive(), true)
  const config = { agent: {} }
  suppressBuiltinAgentTurns(config)
  assert.equal(config.agent.title.disable, true)
  assert.equal(config.agent.summary.disable, true)
  assert.equal(
    config.compaction,
    undefined,
    "compaction is not a solo-mode concern — applyCompactionPolicy owns it",
  )
})

test("the compaction AGENT entry is left alone in both modes", async () => {
  // Disabling it would turn an automatic compaction into a throw rather than
  // into a skip: opencode's compaction path dereferences the fetched agent
  // without a guard. The global key is the only switch that is safe.
  for (const mode of [AGENT_MODE_ORCHESTRATOR, AGENT_MODE_SOLO]) {
    loadWith({ agentMode: mode })
    const config = await hookConfig()
    assert.equal(config.agent.compaction, undefined, mode)
  }
})
