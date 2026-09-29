// The `verifier`: runs a built artefact where it really runs, looks at what it
// renders and judges it — its map, its prompt, the orchestrator's routing to
// it, and the no-vision line a verifier on a model without image input gets in
// its system prompt, plus the sidebar's note for the same case.
//
// LOG_PATH is read at module load (src/log.js), so the debug log is redirected
// before the first dynamic import; the no-vision line is logged once per entry.
//
// Run: node --test test/verifier-role.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const logFile = join(mkdtempSync(join(tmpdir(), "intercom-verifier-log-")), "debug.log")
process.env.OPENCODE_AGENT_INTERCOM_DEBUG_LOG = logFile
process.env.OPENCODE_AGENT_INTERCOM_DEBUG = "1"

const { default: plugin } = await import("../src/index.js")
const { upsertSession } = await import("../src/registry.js")
const { AGENTS, NESTED_SPAWN_TARGETS, SPAWNABLE_ROLES, VISION_ROLES, mayDelegate, roleHoldsWrite } =
  await import("../src/agents.js")
const { AGENTS_MD_SUBAGENTS } = await import("../src/hooks.js")
const { HAS_AGENTS_MD, renderDefaultsFile } = await import("../src/promptsfile.js")
const { guideBlocks, OUTLINE_DISABLED_AGENTS, VERIFIER_NO_VISION_LINE } = await import("../src/prompts.js")
const { newProject, cleanupProjects, resetPromptFileState, makeCtx } = await import("./helpers/prompt-files.js")
const { VISION_ROLES: TUI_VISION_ROLES, visionNote } = await import("../tui/src/agent-roles.ts")

after(cleanupProjects)
beforeEach(resetPromptFileState)

const WEB_TOOLS = ["webfetch", "websearch", "web_search", "forum_search", "grounded_search"]
const TODO_TOOL_NAMES = ["todos_open", "todo_add", "todo_edit", "todo_done"]

function logLines(needle) {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, "utf8").split("\n").filter((line) => line.includes(needle))
}

function opencodeSystemWithAgentsMd() {
  return (
    "# Role: Base\nbase prompt\n\n" +
    "You are powered by the model named test. The exact model ID is p/test\n" +
    "Here is some useful information about the environment you are running in:\n" +
    "<env>\n  Working directory: /tmp/proj\n</env>\n" +
    "Instructions from: /tmp/proj/AGENTS.md\nServe it with make serve.\n"
  )
}

function model(image) {
  return { id: "m1", providerID: "p1", capabilities: { input: { text: true, image } } }
}

async function transformFor(hooks, sessionID, input = {}) {
  const out = { system: [opencodeSystemWithAgentsMd()] }
  await hooks["experimental.chat.system.transform"]({ sessionID, ...input }, out)
  return out.system
}

// ---- the role --------------------------------------------------------------

test("the verifier is a hidden subagent that holds bash, read and write and denies edit, outline, spawn, web and TODO tools", () => {
  const { mode, hidden, permission, description } = AGENTS.verifier
  assert.equal(mode, "subagent")
  assert.equal(hidden, true)
  assert.ok(SPAWNABLE_ROLES.includes("verifier"))
  for (const tool of ["bash", "read", "write"]) {
    assert.equal(permission[tool], undefined, `verifier: ${tool} is granted by absence`)
  }
  assert.equal(roleHoldsWrite("verifier"), true)
  for (const tool of ["edit", "outline", "spawn", ...WEB_TOOLS, ...TODO_TOOL_NAMES]) {
    assert.equal(permission[tool], "deny", `verifier denies ${tool}`)
  }
  assert.equal(mayDelegate("verifier"), false)
  assert.equal(NESTED_SPAWN_TARGETS.verifier, undefined, "the verifier names no nested target")
  for (const [caller, targets] of Object.entries(NESTED_SPAWN_TARGETS)) {
    assert.ok(!targets.includes("verifier"), `${caller} may not spawn a verifier`)
  }
  assert.match(description, /Named test, lint and build commands are the checker's\./)
})

test("the installed verifier map keeps bash, read and write and carries the forced spawn deny", async () => {
  const { ctx } = makeCtx(newProject())
  const hooks = await plugin(ctx)
  const config = {}
  await hooks.config(config)
  const installed = config.agent.verifier.permission
  for (const tool of ["bash", "read", "write"]) {
    assert.equal(installed[tool], undefined, `installed verifier holds ${tool}`)
  }
  assert.equal(installed.edit, "deny")
  assert.equal(installed.outline, "deny")
  assert.equal(installed.spawn, "deny")
})

test("the verifier's prompt runs the artefact with pw, reads each screenshot and answers per check", () => {
  const { prompt } = AGENTS.verifier
  assert.match(prompt, /^# Role: Verifier \(Subagent\)/)
  assert.match(prompt, /Run it where it really runs: a web page in a browser, a program as the binary, a package as installed\./)
  assert.match(prompt, /A check you can only run through a test runner or a stub is a checker's: mark it NOT RUN, reason: checker\./)
  assert.match(prompt, /pw start, pw goto <url>, pw console, pw screenshot work\/verify-<time>\/<name>\.png, pw stop\./)
  assert.match(prompt, /Run pw with the environment as you find it, and use only the tools already installed here\./)
  assert.match(
    prompt,
    /When pw start fails, that is the result of every browser check: write each one NOT RUN at once, with pw's error line as the reason, and go on to the next check\./,
  )
  assert.match(prompt, /Right after each screenshot, read the image file and write down what you see\./)
  assert.match(prompt, /Leave existing files as they are\. Stop every process and browser you started before you reply\./)
  assert.match(prompt, /- PASS: you ran it and saw the expected result\./)
  assert.match(prompt, /- FAIL: you ran it and saw something else\./)
  assert.match(prompt, /- NOT RUN: you could not run it or could not see the result; give the reason\./)
  assert.match(prompt, /first line `Checks: <n> — <p> pass, <f> fail, <r> not run`, then one line per check\./)
  assert.doesNotMatch(prompt, /Put every file/, "write carries no path rule")
})

test("VISION_ROLES is the verifier, a spawnable role, and the TUI carries the same list", () => {
  assert.deepEqual([...VISION_ROLES], ["verifier"])
  for (const role of VISION_ROLES) assert.ok(SPAWNABLE_ROLES.includes(role), role)
  assert.deepEqual([...TUI_VISION_ROLES], [...VISION_ROLES])
})

test("the verifier reads no code but keeps AGENTS.md, live and in its prompt file", async () => {
  assert.ok(OUTLINE_DISABLED_AGENTS.has("verifier"))
  const guide = guideBlocks({ agent: "verifier", delegates: false, codegraph: "codegraph" })
  assert.doesNotMatch(guide, /reading discipline|codegraph/, "no outline block and no codegraph card")
  assert.ok(AGENTS_MD_SUBAGENTS.has("verifier"))
  assert.ok(HAS_AGENTS_MD.has("verifier"))
  assert.match(renderDefaultsFile("verifier"), /\{\{agents_md\}\}/)

  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_verifier_md", { agent: "verifier", prompt: "check the page", parentID: "ses_parent", directory: dir })
  const system = await transformFor(hooks, "ses_verifier_md", { model: model(true) })
  assert.match(system.join(""), /make serve/)
})

test("a verifier's write outside work/ passes the guard", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_verifier_write", { agent: "verifier", prompt: "check it", parentID: "ses_parent", directory: dir })
  for (const filePath of [join(dir, "harness", "serve.sh"), join(dir, "shots", "page.png"), "/tmp/verify-elsewhere.txt"]) {
    await assert.doesNotReject(
      () => hooks["tool.execute.before"](
        { tool: "write", sessionID: "ses_verifier_write", callID: `w-${filePath}` },
        { args: { filePath, content: "x" } },
      ),
      filePath,
    )
  }
})

// ---- the orchestrator's routing --------------------------------------------

test("the orchestrator routes a runtime check to the verifier and holds a release behind its PASS", () => {
  const { prompt } = AGENTS.orchestrator
  assert.match(prompt, /Available subagents: .*\bchecker, verifier, debugger\b/)
  assert.match(prompt, /verifier to run a built artefact where it really runs and look at the result/)
  assert.match(prompt, /A change that shows only at runtime is done when a verifier reports PASS for it\./)
  assert.match(prompt, /→ checker → verifier where the change shows at runtime → reviewer →/)
  assert.match(prompt, /; release: verifier → releaser\./)
  assert.match(prompt, /Start a releaser when no coder, debugger or other releaser runs in the same project, and after the verifier's PASS where there is one\./)
  assert.match(AGENTS.refuter.prompt, /name who checks it: verifier for runtime, researcher for the web\./)
})

// ---- the no-vision line ----------------------------------------------------

test("a verifier on a model without image input gets the no-vision line as its own element, logged once", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_verifier_blind", { agent: "verifier", prompt: "check it", parentID: "ses_parent", directory: dir })

  const first = await transformFor(hooks, "ses_verifier_blind", { model: model(false) })
  assert.ok(first.includes(VERIFIER_NO_VISION_LINE), "its own element")
  assert.equal(first.indexOf(VERIFIER_NO_VISION_LINE), 1, "right after the role's blocks")
  const second = await transformFor(hooks, "ses_verifier_blind", { model: model(false) })
  assert.ok(second.includes(VERIFIER_NO_VISION_LINE), "still there on the next turn")
  assert.deepEqual(second, first, "the same bytes on every turn")

  const logged = logLines("vision role on non-vision model").filter((line) => line.includes("ses_verifier_blind"))
  assert.equal(logged.length, 1)
  assert.match(logged[0], /"agent":"verifier"/)
  assert.match(logged[0], /"model":"p1\/m1"/)
})

test("a verifier on a model with image input gets no no-vision line", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_verifier_sees", { agent: "verifier", prompt: "check it", parentID: "ses_parent", directory: dir })
  const system = await transformFor(hooks, "ses_verifier_sees", { model: model(true) })
  assert.ok(!system.includes(VERIFIER_NO_VISION_LINE))
})

test("a verifier whose request names no model gets the no-vision line", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_verifier_nomodel", { agent: "verifier", prompt: "check it", parentID: "ses_parent", directory: dir })
  const system = await transformFor(hooks, "ses_verifier_nomodel")
  assert.ok(system.includes(VERIFIER_NO_VISION_LINE))
})

test("a coder on a model without image input gets no no-vision line", async () => {
  const dir = newProject()
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_coder_blind", { agent: "coder", prompt: "change it", parentID: "ses_parent", directory: dir })
  const system = await transformFor(hooks, "ses_coder_blind", { model: model(false) })
  assert.ok(!system.includes(VERIFIER_NO_VISION_LINE))
  assert.equal(logLines("vision role on non-vision model").filter((line) => line.includes("ses_coder_blind")).length, 0)
})

// ---- the sidebar note ------------------------------------------------------

test("the model row notes a verifier on a model that cannot see, and nothing else", () => {
  assert.equal(visionNote("verifier", "-"), "needs a vision model (V)")
  assert.equal(visionNote("verifier", "V"), "")
  assert.equal(visionNote("verifier", "?"), "", "an unknown model gets no note")
  assert.equal(visionNote("verifier", " "), "", "no model gets no note")
  assert.equal(visionNote("coder", "-"), "")
})
