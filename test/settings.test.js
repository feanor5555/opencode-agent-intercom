// Unit tests for settings.js — the orchestrator-primary context-refresh
// threshold `maxPrimaryContext`, and `contextBudgetFor`, the per-agent-type
// subagent context budget.
//
// `maxPrimaryContext` resolves as JSON config file (if present) > env var >
// built-in default. `contextBudgetFor` extends that order by a per-type level
// at the top and a per-type table at the bottom:
//   agentContext[agent] > flat maxContext from the file > env var >
//   DEFAULT_AGENT_CONTEXT[agent] > DEFAULT_MAX_CONTEXT.
// `0` is a valid value meaning "disabled" — it must be preserved through
// every layer, not treated as falsy.
//
// `compactionEnabledFor`, the per-type switch for automatic compaction, is at
// the very bottom: the same three levels over booleans,
// agentCompaction[agent] > flat `compaction` (file, else env) >
// DEFAULT_COMPACTION, which is `false`.
//
// `resultCeilingFor`, the per-type ceiling on how much of a subagent's final
// reply reaches the orchestrator, is at the bottom of this file: three levels,
// resultTokens[agent] > flat maxResultTokens (file, else env) >
// DEFAULT_MAX_RESULT_TOKENS, where `0` means no ceiling at all.
//
// The mid-run channel's three flat scalars close the file: `midRunMessaging`,
// `answerWaitMs` and `maxMessageTokens`, each on the plain file > env > default
// order, with `0` a real value on both limits and the boolean taken from the
// file only as a real boolean.
//
// Run: node --test --test-timeout=2000 test/settings.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_ANSWER_WAIT_MS,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_MESSAGE_TOKENS,
  DEFAULT_MAX_RESULT_TOKENS,
  DEFAULT_MID_RUN_MESSAGING,
  DEFAULT_COMPACTION,
  compactionEnabledFor,
  contextBudgetFor,
  resultCeilingFor,
  getSettings,
  setSettingsPath,
  resetSettings,
} from "../src/settings.js"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT"

// Make sure no leftover env from the developer's shell skews the assertions.
function clearEnv() {
  delete process.env[ENV_NAME]
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS
  delete process.env.OPENCODE_AGENT_INTERCOM_SEARXNG_URL
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS
  delete process.env.OPENCODE_AGENT_INTERCOM_COMPACTION
}

// Point settings.js at an empty temp dir so the JSON loader has no opinion.
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  setSettingsPath(join(dir, "agent-intercom.json"))
  return dir
}

test("maxPrimaryContext defaults to 80000 when neither env nor JSON file is set", () => {
  clearEnv()
  isolate()
  const s = getSettings()
  assert.equal(s.maxPrimaryContext, 80000, "default must be 80000 tokens")
  // Sanity: independent from maxContext — maxContext keeps its own default.
  assert.equal(s.maxContext, DEFAULT_MAX_CONTEXT)
})

test("maxPrimaryContext picks up the env var override", () => {
  clearEnv()
  isolate()
  process.env[ENV_NAME] = "120000"
  resetSettings()
  assert.equal(getSettings().maxPrimaryContext, 120000)
})

test("maxPrimaryContext = 0 is honored as 'disabled' (not silently replaced by the default)", () => {
  clearEnv()
  isolate()
  // Env path: 0 must round-trip.
  process.env[ENV_NAME] = "0"
  resetSettings()
  assert.equal(getSettings().maxPrimaryContext, 0, "env=0 must be preserved")

  // JSON file path: 0 must round-trip there too, and beat the env default.
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  const file = join(dir, "agent-intercom.json")
  writeFileSync(file, JSON.stringify({ maxPrimaryContext: 0 }))
  delete process.env[ENV_NAME]
  setSettingsPath(file)
  assert.equal(getSettings().maxPrimaryContext, 0, "json=0 must be preserved")
})

// Writes a settings file into a fresh temp dir and points settings.js at it.
function withSettings(content) {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-settings-"))
  const file = join(dir, "agent-intercom.json")
  writeFileSync(file, JSON.stringify(content))
  setSettingsPath(file)
  return file
}

// The two numbers a user who configures nothing runs on. Pinned as literals
// on purpose: everything else in this file reads them through the constants,
// so without this one test a change to either would go unnoticed.
test("the built-in budget is 100000 tokens for every type and for an unknown name", () => {
  assert.equal(DEFAULT_MAX_CONTEXT, 100000)
  for (const [agent, budget] of Object.entries(DEFAULT_AGENT_CONTEXT)) {
    assert.equal(budget, 100000, `${agent} must carry the default budget`)
  }
})

test("contextBudgetFor falls back to the built-in table per agent type", () => {
  clearEnv()
  isolate()
  assert.equal(contextBudgetFor("coder"), DEFAULT_AGENT_CONTEXT.coder)
  assert.equal(contextBudgetFor("designer"), DEFAULT_AGENT_CONTEXT.designer)
  assert.equal(contextBudgetFor("planner"), DEFAULT_AGENT_CONTEXT.planner)
})

test("contextBudgetFor gives an unknown agent name DEFAULT_MAX_CONTEXT", () => {
  clearEnv()
  isolate()
  // A project's own agent, and the provisional name a subagent carries until
  // spawn upgrades it — both behave as the single old global default did.
  assert.equal(contextBudgetFor("some-project-agent"), DEFAULT_MAX_CONTEXT)
  assert.equal(contextBudgetFor("subagent"), DEFAULT_MAX_CONTEXT)
  // The orchestrator is deliberately not in the table: the budget is
  // subagent-only, the primary is governed by primaryContextThreshold.
  assert.equal(Object.hasOwn(DEFAULT_AGENT_CONTEXT, "orchestrator"), false)
})

test("an agentContext entry wins for its own type and leaves the others alone", () => {
  clearEnv()
  withSettings({ agentContext: { coder: 12345 } })
  assert.equal(contextBudgetFor("coder"), 12345)
  assert.equal(contextBudgetFor("planner"), DEFAULT_AGENT_CONTEXT.planner)
  assert.equal(contextBudgetFor("unknown"), DEFAULT_MAX_CONTEXT)
})

test("the flat maxContext seeds every type that has no entry of its own", () => {
  clearEnv()
  withSettings({ maxContext: 25000 })
  assert.equal(contextBudgetFor("coder"), 25000)
  assert.equal(contextBudgetFor("researcher"), 25000)
  assert.equal(contextBudgetFor("unknown"), 25000)
})

test("an agentContext entry beats the flat maxContext seed", () => {
  clearEnv()
  withSettings({ maxContext: 25000, agentContext: { coder: 90000 } })
  assert.equal(contextBudgetFor("coder"), 90000)
  assert.equal(contextBudgetFor("planner"), 25000)
})

test("the env var seeds every unconfigured type and loses to file and entry", () => {
  clearEnv()
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "50000"
  resetSettings()
  assert.equal(contextBudgetFor("coder"), 50000, "env displaces the built-in table")
  assert.equal(contextBudgetFor("unknown"), 50000)

  withSettings({ maxContext: 25000 })
  assert.equal(contextBudgetFor("coder"), 25000, "the file's flat key beats the env var")

  withSettings({ agentContext: { coder: 11000 } })
  assert.equal(contextBudgetFor("coder"), 11000, "the type's own entry beats the env var")
  assert.equal(contextBudgetFor("planner"), 50000, "an unconfigured type still takes the env var")
  clearEnv()
})

test("an env var equal to DEFAULT_MAX_CONTEXT still displaces the per-type table", () => {
  clearEnv()
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = String(DEFAULT_MAX_CONTEXT)
  resetSettings()
  assert.equal(contextBudgetFor("coder"), DEFAULT_MAX_CONTEXT)
  clearEnv()
})

test("0 is a real budget at every level and disables that type", () => {
  clearEnv()
  // Per type: 0 beats the non-zero built-in default of that type.
  withSettings({ agentContext: { coder: 0 } })
  assert.equal(contextBudgetFor("coder"), 0)
  assert.equal(contextBudgetFor("planner"), DEFAULT_AGENT_CONTEXT.planner)

  // As the flat seed: 0 disables every type that has no entry of its own.
  withSettings({ maxContext: 0, agentContext: { coder: 60000 } })
  assert.equal(contextBudgetFor("planner"), 0)
  assert.equal(contextBudgetFor("unknown"), 0)
  assert.equal(contextBudgetFor("coder"), 60000)

  // As the env var: same, and the file's entry still wins.
  isolate()
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "0"
  resetSettings()
  assert.equal(contextBudgetFor("coder"), 0)
  clearEnv()
})

test("a malformed agentContext map is dropped entry by entry", () => {
  clearEnv()
  withSettings({
    agentContext: { coder: "lots", planner: -1, reviewer: 2.5, designer: 1000, "": 5 },
  })
  assert.equal(contextBudgetFor("coder"), DEFAULT_AGENT_CONTEXT.coder, "non-integer entry must be dropped")
  assert.equal(contextBudgetFor("planner"), DEFAULT_AGENT_CONTEXT.planner, "negative entry must be dropped")
  assert.equal(contextBudgetFor("reviewer"), DEFAULT_AGENT_CONTEXT.reviewer, "fractional entry must be dropped")
  assert.equal(contextBudgetFor("designer"), 1000, "the one valid entry must survive")
})

test("an agentContext that is not a plain object leaves the key unset", () => {
  clearEnv()
  for (const bad of [[1, 2], "60000", null, 42]) {
    withSettings({ agentContext: bad })
    assert.deepEqual(getSettings().agentContext, {}, `bad map ${JSON.stringify(bad)}`)
    assert.equal(contextBudgetFor("coder"), DEFAULT_AGENT_CONTEXT.coder)
  }
})

test("getSettings names where the flat maxContext came from", () => {
  clearEnv()
  isolate()
  assert.equal(getSettings().maxContextSource, "default")
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "50000"
  resetSettings()
  assert.equal(getSettings().maxContextSource, "env")
  withSettings({ maxContext: 25000 })
  assert.equal(getSettings().maxContextSource, "file")
  // A file value the validator rejects leaves the env resolution standing.
  withSettings({ maxContext: "lots" })
  assert.equal(getSettings().maxContextSource, "env")
  clearEnv()
})

// --- the reply token ceiling -------------------------------------------------
//
// `resultCeilingFor` has the three levels `reuseCeilingFor` has, no built-in
// per-type table and no legacy key: resultTokens[agent] > flat maxResultTokens
// (file, else env) > DEFAULT_MAX_RESULT_TOKENS. `0` here means NO ceiling for
// that type — the reply is forwarded whole — so it must survive every layer
// rather than be read as "unset".

const RESULT_ENV = "OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS"

test("the reply ceiling defaults to 2000 for every type", () => {
  clearEnv()
  isolate()
  assert.equal(DEFAULT_MAX_RESULT_TOKENS, 2000)
  assert.equal(getSettings().maxResultTokens, DEFAULT_MAX_RESULT_TOKENS)
  assert.deepEqual(getSettings().resultTokens, {})
  assert.equal(resultCeilingFor("researcher"), 2000)
  assert.equal(resultCeilingFor("a-type-nobody-configured"), 2000)
})

test("the reply ceiling resolves file > env > default", () => {
  clearEnv()
  isolate()
  process.env[RESULT_ENV] = "3000"
  resetSettings()
  assert.equal(resultCeilingFor("coder"), 3000, "env beats the built-in default")

  withSettings({ maxResultTokens: 5000 })
  assert.equal(resultCeilingFor("coder"), 5000, "the flat file key beats the env var")

  withSettings({ maxResultTokens: 5000, resultTokens: { coder: 20000 } })
  assert.equal(resultCeilingFor("coder"), 20000, "the type's own entry beats the flat key")
  assert.equal(resultCeilingFor("planner"), 5000, "a type without an entry keeps the flat value")
  clearEnv()
})

test("0 is a real reply ceiling at every level and means no ceiling", () => {
  clearEnv()
  // Per type: 0 beats a non-zero flat value.
  withSettings({ maxResultTokens: 2000, resultTokens: { researcher: 0 } })
  assert.equal(resultCeilingFor("researcher"), 0)
  assert.equal(resultCeilingFor("coder"), 2000)

  // As the flat key: every type without an entry of its own is uncapped.
  withSettings({ maxResultTokens: 0, resultTokens: { coder: 4000 } })
  assert.equal(resultCeilingFor("planner"), 0)
  assert.equal(resultCeilingFor("coder"), 4000)

  // As the env var.
  isolate()
  process.env[RESULT_ENV] = "0"
  resetSettings()
  assert.equal(resultCeilingFor("coder"), 0)
  clearEnv()
})

test("a malformed resultTokens map is dropped entry by entry", () => {
  clearEnv()
  withSettings({
    maxResultTokens: 2000,
    resultTokens: { coder: "lots", planner: -1, reviewer: 2.5, designer: 8000, "": 5 },
  })
  assert.equal(resultCeilingFor("coder"), 2000, "non-integer entry must be dropped")
  assert.equal(resultCeilingFor("planner"), 2000, "negative entry must be dropped")
  assert.equal(resultCeilingFor("reviewer"), 2000, "fractional entry must be dropped")
  assert.equal(resultCeilingFor("designer"), 8000, "the one valid entry must survive")
  assert.deepEqual(getSettings().resultTokens, { designer: 8000 })
})

test("a resultTokens that is not a plain object leaves the map empty", () => {
  clearEnv()
  for (const bad of [[1, 2], "2000", null, 42]) {
    withSettings({ resultTokens: bad })
    assert.deepEqual(getSettings().resultTokens, {}, `bad map ${JSON.stringify(bad)}`)
    assert.equal(resultCeilingFor("coder"), DEFAULT_MAX_RESULT_TOKENS)
  }
})

test("a malformed flat maxResultTokens leaves the env-or-default resolution standing", () => {
  clearEnv()
  isolate()
  process.env[RESULT_ENV] = "1500"
  resetSettings()
  for (const bad of [-1, 2.5, "3000", null]) {
    const file = withSettings({ maxResultTokens: bad })
    assert.equal(resultCeilingFor("coder"), 1500, `bad value ${JSON.stringify(bad)} in ${file}`)
  }
  clearEnv()
})

// ===========================================================================
// compactionEnabledFor — automatic compaction per agent type
// ===========================================================================

const COMPACTION_ENV = "OPENCODE_AGENT_INTERCOM_COMPACTION"

test("compaction is off for every type when nobody configured it", () => {
  clearEnv()
  isolate()
  assert.equal(DEFAULT_COMPACTION, false)
  assert.equal(getSettings().compaction, false)
  assert.deepEqual(getSettings().agentCompaction, {})
  assert.equal(compactionEnabledFor("orchestrator"), false)
  assert.equal(compactionEnabledFor("coder"), false)
  assert.equal(compactionEnabledFor("a-type-nobody-configured"), false)
})

test("the compaction switch resolves file > env > default", () => {
  clearEnv()
  isolate()
  process.env[COMPACTION_ENV] = "1"
  resetSettings()
  assert.equal(compactionEnabledFor("coder"), true, "env beats the built-in default")

  withSettings({ compaction: false })
  assert.equal(compactionEnabledFor("coder"), false, "the flat file key beats the env var")

  withSettings({ compaction: false, agentCompaction: { coder: true } })
  assert.equal(compactionEnabledFor("coder"), true, "the type's own entry beats the flat key")
  assert.equal(compactionEnabledFor("planner"), false, "a type without an entry inherits the flat value")

  withSettings({ compaction: true, agentCompaction: { coder: false } })
  assert.equal(compactionEnabledFor("coder"), false, "an own `false` beats a flat `true`")
  assert.equal(compactionEnabledFor("orchestrator"), true)
  clearEnv()
})

test("a malformed agentCompaction map is dropped entry by entry", () => {
  clearEnv()
  withSettings({
    compaction: false,
    agentCompaction: { coder: "true", planner: 1, reviewer: null, designer: true, "": true },
  })
  assert.equal(compactionEnabledFor("coder"), false, "a string entry must be dropped")
  assert.equal(compactionEnabledFor("planner"), false, "a numeric entry must be dropped")
  assert.equal(compactionEnabledFor("reviewer"), false, "a null entry must be dropped")
  assert.equal(compactionEnabledFor("designer"), true, "the one valid entry must survive")
  assert.deepEqual(getSettings().agentCompaction, { designer: true })
})

test("an agentCompaction that is not a plain object leaves the map empty", () => {
  clearEnv()
  for (const bad of [[true], "true", null, 1]) {
    withSettings({ compaction: true, agentCompaction: bad })
    assert.deepEqual(getSettings().agentCompaction, {}, `bad map ${JSON.stringify(bad)}`)
    assert.equal(compactionEnabledFor("coder"), true, "every type falls through to the flat value")
  }
})

test("a malformed flat compaction key leaves the env-or-default resolution standing", () => {
  clearEnv()
  isolate()
  process.env[COMPACTION_ENV] = "1"
  resetSettings()
  for (const bad of ["true", 1, null, 0]) {
    const file = withSettings({ compaction: bad })
    assert.equal(compactionEnabledFor("coder"), true, `bad value ${JSON.stringify(bad)} in ${file}`)
  }
  clearEnv()
})

test("the compaction env var is read as 1/0 and anything else falls through", () => {
  clearEnv()
  isolate()
  for (const [raw, expected] of [
    ["1", true],
    ["0", false],
    [" 1 ", true],
    ["yes", DEFAULT_COMPACTION],
    ["true", DEFAULT_COMPACTION],
    ["", DEFAULT_COMPACTION],
  ]) {
    process.env[COMPACTION_ENV] = raw
    resetSettings()
    assert.equal(compactionEnabledFor("coder"), expected, `env ${JSON.stringify(raw)}`)
  }
  clearEnv()
})

// ---- the mid-run channel's three scalars -------------------------------------
//
// Two limits and a boolean, each resolving file > env > default like every
// other key. They are pinned here because nothing else in the suite reads them
// as plain settings: `midRunMessaging` is the switch both tools refuse on,
// `answerWaitMs` is the number the ask waiter clamps (test/ask-waiter.test.js
// pins the clamp itself) and `maxMessageTokens` bounds one message in either
// direction.

const ANSWER_WAIT_ENV = "OPENCODE_AGENT_INTERCOM_ANSWER_WAIT_MS"
const MESSAGE_TOKENS_ENV = "OPENCODE_AGENT_INTERCOM_MAX_MESSAGE_TOKENS"
const MID_RUN_ENV = "OPENCODE_AGENT_INTERCOM_MID_RUN_MESSAGING"

function clearMidRunEnv() {
  delete process.env[ANSWER_WAIT_ENV]
  delete process.env[MESSAGE_TOKENS_ENV]
  delete process.env[MID_RUN_ENV]
}

// The three values a user who configures nothing runs on, as literals — every
// other assertion below reads them through the constants.
test("the mid-run channel ships on a 5 minute wait, a 1000 token message and on", () => {
  clearMidRunEnv()
  isolate()
  resetSettings()
  assert.equal(DEFAULT_ANSWER_WAIT_MS, 300000)
  assert.equal(DEFAULT_MAX_MESSAGE_TOKENS, 1000)
  assert.equal(DEFAULT_MID_RUN_MESSAGING, true)
  const s = getSettings()
  assert.equal(s.answerWaitMs, DEFAULT_ANSWER_WAIT_MS)
  assert.equal(s.maxMessageTokens, DEFAULT_MAX_MESSAGE_TOKENS)
  assert.equal(s.midRunMessaging, DEFAULT_MID_RUN_MESSAGING)
})

test("the two mid-run limits resolve file > env > default", () => {
  clearMidRunEnv()
  process.env[ANSWER_WAIT_ENV] = "60000"
  process.env[MESSAGE_TOKENS_ENV] = "500"
  isolate()
  resetSettings()
  assert.equal(getSettings().answerWaitMs, 60000, "env over the built-in default")
  assert.equal(getSettings().maxMessageTokens, 500, "env over the built-in default")

  withSettings({ answerWaitMs: 120000, maxMessageTokens: 250 })
  resetSettings()
  assert.equal(getSettings().answerWaitMs, 120000, "the file wins over the env var")
  assert.equal(getSettings().maxMessageTokens, 250, "the file wins over the env var")
  clearMidRunEnv()
})

test("0 is a real value on both mid-run limits", () => {
  clearMidRunEnv()
  withSettings({ answerWaitMs: 0, maxMessageTokens: 0 })
  resetSettings()
  // 0 on the wait is "deliver the question and do not wait"; 0 on the token
  // ceiling is "do not bound the message". Neither may be read as falsy and
  // replaced by the default.
  assert.equal(getSettings().answerWaitMs, 0)
  assert.equal(getSettings().maxMessageTokens, 0)
  clearMidRunEnv()
})

test("a malformed mid-run limit leaves the env-or-default resolution standing", () => {
  clearMidRunEnv()
  process.env[ANSWER_WAIT_ENV] = "60000"
  for (const bad of [1.5, -1, "2", null, {}]) {
    withSettings({ answerWaitMs: bad, maxMessageTokens: bad })
    resetSettings()
    assert.equal(getSettings().answerWaitMs, 60000, `bad value ${JSON.stringify(bad)}`)
    assert.equal(
      getSettings().maxMessageTokens,
      DEFAULT_MAX_MESSAGE_TOKENS,
      `bad value ${JSON.stringify(bad)}`,
    )
  }
  clearMidRunEnv()
})

test("midRunMessaging is taken from the file only as a real boolean", () => {
  clearMidRunEnv()
  withSettings({ midRunMessaging: false })
  resetSettings()
  assert.equal(getSettings().midRunMessaging, false, "the channel can be switched off")

  for (const bad of ["false", 0, null, "true"]) {
    withSettings({ midRunMessaging: bad })
    resetSettings()
    assert.equal(
      getSettings().midRunMessaging,
      DEFAULT_MID_RUN_MESSAGING,
      `bad value ${JSON.stringify(bad)}`,
    )
  }
  clearMidRunEnv()
})

test("the midRunMessaging env var is read as 1/0 and the file still beats it", () => {
  clearMidRunEnv()
  isolate()
  for (const [raw, expected] of [
    ["0", false],
    ["1", true],
    ["no", DEFAULT_MID_RUN_MESSAGING],
    ["", DEFAULT_MID_RUN_MESSAGING],
  ]) {
    process.env[MID_RUN_ENV] = raw
    resetSettings()
    assert.equal(getSettings().midRunMessaging, expected, `env ${JSON.stringify(raw)}`)
  }
  process.env[MID_RUN_ENV] = "0"
  withSettings({ midRunMessaging: true })
  resetSettings()
  assert.equal(getSettings().midRunMessaging, true, "the file wins over the env var")
  clearMidRunEnv()
})
