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
// therefore carries one agent cycler, not two. The `compaction` row is the
// fourth value on that cycler and sits last of them, directly above
// `[reset current agent]`. The flat retention rows and the
// two watchdog rows — `silence (s)` and `in tool (min)` — stay in
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

test("clicking the endless row disarms mode before its live toggle check", () => {
  const start = source.indexOf('rowLabel("endless mode")')
  const end = source.indexOf('rowLabel("endless (k)")', start)
  assert.ok(start >= 0 && end > start, "the endless row bounds are present")
  const rowSource = source.slice(start, end).replace(/\s+/g, " ")
  const disarm = rowSource.indexOf("props.onDisarmAgentMode();")
  const liveCheck = rowSource.indexOf("if (endlessRowLive(endlessState()))")
  assert.ok(disarm >= 0, "the endless row disarms the pending mode question")
  assert.ok(liveCheck > disarm, "the live-row guard follows the disarm")
})

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

// The compaction row is per role, not a flat limit over all subagents, so it
// belongs on the cycler in the LLM params body and not in the Subagents block.
// Its `orchestrator` entry is the row's most important one, and the cycler is
// the only control in the sidebar that selects that role.
test("the compaction row sits last on the cycler, above [reset current agent]", () => {
  const compaction = row("compaction")
  const resultToken = row("result Token")

  assert.ok(compaction > LLM_HEADER, "compaction stands in the LLM params body")
  assert.ok(compaction > resultToken, "compaction stands after result Token")
  assert.ok(compaction < RESET_ROW, "compaction stands before [reset current agent]")
  assert.ok(
    compaction > SUBAGENTS_HEADER && compaction > TUI_SETTINGS_HEADER,
    "compaction is not in the Subagents or TUI settings body",
  )
})

test("the compaction row reads the LLM section's agent selection and the endless state", () => {
  assert.ok(
    source.includes(
      "compactionRowState(\n                props.settings(),\n                props.llmAgent(),\n                endlessState() === \"on\",\n              )",
    ),
    "the row's state is resolved from the settings, the LLM agent and the endless row's own verdict",
  )
  // The write is a toggle of that same agent, with no cycler list behind it:
  // unlike the three ceilings it runs no freeze migration.
  assert.ok(
    source.includes("toggleAgentCompaction(currentLlmAgent())"),
    "the toggle writes the LLM agent's own entry",
  )
  assert.equal(
    source.includes("toggleAgentCompaction(currentLlmAgent(), AGENT_NAMES)"),
    false,
    "the toggle freezes no list",
  )
})

// The row is live: the global `compaction.auto:false` the plugin writes reads
// no setting, so nothing this row writes has to reach opencode's bootstrap
// snapshot. It must therefore NOT carry the restart note the `mode` row does,
// and it must stay a plain click rather than gaining that row's arm-and-confirm.
test("the compaction row is a live switch with no restart note", () => {
  const start = source.indexOf('rowLabel("compaction")')
  const end = source.indexOf('{"[reset current agent]"}', start)
  assert.ok(start >= 0 && end > start, "the compaction row bounds are present")
  const rowSource = source.slice(start, end)
  assert.ok(
    rowSource.includes("props.onToggleCompaction"),
    "the cell writes the switch on a plain click",
  )
  for (const forbidden of ["restart", "armed", "Armed"]) {
    assert.equal(
      rowSource.includes(forbidden),
      false,
      `the compaction row carries no ${forbidden} state`,
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

// The effort row's ladder is per model: the pick list carries the variant
// names each model declares, and both the row's live/inert state and the
// cycler's ladder are derived from them, so a step like `xhigh` is offered
// only where the model names it.
test("the effort row cycles the ladder of the model under the cursor", () => {
  // The pick list keeps the variant names, from the model record's own map.
  assert.ok(
    source.includes("variants: string[] | null;"),
    "ModelChoice carries the variant names",
  )
  assert.ok(
    source.includes("variants: variantNames(m?.variants),"),
    "refreshModelChoices fills them from the provider list's model record",
  )

  // The row's own state and the write both come from that list, not from a
  // ladder fixed for every model.
  assert.ok(
    source.includes("effortLadderFor(hit.variants).length - 1"),
    "resolveLlmEffort sizes the row's ladder from the model's variants",
  )
  assert.ok(
    source.includes(
      "cycleLlmVariant(agent, delta, model, effortLadderFor(hit?.variants ?? null))",
    ),
    "the effort cycler hands cycleLlmVariant the model's own ladder",
  )
})

// Both watchdog windows are flat scalars over every subagent, not per-type
// ceilings, so they sit with the other limit rows in the Subagents body rather
// than in the LLM params body with the agent cycler.
test("the two watchdog rows stay in the Subagents body, silence before in tool", () => {
  const silence = row("silence (s)")
  const inTool = row("in tool (min)")

  for (const [label, at] of [["silence (s)", silence], ["in tool (min)", inTool]]) {
    assert.ok(at > SUBAGENTS_HEADER, `${label} stands after the Subagents header`)
    assert.ok(at < TUI_SETTINGS_HEADER, `${label} stands before the TUI settings header`)
  }

  assert.ok(silence < inTool, "the silence window stands before the tool-call window")
})

test("each watchdog row steps its own key in its own unit", () => {
  for (const [key, step] of [
    ["maxSubagentAgeMs", "SUBAGENT_AGE_STEP_MS"],
    ["maxSubagentToolCallMs", "SUBAGENT_TOOL_CALL_STEP_MS"],
  ]) {
    assert.ok(
      source.includes(`props.onAdjust("${key}", -${step})`),
      `${key} steps down by ${step}`,
    )
    assert.ok(
      source.includes(`props.onAdjust("${key}", ${step})`),
      `${key} steps up by ${step}`,
    )
  }
})

// 0 is reachable on both rows and means "this bound does not apply" on each, so
// neither may render it as the number 0 — a window of 0 seconds is not the
// reading that value has. Matched over the source with its line breaks and
// indentation collapsed, so re-wrapping the expression does not fail the test.
const flat = source.replace(/\s+/g, " ")
test("both watchdog rows render a 0 as off rather than as a number", () => {
  for (const key of ["maxSubagentAgeMs", "maxSubagentToolCallMs"]) {
    assert.ok(
      flat.includes(`props.settings().${key} === 0 ? "off"`),
      `${key} renders 0 as off`,
    )
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
