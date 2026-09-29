// The codegraph CLI offered to the code-reading agents: how its command
// resolves (settings file key > env var > PATH > none, once per process),
// which agents get the usage card, that the card follows the role's resolved
// `bash` permission, and that no agent hears of it where nothing resolves.

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import plugin from "../src/index.js"
import { AGENTS } from "../src/agents.js"
import {
  resolveCodegraphCommand,
  codegraphCommand,
  codegraphCommandFor,
  setCodegraphResolver,
  CODEGRAPH_COMMAND,
} from "../src/codegraph.js"
import { OUTLINE_DISABLED_AGENTS, codegraphGuide, guideBlocks } from "../src/prompts.js"
import { renderOpencodeDefaultFile, AGENT_NAMES } from "../src/promptsfile.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { resetState } from "../src/state.js"
import { upsertSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"

const root = mkdtempSync(join(tmpdir(), "codegraph-cli-test-"))
const settingsFile = join(root, "agent-intercom.json")
const binDir = join(root, "bin")
const fileBin = join(root, "opt", "codegraph")
const envBin = join(root, "opt", "codegraph-env")
const plainFile = join(root, "opt", "not-executable")
const ENV_KEY = "OPENCODE_AGENT_INTERCOM_CODEGRAPH_BIN"
const CARD_TITLE = "agent-intercom: code search"

function executable(path) {
  writeFileSync(path, "#!/bin/sh\nexit 0\n")
  chmodSync(path, 0o755)
}

mkdirSync(binDir, { recursive: true })
mkdirSync(join(root, "opt"), { recursive: true })
executable(join(binDir, CODEGRAPH_COMMAND))
executable(fileBin)
executable(envBin)
writeFileSync(plainFile, "data\n")
chmodSync(plainFile, 0o644)

const savedPath = process.env.PATH
const savedEnv = process.env[ENV_KEY]

function settings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  setSettingsPath(settingsFile)
  resetSettings()
}

// The subagents the card can reach: every subagent under the outline gate.
const CODE_READERS = AGENT_NAMES.filter(
  (agent) => agent !== "orchestrator" && !OUTLINE_DISABLED_AGENTS.has(agent),
)

beforeEach(() => {
  process.env.PATH = "/nonexistent-dir"
  delete process.env[ENV_KEY]
  settings({})
  setCodegraphResolver(() => null)
  resetPermissionGuardCache()
})

after(() => {
  process.env.PATH = savedPath
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  setCodegraphResolver(() => null)
  rmSync(root, { recursive: true, force: true })
})

// ---- resolution --------------------------------------------------------------

test("a configured executable wins and is named by its absolute path", () => {
  assert.equal(resolveCodegraphCommand({ configured: [fileBin], pathEnv: binDir }), fileBin)
})

test("codegraph on PATH is named by the bare command", () => {
  const pathEnv = ["/nonexistent", binDir].join(delimiter)
  assert.equal(resolveCodegraphCommand({ configured: [], pathEnv }), CODEGRAPH_COMMAND)
})

test("an unusable configured value falls to the next level", () => {
  for (const bad of [plainFile, join(root, "missing"), "relative/codegraph", root]) {
    assert.equal(resolveCodegraphCommand({ configured: [bad, envBin], pathEnv: binDir }), envBin, bad)
    assert.equal(resolveCodegraphCommand({ configured: [bad], pathEnv: binDir }), CODEGRAPH_COMMAND, bad)
    assert.equal(resolveCodegraphCommand({ configured: [bad], pathEnv: "" }), null, bad)
  }
})

test("nothing configured and nothing on PATH resolves to none", () => {
  const pathEnv = ["/nonexistent", "relative"].join(delimiter)
  assert.equal(resolveCodegraphCommand({ configured: [], pathEnv }), null)
})

test("the settings file key wins over the env var, which wins over PATH", () => {
  process.env.PATH = binDir
  process.env[ENV_KEY] = envBin
  const resolve = (values) => {
    settings(values)
    setCodegraphResolver()
    return codegraphCommand()
  }
  assert.equal(resolve({ codegraphBin: fileBin }), fileBin, "file key first")
  assert.equal(resolve({ codegraphBin: "relative/codegraph" }), envBin, "unusable file key: env var")
  assert.equal(resolve({}), envBin, "env var when the file has none")
  delete process.env[ENV_KEY]
  assert.equal(resolve({}), CODEGRAPH_COMMAND, "PATH when neither is set")
})

test("the command is resolved once per process", () => {
  settings({ codegraphBin: fileBin })
  setCodegraphResolver()
  assert.equal(codegraphCommand(), fileBin)
  settings({})
  assert.equal(codegraphCommand(), fileBin, "a settings change does not reach the running process")
})

// ---- the usage card ----------------------------------------------------------

test("the card names every command, the project root once and the no-index way out", () => {
  const card = codegraphGuide("codegraph")
  for (const sub of ["explore", "node", "callers", "callees", "impact", "query"]) {
    assert.match(card, new RegExp(`\`codegraph ${sub} [^\`]+\``), sub)
  }
  assert.equal(card.split("-p <project root>").length - 1, 1)
  assert.match(card, /To find code, run codegraph/)
  assert.match(card, /To read a file you already know, use `outline` and `read`/)
  assert.match(card, /not initialized/)
  assert.match(card, /leave `init` to the user/)
})

test("a configured path with shell characters is single-quoted in the card", () => {
  assert.match(codegraphGuide("/opt/my tools/codegraph"), /`'\/opt\/my tools\/codegraph' explore /)
  assert.match(codegraphGuide("/opt/it's/codegraph"), /`'\/opt\/it'\\''s\/codegraph' explore /)
})

test("the code-reading subagents get the card, the other agents never", () => {
  const card = codegraphGuide(fileBin)
  for (const agent of AGENT_NAMES) {
    const guide = guideBlocks({ primary: agent === "orchestrator", agent, codegraph: fileBin })
    assert.equal(guide.includes(card), CODE_READERS.includes(agent), agent)
  }
})

test("without a codegraph command no agent is told about it", () => {
  for (const agent of AGENT_NAMES) {
    const guide = guideBlocks({ primary: agent === "orchestrator", agent, codegraph: null })
    assert.ok(!guide.includes(CARD_TITLE), agent)
  }
})

test("the solo-mode primary gets the card as its only block", () => {
  settings({ agentMode: "solo" })
  const card = codegraphGuide(fileBin)
  assert.equal(guideBlocks({ primary: true, agent: "orchestrator", codegraph: fileBin }), card)
  assert.equal(guideBlocks({ primary: true, agent: "orchestrator", codegraph: null }), "")
})

test("the opencode-defaults reference names the card where it is injected", () => {
  const NAME = "codegraphGuide(<command>)"
  assert.ok(!renderOpencodeDefaultFile("coder").includes(NAME))
  setCodegraphResolver(() => fileBin)
  assert.ok(renderOpencodeDefaultFile("coder").includes(NAME))
  assert.ok(!renderOpencodeDefaultFile("designer").includes(NAME))
  assert.ok(!renderOpencodeDefaultFile("orchestrator").includes(NAME))
  settings({ agentMode: "solo" })
  assert.ok(renderOpencodeDefaultFile("orchestrator").includes(NAME))
})

// ---- the permission the card needs ------------------------------------------

test("every role the card can reach holds bash", () => {
  for (const agent of CODE_READERS) {
    assert.equal(AGENTS[agent].permission?.bash, undefined, `${agent} must carry no bash deny`)
  }
})

function makeClient(agentConfig) {
  return {
    session: {
      create: async () => ({ data: { id: "ses_new" } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: root } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
}

test("the command is withheld from a role whose resolved bash is denied", async () => {
  setCodegraphResolver(() => fileBin)
  const client = makeClient({ reviewer: { permission: { bash: "deny" } } })
  assert.equal(await codegraphCommandFor(client, "reviewer"), null)
  assert.equal(await codegraphCommandFor(client, "coder"), fileBin)
  setCodegraphResolver(() => null)
  assert.equal(await codegraphCommandFor(client, "coder"), null)
})

test("the system prompt carries the card exactly where the resolved bash allows it", async () => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  setCodegraphResolver(() => fileBin)
  const client = makeClient({ reviewer: { permission: { bash: "deny" } } })
  const hooks = await plugin({ client, directory: root, worktree: root, project: {} })
  const promptFor = async (agent) => {
    const sessionID = `ses_${agent}`
    upsertSession(sessionID, { agent, prompt: "task", parentID: "ses_primary", directory: root })
    const out = { system: ["base prompt"] }
    await hooks["experimental.chat.system.transform"]({ sessionID }, out)
    return out.system.join("")
  }
  assert.ok((await promptFor("coder")).includes(codegraphGuide(fileBin)), "coder holds bash")
  assert.ok(!(await promptFor("reviewer")).includes(CARD_TITLE), "reviewer's bash is denied")
  _stopWatchdogForTests()
})
