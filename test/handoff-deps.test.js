// Unit tests for the three small REAL dependency-provider helpers that
// `performPrimaryHandoff(deps)` (handoff.js, slice 6a) needs to be wired up:
//
//   - inFlightSubagentsFor(parentID)        — src/registry.js
//   - readPlannedSteps(directory)          — src/project.js
//   - forgetPrimary(sessionID)             — src/registry.js
//
// Slice 6b-i: the helpers exist and are testable in isolation. The next slice
// (6b-ii) wires the real implementations into `performPrimaryHandoff` as the
// `getInFlightSubagents` / `getPlannedSteps` / `forgetPrimary` deps; this test
// file proves each one returns / mutates what the handoff consumer expects
// (the InFlightSubagent typedef, a string[] for planned steps, and a sync
// removal from both primary-tracking maps).
//
// Imports ONLY src/registry.js, src/state.js, src/project.js (+ node builtins).
// NEVER hooks.js / client.js — those start long-lived plugin handles that
// keep `node --test` from exiting.
//
// Run: node --test --test-timeout=2000 test/handoff-deps.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  registry,
  bySession,
  primarySessions,
  primaryCtx,
  aborted,
  counters,
  registryMutex,
} from "../src/state.js"
import { inFlightSubagentsFor, forgetPrimary } from "../src/registry.js"
import { readPlannedSteps } from "../src/project.js"

// Mirror the seed convention from test/reparent-subagents.test.js and
// test/registry-mutex.test.js — bypass upsertSession so the slice's tests are
// independent of every other plugin wiring.
function seed(sessionID, handle, { agent = "researcher", parentID, dispatched = false, prompt = "", taskId = undefined } = {}) {
  const entry = { handle, sessionID, agent, parentID, status: "busy", dispatched, prompt, taskId }
  registry.set(handle, entry)
  bySession.set(sessionID, handle)
  return entry
}

function reset() {
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()
  counters.clear()
  primaryCtx.clear()
}

// ===========================================================================
// inFlightSubagentsFor(parentID)
// ===========================================================================

test("inFlightSubagentsFor returns the in-flight entries of parentID as {handle, agent, task}", async () => {
  reset()
  // Two entries for A — one dispatched (must be excluded), one live.
  // One entry for B (different parent — must be excluded).
  // One entry with no parent — must be excluded.
  seed("s-a-live", "researcher#1", { parentID: "A", prompt: "ship the export endpoint" })
  seed("s-a-dispatched", "researcher#2", { parentID: "A", dispatched: true, prompt: "already mid-delivery" })
  seed("s-b", "coder#1", { parentID: "B", prompt: "write tests" })
  seed("s-none", "researcher#3", { parentID: undefined, prompt: "orphan" })

  const inFlight = await inFlightSubagentsFor("A")

  assert.equal(inFlight.length, 1, "exactly one A entry is in-flight")
  assert.deepEqual(inFlight[0], {
    handle: "researcher#1",
    agent: "researcher",
    task: "ship the export endpoint",
  })
})

test("inFlightSubagentsFor falls back through prompt -> taskId -> agent for the `task` slot", async () => {
  reset()

  // No prompt — taskId wins.
  seed("s-tid", "researcher#1", { parentID: "A", prompt: "", taskId: "T7" })
  // No prompt AND no taskId — agent is the last resort.
  seed("s-bare", "researcher#2", { parentID: "A", prompt: "", taskId: undefined })
  // Both prompt and taskId present — prompt wins (it's the richer description).
  seed("s-both", "researcher#3", { parentID: "A", prompt: "real prompt", taskId: "T9" })

  const inFlight = await inFlightSubagentsFor("A")
  const byHandle = Object.fromEntries(inFlight.map((s) => [s.handle, s.task]))

  assert.equal(byHandle["researcher#1"], "T7", "taskId used when prompt is empty")
  assert.equal(byHandle["researcher#2"], "researcher", "agent name used when both prompt and taskId absent")
  assert.equal(byHandle["researcher#3"], "real prompt", "prompt wins over taskId")
})

test("inFlightSubagentsFor returns [] for unknown parentID", async () => {
  reset()
  seed("s-a", "researcher#1", { parentID: "A" })
  const inFlight = await inFlightSubagentsFor("does-not-exist")
  assert.deepEqual(inFlight, [])
})

test("inFlightSubagentsFor returns [] synchronously for falsy parentID (no mutex round-trip)", async () => {
  // The function early-returns [] on a falsy parentID, without ever touching
  // registryMutex. This is important for callers that may invoke it before
  // knowing the primary's id (e.g. from an empty-session path).
  reset()
  assert.deepEqual(await inFlightSubagentsFor(""), [])
  assert.deepEqual(await inFlightSubagentsFor(undefined), [])
  assert.deepEqual(await inFlightSubagentsFor(null), [])
})

test("inFlightSubagentsFor runs under registryMutex (concurrent holder sees serialized snapshot)", async () => {
  // Regression for the locking discipline: the helper must hold the mutex
  // across the whole iteration so a concurrent upsertSession / removeEntry
  // cannot splice the snapshot mid-way. We can't easily exercise the racing
  // splice here, but we CAN assert that the helper coexists with a queued
  // runExclusive without deadlock — the same property reparentSubagents'
  // tests assert.
  reset()
  for (let i = 0; i < 5; i++) seed(`s-${i}`, `researcher#${i}`, { parentID: "A" })

  // Two helpers + a separate runExclusive queued behind them. All settle.
  const [a, b, tail] = await Promise.all([
    inFlightSubagentsFor("A"),
    inFlightSubagentsFor("A"),
    registryMutex.runExclusive(() => "alive"),
  ])

  assert.equal(a.length, 5)
  assert.equal(b.length, 5)
  assert.equal(tail, "alive")
})

// ===========================================================================
// forgetPrimary(sessionID)
// ===========================================================================

test("forgetPrimary removes the session from BOTH primarySessions and primaryCtx", () => {
  reset()
  const id = "ses_primary_1"
  primarySessions.add(id)
  primaryCtx.set(id, { tokens: 12345, lastFetchAt: Date.now() })

  forgetPrimary(id)

  assert.equal(primarySessions.has(id), false, "primarySessions entry removed")
  assert.equal(primaryCtx.has(id), false, "primaryCtx entry removed")
})

test("forgetPrimary is a safe no-op for an unknown sessionID", () => {
  reset()
  // Seed a DIFFERENT session that must NOT be touched.
  primarySessions.add("ses_other")
  primaryCtx.set("ses_other", { tokens: 999, lastFetchAt: Date.now() })

  forgetPrimary("does-not-exist")

  assert.equal(primarySessions.has("ses_other"), true, "other primary untouched")
  assert.equal(primaryCtx.has("ses_other"), true, "other ctx untouched")
})

test("forgetPrimary is a safe no-op for an empty / falsy sessionID", () => {
  reset()
  primarySessions.add("ses_primary")
  primaryCtx.set("ses_primary", { tokens: 1, lastFetchAt: 1 })

  // None of these throw, none of these mutate the other session.
  forgetPrimary("")
  forgetPrimary(undefined)
  forgetPrimary(null)

  assert.equal(primarySessions.has("ses_primary"), true)
  assert.equal(primaryCtx.has("ses_primary"), true)
})

test("forgetPrimary clears primaryCtx even when primarySessions had no entry (and vice versa)", () => {
  reset()
  // Asymmetric seeding — only in primaryCtx.
  primaryCtx.set("ses_orphan", { tokens: 42, lastFetchAt: 1 })
  forgetPrimary("ses_orphan")
  assert.equal(primaryCtx.has("ses_orphan"), false)

  // And the mirror: only in primarySessions.
  primarySessions.add("ses_orphan2")
  forgetPrimary("ses_orphan2")
  assert.equal(primarySessions.has("ses_orphan2"), false)
})

test("forgetPrimary is sync (returns undefined, not a Promise)", () => {
  reset()
  primarySessions.add("ses_x")
  const ret = forgetPrimary("ses_x")
  assert.equal(ret, undefined, "sync function returns undefined")
})

// ===========================================================================
// readPlannedSteps(directory)
// ===========================================================================

test("readPlannedSteps returns [] when TODO.md is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    assert.deepEqual(readPlannedSteps(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPlannedSteps returns [] for an empty directory argument", () => {
  assert.deepEqual(readPlannedSteps(""), [])
  assert.deepEqual(readPlannedSteps(undefined), [])
})

test("readPlannedSteps extracts list items under a `## Offen` heading", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    writeFileSync(
      join(dir, "TODO.md"),
      [
        "# TODO",                                                       // 1
        "",                                                              // 2
        "## Kontext: Stand dieser Session",                              // 3
        "",                                                              // 4
        "Erledigt & gepusht.",                                           // 5
        "",                                                              // 6
        "## Offen",                                                      // 7
        "",                                                              // 8
        "- T1: auto context refresh ab 80% Kontextfüllung",              // 9
        "  accept: Schwellenwert konfigurierbar, Summary wird gebaut",   // 10
        "- T3: Wake-Retry bei postNotice-Fehler",                        // 11
        "",                                                              // 12
        "## Done",                                                       // 13
        "",                                                              // 14
        "- T0: initial seed task",                                       // 15
      ].join("\n"),
    )

    const steps = readPlannedSteps(dir)

    // Exactly the three lines under `## Offen` (the two `- T<n>: …` headers +
    // the indented `accept:` continuation under T1). T0 must NOT appear.
    assert.deepEqual(steps, [
      "T1: auto context refresh ab 80% Kontextfüllung",
      "accept: Schwellenwert konfigurierbar, Summary wird gebaut",
      "T3: Wake-Retry bei postNotice-Fehler",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPlannedSteps falls back to top-level list items when no `## Offen` heading is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    // Mirrors the canonical todofile.js layout: flat top-level `- T<n>: …`
    // lines, no `## Offen` section heading. Everything in the file is treated
    // as a planned step.
    writeFileSync(
      join(dir, "TODO.md"),
      [
        "# TODO",
        "",
        "- T1: add export endpoint",
        "  accept: GET /export returns 200 with JSON",
        "- T2: write tests for export",
      ].join("\n"),
    )

    const steps = readPlannedSteps(dir)
    assert.deepEqual(steps, [
      "T1: add export endpoint",
      "accept: GET /export returns 200 with JSON",
      "T2: write tests for export",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPlannedSteps also accepts `- [ ] …` checkbox bullets", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    writeFileSync(
      join(dir, "TODO.md"),
      [
        "# TODO",
        "",
        "- [ ] wire pagination",
        "- [x] already done — should still pass the bullet filter",
        "* checkbox with star",
      ].join("\n"),
    )

    const steps = readPlannedSteps(dir)
    assert.ok(steps.includes("wire pagination"))
    assert.ok(steps.includes("already done — should still pass the bullet filter"))
    assert.ok(steps.includes("checkbox with star"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPlannedSteps returns [] for an empty TODO.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    writeFileSync(join(dir, "TODO.md"), "")
    assert.deepEqual(readPlannedSteps(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPlannedSteps handles `## Offen` at the very end of the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "intercom-handoff-deps-"))
  try {
    writeFileSync(
      join(dir, "TODO.md"),
      [
        "## Erledigt",
        "- old thing",
        "",
        "## Offen",
        "- T1: last task",
      ].join("\n"),
    )

    const steps = readPlannedSteps(dir)
    // The `## Offen` section runs to EOF (no closing `## …` heading), so
    // `old thing` under `## Erledigt` is NOT included.
    assert.deepEqual(steps, ["T1: last task"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})