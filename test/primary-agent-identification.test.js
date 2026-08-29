// Unit tests for the primary-agent identification chain (concept step 1).
//
// A primary session has no registry entry, so its agent name has to be
// resolved. The chain in hooks.js is, most authoritative first:
//
//   1. what the `chat.message` hook recorded for the session
//   2. the `# Role:` header of the prompt this plugin wrote
//   3. the `default_agent` captured at the `config` hook
//
// The old code had rungs 2 and a literal `"orchestrator"` only, so a project
// whose primary is called something else was mis-identified — and a project
// markdown file that displaces the plugin's prompt removed rung 2 as well,
// which the literal then masked.
//
// Run: node --test test/primary-agent-identification.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, sessionAgent } from "../src/state.js"
import { resolvePrimaryAgent, resetTurnNotices } from "../src/hooks.js"
import { recordSessionAgent, sessionAgentName, forgetPrimary } from "../src/registry.js"
import { installAgents, defaultAgentName, DEFAULT_AGENT } from "../src/agents.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetProjectContext } from "../src/project.js"
import { PROMPT_CONTRACT } from "../src/prompts.js"
import { CONTRACT_STAMP_KEY } from "../src/overrides.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-agentid-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
// Keep the dev machine's real ~/.config/opencode/agent-intercom.json out of the
// transform path.
setSettingsPath(join(fixtureDir, "agent-intercom.json"))

// Per-agent prompt templates, so the transform test can prove WHICH file the
// resolved name picks.
//
// `orchestrator.md` carries a current contract stamp in its header comment:
// it is one of the plugin's own roles, so the prompt-file scan (detector B)
// reads it, and a bare template would be reported as predating the contract —
// which would append the override block to the prompt asserted below. The
// comment is stripped before the prompt is assembled, so the file still
// substitutes to its one line. `build.md` needs none: the scan covers the
// plugin's nine roles and `build` is not one of them.
const promptsDir = join(fixtureDir, ".opencode", "agent-intercom")
mkdirSync(promptsDir, { recursive: true })
writeFileSync(
  join(promptsDir, "orchestrator.md"),
  `<!-- ${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT} -->\nTEMPLATE FOR ORCHESTRATOR`,
)
writeFileSync(join(promptsDir, "build.md"), "TEMPLATE FOR BUILD")

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetSettings()
})

function makeCtx() {
  const client = {
    session: {
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { client, directory: fixtureDir, worktree: fixtureDir, project: {} }
}

// A system prompt as opencode hands it over when the plugin's own role prompt
// is intact, and one as it looks after a project `.opencode/agent/<name>.md`
// has displaced that prompt (no `# Role:` header left).
const withHeader = () => ({ system: ["# Role: Orchestrator\n\nsome prompt body"] })
const displaced = () => ({ system: ["You are build, a helpful assistant."] })

test("rung 1: the name recorded by chat.message wins over the role header", () => {
  recordSessionAgent("ses_a", "build")
  assert.equal(
    resolvePrimaryAgent("ses_a", withHeader()),
    "build",
    "the name opencode resolved beats a header the plugin wrote",
  )
})

test("rung 1 survives a displaced role prompt — no header, still the right name", () => {
  // This is the defect: detectAgentFromSystem returned null here and the old
  // `?? \"orchestrator\"` literal hid it.
  recordSessionAgent("ses_b", "build")
  assert.equal(resolvePrimaryAgent("ses_b", displaced()), "build")
})

test("rung 2: with no chat.message record the header still identifies the agent", () => {
  assert.equal(resolvePrimaryAgent("ses_unseen", withHeader()), "orchestrator")
  assert.equal(
    resolvePrimaryAgent("ses_unseen", { system: ["# Role: Coder (Subagent)"] }),
    "coder",
    "the header is lowercased and cut at the first word",
  )
})

test("rung 3: with neither record nor header the captured default_agent answers", () => {
  // Nothing has run the config hook in this test process yet, so the plugin's
  // own default stands — and that is the value installAgents would write.
  assert.equal(defaultAgentName(), DEFAULT_AGENT)
  assert.equal(resolvePrimaryAgent("ses_c", displaced()), DEFAULT_AGENT)

  // A project that names its own primary is captured at the config hook, and
  // the chain's last rung reports THAT instead of the literal.
  const config = { default_agent: "build" }
  installAgents(config)
  assert.equal(config.default_agent, "build", "an explicit default_agent is respected")
  assert.equal(defaultAgentName(), "build")
  assert.equal(resolvePrimaryAgent("ses_c", displaced()), "build")
})

test("installAgents writes and captures the plugin's default when the project set none", () => {
  const config = {}
  installAgents(config)
  assert.equal(config.default_agent, DEFAULT_AGENT)
  assert.equal(defaultAgentName(), DEFAULT_AGENT)
})

test("the chat.message hook records the turn's agent for the session", async () => {
  const hooks = await plugin(makeCtx())
  await hooks["chat.message"](
    { sessionID: "ses_d", agent: "build" },
    { message: { id: "m1", agent: "build" }, parts: [] },
  )
  assert.equal(sessionAgentName("ses_d"), "build")

  // opencode leaves `input.agent` optional; the name it stamped on the user
  // message it just created is the fallback, exactly as the model choice reads it.
  await hooks["chat.message"](
    { sessionID: "ses_e" },
    { message: { id: "m2", agent: "orchestrator" }, parts: [] },
  )
  assert.equal(sessionAgentName("ses_e"), "orchestrator")

  // Nothing usable on either side records nothing rather than an empty name.
  await hooks["chat.message"]({ sessionID: "ses_f" }, { message: { id: "m3" }, parts: [] })
  assert.equal(sessionAgentName("ses_f"), null)
})

// Assumption 3 of the concept, falsification test: "the session -> agent map
// being empty at the first transform of a fresh session".
test("the recorded name is in hand at the FIRST system transform of a fresh session", async () => {
  const hooks = await plugin(makeCtx())
  const sessionID = "ses_first_turn"
  assert.equal(sessionAgent.has(sessionID), false, "fresh session, nothing recorded yet")

  // Production order: opencode triggers chat.message inside createUserMessage,
  // then the request loop triggers the system transform.
  await hooks["chat.message"](
    { sessionID, agent: "build" },
    { message: { id: "m1", agent: "build" }, parts: [] },
  )
  assert.equal(
    sessionAgent.has(sessionID),
    true,
    "map must be populated before the first transform of the turn",
  )

  const out = displaced()
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  assert.equal(
    out.system.join(""),
    "TEMPLATE FOR BUILD",
    "a primary named build loads build.md, not orchestrator.md",
  )
})

test("a primary whose prompt is intact still loads its own template", async () => {
  const hooks = await plugin(makeCtx())
  const sessionID = "ses_orch_turn"
  await hooks["chat.message"](
    { sessionID, agent: "orchestrator" },
    { message: { id: "m1", agent: "orchestrator" }, parts: [] },
  )
  const out = withHeader()
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  assert.equal(out.system.join(""), "TEMPLATE FOR ORCHESTRATOR")
})

test("forgetPrimary drops the session's recorded agent name", () => {
  recordSessionAgent("ses_gone", "build")
  assert.equal(sessionAgentName("ses_gone"), "build")
  forgetPrimary("ses_gone")
  assert.equal(sessionAgentName("ses_gone"), null, "a deleted session leaves no record behind")
})

test("recordSessionAgent ignores an unusable session id or name", () => {
  recordSessionAgent("", "build")
  recordSessionAgent("ses_g", "")
  recordSessionAgent("ses_g", undefined)
  recordSessionAgent(undefined, "build")
  assert.equal(sessionAgent.size, 0)
})
