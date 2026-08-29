// Unit tests for the label of a sidebar subagent row
// (tui/src/subagent-label.ts): agent handle, topic, model in parentheses.
//
// Run: node --test test/tui-subagent-label.test.js

import test from "node:test"
import assert from "node:assert/strict"
import {
  FALLBACK_PANEL_W,
  MIN_TOPIC_W,
  MODEL_MAX_W,
  ROW_CHROME_W,
  TOPIC_MAX_W,
  composeSubagentLabel,
  modelDisplayName,
  subagentLabelWidth,
  subagentModel,
  subagentTopic,
  truncate,
} from "../tui/src/subagent-label.ts"

// The panel's model pick list, as it is built from the configured providers.
const CHOICES = [
  { providerID: "anthropic", modelID: "opus", label: "Claude Opus" },
  { providerID: "xai", modelID: "grok-4", label: "Luna" },
]

const MODELS = {
  researcher: { providerID: "xai", modelID: "grok-4" },
  coder: { providerID: "anthropic", modelID: "opus" },
}

// The panel width the host sidebar was measured at, and the columns a label may
// use in it.
const HOST_PANEL_W = 42
const HOST_LABEL_W = HOST_PANEL_W - ROW_CHROME_W

test("truncate leaves a string that fits and cuts a longer one with an ellipsis", () => {
  assert.equal(truncate("abcde", 5), "abcde")
  assert.equal(truncate("abcdef", 5), "abcd…")
  assert.equal(truncate("abcdef", 5).length, 5)
})

test("subagentTopic keeps a description title as it stands", () => {
  assert.equal(
    subagentTopic("researcher", "Searching for latest Spring API"),
    "Searching for latest Spring API",
  )
})

test("subagentTopic strips the redundant agent prefix of a fallback title", () => {
  assert.equal(
    subagentTopic("coder", "coder: rewrite the parser"),
    "rewrite the parser",
  )
  // Without the space after the colon, and with surrounding whitespace.
  assert.equal(subagentTopic("coder", "  coder:rewrite  "), "rewrite")
})

test("subagentTopic strips only the prefix of that agent", () => {
  assert.equal(
    subagentTopic("coder", "reviewer: judge the parser"),
    "reviewer: judge the parser",
  )
})

test("subagentTopic is empty for a title that carries nothing else", () => {
  assert.equal(subagentTopic("coder", ""), "")
  assert.equal(subagentTopic("coder", "   "), "")
  assert.equal(subagentTopic("coder", "coder:"), "")
})

test("subagentTopic cuts a long topic to the budget", () => {
  const long = "x".repeat(TOPIC_MAX_W + 10)
  const topic = subagentTopic("coder", long)
  assert.equal(topic.length, TOPIC_MAX_W)
  assert.equal(topic, "x".repeat(TOPIC_MAX_W - 1) + "…")
})

test("subagentTopic cuts after stripping the prefix, not before", () => {
  const body = "y".repeat(TOPIC_MAX_W)
  assert.equal(subagentTopic("coder", `coder: ${body}`), body)
})

test("subagentModel gives the display name of the configured model", () => {
  assert.equal(subagentModel("researcher", MODELS, CHOICES), "Luna")
})

test("subagentModel falls back to the bare id when the model is not in the pick list", () => {
  const models = { coder: { providerID: "gone", modelID: "some-model" } }
  assert.equal(subagentModel("coder", models, CHOICES), "some-model")
})

test("subagentModel is empty for an agent with no configured model", () => {
  assert.equal(subagentModel("documenter", MODELS, CHOICES), "")
  assert.equal(subagentModel("coder", {}, CHOICES), "")
})

test("subagentModel ignores a half-written entry", () => {
  const models = { coder: { providerID: "anthropic" } }
  assert.equal(subagentModel("coder", models, CHOICES), "")
})

test("subagentModel cuts a long model name to the budget", () => {
  const choices = [
    { providerID: "xai", modelID: "grok-4", label: "z".repeat(MODEL_MAX_W + 5) },
  ]
  const name = subagentModel("researcher", MODELS, choices)
  assert.equal(name.length, MODEL_MAX_W)
  assert.equal(name, "z".repeat(MODEL_MAX_W - 1) + "…")
})

test("composeSubagentLabel puts agent, topic and model in that order", () => {
  const entry = {
    handle: "researcher#2",
    agent: "researcher",
    title: "Searching for latest Spring API",
  }
  assert.equal(
    composeSubagentLabel(entry, MODELS, CHOICES, 60),
    "researcher#2 · Searching for latest Spring API (Luna)",
  )
})

test("composeSubagentLabel drops the model part when none is configured", () => {
  const entry = { handle: "documenter#1", agent: "documenter", title: "write the readme" }
  assert.equal(
    composeSubagentLabel(entry, MODELS, CHOICES),
    "documenter#1 · write the readme",
  )
})

test("composeSubagentLabel drops the topic part when the title carries nothing", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "" }
  assert.equal(composeSubagentLabel(entry, MODELS, CHOICES), "coder#1 (Claude Opus)")
})

test("composeSubagentLabel shows the handle alone with neither topic nor model", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "coder:" }
  assert.equal(composeSubagentLabel(entry, {}, CHOICES), "coder#1")
})

test("truncate leaves nothing for a width of zero or less", () => {
  assert.equal(truncate("abc", 0), "")
  assert.equal(truncate("abc", -3), "")
})

test("subagentLabelWidth is the panel minus the row's own columns", () => {
  assert.equal(subagentLabelWidth(HOST_PANEL_W), HOST_LABEL_W)
  assert.equal(subagentLabelWidth(80), 80 - ROW_CHROME_W)
})

test("subagentLabelWidth falls back where the panel reports no usable width", () => {
  const fallback = FALLBACK_PANEL_W - ROW_CHROME_W
  assert.equal(subagentLabelWidth(undefined), fallback)
  assert.equal(subagentLabelWidth(0), fallback)
  assert.equal(subagentLabelWidth(-5), fallback)
})

test("subagentLabelWidth never goes below zero on a panel narrower than the chrome", () => {
  assert.equal(subagentLabelWidth(3), 0)
})

test("modelDisplayName drops the parenthesised part of a pick-list label", () => {
  assert.equal(modelDisplayName("Luna (gpt-5.6-luna)"), "Luna")
  assert.equal(modelDisplayName("Claude Opus"), "Claude Opus")
  assert.equal(modelDisplayName("Luna(gpt-5)"), "Luna")
})

test("modelDisplayName leaves no parenthesis in its result, whatever the label", () => {
  for (const label of [
    "Luna (gpt-5.6-luna)",
    "(gpt-5.6-luna)",
    "a) b (c)",
    "((nested))",
    ")(",
  ]) {
    const name = modelDisplayName(label)
    assert.equal(name.includes("("), false, label)
    assert.equal(name.includes(")"), false, label)
  }
})

test("modelDisplayName keeps the inner text of a label that is only parentheses", () => {
  assert.equal(modelDisplayName("(gpt-5.6-luna)"), "gpt-5.6-luna")
})

test("subagentModel gives the display name without the model id behind it", () => {
  const choices = [
    { providerID: "xai", modelID: "grok-4", label: "Luna (gpt-5.6-luna)" },
  ]
  assert.equal(subagentModel("researcher", MODELS, choices), "Luna")
})

test("composeSubagentLabel fits the host panel, the case that used to wrap", () => {
  const entry = {
    handle: "coder#1",
    agent: "coder",
    title: "Searching for the latest OpenCode sidebar model label behavior",
  }
  const choices = [
    { providerID: "anthropic", modelID: "opus", label: "Luna (gpt-5.6-luna)" },
  ]
  const label = composeSubagentLabel(entry, MODELS, choices, HOST_PANEL_W)
  assert.equal(label, "coder#1 · Searching for the… (Luna)")
  assert.equal(label.length, HOST_LABEL_W)
})

test("composeSubagentLabel never exceeds the budget, for any part length", () => {
  const widths = [12, 20, HOST_PANEL_W, 60, 120]
  const titles = ["", "short", "s".repeat(200)]
  const handles = ["c#1", "documenter#12", "h".repeat(60)]
  const choices = [
    { providerID: "anthropic", modelID: "opus", label: "M".repeat(80) },
    { providerID: "xai", modelID: "grok-4", label: "Luna (gpt-5.6-luna)" },
  ]
  for (const panel of widths) {
    for (const title of titles) {
      for (const handle of handles) {
        for (const agent of ["coder", "researcher", "documenter"]) {
          const label = composeSubagentLabel(
            { handle, agent, title },
            MODELS,
            choices,
            panel,
          )
          assert.ok(
            label.length <= subagentLabelWidth(panel),
            `${panel}/${agent}/${handle}: ${label.length} > ${subagentLabelWidth(panel)}`,
          )
          assert.equal(label.split("(").length <= 2, true, label)
        }
      }
    }
  }
})

test("composeSubagentLabel gives the topic what handle and model leave over", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "t".repeat(100) }
  // 35 columns: handle 7, " (Claude Opus)" 14, separator 3 — 11 for the topic.
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.equal(label, `coder#1 · ${"t".repeat(10)}… (Claude Opus)`)
  assert.equal(label.length, HOST_LABEL_W)
})

test("composeSubagentLabel caps the topic on a panel wide enough for more", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "t".repeat(200) }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, 200)
  assert.equal(label, `coder#1 · ${"t".repeat(TOPIC_MAX_W - 1)}… (Claude Opus)`)
})

test("composeSubagentLabel gives the topic the room the dropped model leaves", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "rewrite the parser" }
  // 26 columns of panel leave 19, too few for handle 7 plus " (Claude Opus)" 14,
  // so the model goes and the topic takes the whole remainder.
  const label = composeSubagentLabel(entry, MODELS, CHOICES, 26)
  assert.equal(label, "coder#1 · rewrite …")
  assert.equal(label.length, subagentLabelWidth(26))
})

test("composeSubagentLabel shows the handle alone where neither part fits", () => {
  const entry = { handle: "coder#1", agent: "coder", title: "rewrite the parser" }
  // 17 columns of label: the model needs 21, and what it leaves the topic is
  // under MIN_TOPIC_W.
  assert.equal(composeSubagentLabel(entry, MODELS, CHOICES, 24), "coder#1")
})

test("composeSubagentLabel keeps the topic where the remainder reaches the minimum", () => {
  const entry = { handle: "c#1", agent: "documenter", title: "write the readme" }
  const panel = ROW_CHROME_W + "c#1".length + " · ".length + MIN_TOPIC_W
  const label = composeSubagentLabel(entry, MODELS, CHOICES, panel)
  assert.equal(label, "c#1 · write t…")
  assert.equal(label.length, subagentLabelWidth(panel))
})

test("composeSubagentLabel drops the model where the handle alone fills the row", () => {
  const entry = { handle: "documenter#12", agent: "coder", title: "x" }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, ROW_CHROME_W + 13)
  assert.equal(label, "documenter#12")
})

test("composeSubagentLabel cuts even the handle on a panel that cannot hold it", () => {
  const entry = { handle: "documenter#12", agent: "coder", title: "x" }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, ROW_CHROME_W + 5)
  assert.equal(label, "docu…")
})
