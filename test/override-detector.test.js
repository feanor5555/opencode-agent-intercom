// Unit tests for detector A and the per-tool-key permission merge (concept
// step 3).
//
// opencode folds a project's `.opencode/agent/<name>.md` and its `opencode.json`
// agent entries into `config.agent` BEFORE the plugin's `config` hook runs, so
// the entry already sitting under one of this plugin's role names IS the
// collision — no request, no resolved-agent read, no cache.
//
// Two things are pinned here: what installAgents now MERGES (the plugin's
// denies survive a project map that did not name the key) and what it REPORTS
// (which fields were displaced, which file they came from, and that a re-run
// reports the same thing once).
//
// Run: node --test test/override-detector.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installAgents, AGENTS } from "../src/agents.js"
import { overrideFindings, hasFindings, resetOverrides } from "../src/overrides.js"
import { resetState } from "../src/state.js"

// A project directory carrying `.opencode/agent/coder.md`, so the file probe
// has something to find; `researcher.md` deliberately does NOT exist, which is
// the `file: null` case (an entry written straight into opencode.json).
const projectDir = mkdtempSync(join(tmpdir(), "intercom-override-"))
mkdirSync(join(projectDir, ".opencode", "agent"), { recursive: true })
const coderFile = join(projectDir, ".opencode", "agent", "coder.md")
writeFileSync(coderFile, "---\nmode: subagent\n---\n\nProject coder.\n")

// The `agents/` spelling for a second role, to pin that both directory names
// are probed.
mkdirSync(join(projectDir, ".opencode", "agents"), { recursive: true })
const plannerFile = join(projectDir, ".opencode", "agents", "planner.md")
writeFileSync(plannerFile, "Project planner.\n")

after(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

beforeEach(() => {
  resetOverrides()
  resetState()
})

// What opencode hands the config hook for a markdown agent: the frontmatter
// fields plus a `permission` object that is materialised whether or not the
// author wrote one (packages/core/src/v1/config/agent.ts).
function mdAgent(fields = {}) {
  return { permission: {}, ...fields }
}

function findingFor(agent) {
  return overrideFindings().find((f) => f.agent === agent) ?? null
}

test("an empty project permission map keeps every deny the plugin sets", () => {
  const config = { agent: { coder: mdAgent({ prompt: "Project coder." }) } }
  installAgents(config)
  assert.deepEqual(
    config.agent.coder.permission,
    AGENTS.coder.permission,
    "an author who wrote no permission line expressed nothing — the plugin's map stands",
  )
  assert.equal(config.agent.coder.prompt, "Project coder.", "the prompt stays the author's")
})

test("a project permission key wins over the plugin's, the rest of the map survives", () => {
  const config = {
    agent: { researcher: mdAgent({ permission: { read: "allow" } }) },
  }
  installAgents(config)
  const merged = config.agent.researcher.permission
  assert.equal(merged.read, "allow", "the one intent the author could express wins")
  for (const [tool, value] of Object.entries(AGENTS.researcher.permission)) {
    if (tool === "read") continue
    assert.equal(merged[tool], value, `${tool} keeps the plugin's value`)
  }
})

test("a permission value that names no tool key cannot wipe the map", () => {
  const config = { agent: { gitter: { permission: "deny" } } }
  installAgents(config)
  assert.deepEqual(config.agent.gitter.permission, AGENTS.gitter.permission)
})

test("prompt, model and description stay the user's", () => {
  const config = {
    agent: {
      coder: mdAgent({
        prompt: "Project coder.",
        model: "anthropic/claude-x",
        description: "the project's own coder",
      }),
    },
  }
  installAgents(config)
  assert.equal(config.agent.coder.prompt, "Project coder.")
  assert.equal(config.agent.coder.model, "anthropic/claude-x")
  assert.equal(config.agent.coder.description, "the project's own coder")
})

test("a prompt-only entry reports `prompt` and names the file it came from", () => {
  const config = { agent: { coder: mdAgent({ prompt: "Project coder." }) } }
  installAgents(config, { directory: projectDir })
  const finding = findingFor("coder")
  assert.ok(finding, "the collision is recorded")
  assert.equal(finding.kind, "agent-entry")
  assert.deepEqual([...finding.fields], ["prompt"], "only what actually differs is named")
  assert.equal(finding.file, coderFile)
  assert.equal(finding.detail, "", "nothing was taken away, so no permission clause")
})

test("the `agents/` spelling is probed too", () => {
  const config = { agent: { planner: mdAgent({ prompt: "Project planner." }) } }
  installAgents(config, { directory: projectDir })
  assert.equal(findingFor("planner")?.file, plannerFile)
})

test("an entry with no file on disk reports file: null, and the block says so", () => {
  const config = { agent: { researcher: mdAgent({ prompt: "Project researcher." }) } }
  installAgents(config, { directory: projectDir })
  const finding = findingFor("researcher")
  assert.equal(finding.file, null, "an opencode.json entry has no markdown file — say so")
})

test("with no directory at all the detection still happens, the file is just unknown", () => {
  const config = { agent: { coder: mdAgent({ prompt: "Project coder." }) } }
  installAgents(config)
  assert.equal(findingFor("coder")?.file, null)
})

test("a relaxed permission key is reported with the denies the plugin re-imposes", () => {
  const config = {
    agent: { researcher: mdAgent({ permission: { read: "allow" } }) },
  }
  installAgents(config, { directory: projectDir })
  const finding = findingFor("researcher")
  assert.deepEqual([...finding.fields], ["permission"])
  assert.match(finding.detail, /^a project agent entry replaces permission; /)
  assert.match(finding.detail, /this plugin's deny stays in force for .*\bwrite\b/)
  assert.doesNotMatch(finding.detail, /\bread\b/, "what the author took away is not re-imposed")
})

test("the fields of one entry are reported in one line, prompt first", () => {
  const config = {
    agent: {
      coder: mdAgent({ prompt: "p", model: "m", description: "d", permission: { bash: "allow" } }),
    },
  }
  installAgents(config, { directory: projectDir })
  assert.deepEqual(
    [...findingFor("coder").fields],
    ["prompt", "permission", "model", "description"],
    "fixed order, so the rendered block does not move when a detector runs again",
  )
})

test("a role the project does not define is no finding", () => {
  const config = { agent: { coder: mdAgent({ prompt: "Project coder." }) } }
  installAgents(config, { directory: projectDir })
  assert.equal(overrideFindings().length, 1, "eight untouched roles report nothing")
})

test("a clean project reports nothing at all", () => {
  installAgents({}, { directory: projectDir })
  assert.equal(hasFindings(), false)
})

test("re-running installAgents over its own output yields one unchanged finding", () => {
  const config = {
    agent: {
      coder: mdAgent({ prompt: "Project coder.", permission: { bash: "allow" } }),
    },
  }
  installAgents(config, { directory: projectDir })
  const first = findingFor("coder")
  const permissionAfterFirst = { ...config.agent.coder.permission }

  installAgents(config, { directory: projectDir })
  assert.equal(overrideFindings().length, 1, "idempotent detection, one line")
  const second = findingFor("coder")
  assert.deepEqual([...second.fields], [...first.fields], "the same fields, still displaced")
  assert.equal(second.detail, first.detail, "byte-identical text — the block must not move")
  assert.deepEqual(
    config.agent.coder.permission,
    permissionAfterFirst,
    "the merge is idempotent as well",
  )
})

test("an entry that carries exactly what the plugin installs is no collision", () => {
  // The shape a second config hook sees when the project defined nothing: every
  // field is the plugin's own, so nothing was displaced.
  const config = { agent: { coder: { ...AGENTS.coder } } }
  installAgents(config, { directory: projectDir })
  assert.equal(hasFindings(), false)
})

test("the global opencode agent dir is probed when the project has no file", () => {
  const configHome = mkdtempSync(join(tmpdir(), "intercom-xdg-"))
  mkdirSync(join(configHome, "opencode", "agent"), { recursive: true })
  const globalFile = join(configHome, "opencode", "agent", "designer.md")
  writeFileSync(globalFile, "Global designer.\n")
  const previous = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = configHome
  try {
    installAgents(
      { agent: { designer: mdAgent({ prompt: "Global designer." }) } },
      { directory: projectDir },
    )
    assert.equal(findingFor("designer")?.file, globalFile)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(configHome, { recursive: true, force: true })
  }
})
