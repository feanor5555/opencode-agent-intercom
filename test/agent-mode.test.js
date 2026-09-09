// The agent-mode switch: `agentMode` in the settings file, values
// "orchestrator" (the shipped delegation pattern) and "solo" (one agent that
// does the work itself), env override OPENCODE_AGENT_INTERCOM_AGENT_MODE.
//
// Two halves are pinned here.
//
// 1. The resolution. File > env > "orchestrator", the order every other key
//    uses, with one difference: the value is a WORD, matched exactly, so
//    anything naming no mode is not used and the level below it stands. The
//    sidebar reads the same file with its own copy of that predicate
//    (tui/src/agent-mode.ts), and the two acceptance rules are pinned against
//    each other below. The answer is LATCHED at
//    the first read (settings.js `soloModeActive`) exactly as retention is,
//    because two of the things it decides — the tool map and the agent
//    config — are settled once, when opencode bootstraps the instance. A
//    settings edit mid-process therefore changes nothing until a restart.
//
// 2. The five places the mode is a branch, each reading that one latched
//    answer and no copy of the logic:
//      - src/agents.js  installAgents      — the primary's deny map, its role
//                                            prompt and its description,
//      - src/tools.js   createTools        — spawn / abort / list / reuse,
//      - src/hooks.js   guardToolExecute   — the primary-side runtime guard,
//      - src/prompts.js guideBlocks        — the injected orchestration guide,
//      - src/settings.js endlessModeInEffect — endless mode, which counts as off
//                                            in solo mode because its cycle
//                                            starts a subagent of its own.
//    Two files that only DESCRIBE what the primary gets follow the same
//    answer: src/promptsfile.js renders the reference and blank-slate prompt
//    files, and src/hooks.js builds the injected limits block.
//    What must NOT change with the mode is pinned beside each: opencode's
//    native `task` stays denied to the primary on both branches, the subagent
//    roles keep their maps, the subagent-side `task` deny stays unconditional,
//    and the subagent guide blocks are untouched.
//
// Run: node --test test/agent-mode.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AGENT_MODE_ORCHESTRATOR,
  AGENT_MODE_SOLO,
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  getSettings,
  soloModeActive,
  setSettingsPath,
  resetSettings,
  dropSettingsCacheKeepingLatch,
} from "../src/settings.js"
import {
  AGENTS,
  SOLO_PRIMARY_PERMISSION,
  SOLO_PRIMARY_DESCRIPTION,
  installAgents,
  rolePrompt,
  roleDescription,
} from "../src/agents.js"
import { renderDefaultsFile, renderOpencodeDefaultFile } from "../src/promptsfile.js"
import { createTools } from "../src/tools.js"
import { createGuardToolExecute, resolvePrimaryAgent } from "../src/hooks.js"
import { endlessModeInEffect, primaryContextThreshold } from "../src/settings.js"
import { guideBlocks, ORCHESTRATION_GUIDE, SUBAGENT_GUIDE_CORE } from "../src/prompts.js"
import { resetState, registry, bySession } from "../src/state.js"
// The sidebar's own copy of the two values: a separate npm package that cannot
// import this plugin, so the two are pinned against each other here rather than
// left to drift over the file they share.
import {
  AGENT_MODES as TUI_AGENT_MODES,
  DEFAULT_AGENT_MODE as TUI_DEFAULT_AGENT_MODE,
  isAgentMode as tuiIsAgentMode,
} from "../tui/src/agent-mode.ts"

const ENV_NAME = "OPENCODE_AGENT_INTERCOM_AGENT_MODE"
const PRIMARY = "ses_primary"
const SUBAGENT = "ses_sub"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-agent-mode-"))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  delete process.env[ENV_NAME]
  rmSync(settingsFile, { force: true })
  resetState()
  resetSettings()
})

// The settings this process is LOADED with: the file is written and both
// latches are dropped, so the next read decides the mode afresh.
function loadWith(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

// Load in solo mode and take the latch, so every branch point below sees the
// answer a solo-mode process really has.
function loadSolo() {
  loadWith({ agentMode: AGENT_MODE_SOLO })
  assert.equal(soloModeActive(), true)
}

// ---- 1. resolution ----------------------------------------------------------

test("with neither file nor env the mode is the orchestrator pattern", () => {
  assert.equal(DEFAULT_AGENT_MODE, AGENT_MODE_ORCHESTRATOR)
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR)
  assert.equal(soloModeActive(), false)
})

test("the env var selects the mode", () => {
  process.env[ENV_NAME] = AGENT_MODE_SOLO
  resetSettings()
  assert.equal(getSettings().agentMode, AGENT_MODE_SOLO)
  assert.equal(soloModeActive(), true)
})

test("the file selects the mode", () => {
  loadWith({ agentMode: AGENT_MODE_SOLO })
  assert.equal(getSettings().agentMode, AGENT_MODE_SOLO)
  assert.equal(soloModeActive(), true)
})

test("the file wins over the env var", () => {
  process.env[ENV_NAME] = AGENT_MODE_SOLO
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR })
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR)
  assert.equal(soloModeActive(), false)
})

test("a value naming no mode is not used — the level below it stands", () => {
  // File alone: nothing below it but the default.
  loadWith({ agentMode: "swarm" })
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR)

  // A non-string in the file is the same case.
  loadWith({ agentMode: 3 })
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR)

  // Env alone.
  process.env[ENV_NAME] = "swarm"
  loadWith({})
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR)

  // A bad FILE value leaves the env-or-default resolution standing, the
  // discipline every other key in this module uses for a bad value.
  loadWith({ agentMode: "swarm" })
  process.env[ENV_NAME] = AGENT_MODE_SOLO
  resetSettings()
  assert.equal(getSettings().agentMode, AGENT_MODE_SOLO)
})

test("the file value is matched exactly — the sidebar accepts exactly these two", () => {
  // The panel reads the same file with the same predicate (isAgentMode,
  // tui/src/agent-mode.ts) and takes those two strings alone. A value only one
  // of the two sides accepted would show one mode in the panel and run the
  // other.
  for (const value of ["Solo", "SOLO", " solo", "solo ", "solo\n"]) {
    loadWith({ agentMode: value })
    assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR, JSON.stringify(value))
    assert.equal(tuiIsAgentMode(value), false, `the sidebar refuses ${JSON.stringify(value)} too`)
  }
  for (const value of [AGENT_MODE_ORCHESTRATOR, AGENT_MODE_SOLO]) {
    loadWith({ agentMode: value })
    assert.equal(getSettings().agentMode, value)
    assert.equal(tuiIsAgentMode(value), true)
  }
})

test("the plugin and the sidebar agree on the default mode", () => {
  assert.equal(DEFAULT_AGENT_MODE, TUI_DEFAULT_AGENT_MODE)
  assert.deepEqual([...AGENT_MODES], [...TUI_AGENT_MODES])
})

test("the env var is trimmed — no second reader of it exists to disagree", () => {
  process.env[ENV_NAME] = ` ${AGENT_MODE_SOLO} `
  resetSettings()
  assert.equal(getSettings().agentMode, AGENT_MODE_SOLO)

  process.env[ENV_NAME] = "SOLO"
  resetSettings()
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR, "the words are matched exactly")
})

test("the mode is latched: a settings edit takes effect only after a restart", () => {
  loadSolo()

  // The user's live edit: the file moves, the latch does not.
  writeFileSync(settingsFile, JSON.stringify({ agentMode: AGENT_MODE_ORCHESTRATOR }))
  dropSettingsCacheKeepingLatch()
  assert.equal(getSettings().agentMode, AGENT_MODE_ORCHESTRATOR, "the raw value follows the file")
  assert.equal(soloModeActive(), true, "the mode in effect needs an opencode restart")

  // The restart: a fresh process reads the file and decides again.
  resetSettings()
  assert.equal(soloModeActive(), false)
})

// ---- 2a. the primary's deny map (src/agents.js) ------------------------------

function installedPermission(agent) {
  const config = { agent: {} }
  installAgents(config, { directory: fixtureDir, worktree: fixtureDir })
  return config.agent[agent].permission
}

test("orchestrator mode: the primary is denied every working tool", () => {
  const permission = installedPermission("orchestrator")
  assert.deepEqual(permission, AGENTS.orchestrator.permission)
  for (const tool of ["read", "edit", "bash", "outline", "glob", "grep", "task", "todo_add"]) {
    assert.equal(permission[tool], "deny", `${tool} must stay denied in the orchestrator pattern`)
  }
})

test("solo mode: the primary keeps its tools and is denied `task` alone", () => {
  loadSolo()
  const permission = installedPermission("orchestrator")
  assert.deepEqual(permission, { ...SOLO_PRIMARY_PERMISSION })
  assert.equal(permission.task, "deny", "a second agent is the one thing solo mode cannot afford")
  for (const tool of [
    "read",
    "edit",
    "bash",
    "outline",
    "glob",
    "grep",
    "todos_open",
    "todo_done",
    "todo_add",
    "todo_edit",
    "webfetch",
    "websearch",
    "web_search",
    "forum_search",
    "grounded_search",
  ]) {
    assert.equal(permission[tool], undefined, `${tool} must not be denied in solo mode`)
  }
})

test("solo mode changes nothing about the subagent roles", () => {
  loadSolo()
  for (const [name, def] of Object.entries(AGENTS)) {
    if (def.mode === "primary") continue
    assert.deepEqual(installedPermission(name), def.permission, `${name} keeps its own deny map`)
  }
})

// ---- 2b. the tool map (src/tools.js) -----------------------------------------

const ORCHESTRATION_TOOLS = ["spawn", "abort", "list", "reuse"]

function toolNames() {
  return Object.keys(
    createTools({ client: {}, directory: fixtureDir, permissionGuard: null }),
  )
}

test("orchestrator mode: the primary gets the orchestration tools", () => {
  const names = toolNames()
  for (const tool of ["spawn", "abort", "list"]) assert.ok(names.includes(tool), tool)
  assert.ok(!names.includes("reuse"), "retention is off by default")
})

test("solo mode: none of the four orchestration tools is registered", () => {
  loadSolo()
  const names = toolNames()
  for (const tool of ORCHESTRATION_TOOLS) {
    assert.ok(!names.includes(tool), `${tool} must not exist in solo mode`)
  }
  // The rest of the tool map is untouched — the primary works with it.
  for (const tool of ["todos_open", "todo_done", "todo_add", "todo_edit"]) {
    assert.ok(names.includes(tool), tool)
  }
})

test("solo mode leaves out `reuse` even where retention is switched on", () => {
  loadWith({ agentMode: AGENT_MODE_SOLO, maxRetainedSubagents: 3 })
  const names = toolNames()
  for (const tool of ORCHESTRATION_TOOLS) {
    assert.ok(!names.includes(tool), `${tool} must not exist in solo mode`)
  }
})

// ---- 2c. the runtime guard (src/hooks.js) ------------------------------------

const guardOf = () => createGuardToolExecute({}, null)

async function refusal(guard, tool, sessionID = PRIMARY) {
  try {
    await guard({ tool, sessionID, callID: `c_${tool}` })
  } catch (err) {
    return err?.message ?? String(err)
  }
  return ""
}

// A tracked subagent, put into the registry by hand: nothing spawns in solo
// mode, and the deny this pins has to hold for a subagent however it got there.
function trackSubagent(agent = "planner") {
  const entry = {
    handle: `${agent}#1`,
    agent,
    sessionID: SUBAGENT,
    toolCalls: new Map(),
    lastActivityAt: Date.now(),
  }
  registry.set(entry.handle, entry)
  bySession.set(SUBAGENT, entry.handle)
}

test("orchestrator mode: the primary is refused every non-orchestration tool", async () => {
  const guard = guardOf()
  assert.match(await refusal(guard, "read"), /this is an orchestrator session/)
  assert.match(await refusal(guard, "task"), /this is an orchestrator session/)
  assert.equal(await refusal(guard, "spawn"), "", "the orchestration tools pass")
})

test("solo mode: the primary's own tools pass the guard", async () => {
  loadSolo()
  const guard = guardOf()
  for (const tool of ["read", "edit", "bash", "glob", "grep", "outline", "todo_add"]) {
    assert.equal(await refusal(guard, tool), "", `${tool} must pass in solo mode`)
  }
})

test("solo mode: the primary is still refused opencode's native `task`", async () => {
  loadSolo()
  const message = await refusal(guardOf(), "task")
  assert.match(message, /solo mode runs one agent/)
  assert.doesNotMatch(message, /this is an orchestrator session/)
})

test("solo mode leaves the subagent-side `task` deny exactly as it is", async () => {
  loadSolo()
  trackSubagent()
  const message = await refusal(guardOf(), "task", SUBAGENT)
  assert.match(message, /a subagent cannot spawn other agents/)
})

// ---- 2d. the injected guide (src/prompts.js) ---------------------------------

test("orchestrator mode: the primary is given the orchestration protocol", () => {
  assert.equal(guideBlocks({ primary: true }), ORCHESTRATION_GUIDE)
})

test("solo mode: the primary is given no guide at all", () => {
  loadSolo()
  assert.equal(guideBlocks({ primary: true }), "")
  // Retention cannot put a block back that the mode took out: the `reuse` tool
  // does not exist in solo mode either.
  assert.equal(guideBlocks({ primary: true, retention: true }), "")
})

test("solo mode changes nothing about the subagent guide blocks", () => {
  const before = guideBlocks({ agent: "coder", delegates: false })
  loadSolo()
  assert.equal(guideBlocks({ agent: "coder", delegates: false }), before)
  assert.ok(before.startsWith(SUBAGENT_GUIDE_CORE))
})

// ---- 2e. the primary's role prompt (src/agents.js) ---------------------------

// What the solo primary is told, as installAgents installs it.
const soloPrompt = () => rolePrompt("orchestrator")

test("orchestrator mode: the primary is given the orchestration prompt", () => {
  assert.equal(soloPrompt(), AGENTS.orchestrator.prompt)
  assert.equal(roleDescription("orchestrator"), AGENTS.orchestrator.description)
  assert.match(soloPrompt(), /Your only job is to delegate work to subagents/)
})

test("solo mode: the primary is given a prompt that says it works alone", () => {
  loadSolo()
  const prompt = soloPrompt()
  assert.match(prompt, /^# Role: Solo\n/)
  assert.match(prompt, /You do the work yourself, with your own tools\./)
  assert.match(prompt, /There are no subagents and nothing to delegate to\./)
})

test("solo mode: nothing false about delegation survives in the primary's prompt", () => {
  loadSolo()
  const prompt = soloPrompt()
  // The three statements the orchestration prompt makes that solo mode
  // falsifies: the job IS delegation, the tools ARE spawn/abort/list, and there
  // is a fleet to pick from.
  assert.doesNotMatch(prompt, /only job is to delegate/)
  assert.doesNotMatch(prompt, /spawn|abort\b|\blist\b/i)
  for (const role of Object.keys(AGENTS)) {
    if (role === "orchestrator") continue
    assert.doesNotMatch(prompt, new RegExp(role, "i"), `${role} is not offered in solo mode`)
  }
})

test("solo mode: the prompt says what is true and adds no method beyond it", () => {
  loadSolo()
  const body = soloPrompt().split("\n").filter((line) => line.trim() !== "")
  assert.equal(body.length, 2, "a header and one sentence — the orchestrator one is not replaced by a longer one")
  assert.ok(
    soloPrompt().length < AGENTS.orchestrator.prompt.length,
    "the solo prompt is at most as long as the orchestrator one",
  )
})

test("solo mode: the installed entry carries the solo prompt and description", () => {
  loadSolo()
  const config = { agent: {} }
  installAgents(config, { directory: fixtureDir, worktree: fixtureDir })
  assert.equal(config.agent.orchestrator.prompt, soloPrompt())
  assert.equal(config.agent.orchestrator.description, SOLO_PRIMARY_DESCRIPTION)
  assert.doesNotMatch(
    config.agent.orchestrator.description,
    /Orchestrates only|Delegates to subagents/,
    "the shipped description is the opposite of what a solo primary does",
  )
})

test("solo mode changes no subagent's prompt or description", () => {
  loadSolo()
  const config = { agent: {} }
  installAgents(config, { directory: fixtureDir, worktree: fixtureDir })
  for (const [name, def] of Object.entries(AGENTS)) {
    if (def.mode === "primary") continue
    assert.equal(config.agent[name].prompt, def.prompt, `${name} keeps its prompt`)
    assert.equal(config.agent[name].description, def.description, `${name} keeps its description`)
  }
})

test("the solo prompt's header still identifies the primary by its own name", () => {
  // Rung 2 of the primary identification chain reads the `# Role:` header, and
  // the name it yields selects the prompt-template file. Solo mode replaces the
  // PROMPT and leaves the role's name alone, so the header must not resolve to
  // a "solo" agent — there is none.
  loadSolo()
  assert.equal(
    resolvePrimaryAgent("ses_unseen_solo", { system: [soloPrompt()] }),
    "orchestrator",
  )
})

// ---- 2f. the reference files (src/promptsfile.js) ----------------------------

// The guide-block line of the opencode-defaults reference file.
const guideNote = (agent) =>
  /\n {2}- (?:the agent-intercom guide block \(([^)]+)\) appended by the plugin|no agent-intercom guide block[^\n]*)/.exec(
    renderOpencodeDefaultFile(agent),
  )?.[0] ?? ""

test("orchestrator mode: the reference file names the guide the primary really gets", () => {
  assert.match(guideNote("orchestrator"), /agent-intercom guide block \(ORCHESTRATION_GUIDE\)/)
  assert.match(renderDefaultsFile("orchestrator"), /Your only job is to delegate/)
})

test("solo mode: the reference files name no guide block and carry the solo prompt", () => {
  loadSolo()
  // guideBlocks returns "" for a solo primary, so there is no block to name.
  assert.match(guideNote("orchestrator"), /no agent-intercom guide block/)
  assert.doesNotMatch(guideNote("orchestrator"), /ORCHESTRATION_GUIDE/)
  for (const render of [renderDefaultsFile, renderOpencodeDefaultFile]) {
    const file = render("orchestrator")
    assert.match(file, /# Role: Solo/)
    assert.doesNotMatch(file, /Your only job is to delegate/)
  }
})

test("solo mode leaves every subagent's reference file exactly as it was", () => {
  const before = Object.keys(AGENTS)
    .filter((a) => a !== "orchestrator")
    .map((a) => [a, renderOpencodeDefaultFile(a), renderDefaultsFile(a)])
  loadSolo()
  for (const [agent, reference, defaults] of before) {
    assert.equal(renderOpencodeDefaultFile(agent), reference, `${agent} reference file`)
    assert.equal(renderDefaultsFile(agent), defaults, `${agent} blank-slate file`)
  }
})

// ---- 2g. endless mode (src/settings.js) --------------------------------------

test("solo mode: endless mode counts as off however the switch stands", () => {
  loadWith({ agentMode: AGENT_MODE_SOLO, endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  assert.equal(getSettings().endlessMode, true, "the user's switch is not written")
  assert.equal(endlessModeInEffect(), false, "its cycle would start a subagent")
  assert.equal(
    primaryContextThreshold(),
    80000,
    "the plain handoff owns the threshold, as it does with the mode off",
  )
})

test("orchestrator mode leaves the switch in charge", () => {
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR, endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  assert.equal(endlessModeInEffect(), true)
  assert.equal(primaryContextThreshold(), 250000)
})
