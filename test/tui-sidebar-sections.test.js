// Where each sidebar row sits, pinned against the panel source
// (tui/src/tui.tsx).
//
// The panel is @opentui/solid JSX with no render seam a unit test can drive, so
// what a test can hold is the source itself: which section body a row is
// written into, in what order, and which agent selection its value is read
// from. That is exactly what this file checks, and nothing about how the row
// looks once drawn.
//
// The three per-agent ceilings — `max Token(k)`, `reuse Token(k)` and
// `result Token` — live in the LLM params body, directly after the `effort`
// row and before `[reset current agent]`, and read the agent from the LLM
// section's own cycler (`props.llmAgent()`, over AGENT_NAMES). The sidebar
// therefore carries one agent cycler, not two. The flat retention rows stay in
// the Subagents body, and `[reset current agent]` stays a reset of the LLM
// parameters alone: it must not touch the three ceilings, which live in a
// different file (agent-intercom.json) from the ones it clears.
//
// Run: node --test test/tui-sidebar-sections.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(
  fileURLToPath(new URL("../tui/src/tui.tsx", import.meta.url)),
  "utf8",
)

// The one place a marker may stand, as an index into the source. Fails loudly
// where a marker has moved or gained a second occurrence, since every ordering
// assertion below rests on it being unique.
function only(marker) {
  const first = source.indexOf(marker)
  assert.notEqual(first, -1, `marker not in tui.tsx: ${marker}`)
  assert.equal(
    source.indexOf(marker, first + 1),
    -1,
    `marker occurs more than once in tui.tsx: ${marker}`,
  )
  return first
}

const row = (label) => only(`rowLabel(${JSON.stringify(label)})`)

const SUBAGENTS_HEADER = only("` Subagents (${rows().length})`")
const TUI_SETTINGS_HEADER = only('{" TUI settings"}')
const LLM_HEADER = only('{" LLM params"}')
const RESET_ROW = only('{"[reset current agent]"}')

test("the three per-agent ceilings sit in the LLM params body", () => {
  const effort = row("effort")
  const maxToken = row("max Token(k)")
  const reuseToken = row("reuse Token(k)")
  const resultToken = row("result Token")

  for (const [label, at] of [
    ["max Token(k)", maxToken],
    ["reuse Token(k)", reuseToken],
    ["result Token", resultToken],
  ]) {
    assert.ok(at > LLM_HEADER, `${label} stands after the LLM params header`)
    assert.ok(at > effort, `${label} stands after the effort row`)
    assert.ok(at < RESET_ROW, `${label} stands before [reset current agent]`)
  }

  assert.ok(maxToken < reuseToken, "max Token(k) before reuse Token(k)")
  assert.ok(reuseToken < resultToken, "reuse Token(k) before result Token")
})

test("the ceiling rows read the LLM section's agent selection", () => {
  for (const resolver of [
    "effectiveAgentContext",
    "effectiveReuseContext",
    "effectiveResultTokens",
  ]) {
    assert.ok(
      source.includes(`${resolver}(props.settings(), props.llmAgent())`),
      `${resolver} is called with the LLM agent`,
    )
  }

  // The steppers behind the rows freeze the cycler's whole list on their first
  // edit, so the list they hand over has to be the one the cycler offers.
  for (const stepper of ["stepAgentContext", "stepReuseContext", "stepResultTokens"]) {
    assert.ok(
      source.includes(`${stepper}(currentLlmAgent(), delta, AGENT_NAMES)`),
      `${stepper} steps the LLM agent against AGENT_NAMES`,
    )
  }
})

test("the sidebar carries exactly one agent cycler, in the LLM params body", () => {
  const agentRow = row("agent")
  assert.ok(agentRow > LLM_HEADER, "the agent row stands in the LLM params body")

  // The Subagents body's own selection is gone with its row — nothing may be
  // left pointing at it.
  for (const gone of [
    "contextAgent",
    "contextAgentIdx",
    "contextAgents",
    "onCycleContextAgent",
  ]) {
    assert.equal(source.includes(gone), false, `${gone} is gone from tui.tsx`)
  }
})

test("the flat retention rows stay in the Subagents body", () => {
  for (const label of ["retained subs", "retain (min)"]) {
    const at = row(label)
    assert.ok(at > SUBAGENTS_HEADER, `${label} stands after the Subagents header`)
    assert.ok(at < TUI_SETTINGS_HEADER, `${label} stands before the TUI settings header`)
  }
})

test("[reset current agent] resets the LLM parameters and no ceiling", () => {
  const body = source.slice(
    source.indexOf("const resetLlmAgent = (): void => {"),
    source.indexOf("const thinkingOn"),
  )
  assert.ok(body.length > 0, "resetLlmAgent is in tui.tsx")
  assert.ok(body.includes("clearLlmParamsAgent(agent)"), "it clears the agent's params")
  assert.ok(body.includes("setLlmModel(agent, null)"), "it clears the agent's model")
  for (const stepper of [
    "stepAgentContext",
    "stepReuseContext",
    "stepResultTokens",
    "showSettings",
  ]) {
    assert.equal(
      body.includes(stepper),
      false,
      `resetLlmAgent does not reach the settings store through ${stepper}`,
    )
  }
})
