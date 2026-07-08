// Unit tests for the primary handoff summary formatting + persistence
// (Slice 4 — format + persist only; no content gathering, no handoff).
//
// Covers the four pure-ish helpers in src/project.js:
//   - formatPrimarySummary  — deterministic markdown shape
//   - primarySummaryPath    — convention check
//   - writePrimarySummary   — disk write, mkdir -p
//   - readPrimarySummary    — round-trip + missing-file contract
//
// Imports ONLY src/project.js (+ node builtins fs/path/os). Never imports
// src/hooks.js or src/client.js — those start long-lived plugin handles that
// keep `node --test` from exiting.
//
// Run: node --test --test-timeout=2000 test/primary-summary.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  formatPrimarySummary,
  primarySummaryPath,
  writePrimarySummary,
  readPrimarySummary,
} from "../src/project.js"

// ---------- primarySummaryPath ---------------------------------------------

test("primarySummaryPath resolves to <dir>/.opencode/agent-intercom/primary-summary.md", () => {
  const dir = "/tmp/example-project"
  assert.equal(
    primarySummaryPath(dir),
    join(dir, ".opencode", "agent-intercom", "primary-summary.md"),
  )
})

// ---------- formatPrimarySummary: headers in order --------------------------

test("formatPrimarySummary emits the three German headers in fixed order", () => {
  const md = formatPrimarySummary({
    stand: "All tests green.",
    notes: ["reviewer flagged the auth shim"],
    plannedSteps: ["ship T5"],
  })

  const iStand = md.indexOf("## Stand / Aktueller Zustand")
  const iNotes = md.indexOf("## Zu beachtende Punkte")
  const iPlanned = md.indexOf("## Geplante Schritte")
  assert.ok(iStand >= 0, "Stand header present")
  assert.ok(iNotes > iStand, "Notes header comes after Stand")
  assert.ok(iPlanned > iNotes, "Planned header comes after Notes")

  // Each header appears exactly once.
  assert.equal(
    md.split("## Stand / Aktueller Zustand").length - 1,
    1,
    "Stand header is unique",
  )
  assert.equal(
    md.split("## Zu beachtende Punkte").length - 1,
    1,
    "Notes header is unique",
  )
  assert.equal(
    md.split("## Geplante Schritte").length - 1,
    1,
    "Planned header is unique",
  )
})

// ---------- formatPrimarySummary: items under each section ------------------

test("formatPrimarySummary places stand as paragraph; notes + plannedSteps as bulleted lists", () => {
  const md = formatPrimarySummary({
    stand: "All tests green.",
    notes: ["reviewer flagged the auth shim", "do NOT touch src/legacy/"],
    plannedSteps: ["ship T5", "open follow-up for T6"],
  })

  // Stand is a paragraph, not a bullet.
  assert.match(md, /## Stand \/ Aktueller Zustand\n\nAll tests green\./)

  // Notes bullets, in order.
  assert.match(md, /- reviewer flagged the auth shim\n- do NOT touch src\/legacy\//)

  // Planned steps bullets, in order.
  assert.match(md, /- ship T5\n- open follow-up for T6/)
})

test("formatPrimarySummary also accepts an array for stand (rendered as bullets)", () => {
  const md = formatPrimarySummary({
    stand: ["login flow works", "logout is broken on Safari"],
    notes: [],
    plannedSteps: [],
  })
  assert.match(md, /- login flow works\n- logout is broken on Safari/)
})

// ---------- formatPrimarySummary: empty input ------------------------------

test("formatPrimarySummary renders headers without crashing when all inputs are empty", () => {
  const md = formatPrimarySummary({ stand: "", notes: [], plannedSteps: [] })
  assert.match(md, /## Stand \/ Aktueller Zustand/)
  assert.match(md, /## Zu beachtende Punkte/)
  assert.match(md, /## Geplante Schritte/)
})

test("formatPrimarySummary treats undefined / missing sections as empty", () => {
  const md = formatPrimarySummary({})
  assert.match(md, /## Stand \/ Aktueller Zustand/)
  assert.match(md, /## Zu beachtende Punkte/)
  assert.match(md, /## Geplante Schritte/)
})

test("formatPrimarySummary drops blank/whitespace-only list entries", () => {
  const md = formatPrimarySummary({
    stand: "ok",
    notes: ["real note", "   ", ""],
    plannedSteps: ["   ", "ship it"],
  })
  assert.match(md, /- real note/)
  assert.match(md, /- ship it/)
  assert.doesNotMatch(md, /- {3,}/, "whitespace-only bullets are dropped")
  assert.doesNotMatch(md, /\n-\n/, "empty bullets are dropped")
})

// ---------- round-trip: write -> read ---------------------------------------

test("writePrimarySummary + readPrimarySummary round-trip into os.tmpdir()", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-primary-summary-"))
  try {
    const expected = formatPrimarySummary({
      stand: "Round-trip stand.",
      notes: ["n1", "n2"],
      plannedSteps: ["p1"],
    })

    writePrimarySummary(dir, expected)

    // File exists at the documented path.
    const path = primarySummaryPath(dir)
    assert.ok(existsSync(path), `expected file at ${path}`)

    // Raw on-disk bytes match exactly (writePrimarySummary wrote utf8 as-is).
    const onDisk = readFileSync(path, "utf8")
    assert.equal(onDisk, expected, "raw disk content matches input")

    // Reader returns the same string.
    assert.equal(readPrimarySummary(dir), expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("writePrimarySummary creates the .opencode/agent-intercom/ dir if missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-primary-summary-"))
  try {
    // Sanity: dir has no .opencode/ yet.
    assert.equal(existsSync(join(dir, ".opencode")), false)

    writePrimarySummary(dir, "# hello\n")

    assert.ok(
      existsSync(join(dir, ".opencode", "agent-intercom", "primary-summary.md")),
      "summary file lands in the per-plugin state dir",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPrimarySummary returns '' when the file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-primary-summary-"))
  try {
    assert.equal(readPrimarySummary(dir), "")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPrimarySummary returns '' for an empty directory argument", () => {
  assert.equal(readPrimarySummary(""), "")
  assert.equal(readPrimarySummary(undefined), "")
})