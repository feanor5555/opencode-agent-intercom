// Unit tests for `parseOpenPoints` (src/openpoints.js) — the parser for the
// orchestrator's final "what is still open" turn in an endless cycle.
//
// Pure function, so the suite imports nothing but the module itself: no plugin
// runtime, no state, no I/O.
//
// Run: node --test --test-timeout=2000 test/openpoints.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  parseOpenPoints,
  hasOpenPointsHeading,
  OPEN_POINT_MAX_CHARS,
  OPEN_POINTS_MAX,
} from "../src/openpoints.js"
import { looksLikeOpenPointsReply } from "../src/handoff.js"

test("parseOpenPoints: a well-formed reply yields title+accept pairs in order", () => {
  const reply = [
    "## OPEN POINTS",
    "",
    "- Finish the migration script",
    "  accept: `npm run migrate` exits 0 on a fresh database",
    "- Write the rollback procedure",
    "  accept: procedures/rollback.md exists and names an exit code per step",
  ].join("\n")
  assert.deepEqual(parseOpenPoints(reply), [
    {
      title: "Finish the migration script",
      accept: "`npm run migrate` exits 0 on a fresh database",
    },
    {
      title: "Write the rollback procedure",
      accept: "procedures/rollback.md exists and names an exit code per step",
    },
  ])
})

test("parseOpenPoints: a point with no accept line yields a title and no criterion", () => {
  const reply = "## OPEN POINTS\n\n- Just this one\n- And another\n  accept: it is done\n"
  assert.deepEqual(parseOpenPoints(reply), [
    { title: "Just this one" },
    { title: "And another", accept: "it is done" },
  ])
})

test("parseOpenPoints: the heading with no points yields [] (a legal answer)", () => {
  assert.deepEqual(parseOpenPoints("## OPEN POINTS"), [])
  assert.deepEqual(parseOpenPoints("## OPEN POINTS\n\n"), [])
})

test("parseOpenPoints: a reply without the heading yields null, distinct from []", () => {
  assert.equal(parseOpenPoints("- a point\n  accept: something"), null)
  assert.equal(parseOpenPoints(""), null)
  assert.equal(parseOpenPoints(undefined), null)
  assert.equal(parseOpenPoints({ heading: "## OPEN POINTS" }), null)
})

test("parseOpenPoints: prose before the heading is ignored", () => {
  const reply =
    "Sure, here is what is still open — I will keep it short.\n\n" +
    "## OPEN POINTS\n\n- The one real point\n  accept: it lands\n"
  assert.deepEqual(parseOpenPoints(reply), [{ title: "The one real point", accept: "it lands" }])
})

test("parseOpenPoints: an over-long title and criterion are capped", () => {
  const long = "x".repeat(500)
  const [point] = parseOpenPoints(`## OPEN POINTS\n\n- ${long}\n  accept: ${long}\n`)
  assert.equal(point.title.length, OPEN_POINT_MAX_CHARS)
  assert.equal(point.accept.length, OPEN_POINT_MAX_CHARS)
  assert.ok(point.title.endsWith("…"), "a capped title is marked as truncated")
})

test("parseOpenPoints: more than 40 points are cut to 40", () => {
  const lines = ["## OPEN POINTS", ""]
  for (let i = 1; i <= OPEN_POINTS_MAX + 15; i++) lines.push(`- point ${i}`)
  const points = parseOpenPoints(lines.join("\n"))
  assert.equal(points.length, OPEN_POINTS_MAX)
  assert.equal(points[0].title, "point 1")
  assert.equal(points[OPEN_POINTS_MAX - 1].title, `point ${OPEN_POINTS_MAX}`)
})

test("parseOpenPoints: an empty bullet is not a point", () => {
  assert.deepEqual(parseOpenPoints("## OPEN POINTS\n\n-   \n- real one\n"), [{ title: "real one" }])
})

// ---------------------------------------------------------------------------
// The poll's shape check and the parse read the same heading
// ---------------------------------------------------------------------------

test("the endless cycle's poll gate and its parse agree on every reply shape", () => {
  // Two stages of one cycle: `looksLikeOpenPointsReply` decides that the reply
  // has arrived, `parseOpenPoints` decides what it says. A reply the first
  // accepts and the second rejects abandons the cycle at `save` with "reply
  // carried no `## OPEN POINTS` heading" — so they must never disagree.
  const replies = [
    "## OPEN POINTS",
    "## OPEN POINTS\n\n- a point\n  accept: it lands\n",
    "##   OPEN POINTS   \n\n- a point\n",
    "prose first\n\n## OPEN POINTS\n\n- a point\n",
    "## Open Points\n\n- a point\n",
    "## OPEN POINTS extra\n",
    "no heading at all",
    "",
  ]
  for (const reply of replies) {
    assert.equal(
      looksLikeOpenPointsReply(reply),
      parseOpenPoints(reply) !== null,
      `poll gate and parse disagree on ${JSON.stringify(reply)}`,
    )
    assert.equal(looksLikeOpenPointsReply(reply), hasOpenPointsHeading(reply))
  }
})

test("hasOpenPointsHeading takes a non-string without throwing", () => {
  for (const value of [undefined, null, 42, {}, ["## OPEN POINTS"]]) {
    assert.equal(hasOpenPointsHeading(value), false)
    assert.equal(looksLikeOpenPointsReply(value), false)
  }
})
