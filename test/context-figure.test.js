// The one shared context-figure computation (src/context-figure.js), pinned
// three ways:
//
//   1. directly — the sum (input + output + reasoning + cache.read +
//      cache.write), opencode's own selection (the newest assistant message
//      with tokens.output > 0), and the compaction stop;
//   2. through the server call site — fetchSnapshot's ctxTokens (src/client.js)
//      is the same function, not a local copy;
//   3. through the sidebar call site — tui/src/tui.tsx imports the shared
//      module and carries NO local token-field sum of its own any more (the
//      file holds JSX and cannot be imported by node --test, so this half is
//      pinned by source scan, the pattern of test/tui-abort-log.test.js).
//
// Run: node --test test/context-figure.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { latestContextTokens } from "../src/context-figure.js"
import { fetchSnapshot } from "../src/client.js"

function msg(tokens, extra = {}) {
  return { info: { role: "assistant", tokens, ...extra }, parts: [] }
}

// ---- 1. the shared module itself ---------------------------------------------

test("the figure is the five-field sum, reasoning included", () => {
  assert.equal(
    latestContextTokens([
      msg({ input: 100, output: 5, reasoning: 4000, cache: { read: 10, write: 2 } }),
    ]),
    4117,
  )
})

test("missing fields read as zero; an absent output never qualifies", () => {
  assert.equal(latestContextTokens([msg({ input: 7 })]), undefined)
  assert.equal(latestContextTokens([msg({ output: 1, cache: {} })]), 1)
  assert.equal(latestContextTokens([msg({ input: 4, output: 3 })]), 7)
})

test("selection: the newest assistant message with output > 0", () => {
  assert.equal(
    latestContextTokens([
      msg({ input: 500, output: 10 }),
      msg({ input: 900, output: 20 }),
    ]),
    920,
    "the NEWEST qualifying step answers, not the first found",
  )
})

test("an in-flight step (no output yet) is walked past", () => {
  assert.equal(
    latestContextTokens([
      msg({ input: 200, output: 8 }),
      // streaming: opencode has recorded input and reasoning, no output yet
      msg({ input: 0, output: 0, reasoning: 42, cache: { read: 0, write: 0 } }),
    ]),
    208,
  )
})

test("a step whose retained sum is positive but output is zero is no figure", () => {
  // The old completion test (input + cache > 0) would have returned 900 for
  // this array; opencode's selection does not show it either, and neither do
  // we — the figure the threshold rides on and the figure the user is shown
  // are the same message.
  assert.equal(
    latestContextTokens([
      msg({ input: 500, output: 3 }),
      msg({ input: 900, output: 0 }),
    ]),
    503,
  )
})

test("user messages and messages without tokens are skipped", () => {
  // Newest-first: the two newest entries carry no figure (a user turn, and a
  // message with no role at all); the qualifying assistant step behind them
  // answers.
  assert.equal(
    latestContextTokens([
      msg({ input: 40, output: 4 }),
      { info: { role: "user" }, parts: [] },
      { info: {}, parts: [] },
    ]),
    44,
  )
  // Nothing assistant-qualifying anywhere.
  assert.equal(
    latestContextTokens([
      { info: { role: "user", tokens: { input: 9, output: 9 } }, parts: [] },
      { info: { role: "user" }, parts: [] },
    ]),
    undefined,
  )
})

test("the walk stops at a compaction message and answers undefined", () => {
  assert.equal(
    latestContextTokens([
      msg({ input: 5000, output: 10 }),
      // The compaction turn: its input is the history the compaction removed.
      msg({ input: 120000, output: 900 }, { summary: true }),
    ]),
    undefined,
  )
})

test("the stop is on summary === true alone; false is an ordinary message", () => {
  // The newest message carries summary: false — an ordinary assistant turn
  // (finalResult treats it the same) — and answers, walked to like any other.
  assert.equal(
    latestContextTokens([
      msg({ input: 500, output: 10 }),
      msg({ input: 30, output: 2 }, { summary: false }),
    ]),
    32,
  )
})

test("no qualifying message, an empty array and a non-array all answer undefined", () => {
  assert.equal(latestContextTokens([]), undefined)
  assert.equal(latestContextTokens([msg({ input: 10, output: 0 })]), undefined)
  assert.equal(latestContextTokens(undefined), undefined)
  assert.equal(latestContextTokens(null), undefined)
  assert.equal(latestContextTokens("no"), undefined)
})

// ---- 2. the server call site --------------------------------------------------

test("fetchSnapshot's ctxTokens is the shared figure", async () => {
  const client = {
    session: {
      messages: async () => ({
        data: [
          msg({ input: 100, output: 5, reasoning: 4000, cache: { read: 10, write: 2 } }),
          msg({ input: 0, output: 0, reasoning: 7 }),
        ],
      }),
    },
  }
  const snap = await fetchSnapshot(client, "ses_fig")
  assert.equal(snap.ctxTokens, 4117)
})

// ---- 3. the sidebar call site (source scan) -----------------------------------

const tui = readFileSync(fileURLToPath(new URL("../tui/src/tui.tsx", import.meta.url)), "utf8")

test("tui.tsx imports the shared module", () => {
  assert.match(
    tui,
    /import\s*\{[^}]*latestContextTokens[^}]*\}\s*from\s*"\.\.\/\.\.\/src\/context-figure\.js"/,
    "the panel must bundle the one computation, not re-declare it",
  )
})

test("tui.tsx carries no local token-field sum", () => {
  assert.doesNotMatch(
    tui,
    /function\s+latestContextTokens/,
    "the old local copy is gone",
  )
  assert.doesNotMatch(
    tui,
    /cache\?\.read/,
    "no surface in the panel may sum token fields on its own",
  )
})
