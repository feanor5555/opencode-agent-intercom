// The blocked-report contract: a subagent that hits a problem its spawn prompt
// does not cover stops that step, finishes what does not depend on it, and
// opens its final reply with `Blocked:`. The one-shot design is unchanged —
// there is no mid-flight channel; the report rides the existing return path and
// the orchestrator decides what happens and spawns a fresh subagent where the
// task continues.
//
// Covered here:
//   - the notice branch (src/notices.js): headline + decision line for a
//     blocked result, byte-identical output on the normal path, and what does
//     and does not count as the marker;
//   - the TODO.md tail on a blocked report, which must not read as a missing
//     marker to chase;
//   - the prompt-assembly side (src/prompts.js, src/agents.js, src/tools.js):
//     the subagent-facing obligation, the orchestrator-facing counterpart, and
//     that no block still tells a subagent to report a stopper plainly.
//
// Run: node --test --test-timeout=5000 test/blocked-report.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { completionNotice, isBlockedResult } from "../src/notices.js"
import {
  SUBAGENT_GUIDE_CORE,
  SUBAGENT_NO_SPAWN_GUIDE,
  SUBAGENT_DELEGATION_GUIDE,
  ORCHESTRATION_GUIDE,
} from "../src/prompts.js"
import { AGENTS } from "../src/agents.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-blocked-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

const BLOCKED = "Blocked: the migration file the prompt names does not exist. Ran the two tests that do not touch it. Need the real path."
const PLAIN = "Done: rewrote src/foo.js and ran the suite."

function notice(result, taskOutcome) {
  return completionNotice("coder#1", "coder", result, "ses_primary", taskOutcome, 0, 0)
}

// ---- what counts as the marker --------------------------------------------

test("the marker is the first non-empty line, leading blank lines and indent tolerated", () => {
  assert.equal(isBlockedResult(BLOCKED), true)
  assert.equal(isBlockedResult("\n\n  Blocked: no database credentials."), true)
  assert.equal(isBlockedResult(PLAIN), false)
  assert.equal(isBlockedResult(""), false)
  assert.equal(isBlockedResult(undefined), false)
})

test("the marker accepts common markdown renderings at line start", () => {
  const rendered = [
    "**Blocked:** markdown emphasis with the colon inside",
    "**blocked**: markdown emphasis with the colon outside",
    "__BLOCKED:__ underscore emphasis with the colon inside",
    "__blocked__: underscore emphasis with the colon outside",
    "*Blocked:* single emphasis with the colon inside",
    "*blocked*: single emphasis with the colon outside",
    "_BLOCKED:_ underscore emphasis with the colon inside",
    "_blocked_: underscore emphasis with the colon outside",
    "`Blocked:` inline code with the colon inside",
    "`blocked`: inline code with the colon outside",
    "# Blocked: heading",
    "### Blocked: deeper heading",
    "- Blocked: list item",
    "> **Blocked**: quoted item with emphasis",
    "- __BLOCKED:__ list item with emphasis",
  ]
  for (const result of rendered) {
    assert.equal(isBlockedResult(result), true, result)
  }
})

test("the marker counts only at the top — not mentioned mid-reply", () => {
  assert.equal(
    isBlockedResult("Done: wrote the file.\nBlocked: nothing, just naming the word."),
    false,
    "a later line does not turn a finished run into a decision",
  )
  assert.equal(isBlockedResult("blocked: lowercase is accepted"), true)
  assert.equal(isBlockedResult("The report says **Blocked:** but is otherwise done"), false)
  assert.equal(isBlockedResult("*Blocked:** mismatched emphasis"), false)
})

// ---- the notice branch -----------------------------------------------------

test("a blocked result says so in the headline instead of 'has finished'", () => {
  const text = notice(BLOCKED)
  assert.match(text, /^🔔 agent-intercom: your subagent "coder#1" \(coder\) came back BLOCKED and was destroyed\.\n/)
  assert.doesNotMatch(text, /has finished and been destroyed/)
  assert.ok(text.includes(`Its result:\n${BLOCKED}\n`), "the report itself is carried verbatim")
})

test("a blocked result carries the decision line the orchestrator has to act on", () => {
  const text = notice(BLOCKED)
  assert.match(text, /DECISION for you, not a failed run to retry/)
  assert.match(text, /whether the original task continues/)
  assert.match(text, /spawn a FRESH subagent/)
  assert.match(text, /Do not re-send the same prompt/)
  assert.doesNotMatch(
    text,
    /Use this to report back to the user/,
    "a blocked report is not a result to hand on as-is",
  )
})

test("a normal result keeps the wording the orchestrator already knows", () => {
  const text = notice(PLAIN)
  assert.match(
    text,
    /^🔔 agent-intercom: your subagent "coder#1" \(coder\) has finished and been destroyed\.\n/,
  )
  assert.ok(text.includes(`Its result:\n${PLAIN}\n`))
  assert.match(text, /Use this to report back to the user\./)
  assert.doesNotMatch(text, /BLOCKED|DECISION for you/)
})

test("an empty result is not a blocked report", () => {
  const text = notice("")
  assert.match(text, /has finished and been destroyed/)
  assert.match(text, /It produced no text result\./)
})

// ---- the TODO.md tail on a blocked report ----------------------------------

test("a blocked task-tracked run is told the task stays open, not that a marker is missing", () => {
  const text = notice(BLOCKED, { kind: "no-marker" })
  assert.match(text, /📋 TODO\.md: the task stays open — a blocked report carries no `DONE: <id>`/)
  assert.doesNotMatch(text, /did NOT put/)
  assert.doesNotMatch(
    text,
    /Delegate verification and TODO\.md cleanup/,
    "the decision comes first; cleanup is not the move on a blocker",
  )
})

test("a plain run without the marker still gets the verification warning", () => {
  const text = notice(PLAIN, { kind: "no-marker" })
  assert.match(text, /⚠️ TODO\.md: this subagent had a task id but its reply did NOT put/)
  assert.match(text, /Delegate verification and TODO\.md cleanup/)
})

test("a completed task is removed the same way whatever the branch", () => {
  assert.match(notice(PLAIN, { kind: "done", id: "T7" }), /📋 TODO\.md: T7 removed\./)
})

// ---- the prompt side: what the subagent is told ----------------------------

test("the core guide states the blocked contract, marker and all", () => {
  assert.match(SUBAGENT_GUIDE_CORE, /`Blocked:`/)
  assert.match(SUBAGENT_GUIDE_CORE, /stop that step/i)
  assert.match(SUBAGENT_GUIDE_CORE, /finish every part of the task that does not depend on it/)
  assert.match(SUBAGENT_GUIDE_CORE, /FIRST line/)
  assert.match(SUBAGENT_GUIDE_CORE, /Do not invent a workaround/)
  assert.match(SUBAGENT_GUIDE_CORE, /do not widen the task/)
  assert.match(SUBAGENT_GUIDE_CORE, /The orchestrator decides/)
})

test("the DONE-marker sentence points at the blocked report instead of contradicting it", () => {
  assert.doesNotMatch(
    SUBAGENT_GUIDE_CORE,
    /just report plainly without that marker/,
    "the old escape hatch would let a subagent bury a blocker in prose",
  )
  assert.match(SUBAGENT_GUIDE_CORE, /leave that marker off and report as blocked/)
})

test("both delegation blocks route a stopper into the same marker", () => {
  assert.match(SUBAGENT_NO_SPAWN_GUIDE, /`Blocked:`/)
  assert.match(SUBAGENT_DELEGATION_GUIDE, /`Blocked:`/)
})

test("every role prompt that defers work to the orchestrator names the marker", () => {
  for (const agent of ["planner", "debugger", "designer"]) {
    assert.match(
      AGENTS[agent].prompt,
      /`Blocked:`/,
      `${agent} asks the orchestrator for work it cannot do itself`,
    )
  }
})

// ---- the prompt side: what the orchestrator is told -------------------------

test("the orchestration guide names the counterpart: a blocked reply is a decision", () => {
  assert.match(ORCHESTRATION_GUIDE, /`Blocked:` is a decision handed up to you, not a failed run to retry/)
  assert.match(ORCHESTRATION_GUIDE, /whether the original task continues/)
  assert.match(ORCHESTRATION_GUIDE, /spawn a FRESH subagent/)
  assert.match(ORCHESTRATION_GUIDE, /Never re-send the same prompt unchanged/)
})

test("the spawn tool description carries the same counterpart", async () => {
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_sub1" } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  const hooks = await plugin({ client, directory: fixtureDir, worktree: fixtureDir, project: {} })
  const desc = hooks.tool.spawn.description
  assert.match(desc, /`Blocked:` is a decision handed up to you, not a failure to retry/)
  assert.match(desc, /spawn a fresh subagent carrying that decision/)
})
