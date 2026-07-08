// Unit tests for the per-file doc-summaries helpers in src/handoff.js
// (Slice 6a-deps — the kickoff's doc-context payload).
//
// Covers three pieces of handoff.js that live between `performPrimaryHandoff`
// and the existing `lastUserGoal`:
//
//   - DOC_SUMMARY_PROMPT       — the prompt sent to the old primary (#1)
//   - FALLBACK_DOC_SUMMARIES   — the placeholder block used when #1 is
//                                unavailable or the reply is malformed
//   - validateDocSummaries     — pure normaliser: turns a free-form reply
//                                into the three-section block the new
//                                orchestrator expects
//
// Imports ONLY src/handoff.js (+ node builtins). Never imports hooks.js /
// client.js — those start long-lived plugin handles that keep
// `node --test` from exiting.
//
// Run: node --test --test-timeout=2000 test/handoff-doc-summaries.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  DOC_SUMMARY_PROMPT,
  DOC_SUMMARY_MAX_CHARS,
  FALLBACK_DOC_SUMMARIES,
  validateDocSummaries,
} from "../src/handoff.js"

// ===========================================================================
// DOC_SUMMARY_PROMPT
// ===========================================================================

test("DOC_SUMMARY_PROMPT names the three required sections, in order, with em-dash headings", () => {
  for (const heading of [
    "## PROJECT.md",
    "## TODO.md",
    "## ARCHITECTURE.md",
  ]) {
    assert.ok(
      DOC_SUMMARY_PROMPT.includes(heading),
      `DOC_SUMMARY_PROMPT must mention ${heading}`,
    )
  }

  // The order is the point — the prompt asks for PROJECT.md first so the
  // new orchestrator gets project index before task list before architecture.
  const iProject = DOC_SUMMARY_PROMPT.indexOf("## PROJECT.md")
  const iTodo = DOC_SUMMARY_PROMPT.indexOf("## TODO.md")
  const iArch = DOC_SUMMARY_PROMPT.indexOf("## ARCHITECTURE.md")
  assert.ok(iProject >= 0 && iTodo > iProject && iArch > iTodo, "headings in fixed order")
})

test("DOC_SUMMARY_PROMPT forbids disk reads — it must derive the summaries from the old primary's own context", () => {
  // The whole point of the new flow is that #2 should NOT have to re-read
  // the docs from disk. The prompt has to forbid #1 from doing that too,
  // because if #1 goes off and reads the files it will eat its last
  // remaining context budget on the very turn we're trying to escape.
  assert.match(DOC_SUMMARY_PROMPT, /do NOT read files from disk/i)
  // The prompt must also tell #1 not to call tools at all on this turn.
  assert.match(DOC_SUMMARY_PROMPT, /no tool calls|no `read`\/`bash`/i)
})

test("DOC_SUMMARY_PROMPT tells the model to start the reply with the PROJECT.md heading literally", () => {
  // The validator uses a regex anchored on the heading text; if the model
  // adds prose before the first heading, the parse fails. The prompt must
  // explicitly ask the model to start with the heading.
  assert.match(
    DOC_SUMMARY_PROMPT,
    /start (?:your reply|the reply)[^.]*PROJECT\.md/i,
  )
})

test("DOC_SUMMARY_PROMPT mentions the per-section character cap", () => {
  // We cap at DOC_SUMMARY_MAX_CHARS in code; the prompt has to mention the
  // cap so the model actually respects it. Loose match: just check the
  // number 400 appears.
  assert.match(DOC_SUMMARY_PROMPT, /400\s*characters/i)
})

// ===========================================================================
// FALLBACK_DOC_SUMMARIES
// ===========================================================================

test("FALLBACK_DOC_SUMMARIES contains all three headings, each marked as unavailable", () => {
  for (const heading of [
    "## PROJECT.md — (nicht verfügbar)",
    "## TODO.md — (nicht verfügbar)",
    "## ARCHITECTURE.md — (nicht verfügbar)",
  ]) {
    assert.ok(
      FALLBACK_DOC_SUMMARIES.includes(heading),
      `FALLBACK_DOC_SUMMARIES must contain ${heading}`,
    )
  }
})

test("FALLBACK_DOC_SUMMARIES is parseable by validateDocSummaries (round-trip)", () => {
  // The fallback block is the same shape the validator emits. Running it
  // through the validator must yield the same headings (body text is
  // already at-or-under the cap, so it survives unchanged).
  const out = validateDocSummaries(FALLBACK_DOC_SUMMARIES)
  for (const heading of [
    "## PROJECT.md — (nicht verfügbar)",
    "## TODO.md — (nicht verfügbar)",
    "## ARCHITECTURE.md — (nicht verfügbar)",
  ]) {
    assert.ok(out.includes(heading), `round-trip keeps ${heading}`)
  }
})

// ===========================================================================
// validateDocSummaries — happy path
// ===========================================================================

test("validateDocSummaries extracts the three sections verbatim and re-emits them in canonical order", () => {
  const input = [
    "Some preamble the LLM might add.",
    "",
    "## PROJECT.md — the project is an OpenCode plugin intercom.",
    "",
    "Some inter-section prose the LLM might add.",
    "",
    "## TODO.md — currently building the doc-summaries handoff slice.",
    "",
    "## ARCHITECTURE.md — handoff is a fresh orchestrator with no prior state.",
  ].join("\n")

  const out = validateDocSummaries(input)

  for (const heading of [
    "## PROJECT.md — the project is an OpenCode plugin intercom.",
    "## TODO.md — currently building the doc-summaries handoff slice.",
    "## ARCHITECTURE.md — handoff is a fresh orchestrator with no prior state.",
  ]) {
    assert.ok(out.includes(heading), `output contains ${heading}`)
  }

  // Canonical order: PROJECT.md must come before TODO.md which must come
  // before ARCHITECTURE.md in the output.
  const iP = out.indexOf("## PROJECT.md")
  const iT = out.indexOf("## TODO.md")
  const iA = out.indexOf("## ARCHITECTURE.md")
  assert.ok(iP >= 0 && iT > iP && iA > iT, "sections in canonical order")
})

test("validateDocSummaries tolerates extra whitespace and surrounding blank lines", () => {
  const input = [
    "",
    "",
    "## PROJECT.md — project index",
    "",
    "## TODO.md — task list",
    "",
    "## ARCHITECTURE.md — architecture",
    "",
    "",
  ].join("\n")

  const out = validateDocSummaries(input)
  assert.ok(out.includes("## PROJECT.md — project index"))
  assert.ok(out.includes("## TODO.md — task list"))
  assert.ok(out.includes("## ARCHITECTURE.md — architecture"))
})

// ===========================================================================
// validateDocSummaries — truncation
// ===========================================================================

test("validateDocSummaries truncates any per-section body longer than DOC_SUMMARY_MAX_CHARS", () => {
  const longBody = "x".repeat(DOC_SUMMARY_MAX_CHARS + 200)
  const input = [
    `## PROJECT.md — ${longBody}`,
    "",
    "## TODO.md — short",
    "",
    "## ARCHITECTURE.md — short",
  ].join("\n")

  const out = validateDocSummaries(input)

  // The PROJECT.md body, in the output, must be at most
  // DOC_SUMMARY_MAX_CHARS chars (the cap is applied per-section).
  const m = /^## PROJECT\.md — ([\s\S]*?)(?=\n\n## |\n*$)/m.exec(out)
  assert.ok(m, "PROJECT.md body present in output")
  assert.ok(
    m[1].length <= DOC_SUMMARY_MAX_CHARS,
    `PROJECT.md body length ${m[1].length} exceeds cap ${DOC_SUMMARY_MAX_CHARS}`,
  )
  // Truncated with an ellipsis so the new orchestrator can see the cut.
  assert.ok(m[1].endsWith("…"), "truncated body ends with ellipsis")
})

test("validateDocSummaries does NOT truncate bodies at or under the cap", () => {
  const body = "y".repeat(DOC_SUMMARY_MAX_CHARS)
  const input = [
    `## PROJECT.md — ${body}`,
    "",
    "## TODO.md — short",
    "",
    "## ARCHITECTURE.md — short",
  ].join("\n")

  const out = validateDocSummaries(input)
  const m = /^## PROJECT\.md — ([\s\S]*?)(?=\n\n## |\n*$)/m.exec(out)
  assert.ok(m, "PROJECT.md body present in output")
  assert.equal(m[1].length, DOC_SUMMARY_MAX_CHARS)
  assert.ok(!m[1].endsWith("…"), "exact-cap body is not ellipsised")
})

// ===========================================================================
// validateDocSummaries — graceful fallback
// ===========================================================================

test("validateDocSummaries returns the fallback block on empty input", () => {
  assert.equal(validateDocSummaries(""), FALLBACK_DOC_SUMMARIES)
  assert.equal(validateDocSummaries("   \n\n  "), FALLBACK_DOC_SUMMARIES)
})

test("validateDocSummaries returns the fallback block on non-string input", () => {
  // Defensive — the helper is pure and the dep could theoretically
  // misbehave and pass a non-string. The handoff must never crash on it.
  assert.equal(validateDocSummaries(undefined), FALLBACK_DOC_SUMMARIES)
  assert.equal(validateDocSummaries(null), FALLBACK_DOC_SUMMARIES)
  assert.equal(validateDocSummaries(42), FALLBACK_DOC_SUMMARIES)
  assert.equal(validateDocSummaries({}), FALLBACK_DOC_SUMMARIES)
})

test("validateDocSummaries returns the fallback block when one section is missing", () => {
  const input = [
    "## PROJECT.md — project index",
    "",
    "## TODO.md — task list",
    // ARCHITECTURE.md is missing
  ].join("\n")
  assert.equal(validateDocSummaries(input), FALLBACK_DOC_SUMMARIES)
})

test("validateDocSummaries returns the fallback block when one section has the wrong heading text", () => {
  // A model that paraphrases the heading ("## docs/ARCHITECTURE.md — …")
  // must not silently corrupt the kickoff. The validator matches the exact
  // basename.
  const input = [
    "## PROJECT.md — project index",
    "",
    "## TODO.md — task list",
    "",
    "## docs/ARCHITECTURE.md — architecture",
  ].join("\n")
  assert.equal(validateDocSummaries(input), FALLBACK_DOC_SUMMARIES)
})

test("validateDocSummaries returns the fallback block when no section uses the em-dash separator", () => {
  // Some models drop the em-dash and write "## PROJECT.md: …" instead. The
  // exact-shape requirement is part of the contract — without the em-dash
  // we can't safely parse. Fall back rather than guessing.
  const input = [
    "## PROJECT.md: project index",
    "",
    "## TODO.md: task list",
    "",
    "## ARCHITECTURE.md: architecture",
  ].join("\n")
  assert.equal(validateDocSummaries(input), FALLBACK_DOC_SUMMARIES)
})

// ===========================================================================
// validateDocSummaries — edge cases
// ===========================================================================

test("validateDocSummaries keeps the last section's trailing body even without a trailing newline", () => {
  // The regex lookahead `(?=\n##\s+|$)` must accept end-of-string so the
  // last section survives when the reply has no trailing newline.
  const input =
    "## PROJECT.md — project index\n\n## TODO.md — task list\n\n## ARCHITECTURE.md — architecture"
  const out = validateDocSummaries(input)
  assert.ok(out.includes("## ARCHITECTURE.md — architecture"))
})

test("validateDocSummaries output has stable, well-formed markdown: each section separated by a blank line", () => {
  const input = [
    "## PROJECT.md — project index",
    "",
    "## TODO.md — task list",
    "",
    "## ARCHITECTURE.md — architecture",
  ].join("\n")

  const out = validateDocSummaries(input)

  // The new orchestrator is told to match on the three `## ` headings, so
  // each section must be its own paragraph. Sections joined with "\n\n"
  // (blank line between) is the contract. The FIRST section is at the
  // start of the string (no preceding blank line), but every subsequent
  // section must be preceded by one.
  const secondAndThird = ["## TODO.md", "## ARCHITECTURE.md"]
  for (const heading of secondAndThird) {
    assert.ok(
      out.includes(`\n\n${heading} `),
      `section ${heading} preceded by a blank line in output`,
    )
  }
  // And every section heading must appear at least once with a space
  // after the em-dash (the parser's contract).
  for (const heading of [
    "## PROJECT.md — project index",
    "## TODO.md — task list",
    "## ARCHITECTURE.md — architecture",
  ]) {
    assert.ok(out.includes(heading), `output contains ${heading}`)
  }
})
