// Unit tests for the structural prevention of concept step 6: the default
// prompt file carries `{{guide}}` instead of the inlined guide text, so a file
// written today cannot freeze the contract it was rendered from.
//
// Two directions, both required:
//
//   - a freshly rendered file substitutes to exactly what the auto-assembled
//     prompt injects for that role, and the token never survives into a prompt
//     that reaches a model;
//   - a file with the guide inlined — every file written before the token
//     existed — keeps working unchanged.
//
// Run: node --test test/prompt-guide-placeholder.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"

import plugin from "../src/index.js"
import { upsertSession } from "../src/registry.js"
import { mayDelegate } from "../src/agents.js"
import {
  PROMPT_CONTRACT,
  guideBlocks,
  ORCHESTRATION_GUIDE,
  ORCHESTRATION_REUSE_GUIDE,
  SUBAGENT_GUIDE_CORE,
  SUBAGENT_DELEGATION_GUIDE,
  SUBAGENT_GROUNDED_DELEGATION_GUIDE,
  SUBAGENT_NO_SPAWN_GUIDE,
  delegationGuideNameFor,
  SUBAGENT_OUTLINE_GUIDE,
} from "../src/prompts.js"
import { CONTRACT_STAMP_KEY } from "../src/overrides.js"
import {
  AGENT_NAMES,
  renderDefaultsFile,
  renderOpencodeDefaultFile,
  applyCustomPrompt,
  getPromptFilePath,
} from "../src/promptsfile.js"
import {
  newProject,
  cleanupProjects,
  resetPromptFileState,
  makeCtx,
  writeSettings,
} from "./helpers/prompt-files.js"
import { retentionOffered } from "../src/settings.js"

after(cleanupProjects)
beforeEach(resetPromptFileState)


let counter = 0
const nextSession = (prefix) => `${prefix}_${++counter}`

// The system prompt the plugin assembles for one session, joined into one
// string. A subagent needs a registry entry — that is where its role is read
// from; a primary needs none.
async function promptFor(hooks, sessionID) {
  const out = { system: ["# Role: Base\n\nbase prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system.join("")
}

function subagent(sessionID, agent, dir) {
  upsertSession(sessionID, { agent, prompt: "task", parentID: "ses_parent", directory: dir })
}

// ---- what the renderer writes ----------------------------------------------

test("the default file carries the token and the stamp, not the guide text", () => {
  for (const agent of AGENT_NAMES) {
    const file = renderDefaultsFile(agent)
    assert.match(file, /\{\{guide\}\}/, `${agent} must carry the guide token`)
    assert.ok(
      file.includes(`${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT}`),
      `${agent} must carry the current contract stamp`,
    )
    // None of the four guide blocks is inlined any more — that inlining is what
    // froze the contract in every file written before this token.
    for (const block of [
      ORCHESTRATION_GUIDE,
      SUBAGENT_GUIDE_CORE,
      SUBAGENT_DELEGATION_GUIDE,
      SUBAGENT_NO_SPAWN_GUIDE,
      SUBAGENT_OUTLINE_GUIDE,
    ]) {
      assert.ok(!file.includes(block.trim()), `${agent} still inlines a guide block`)
    }
  }
})

test("the stamp sits in the stripped comment, so it never reaches the model", () => {
  const rendered = applyCustomPrompt(renderDefaultsFile("coder"), {
    env: "",
    agents_md: "",
    project_md: "",
    guide: "GUIDE",
    limits: "",
  })
  assert.ok(!rendered.includes(CONTRACT_STAMP_KEY), "the contract stamp is author-facing only")
  assert.ok(!rendered.includes("{{guide}}"), "the token is substituted")
  assert.match(rendered, /GUIDE/)
})

// ---- what the token substitutes to ------------------------------------------

test("a freshly rendered file substitutes to the same guide the auto path assembles", async () => {
  for (const agent of ["coder", "researcher", "designer"]) {
    const dir = newProject()
    const hooks = await plugin(makeCtx(dir).ctx)

    // The auto path first, in a project with no prompt file at all.
    const bare = nextSession("ses_bare")
    subagent(bare, agent, dir)
    const auto = await promptFor(hooks, bare)

    // Then the same role, driven from the file the renderer writes.
    writeFileSync(getPromptFilePath(dir, agent), renderDefaultsFile(agent))
    const fromFile = nextSession("ses_file")
    subagent(fromFile, agent, dir)
    const custom = await promptFor(hooks, fromFile)

    const expected = guideBlocks({ agent, delegates: mayDelegate(agent) })
    assert.ok(auto.includes(expected), `${agent}: the auto path injects the assembled guide`)
    assert.ok(custom.includes(expected), `${agent}: the file substitutes to the same text`)
    assert.ok(!custom.includes("{{guide}}"), `${agent}: no raw token reaches the model`)
    assert.ok(
      !custom.includes("project files are overriding"),
      `${agent}: a file the renderer just wrote is not reported as stale`,
    )
  }
})

test("the substituted guide is the role's own — delegation and outline included", async () => {
  const dir = newProject()
  const hooks = await plugin(makeCtx(dir).ctx)
  for (const agent of ["coder", "gitter"]) {
    writeFileSync(getPromptFilePath(dir, agent), renderDefaultsFile(agent))
  }

  const coder = nextSession("ses_coder")
  subagent(coder, "coder", dir)
  const coderPrompt = await promptFor(hooks, coder)
  assert.ok(coderPrompt.includes(SUBAGENT_DELEGATION_GUIDE), "a delegating role is told its target")
  assert.ok(!coderPrompt.includes(SUBAGENT_GROUNDED_DELEGATION_GUIDE), "and not another's")
  assert.ok(coderPrompt.includes(SUBAGENT_OUTLINE_GUIDE), "and keeps the reading discipline")
  assert.ok(!coderPrompt.includes(SUBAGENT_NO_SPAWN_GUIDE))

  const gitter = nextSession("ses_gitter")
  subagent(gitter, "gitter", dir)
  const gitterPrompt = await promptFor(hooks, gitter)
  assert.ok(gitterPrompt.includes(SUBAGENT_NO_SPAWN_GUIDE))
  assert.ok(!gitterPrompt.includes(SUBAGENT_DELEGATION_GUIDE))
  assert.ok(!gitterPrompt.includes(SUBAGENT_OUTLINE_GUIDE), "gitter has no outline tool")
})

test("a primary's file substitutes the orchestration protocol", async () => {
  const dir = newProject()
  writeFileSync(getPromptFilePath(dir, "orchestrator"), renderDefaultsFile("orchestrator"))
  const hooks = await plugin(makeCtx(dir).ctx)
  const prompt = await promptFor(hooks, nextSession("ses_primary"))
  assert.ok(prompt.includes(ORCHESTRATION_GUIDE))
  assert.ok(!prompt.includes(SUBAGENT_GUIDE_CORE), "the primary gets its own protocol, not the subagent one")
  assert.ok(!prompt.includes("{{guide}}"))
})

// ---- what an already-written file does --------------------------------------

test("a file written before the token existed keeps working, guide text and all", async () => {
  // The shape `renderDefaultsFile` produced until now: role prompt, tokens, and
  // the guide inlined. Nothing about it changes — no token to substitute, no
  // second copy of the guide, and the file still owns the whole layout.
  const dir = newProject()
  const inlined =
    "<!-- an author note -->\n\n# Role: Coder\n\n{{env}}\n" +
    guideBlocks({ agent: "coder", delegates: true }) +
    "\n{{project_md}}\n"
  writeFileSync(getPromptFilePath(dir, "coder"), inlined)

  const hooks = await plugin(makeCtx(dir).ctx)
  const sessionID = nextSession("ses_inlined")
  subagent(sessionID, "coder", dir)
  const prompt = await promptFor(hooks, sessionID)

  assert.ok(prompt.startsWith("# Role: Coder"), "the comment is stripped, the layout is the file's")
  assert.equal(
    prompt.split(SUBAGENT_GUIDE_CORE).length - 1,
    1,
    "the guide appears exactly once — the token is absent, nothing is added",
  )
  assert.ok(!prompt.includes("{{guide}}"))
  assert.ok(
    !prompt.includes("project files are overriding"),
    "a file carrying the current contract inline is not stale either",
  )
})

test("an unknown token is still left in place — only `guide` was added", () => {
  const rendered = applyCustomPrompt("head {{guide}} {{typo}} tail", { guide: "G" })
  assert.equal(rendered, "head G {{typo}} tail")
})

// ---- the reference file's account of what the plugin adds -------------------

// The guide constants by name, so the reference file's note can be compared
// against what `guideBlocks` really assembles instead of against a hand-kept
// list. `HAS_OUTLINE` in promptsfile.js is derived from OUTLINE_DISABLED_AGENTS
// and this is what pins the derivation: a role moved into or out of that set
// changes both sides here, and a note that stops naming a block fails.
const GUIDE_CONSTANTS = [
  ["ORCHESTRATION_GUIDE", ORCHESTRATION_GUIDE],
  ["ORCHESTRATION_REUSE_GUIDE", ORCHESTRATION_REUSE_GUIDE],
  ["SUBAGENT_GUIDE_CORE", SUBAGENT_GUIDE_CORE],
  ["SUBAGENT_DELEGATION_GUIDE", SUBAGENT_DELEGATION_GUIDE],
  ["SUBAGENT_GROUNDED_DELEGATION_GUIDE", SUBAGENT_GROUNDED_DELEGATION_GUIDE],
  ["SUBAGENT_NO_SPAWN_GUIDE", SUBAGENT_NO_SPAWN_GUIDE],
  ["SUBAGENT_OUTLINE_GUIDE", SUBAGENT_OUTLINE_GUIDE],
]

const GUIDE_NOTE = /^ {2}- the agent-intercom guide block \(([^)]+)\) appended by the plugin$/m

// The note against what `guideBlocks` really assembles for the role, in this
// process's retention state. The state is read through `retentionOffered` on
// both sides, so the comparison cannot pass by both sides being wrong in the
// same direction: the file is rendered from the latch, and the guide it is
// measured against is assembled from the same latch.
function assertGuideNoteNamesWhatTheRoleGets() {
  for (const agent of AGENT_NAMES) {
    const primary = agent === "orchestrator"
    const guide = guideBlocks({
      primary,
      agent,
      delegates: mayDelegate(agent),
      retention: retentionOffered(),
    })
    const expected = GUIDE_CONSTANTS.filter(([, text]) => guide.includes(text)).map(([name]) => name)

    const note = GUIDE_NOTE.exec(renderOpencodeDefaultFile(agent))
    assert.ok(note, `${agent}: the reference file must carry the guide-block note`)
    assert.deepEqual(
      note[1].split(" + "),
      expected,
      `${agent}: the reference file must name the blocks guideBlocks assembles, in order`,
    )
  }
}

test("the opencode-defaults reference names every guide block the role really gets", () => {
  assertGuideNoteNamesWhatTheRoleGets()
})

// With retention offered the orchestrator's prompt carries a SECOND block, and
// a reference file that still names ORCHESTRATION_GUIDE alone under-reports what
// the plugin appends — the one thing that file exists to state.
test("with retention offered the reference names the reuse block too", () => {
  writeSettings({ maxRetainedSubagents: 3 })
  assert.equal(retentionOffered(), true)
  assertGuideNoteNamesWhatTheRoleGets()

  const note = GUIDE_NOTE.exec(renderOpencodeDefaultFile("orchestrator"))
  assert.equal(note[1], "ORCHESTRATION_GUIDE + ORCHESTRATION_REUSE_GUIDE")

  // Only the orchestrator. A subagent is never told about retention, so no
  // subagent's file may grow a block on account of it.
  for (const agent of AGENT_NAMES) {
    if (agent === "orchestrator") continue
    assert.doesNotMatch(renderOpencodeDefaultFile(agent), /ORCHESTRATION_REUSE_GUIDE/)
  }
})

test("with retention off the reference names ORCHESTRATION_GUIDE alone", () => {
  assert.equal(retentionOffered(), false, "the shipped default")
  const note = GUIDE_NOTE.exec(renderOpencodeDefaultFile("orchestrator"))
  assert.equal(note[1], "ORCHESTRATION_GUIDE")
  assert.doesNotMatch(renderOpencodeDefaultFile("orchestrator"), /reuse/i)
})

test("the reference file names the no-spawn stand-in for exactly the delegating roles", () => {
  // `delegates` is a runtime answer, not the role's map alone: with nested
  // spawning switched off a delegating role gets SUBAGENT_NO_SPAWN_GUIDE
  // instead (hooks.js), and only for those roles is the caveat true.
  for (const agent of AGENT_NAMES) {
    const file = renderOpencodeDefaultFile(agent)
    // Named by the role's own block: the researcher's stand-in replaces
    // SUBAGENT_GROUNDED_DELEGATION_GUIDE, every other delegating role's the
    // researcher-target block.
    const hasCaveat = file.includes(`stands in for ${delegationGuideNameFor(agent)}`)
    assert.equal(hasCaveat, mayDelegate(agent), `${agent}: caveat iff the role may delegate`)
  }
})
