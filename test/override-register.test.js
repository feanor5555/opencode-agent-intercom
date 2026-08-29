// Unit tests for the override finding register (concept step 2).
//
// The register is process-wide and pure: two producers write findings into it
// (the config-hook detector and the prompt-file scan, both later steps), three
// consumers read it (debug log, toast, the primary's system-prompt block).
// These tests pin the shape of the record and the two renderers, which is all
// the later steps may rely on.
//
// Run: node --test test/override-register.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import {
  recordAgentEntryOverride,
  recordPromptFileOverride,
  hasFindings,
  overrideFindings,
  overrideBlock,
  overrideToastText,
  resetOverrides,
} from "../src/overrides.js"

beforeEach(() => {
  resetOverrides()
})

test("a clean register renders nothing at all", () => {
  assert.equal(hasFindings(), false)
  assert.deepEqual(overrideFindings(), [])
  assert.equal(overrideBlock(), "", "no findings -> the block is appendable and empty")
  assert.equal(overrideToastText(), null, "no findings -> no toast")
})

test("an agent-entry finding is normalized and readable", () => {
  assert.equal(
    recordAgentEntryOverride({
      agent: "coder",
      fields: ["prompt", "model", "prompt"],
      file: "/proj/.opencode/agent/coder.md",
    }),
    true,
    "a new finding reports that the register changed",
  )
  assert.equal(hasFindings(), true)
  const [finding] = overrideFindings()
  assert.equal(finding.kind, "agent-entry")
  assert.equal(finding.agent, "coder")
  assert.deepEqual([...finding.fields], ["prompt", "model"], "caller order kept, duplicates dropped")
  assert.deepEqual([...finding.missing], [], "missing belongs to the prompt-file kind only")
  assert.equal(finding.file, "/proj/.opencode/agent/coder.md")
})

test("a repeated identical detection adds no second line", () => {
  const finding = { agent: "coder", fields: ["prompt"], file: "/proj/x.md" }
  assert.equal(recordAgentEntryOverride(finding), true)
  assert.equal(recordAgentEntryOverride({ ...finding }), false, "an exact repeat is not a change")
  assert.equal(overrideFindings().length, 1)
  assert.equal(overrideBlock().match(/^- coder:/gm).length, 1, "one line per role, not two")
})

test("the same role in two projects keeps separate findings and blocks", () => {
  recordAgentEntryOverride({
    agent: "coder",
    fields: ["prompt"],
    file: "/project-a/.opencode/agent/coder.md",
    directory: "/project-a",
  })
  recordAgentEntryOverride({
    agent: "coder",
    fields: ["model"],
    file: "/project-b/.opencode/agent/coder.md",
    directory: "/project-b",
  })

  assert.deepEqual(
    overrideFindings("/project-a").map((finding) => [finding.agent, finding.file]),
    [["coder", "/project-a/.opencode/agent/coder.md"]],
  )
  assert.deepEqual(
    overrideFindings("/project-b").map((finding) => [finding.agent, finding.file]),
    [["coder", "/project-b/.opencode/agent/coder.md"]],
  )
  assert.match(overrideBlock("/project-a"), /project-a/)
  assert.doesNotMatch(overrideBlock("/project-a"), /project-b/)
  assert.equal(overrideFindings().length, 2, "the process register retains both projects")
})

test("a re-detection with different content replaces the finding, still one line", () => {
  recordPromptFileOverride({
    agent: "coder",
    missing: ["blocked-contract", "done-marker"],
    file: "/proj/.opencode/agent-intercom/coder.md",
  })
  assert.equal(
    recordPromptFileOverride({
      agent: "coder",
      missing: ["done-marker"],
      file: "/proj/.opencode/agent-intercom/coder.md",
    }),
    true,
    "a changed finding reports the change, so the log and toast can react",
  )
  assert.equal(overrideFindings().length, 1)
  assert.deepEqual([...overrideFindings()[0].missing], ["done-marker"])
})

test("a finding without a usable agent name is refused", () => {
  assert.equal(recordAgentEntryOverride({ agent: "", fields: ["prompt"] }), false)
  assert.equal(recordAgentEntryOverride({}), false)
  assert.equal(recordAgentEntryOverride(null), false)
  assert.equal(recordPromptFileOverride({ agent: 7 }), false)
  assert.equal(hasFindings(), false)
})

test("the block names every role, what it displaced and where it stands", () => {
  recordAgentEntryOverride({
    agent: "coder",
    fields: ["prompt", "permission"],
    file: "/proj/.opencode/agent/coder.md",
  })
  recordPromptFileOverride({
    agent: "orchestrator",
    missing: ["blocked-contract"],
    file: "/proj/.opencode/agent-intercom/orchestrator.md",
  })
  const block = overrideBlock()
  assert.match(block, /agent-intercom: project files are overriding/)
  assert.match(block, /- coder: a project agent entry replaces prompt, permission \(\/proj\/\.opencode\/agent\/coder\.md\)/)
  assert.match(block, /- orchestrator: the prompt file predates the current prompt contract, missing: blocked-contract/)
  // The block is the outlet that reaches a user with no TUI attached: the model
  // has to be told to pass it on, and told not to act on it.
  assert.match(block, /Tell the user about this in your next answer/)
  assert.match(block, /do not edit or delete these files/)
})

test("a finding with no file says so instead of inventing a path", () => {
  recordAgentEntryOverride({ agent: "planner", fields: ["model"], file: null })
  assert.match(overrideBlock(), /- planner: .* \(no file — the entry comes from the opencode config\)/)
})

test("a caller-supplied detail replaces the generated wording", () => {
  recordAgentEntryOverride({
    agent: "planner",
    fields: ["prompt"],
    file: "/proj/a.md",
    detail: "the role prompt is displaced\nwholesale",
  })
  assert.match(
    overrideBlock(),
    /- planner: the role prompt is displaced wholesale \(\/proj\/a\.md\)/,
    "the detail is folded onto one line — a block line must not wrap into a second",
  )
})

test("the block's text depends on the findings, not on the order they arrived in", () => {
  recordPromptFileOverride({ agent: "reviewer", missing: ["done-marker"], file: "/p/r.md" })
  recordAgentEntryOverride({ agent: "planner", fields: ["prompt"], file: "/p/p.md" })
  recordAgentEntryOverride({ agent: "coder", fields: ["model"], file: "/p/c.md" })
  const first = overrideBlock()

  resetOverrides()
  recordAgentEntryOverride({ agent: "coder", fields: ["model"], file: "/p/c.md" })
  recordPromptFileOverride({ agent: "reviewer", missing: ["done-marker"], file: "/p/r.md" })
  recordAgentEntryOverride({ agent: "planner", fields: ["prompt"], file: "/p/p.md" })

  assert.equal(
    overrideBlock(),
    first,
    "byte-identical across detection orders — it lives in the cached stable prompt element",
  )
  // agent-entry findings before prompt-file ones, alphabetical within a kind.
  assert.deepEqual(
    overrideFindings().map((f) => `${f.kind}/${f.agent}`),
    ["agent-entry/coder", "agent-entry/planner", "prompt-file/reviewer"],
  )
})

test("the toast body counts both kinds and is handed out exactly once", () => {
  recordAgentEntryOverride({ agent: "coder", fields: ["prompt"], file: "/p/c.md" })
  recordAgentEntryOverride({ agent: "planner", fields: ["prompt"], file: "/p/p.md" })
  recordPromptFileOverride({ agent: "reviewer", missing: ["done-marker"], file: "/p/r.md" })

  assert.equal(
    overrideToastText(),
    "2 roles overridden by project files, 1 prompt file out of date — see the orchestrator's first answer",
  )
  assert.equal(overrideToastText(), null, "one toast per process, not one per turn")

  // A later finding does not re-open the toast; the block is what carries it.
  recordAgentEntryOverride({ agent: "gitter", fields: ["prompt"], file: "/p/g.md" })
  assert.equal(overrideToastText(), null)
})

test("the toast body is singular for a single override", () => {
  recordAgentEntryOverride({ agent: "coder", fields: ["prompt"], file: "/p/c.md" })
  assert.equal(
    overrideToastText(),
    "1 role overridden by project files — see the orchestrator's first answer",
  )
})

test("a consumer cannot reshape the register through what it was handed", () => {
  recordAgentEntryOverride({ agent: "coder", fields: ["prompt"], file: "/p/c.md" })
  const listed = overrideFindings()
  listed.push({ kind: "agent-entry", agent: "forged" })
  assert.equal(overrideFindings().length, 1, "the list is a copy")
  assert.throws(
    () => {
      "use strict"
      listed[0].agent = "forged"
    },
    TypeError,
    "the records are frozen",
  )
})

test("resetOverrides clears the findings and re-arms the toast", () => {
  recordAgentEntryOverride({ agent: "coder", fields: ["prompt"], file: "/p/c.md" })
  assert.notEqual(overrideToastText(), null)
  resetOverrides()
  assert.equal(hasFindings(), false)
  assert.equal(overrideBlock(), "")
  recordAgentEntryOverride({ agent: "coder", fields: ["prompt"], file: "/p/c.md" })
  assert.notEqual(overrideToastText(), null, "the one-shot latch is a test seam too")
})
