// Unit tests for the label of a sidebar subagent row
// (tui/src/subagent-label.ts): agent handle, topic, model in parentheses.
//
// The topic is the opencode session title, and in a process that can retain a
// finished subagent that title carries the plugin's own marker prefix. The
// marker exists for the bootstrap sweep, says nothing to the user, and is
// stripped here — pinned below together with its parity against the value
// src/teardown.js actually writes.
//
// Run: node --test test/tui-subagent-label.test.js

import test from "node:test"
import assert from "node:assert/strict"
import {
  SUBAGENT_SESSION_TITLE_MARKER as PLUGIN_MARKER,
  RETENTION_STAMP_RE as PLUGIN_STAMP_RE,
  readRetentionStamp as pluginReadRetentionStamp,
  retentionStampedTitle,
} from "../src/teardown.js"
import {
  FALLBACK_PANEL_W,
  SUBAGENT_SESSION_TITLE_MARKER,
  RETENTION_STAMP_RE,
  readRetentionStamp,
  MIN_TOPIC_W,
  MODEL_MAX_W,
  ROW_CHROME_W,
  TOPIC_MAX_W,
  composeSubagentLabel,
  displayWidth,
  graphemes,
  modelDisplayName,
  sanitizeTitle,
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

test("the TUI's title marker is the one the plugin writes", () => {
  assert.equal(SUBAGENT_SESSION_TITLE_MARKER, PLUGIN_MARKER)
})

test("subagentTopic strips the plugin's session-title marker", () => {
  assert.equal(
    subagentTopic("researcher", `${SUBAGENT_SESSION_TITLE_MARKER}Searching for X`),
    "Searching for X",
  )
})

test("subagentTopic strips the marker and the agent prefix behind it", () => {
  assert.equal(
    subagentTopic("coder", `${SUBAGENT_SESSION_TITLE_MARKER}coder: rewrite the parser`),
    "rewrite the parser",
  )
})

test("a title that is nothing but the marker leaves no topic", () => {
  assert.equal(subagentTopic("coder", SUBAGENT_SESSION_TITLE_MARKER), "")
  assert.equal(subagentTopic("coder", `${SUBAGENT_SESSION_TITLE_MARKER}coder:`), "")
})

test("the TUI reads the retention stamp exactly as the plugin writes it", () => {
  // The plugin publishes a held subagent's window on the session title; this
  // package cannot import it, so the format is mirrored and pinned here.
  assert.equal(RETENTION_STAMP_RE.source, PLUGIN_STAMP_RE.source)
  const held = retentionStampedTitle("Searching for X", 1_700_000_060_000)
  assert.equal(readRetentionStamp(held), 1_700_000_060_000)
  assert.equal(readRetentionStamp(held), pluginReadRetentionStamp(held))
  assert.equal(readRetentionStamp(retentionStampedTitle("Searching for X", 0)), undefined)
})

test("subagentTopic strips the retention stamp: it is state, not topic", () => {
  assert.equal(
    subagentTopic("researcher", retentionStampedTitle("Searching for X", 1_700_000_060_000)),
    "Searching for X",
  )
  assert.equal(
    subagentTopic("coder", retentionStampedTitle("coder: rewrite the parser", 1_700_000_060_000)),
    "rewrite the parser",
  )
})

test("the marker is stripped only where it stands at the front", () => {
  assert.equal(
    subagentTopic("coder", `about ${SUBAGENT_SESSION_TITLE_MARKER}titles`),
    `about ${SUBAGENT_SESSION_TITLE_MARKER}titles`,
  )
})

test("a marked title is cut to the budget on what is left after the marker", () => {
  const long = "x".repeat(TOPIC_MAX_W)
  const topic = subagentTopic("coder", SUBAGENT_SESSION_TITLE_MARKER + long)
  assert.equal(topic, long)
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

// --- Unicode: columns, grapheme clusters and sanitizing -------------------
//
// The label is measured in terminal columns, cut between grapheme clusters and
// composed from a sanitized title, so that a session title the panel does not
// control can neither wrap the row onto its second line (which hides the
// age/ctx line) nor put a glyph on screen that the terminal draws as an empty
// rectangle.

// No code point of the surrogate range may survive on its own: a lone surrogate
// is exactly what a cut through the middle of an astral character leaves, and
// what the renderer shows as a rectangle.
const hasLoneSurrogate = (s) =>
  Array.from(s).some((cp) => {
    const c = cp.codePointAt(0)
    return c >= 0xd800 && c <= 0xdfff
  })

test("displayWidth counts terminal columns, not UTF-16 code units", () => {
  assert.equal(displayWidth("abc"), 3)
  assert.equal(displayWidth("漢字"), 4, "a CJK ideograph takes two columns")
  assert.equal(displayWidth("a\u0308"), 1, "a combining mark takes none")
  assert.equal(displayWidth("\u{1F600}"), 2)
  assert.equal(displayWidth("…"), 1)
  assert.equal(displayWidth(" · "), 3)
})

test("graphemes keeps a surrogate pair and its combining marks together", () => {
  assert.deepEqual(graphemes("a\u0308b"), ["a\u0308", "b"])
  assert.deepEqual(graphemes("x\u{1F600}y"), ["x", "\u{1F600}", "y"])
})

test("truncate cuts wide characters by column, not by code unit", () => {
  // Six columns of CJK cut to five: two ideographs plus the ellipsis.
  const cut = truncate("漢字漢字漢字", 5)
  assert.equal(cut, "漢字…")
  assert.equal(displayWidth(cut), 5)
})

test("truncate leaves a cut a column short rather than a column over", () => {
  // Four columns of budget: the ellipsis takes one, and a two-column ideograph
  // does not fit in the two that are left over beside the first one.
  const cut = truncate("漢字漢", 4)
  assert.equal(cut, "漢…")
  assert.ok(displayWidth(cut) <= 4)
})

test("truncate never cuts through a surrogate pair", () => {
  const emoji = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}"
  for (let w = 1; w <= 12; w++) {
    const cut = truncate(emoji, w)
    assert.equal(hasLoneSurrogate(cut), false, `width ${w}: ${JSON.stringify(cut)}`)
    assert.ok(displayWidth(cut) <= w, `width ${w}: ${displayWidth(cut)} columns`)
  }
})

test("truncate never parts a base character from its combining marks", () => {
  const cut = truncate("a\u0308e\u0301i\u0302o\u0303", 3)
  assert.equal(cut, "a\u0308e\u0301…")
  assert.equal(displayWidth(cut), 3)
})

test("truncate leaves a string that fits, whatever it is made of", () => {
  assert.equal(truncate("漢字", 4), "漢字")
  assert.equal(truncate("a\u0308", 1), "a\u0308")
})

test("sanitizeTitle keeps plain Latin text including umlauts as it stands", () => {
  assert.equal(sanitizeTitle("Prüfe die Größe"), "Prüfe die Größe")
  assert.equal(sanitizeTitle("rewrite the parser"), "rewrite the parser")
})

test("sanitizeTitle drops ANSI escape sequences", () => {
  assert.equal(sanitizeTitle("\u001B[31mred\u001B[0m text"), "red text")
  assert.equal(sanitizeTitle("\u001B]0;window title\u0007done"), "done")
})

test("sanitizeTitle drops control and zero-width characters", () => {
  // A zero-width space, a zero-width joiner, a byte-order mark and a bell.
  assert.equal(sanitizeTitle("a\u200Bb\u200Dc\uFEFFd\u0007e"), "abcde")
})

test("sanitizeTitle drops variation selectors", () => {
  assert.equal(sanitizeTitle("info\uFE0F sign\uFE0E"), "info sign")
})

test("sanitizeTitle drops emoji and pictographic symbols", () => {
  assert.equal(sanitizeTitle("ship it \u{1F680} now"), "ship it now")
  assert.equal(sanitizeTitle("\u{1F44D}\u{1F3FD} ok"), "ok")
  assert.equal(sanitizeTitle("flag \u{1F1E9}\u{1F1EA} here"), "flag here")
  assert.equal(
    sanitizeTitle("family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}"),
    "family",
  )
})

test("sanitizeTitle keeps the glyphs the panel's own chrome is made of", () => {
  assert.equal(sanitizeTitle("a · b … c"), "a · b … c")
})

test("sanitizeTitle collapses runs of whitespace to a single space", () => {
  assert.equal(sanitizeTitle("a  \t b\n\nc   "), "a b c")
  assert.equal(sanitizeTitle("  spaced out  "), "spaced out")
  assert.equal(sanitizeTitle("no\u00A0break"), "no break")
})

test("sanitizeTitle drops an unpaired surrogate but keeps a valid pair", () => {
  assert.equal(sanitizeTitle("a\uD800b"), "ab")
  assert.equal(sanitizeTitle("a\uDC00b"), "ab")
  // A valid pair that is not pictographic survives: a mathematical capital A.
  assert.equal(sanitizeTitle("x\u{1D400}y"), "x\u{1D400}y")
})

test("subagentTopic sanitizes the title before it strips the prefix", () => {
  assert.equal(
    subagentTopic("coder", "\u001B[1mcoder:\u001B[0m  rewrite\nthe parser"),
    "rewrite the parser",
  )
  assert.equal(subagentTopic("coder", "\u{1F680}\u200B"), "")
})

test("composeSubagentLabel keeps a wide-character title inside the budget", () => {
  const entry = {
    handle: "coder#1",
    agent: "coder",
    // 17 ideographs: 17 code units, but 34 columns — the case that used to wrap.
    title: "漢".repeat(17),
  }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.ok(
    displayWidth(label) <= HOST_LABEL_W,
    `${displayWidth(label)} > ${HOST_LABEL_W}: ${label}`,
  )
  assert.equal(hasLoneSurrogate(label), false)
})

test("composeSubagentLabel puts no emoji and no lone surrogate on the row", () => {
  const entry = {
    handle: "researcher#2",
    agent: "researcher",
    title: "\u{1F680} ship \u{1F468}\u200D\u{1F469}\u200D\u{1F467} it \uD800",
  }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.equal(label, "researcher#2 · ship it (Luna)")
  assert.equal(hasLoneSurrogate(label), false)
  assert.equal(/\p{Extended_Pictographic}/u.test(label), false)
})

test("composeSubagentLabel keeps combining marks attached in a cut topic", () => {
  const entry = {
    handle: "coder#1",
    agent: "coder",
    title: "a\u0308".repeat(40),
  }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.ok(displayWidth(label) <= HOST_LABEL_W)
  // Every combining diaeresis in the label still sits behind its letter.
  assert.equal(label.includes(" \u0308"), false, label)
  assert.equal(label.includes("\u0308\u0308"), false, label)
})

test("composeSubagentLabel holds the budget for wide, emoji and combining input", () => {
  const titles = [
    "漢".repeat(60),
    "\u{1F600}".repeat(40),
    "a\u0308".repeat(60),
    "\u001B[31m" + "ｆｕｌｌｗｉｄｔｈ".repeat(6) + "\u001B[0m",
    "mixed 漢 \u{1F680} a\u0308 text ".repeat(8),
    "\u{10000}\uD800".repeat(10),
  ]
  for (const panel of [12, 20, 26, HOST_PANEL_W, 60, 120]) {
    for (const title of titles) {
      for (const agent of ["coder", "researcher", "documenter"]) {
        const label = composeSubagentLabel(
          { handle: `${agent}#1`, agent, title },
          MODELS,
          CHOICES,
          panel,
        )
        const width = displayWidth(label)
        assert.ok(
          width <= subagentLabelWidth(panel),
          `${panel}/${agent}: ${width} > ${subagentLabelWidth(panel)}: ${label}`,
        )
        assert.equal(hasLoneSurrogate(label), false, label)
        assert.equal(label.includes("\n"), false, label)
      }
    }
  }
})

test("composeSubagentLabel clamps a composed label that would overrun", () => {
  // A wide handle that fills the row, and a model part measured against it:
  // the final clamp is what keeps the two from standing side by side.
  const entry = { handle: "漢".repeat(20), agent: "coder", title: "x" }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.ok(displayWidth(label) <= HOST_LABEL_W, `${displayWidth(label)}: ${label}`)
})

test("composeSubagentLabel cuts an over-long title to one line's worth", () => {
  const entry = {
    handle: "coder#1",
    agent: "coder",
    title:
      "Rewrite the whole parser, then the printer, then everything else that " +
      "touches the grammar, and write the tests for all of it",
  }
  const label = composeSubagentLabel(entry, MODELS, CHOICES, HOST_PANEL_W)
  assert.equal(displayWidth(label), HOST_LABEL_W)
  assert.equal(label.startsWith("coder#1 · Rewrite "), true, label)
  assert.equal(label.endsWith("… (Claude Opus)"), true, label)
})
