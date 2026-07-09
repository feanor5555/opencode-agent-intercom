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
  HISTORY_SUMMARY_MAX_CHARS,
  extractHistorySummary,
  DOC_SUMMARIES_TIMEOUT_MS,
  looksLikeDocSummariesReply,
  requestDocSummaries,
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

test("DOC_SUMMARY_PROMPT also requests the Session-Verlauf section, after the three doc sections", () => {
  // The history block rides on the SAME final turn as the doc summaries —
  // one prompt, one reply, one timeout/fallback path. The prompt must name
  // the heading literally (the extractor regexes on it) and ask for the
  // 800-1000 character target.
  assert.ok(
    DOC_SUMMARY_PROMPT.includes("## Session-Verlauf"),
    "DOC_SUMMARY_PROMPT must mention ## Session-Verlauf",
  )
  const iArch = DOC_SUMMARY_PROMPT.indexOf("## ARCHITECTURE.md")
  const iHist = DOC_SUMMARY_PROMPT.indexOf("## Session-Verlauf")
  assert.ok(iHist > iArch, "Session-Verlauf comes after the three doc sections")
  assert.match(DOC_SUMMARY_PROMPT, /800-1000\s*characters/i)
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

// ===========================================================================
// four-section reply: validateDocSummaries + extractHistorySummary side by side
// ===========================================================================

const FOUR_SECTION_REPLY = [
  "## PROJECT.md — project index",
  "",
  "## TODO.md — task list",
  "",
  "## ARCHITECTURE.md — architecture",
  "",
  "## Session-Verlauf — implemented the handoff slice; decided to reuse the doc-summary turn " +
    "because a second prompt would double the timeout window; currently wiring tests; next step " +
    "is the runtime verification.",
].join("\n")

test("validateDocSummaries ignores the trailing Session-Verlauf section: ARCHITECTURE.md body is not swallowed", () => {
  const out = validateDocSummaries(FOUR_SECTION_REPLY)
  assert.ok(out.includes("## ARCHITECTURE.md — architecture"), "ARCHITECTURE.md body intact")
  assert.ok(
    !out.includes("Session-Verlauf"),
    "the doc-summaries block must not contain the history section",
  )
})

test("extractHistorySummary extracts the Session-Verlauf block with its heading", () => {
  const out = extractHistorySummary(FOUR_SECTION_REPLY)
  assert.ok(out.startsWith("## Session-Verlauf — "), "block starts with the heading")
  assert.ok(out.includes("implemented the handoff slice"), "body carried over")
  assert.ok(out.includes("runtime verification."), "body carried to its end")
  assert.ok(!out.includes("## ARCHITECTURE.md"), "no bleed from the preceding section")
})

test("extractHistorySummary returns '' when the section is missing (three-section reply)", () => {
  const threeSections = [
    "## PROJECT.md — project index",
    "",
    "## TODO.md — task list",
    "",
    "## ARCHITECTURE.md — architecture",
  ].join("\n")
  assert.equal(extractHistorySummary(threeSections), "")
})

test("extractHistorySummary returns '' on empty / non-string / empty-body input", () => {
  assert.equal(extractHistorySummary(""), "")
  assert.equal(extractHistorySummary("   \n  "), "")
  assert.equal(extractHistorySummary(undefined), "")
  assert.equal(extractHistorySummary(null), "")
  assert.equal(extractHistorySummary(42), "")
  // Heading present but no body → still "" (an empty block is useless).
  assert.equal(extractHistorySummary("## Session-Verlauf — \n"), "")
})

test("extractHistorySummary truncates runaway bodies at HISTORY_SUMMARY_MAX_CHARS with an ellipsis", () => {
  const long = "z".repeat(HISTORY_SUMMARY_MAX_CHARS + 500)
  const out = extractHistorySummary(`## Session-Verlauf — ${long}`)
  const body = out.replace("## Session-Verlauf — ", "")
  assert.ok(
    body.length <= HISTORY_SUMMARY_MAX_CHARS,
    `body length ${body.length} exceeds cap ${HISTORY_SUMMARY_MAX_CHARS}`,
  )
  assert.ok(body.endsWith("…"), "truncated body ends with ellipsis")
})

test("extractHistorySummary does NOT truncate bodies at or under the cap", () => {
  const body = "w".repeat(HISTORY_SUMMARY_MAX_CHARS)
  const out = extractHistorySummary(`## Session-Verlauf — ${body}`)
  assert.equal(out, `## Session-Verlauf — ${body}`)
  assert.ok(!out.endsWith("…"), "at-cap body is not ellipsised")
})

test("extractHistorySummary tolerates the section appearing before the doc sections", () => {
  // The prompt asks for it last, but a small model may reorder. The
  // extractor must stop at the next `## ` heading instead of swallowing it.
  const reordered = [
    "## Session-Verlauf — did things first",
    "",
    "## PROJECT.md — project index",
  ].join("\n")
  const out = extractHistorySummary(reordered)
  assert.equal(out, "## Session-Verlauf — did things first")
})

// ===========================================================================
// requestDocSummaries — baseline-before-prompt poll discipline
//
// Live-verified bug this guards against: the old implementation compared the
// polled result against the PREVIOUS poll (starting at undefined), so the
// very first poll returned the old primary's PREVIOUS final answer as if it
// were the summaries reply — the DOC_SUMMARY prompt never reached an LLM and
// the kickoff fell back to "(nicht verfügbar)" ×3.
//
// All tests run on virtual time (injected `now`/`sleep`) — no real waiting.
// ===========================================================================

const SUMMARIES_REPLY = [
  "## PROJECT.md — project index",
  "",
  "## TODO.md — open tasks",
  "",
  "## ARCHITECTURE.md — architecture facts",
  "",
  "## Session-Verlauf — session history",
].join("\n")

// Virtual-clock harness: `script` is an array of results fetchResult yields
// on successive calls (last entry repeats forever). Records the interleaving
// of fetch/prompt calls so the tests can assert baseline-before-prompt.
function makePollHarness(script, opts = {}) {
  let t = 0
  let i = 0
  const calls = []
  return {
    calls,
    run: () =>
      requestDocSummaries({
        fetchResult: async () => {
          const value = script[Math.min(i, script.length - 1)]
          i++
          calls.push(["fetch", value])
          return value
        },
        sendPrompt: async () => {
          calls.push(["prompt"])
        },
        sleep: async (ms) => {
          t += ms
        },
        now: () => t,
        timeoutMs: opts.timeoutMs ?? 10_000,
        pollMs: opts.pollMs ?? 500,
      }),
  }
}

test("requestDocSummaries: takes the baseline BEFORE sending the prompt", async () => {
  const h = makePollHarness(["OLD ANSWER", SUMMARIES_REPLY])
  await h.run()
  const iFirstFetch = h.calls.findIndex((c) => c[0] === "fetch")
  const iPrompt = h.calls.findIndex((c) => c[0] === "prompt")
  assert.ok(iFirstFetch >= 0 && iPrompt >= 0)
  assert.ok(
    iFirstFetch < iPrompt,
    "baseline fetch must run BEFORE the summary prompt is sent",
  )
})

test("requestDocSummaries: does NOT return the old primary's stale final result", async () => {
  // The stale result stays visible for several polls before the summary
  // reply lands — the old implementation returned it on the FIRST poll.
  const h = makePollHarness([
    "OLD ANSWER", // baseline
    "OLD ANSWER", // poll 1 — must not be returned
    "OLD ANSWER", // poll 2 — must not be returned
    SUMMARIES_REPLY,
  ])
  const out = await h.run()
  assert.equal(out, SUMMARIES_REPLY, "only the CHANGED summaries reply is returned")
  // It really polled past the stale result (baseline + ≥2 stale polls + hit).
  assert.ok(h.calls.filter((c) => c[0] === "fetch").length >= 4)
})

test("requestDocSummaries: re-baselines on the interrupted in-flight turn's reply and keeps waiting", async () => {
  // The handoff fires from the system.transform of an INCOMING turn, so that
  // turn's reply usually lands BEFORE the summary turn queued behind it. A
  // changed-but-foreign result must NOT be returned — it becomes the new
  // baseline and the poll keeps going until the real summaries reply.
  const h = makePollHarness([
    "OLD ANSWER",               // baseline
    "OLD ANSWER",               // poll 1
    "REPLY TO THE IN-FLIGHT USER TURN", // poll 2 — changed, but no summaries shape
    "REPLY TO THE IN-FLIGHT USER TURN", // poll 3 — now equals the re-baseline
    SUMMARIES_REPLY,            // poll 4 — the summary turn's reply
  ])
  const out = await h.run()
  assert.equal(out, SUMMARIES_REPLY)
})

test("requestDocSummaries: times out (throws) when the result never changes", async () => {
  const h = makePollHarness(["OLD ANSWER"], { timeoutMs: 3_000, pollMs: 500 })
  await assert.rejects(h.run(), /timed out/)
})

test("requestDocSummaries: times out (throws) when only foreign replies land, never the summaries", async () => {
  const h = makePollHarness(
    ["OLD ANSWER", "foreign reply 1", "foreign reply 2", "foreign reply 3"],
    { timeoutMs: 3_000, pollMs: 500 },
  )
  await assert.rejects(h.run(), /timed out/)
})

test("requestDocSummaries: works when the session had NO prior result (undefined baseline)", async () => {
  const h = makePollHarness([undefined, undefined, SUMMARIES_REPLY])
  const out = await h.run()
  assert.equal(out, SUMMARIES_REPLY)
})

test("requestDocSummaries: a failed baseline fetch does not abort — the shape check still lands the reply", async () => {
  let first = true
  let t = 0
  const out = await requestDocSummaries({
    fetchResult: async () => {
      if (first) {
        first = false
        throw new Error("snapshot 503")
      }
      return SUMMARIES_REPLY
    },
    sendPrompt: async () => {},
    sleep: async (ms) => { t += ms },
    now: () => t,
    timeoutMs: 5_000,
    pollMs: 500,
  })
  assert.equal(out, SUMMARIES_REPLY)
})

test("DOC_SUMMARIES_TIMEOUT_MS is sized for the queued-behind-a-busy-turn case (120 s)", () => {
  // Live measurement: the interrupted in-flight turn alone took 42 s before
  // the summary turn could even start. The old 15 s window could never work.
  assert.equal(DOC_SUMMARIES_TIMEOUT_MS, 120_000)
})

test("looksLikeDocSummariesReply: matches the PROJECT.md heading, even after preamble prose", () => {
  assert.equal(looksLikeDocSummariesReply(SUMMARIES_REPLY), true)
  assert.equal(
    looksLikeDocSummariesReply("Sure, here you go:\n## PROJECT.md — index"),
    true,
    "/m heading match must survive a preamble line",
  )
  assert.equal(looksLikeDocSummariesReply("REPLY TO THE IN-FLIGHT USER TURN"), false)
  assert.equal(looksLikeDocSummariesReply(""), false)
  assert.equal(looksLikeDocSummariesReply(undefined), false)
})
