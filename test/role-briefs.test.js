// The role prompts as a chain of hand-offs for weak models: each role's reply
// carries what the next role's brief needs, each role is told the size of its
// own task, and a role without `write` is never told to write a file.
//
// Pinned here: the `Commit:`/`Docs:` reply lines and the orchestrator's copy
// rule, the coder's modes (exact edit, listed rename, test, dependency), the
// cut unit the orchestrator and the planner size by, the reviewer's scope, the
// exact-brief roles' single `ask`, the TODO paragraph split, the debugger's
// `write` for `work/`, the orchestrator's tool list, and the reply-ceiling
// wording by `write` permission — in the blocks and through the transform —
// and the two narrow roles, `scout` for a code lookup and `checker` for a check
// run: their reply forms, their maps, and the orchestrator's routing to them.
//
// Run: node --test test/role-briefs.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"

import plugin from "../src/index.js"
import { upsertSession } from "../src/registry.js"
import { AGENTS, NESTED_SPAWN_TARGETS, SPAWNABLE_ROLES, roleHoldsWrite } from "../src/agents.js"
import { PRIMARY_TOOLS } from "../src/hooks.js"
import {
  guideBlocks,
  OUTLINE_DISABLED_AGENTS,
  replyCapBlock,
  resultCeilingPlan,
  ORCHESTRATION_REUSE_GUIDE,
  resultCeilingDemand,
} from "../src/prompts.js"
import {
  newProject,
  cleanupProjects,
  resetPromptFileState,
  makeCtx,
  writeSettings,
} from "./helpers/prompt-files.js"

after(cleanupProjects)
beforeEach(resetPromptFileState)

const COMMIT_LINE = /`Commit: <path> <path> … \| <subject line>`/
const DOCS_LINE = /`Docs: <file> — <section> — <fact to state>`/
const TODO_MIGRATION = /delete them from the source file/
const TODO_READ_ADD = /Use `todos_open` to read TODO\.md and `todo_add\(title, accept\)`/
const FILE_FORM = /write it under the project/
const NO_FILE_FORM = /keep the reply to the findings that fit, and name what you left out\./

// ---- the analysis → exact-brief hand-off -----------------------------------

test("the coder's reply ends in the Commit: and Docs: lines, in the project's commit style", () => {
  const { prompt } = AGENTS.coder
  assert.match(prompt, COMMIT_LINE)
  assert.match(prompt, DOCS_LINE)
  assert.match(prompt, /subject in the style of `git log -5 --format=%s` and the commit rules in AGENTS\.md\/CLAUDE\.md/)
  assert.match(AGENTS.planner.prompt, COMMIT_LINE, "the planner commits the files it wrote")
  assert.doesNotMatch(AGENTS.planner.prompt, DOCS_LINE)
})

test("the orchestrator copies those lines into the gitter and documenter briefs", () => {
  assert.match(
    AGENTS.orchestrator.prompt,
    /Copy the coder's `Commit:` and `Docs:` lines into the gitter and documenter prompts; where a change has none, ask a coder for them\./,
  )
})

// ---- the coder's modes -----------------------------------------------------

test("the coder applies a stated change as stated and may span a listed rename", () => {
  const { prompt } = AGENTS.coder
  assert.match(prompt, /Where the briefing states the exact change \(file, old text, new text\), apply it as stated/)
  assert.match(prompt, /A rename or move whose sites the briefing lists by path:line may span those files/)
  assert.match(prompt, /max ~100 lines of code change, 1–2 files/, "the slice cap stays")
})

test("the coder's deliverable includes the test and the dependency install", () => {
  const { prompt } = AGENTS.coder
  assert.match(prompt, /add or extend a test that fails without your change and passes with it; name it in your reply/)
  assert.match(prompt, /project's package manager so it rewrites the lock file; name the version installed/)
})

// ---- what the orchestrator cuts work into ----------------------------------

test("the orchestrator and the planner size work by one coder run", () => {
  const { prompt } = AGENTS.orchestrator
  assert.match(prompt, /one spawn has one deliverable: a coder change of about 100 lines in 1–2 named files/)
  assert.match(prompt, /Larger work goes to the planner first/)
  assert.match(prompt, /Brief a rename or move with its list of sites \(path:line\)/)
  assert.match(prompt, /Usual order — bug: debugger → coder \(with a test\) → checker → gitter; feature: planner → coder per task → checker → reviewer → documenter and gitter\./)
  assert.match(prompt, /coder for code and dependency changes and for tests/)
  assert.match(prompt, /write a test for <behaviour>, change no production code/)
  assert.match(prompt, /reviewer for code reviews \(give it a diff range; for a big change one axis per run\)/)
  assert.match(AGENTS.planner.prompt, /Size each task for one coder run: about 100 lines in 1–2 named files, with its `accept` line\./)
})

// The drift guard: the role line names the tools rather than counting them, so
// a tool added to the primary's allowlist without a mention here fails. `reuse`
// is the one exception, and it is named where it exists: the tool is offered
// only with retention on, and the block that introduces it rides on exactly
// that condition — a static role line naming it would send an orchestrator
// without retention after a tool it does not have.
test("the orchestrator's role line names every tool it holds", () => {
  const roleLine = AGENTS.orchestrator.prompt.split("\n").find((line) => line.startsWith("You delegate"))
  assert.ok(roleLine, "the role line is there")
  for (const tool of PRIMARY_TOOLS) {
    if (tool === "reuse") {
      assert.match(ORCHESTRATION_REUSE_GUIDE, /- reuse\(/, "reuse is introduced by its own block")
      assert.doesNotMatch(AGENTS.orchestrator.prompt, /\breuse\b/)
      continue
    }
    assert.match(roleLine, new RegExp(`\\b${tool}\\b`), `the role line names ${tool}`)
  }
  assert.doesNotMatch(AGENTS.orchestrator.prompt, /three tools|nothing else/)
})

// ---- the reviewer's scope --------------------------------------------------

test("the reviewer reviews what its briefing names, functional bugs first", () => {
  const { prompt } = AGENTS.reviewer
  assert.match(prompt, /Your briefing names what to review — a diff range, staged changes or files — and may name the axes\./)
  assert.match(prompt, /Run `git diff <range>` \(or `git diff --staged`\)/)
  assert.match(prompt, /Axes: functional bugs \(off-by-one, null, races\) first/)
  assert.match(prompt, /Where the briefing names axes, review those\./)
})

// ---- the exact-brief roles -------------------------------------------------

test("gitter and documenter ask once for a missing field, then report Blocked:", () => {
  assert.match(AGENTS.gitter.prompt, /Where a commit's files, message or push decision is missing, ask your caller once with `ask`/)
  assert.match(AGENTS.documenter.prompt, /Where your prompt leaves the file, the place or the content open, ask your caller once with `ask`/)
  for (const agent of ["gitter", "documenter"]) {
    assert.match(AGENTS[agent].prompt, /where no answer comes, .*`Blocked:` naming what is missing/, agent)
  }
})

test("the gitter's scope covers pull requests and read-only git reports", () => {
  const { prompt } = AGENTS.gitter
  assert.match(prompt, /pull requests with the title and body the prompt gives/)
  assert.match(prompt, /read-only reports \(`git status --short`, `git diff --stat`, `git log -n <count>`\) returned as they print/)
  assert.match(prompt, /and the output of each report/)
})

test("the exact-brief roles hold no TODO tools, no spawn and no code-reading blocks", () => {
  for (const agent of ["gitter", "documenter"]) {
    const { permission, prompt } = AGENTS[agent]
    assert.equal(permission.spawn, "deny", `${agent} spawns nothing`)
    assert.equal(permission.outline, "deny", `${agent} holds no outline`)
    for (const tool of ["todos_open", "todo_add", "todo_edit", "todo_done"]) {
      assert.equal(permission[tool], "deny", `${agent} denies ${tool}`)
    }
    assert.doesNotMatch(prompt, /todos_open|todo_add/, `${agent} is told nothing about TODO.md`)
    const guide = guideBlocks({ agent, delegates: false, codegraph: "codegraph" })
    assert.doesNotMatch(guide, /reading discipline|code search/, `${agent} gets no code-reading block`)
  }
})

// ---- the TODO paragraphs ---------------------------------------------------

test("planner and coder own TODO.md; debugger, reviewer and designer read and add", () => {
  for (const agent of ["planner", "coder"]) {
    assert.match(AGENTS[agent].prompt, TODO_MIGRATION, agent)
    assert.match(AGENTS[agent].prompt, /You share TODO\.md with planner\/coder\/debugger\/reviewer\/designer:/, agent)
  }
  for (const agent of ["debugger", "reviewer", "designer"]) {
    assert.match(AGENTS[agent].prompt, TODO_READ_ADD, agent)
    assert.match(AGENTS[agent].prompt, /TODOs you find in other files stay where they are\./, agent)
    assert.doesNotMatch(AGENTS[agent].prompt, TODO_MIGRATION, `${agent} edits no other file for a TODO`)
  }
})

// ---- the debugger's reproduction -------------------------------------------

test("the debugger writes repro scripts under work/ and edits nothing", () => {
  const { permission, prompt } = AGENTS.debugger
  assert.equal(permission.write, undefined, "write is granted by absence")
  assert.equal(permission.edit, "deny")
  assert.match(prompt, /Write repro scripts and your notes under `work\/debug-<topic>\/`; leave existing files as they are\./)
})

// ---- the reply ceiling by write permission ---------------------------------

test("roleHoldsWrite reads the plugin's own maps", () => {
  assert.equal(roleHoldsWrite("coder"), true)
  assert.equal(roleHoldsWrite("debugger"), true)
  assert.equal(roleHoldsWrite("gitter"), false)
  assert.equal(roleHoldsWrite("grounder"), false)
})

test("a role without write is told to keep its reply to what fits, in every block", () => {
  writeSettings({ maxResultTokens: 1500 })
  for (const agent of ["gitter", "grounder"]) {
    assert.match(replyCapBlock(agent), NO_FILE_FORM, `${agent}: system-prompt block`)
    assert.doesNotMatch(replyCapBlock(agent), FILE_FORM, agent)
    assert.match(resultCeilingPlan(agent), NO_FILE_FORM, `${agent}: plan band`)
    assert.doesNotMatch(resultCeilingPlan(agent), /File the detail/, agent)
    assert.match(resultCeilingDemand(agent, { canWrite: true }), NO_FILE_FORM, `${agent}: reserve band`)
    assert.match(resultCeilingDemand(agent, { canWrite: false }), NO_FILE_FORM, `${agent}: lockdown`)
    assert.match(guideBlocks({ agent, delegates: false }), NO_FILE_FORM, `${agent}: assembled guide`)
  }
  for (const agent of ["coder", "debugger"]) {
    assert.match(replyCapBlock(agent), FILE_FORM, agent)
    assert.match(resultCeilingPlan(agent), /File the detail under the project AS YOU GO/, agent)
    assert.match(resultCeilingDemand(agent, { canWrite: true }), /put the detail in a file under the project FIRST/, agent)
    assert.match(resultCeilingDemand(agent, { canWrite: false }), /name the absolute path of the file the detail already stands in/, agent)
  }
  // The caller's resolved answer wins over the plugin's map.
  assert.match(replyCapBlock("coder", { holdsWrite: false }), NO_FILE_FORM)
  assert.match(guideBlocks({ agent: "coder", holdsWrite: false }), NO_FILE_FORM)
})

async function systemPromptFor(hooks, sessionID) {
  const out = { system: ["# Role: Base\n\nbase prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system.join("")
}

test("the transform asks the resolved config whether the role holds write", async () => {
  writeSettings({ maxResultTokens: 1500 })
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  ctx.client.config.get = async () => ({
    data: { agent: { coder: { permission: { write: "deny" } } } },
  })
  const hooks = await plugin(ctx)

  upsertSession("ses_coder_nowrite", { agent: "coder", prompt: "task", parentID: "ses_parent", directory: dir })
  upsertSession("ses_debugger_write", { agent: "debugger", prompt: "task", parentID: "ses_parent", directory: dir })

  const coderPrompt = await systemPromptFor(hooks, "ses_coder_nowrite")
  assert.match(coderPrompt, NO_FILE_FORM, "a project that denies write gets the no-file form")
  assert.doesNotMatch(coderPrompt, FILE_FORM)

  const debuggerPrompt = await systemPromptFor(hooks, "ses_debugger_write")
  assert.match(debuggerPrompt, FILE_FORM, "the debugger now holds write and is told to file")
})

// ---- scout and checker -----------------------------------------------------

const WEB_TOOLS = ["webfetch", "websearch", "web_search", "forum_search", "grounded_search"]
const TODO_TOOL_NAMES = ["todos_open", "todo_add", "todo_edit", "todo_done"]

test("the orchestrator routes lookups to the scout and check runs to the checker", () => {
  const { prompt } = AGENTS.orchestrator
  assert.match(prompt, /Available subagents: scout, planner, coder, checker, debugger,/)
  assert.match(prompt, /scout to find code or summarise a file \(where something is, who calls it, what a file does\)/)
  assert.match(prompt, /checker to run tests, lint, type-check or build and report the failures \(name the check, or the command\)/)
  assert.match(prompt, /If you are not sure, ask a scout first\./)
  assert.match(prompt, /Brief a rename or move with its list of sites \(path:line\); a scout lists them first\./)
  assert.doesNotMatch(prompt, /file lookups|use planner/, "lookups no longer go to the planner")
})

test("both roles are spawnable by the orchestrator alone and spawn nothing", () => {
  for (const agent of ["scout", "checker"]) {
    assert.ok(SPAWNABLE_ROLES.includes(agent), `${agent} is a spawn target`)
    assert.equal(AGENTS[agent].permission.spawn, "deny", `${agent} spawns nothing`)
    assert.equal(NESTED_SPAWN_TARGETS[agent], undefined, `${agent} names no nested target`)
    for (const [caller, targets] of Object.entries(NESTED_SPAWN_TARGETS)) {
      assert.ok(!targets.includes(agent), `${caller} may not spawn a ${agent}`)
    }
  }
})

test("both roles hold bash and write for work/, no edit, no web, no TODO tools", () => {
  for (const agent of ["scout", "checker"]) {
    const { permission, prompt } = AGENTS[agent]
    assert.equal(permission.bash, undefined, `${agent}: bash is granted by absence`)
    assert.equal(permission.write, undefined, `${agent}: write is granted by absence`)
    assert.equal(roleHoldsWrite(agent), true, agent)
    assert.equal(permission.edit, "deny", `${agent} edits no file`)
    for (const tool of [...WEB_TOOLS, ...TODO_TOOL_NAMES]) {
      assert.equal(permission[tool], "deny", `${agent} denies ${tool}`)
    }
    assert.match(prompt, /Leave existing files as they are\./, agent)
    assert.match(prompt, /write it to one file under `work\/` and name that path\./, agent)
    assert.doesNotMatch(prompt, /todos_open|todo_add/, `${agent} is told nothing about TODO.md`)
  }
})

test("the scout replies path:line with the quoted line, or a summary of at most 10 lines", () => {
  const { prompt } = AGENTS.scout
  assert.match(prompt, /where something is, who calls it, what a file or function does/)
  assert.match(prompt, /one line per finding, `path:line — <the line, quoted>`/)
  assert.match(prompt, /a summary: at most 10 lines, with the `path:line` it rests on/)
  assert.equal(AGENTS.scout.permission.outline, undefined, "the scout holds outline")
  assert.ok(!OUTLINE_DISABLED_AGENTS.has("scout"))
  const guide = guideBlocks({ agent: "scout", delegates: false, codegraph: "codegraph" })
  assert.match(guide, /reading discipline/, "the scout gets the outline block")
  assert.match(guide, /code search/, "and the codegraph card")
})

test("the checker reports command, exit code, counts and each failing item", () => {
  const { prompt } = AGENTS.checker
  assert.match(prompt, /`Check: <command> — exit <code> — <p> pass, <f> fail, <s> skipped`/)
  assert.match(prompt, /one line per failing item: `<path:line or test name> — <first error line>`/)
  assert.match(prompt, /Run each check once\. A failure is a finding for your reply; the fix goes to another role\./)
  assert.match(prompt, /take the command from AGENTS\.md or the project's scripts/)
  assert.equal(AGENTS.checker.permission.outline, "deny")
  assert.ok(OUTLINE_DISABLED_AGENTS.has("checker"))
  const guide = guideBlocks({ agent: "checker", delegates: false, codegraph: "codegraph" })
  assert.doesNotMatch(guide, /reading discipline|code search/, "the checker gets no code-reading block")
})

// opencode's system string: role prompt, model boilerplate, <env>, then the
// AGENTS.md inject — the three markers the transform splits on.
function opencodeSystemWithAgentsMd() {
  return (
    "# Role: Base\nbase prompt\n\n" +
    "You are powered by the model named test. The exact model ID is p/test\n" +
    "Here is some useful information about the environment you are running in:\n" +
    "<env>\n  Working directory: /tmp/proj\n</env>\n" +
    "Instructions from: /tmp/proj/AGENTS.md\nRun the suite with make check-all.\n"
  )
}

test("the checker keeps AGENTS.md for the check commands; the scout does not", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_checker", { agent: "checker", prompt: "run the tests", parentID: "ses_parent", directory: dir })
  upsertSession("ses_scout", { agent: "scout", prompt: "where is x", parentID: "ses_parent", directory: dir })

  const checkerOut = { system: [opencodeSystemWithAgentsMd()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_checker" }, checkerOut)
  assert.match(checkerOut.system.join(""), /make check-all/)

  const scoutOut = { system: [opencodeSystemWithAgentsMd()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_scout" }, scoutOut)
  assert.doesNotMatch(scoutOut.system.join(""), /make check-all/)
})
