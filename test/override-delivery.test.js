// Unit tests for the delivery of an override finding (concept step 4).
//
// Three outlets, each doing what it can: the debug log at detection (always),
// a toast once per process, and a block in the PRIMARY's system prompt that
// names every finding and tells the orchestrator to report it to the user.
// Report only — no refusal anywhere.
//
// The block's place is the stable system-prompt element, which is only sound
// while its text does not move between the turns of a session; that is pinned
// here.
//
// Run: node --test test/override-delivery.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { resetTurnNotices } from "../src/hooks.js"
import {
  resetOverrides,
  recordAgentEntryOverride,
  overrideBlock,
} from "../src/overrides.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { forgetSessionDirectory } from "../src/client.js"
import { setVariantStorePath } from "../src/variantstore.js"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-delivery-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)
// The `config` hook driven below writes the primary's reasoning effort into
// opencode's own per-model variant store; keep that off the real state file.
setVariantStorePath(join(fixtureDir, "model.json"))

// A project agent file, so the finding can name it.
mkdirSync(join(fixtureDir, ".opencode", "agent"), { recursive: true })
const coderFile = join(fixtureDir, ".opencode", "agent", "coder.md")
writeFileSync(coderFile, "Project coder.\n")

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  resetOverrides()
  rmSync(settingsFile, { force: true })
  resetSettings()
  rmSync(join(fixtureDir, ".opencode", "agent-intercom"), { recursive: true, force: true })
})

// `directory`/`worktree` are the instance paths the plugin is loaded with (the
// `config` hook's view of the project), `sessionDirectory` what `session.get`
// answers for a primary (the transform's view). They are equal for an instance
// started at the project root and differ for a nested one — which is the case
// the two halves of the report have to agree on. `session.fail` makes the
// lookup throw, i.e. a transport error, for as long as it is set.
function makeCtx({ directory = fixtureDir, worktree = fixtureDir, sessionDirectory = fixtureDir } = {}) {
  const created = []
  const toasts = []
  const session = { directory: sessionDirectory, fail: false }
  let counter = 0
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async () => ({ data: undefined }),
      get: async () => {
        if (session.fail) throw new Error("session.get: transport error")
        return { data: { directory: session.directory } }
      },
      messages: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
      delete: async () => ({ data: true }),
      abort: async () => ({ data: true }),
    },
    tui: {
      showToast: async (opts) => {
        toasts.push(opts?.body)
        return { data: true }
      },
    },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory, worktree, project: {} }, created, toasts, session }
}

// A resolved config as opencode hands it to the `config` hook when the project
// carries `.opencode/agent/coder.md`: the markdown agent is already folded in,
// with the `permission` object opencode materialises on every such file.
function displacedConfig() {
  return { agent: { coder: { permission: {}, prompt: "Project coder." } } }
}

async function primaryTransform(hooks, sessionID = "ses_primary") {
  const out = { system: ["# Role: Orchestrator\n\nbase prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out
}

test("no finding -> no block and no toast", async () => {
  const { ctx, toasts } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config({})
  const out = await primaryTransform(hooks)
  assert.doesNotMatch(out.system.join(""), /agent-intercom: project files/)
  assert.equal(toasts.length, 0)
})

test("a finding reaches the primary in the stable system element and names role and file", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  const out = await primaryTransform(hooks)
  assert.match(out.system[0], /agent-intercom: project files are overriding this plugin's roles/)
  assert.match(out.system[0], /- coder: a project agent entry replaces prompt/)
  assert.ok(out.system[0].includes(coderFile), "the file the entry came from is named")
  assert.match(out.system[0], /Tell the user about this in your next answer/)
  assert.match(out.system[0], /this is a report, not a blocker/)
})

test("a primary receives only findings from its session project", async () => {
  recordAgentEntryOverride({
    agent: "coder",
    fields: ["prompt"],
    file: join(fixtureDir, ".opencode", "agent", "coder.md"),
    directory: fixtureDir,
  })
  recordAgentEntryOverride({
    agent: "coder",
    fields: ["prompt"],
    file: "/project-b/.opencode/agent/coder.md",
    directory: "/project-b",
  })

  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = await primaryTransform(hooks)
  assert.ok(out.system[0].includes(fixtureDir))
  assert.doesNotMatch(out.system[0], /\/project-b\/\.opencode\/agent\/coder\.md/)
})

test("a nested instance's finding reaches its own primary", async () => {
  // The join the two halves are keyed on. opencode writes `session.directory`
  // from the instance directory, so detector A has to file its finding under
  // that same directory even when the file it names was found at the worktree
  // root. Scoped by the worktree instead, this block would be empty.
  const nested = join(fixtureDir, "nested")
  mkdirSync(nested, { recursive: true })
  const { ctx } = makeCtx({ directory: nested, worktree: fixtureDir, sessionDirectory: nested })
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  const out = await primaryTransform(hooks, "ses_nested")
  assert.match(out.system[0], /- coder: a project agent entry replaces prompt/)
  assert.ok(out.system[0].includes(coderFile), "the file found at the worktree root is named")
})

test("a session directory that cannot be resolved renders no block at all", async () => {
  // A finding recorded with no directory — what a `config` hook that ran
  // without one leaves behind. It belongs to no project, and a block selected
  // under a null scope is exactly what would pick it up and show it to a
  // session that has a project of its own.
  recordAgentEntryOverride({
    agent: "planner",
    fields: ["prompt"],
    file: "/elsewhere/.opencode/agent/planner.md",
  })
  const { ctx, session, toasts } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())

  session.fail = true
  const first = await primaryTransform(hooks, "ses_nodir")
  assert.doesNotMatch(
    first.system.join(""),
    /agent-intercom: project files/,
    "no project scope, no report — and no empty block where a real one belongs",
  )
  assert.equal(toasts.length, 0, "the project's one toast is not spent on a turn with no scope")

  session.fail = false
  const second = await primaryTransform(hooks, "ses_nodir")
  assert.match(second.system[0], /- coder: a project agent entry replaces prompt/)
  assert.doesNotMatch(
    second.system[0],
    /- planner: a project agent entry/,
    "a finding that carries no directory is nobody's project",
  )
  assert.equal(toasts.length, 1, "the toast arrives with the first turn that has a scope")
})

test("a failing session.get cannot take away a block an earlier turn showed", async () => {
  const { ctx, session } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  const sessionID = "ses_hold"
  const first = await primaryTransform(hooks, sessionID)
  const block = overrideBlock(fixtureDir)
  assert.ok(block.length > 0 && first.system[0].includes(block), "the first turn carries the block")

  // Drop the per-session directory cache and let the lookup fail: the scope the
  // block is selected by is held for the session and does not hang on a
  // per-turn `session.get`. Otherwise this turn renders "" into the STABLE
  // element and moves the bytes the provider cache matches on.
  forgetSessionDirectory(sessionID)
  session.fail = true
  const second = await primaryTransform(hooks, sessionID)
  assert.ok(second.system[0].includes(block), "the same block, byte for byte, on the next turn")
})

test("the toast fires once per process, on the primary transform", async () => {
  const { ctx, toasts } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  assert.equal(toasts.length, 0, "the config hook itself toasts nothing")
  await primaryTransform(hooks)
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "agent-intercom")
  assert.match(toasts[0].message, /1 role overridden by project files/)
  assert.equal(toasts[0].variant, "warning")
  await primaryTransform(hooks)
  assert.equal(toasts.length, 1, "a second turn must not toast again")
})

test("the block holds its bytes across two turns of one session", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  const first = await primaryTransform(hooks)
  const second = await primaryTransform(hooks)
  assert.equal(
    first.system[0],
    second.system[0],
    "the stable element must not move — it is what the provider cache matches on",
  )
})

test("a subagent never gets the block", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  await hooks.tool.spawn.execute(
    { agent: "researcher", prompt: "x" },
    { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" },
  )
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: created[0] }, out)
  assert.doesNotMatch(
    out.system.join(""),
    /agent-intercom: project files/,
    "a subagent cannot reach the user; its findings ride the primary's block",
  )
})

test("on the custom-template path the block follows the template", async () => {
  const promptsDir = join(fixtureDir, ".opencode", "agent-intercom")
  mkdirSync(promptsDir, { recursive: true })
  writeFileSync(join(promptsDir, "orchestrator.md"), "TEMPLATE ONLY")
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.config(displacedConfig())
  const out = await primaryTransform(hooks)
  assert.equal(out.system.length, 1, "the template path still emits one element")
  assert.ok(out.system[0].startsWith("TEMPLATE ONLY"), "the template owns the layout")
  assert.ok(
    out.system[0].endsWith(overrideBlock()),
    "a warning about the template cannot live inside the template",
  )
})

test("the report refuses nothing — the displaced role is still installed and spawnable", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const config = displacedConfig()
  await hooks.config(config)
  assert.equal(config.agent.coder.prompt, "Project coder.", "the project's file is untouched")
  const res = await hooks.tool.spawn.execute(
    { agent: "coder", prompt: "x" },
    { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" },
  )
  assert.match(res.output, /Spawned subagent "coder#1"/)
  assert.equal(created.length, 1)
})
