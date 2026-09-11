// Solo mode's ONE requirement: in a solo-mode process not one second agent
// ever starts. The backing llama.cpp server runs at `parallel 1`, so a second
// agent does not merely cost tokens — it competes with the primary for the only
// slot there is.
//
// test/agent-mode.test.js pins the mode's SURFACE: which tools are registered,
// what the deny map says, which prompt the primary is given. This file pins the
// requirement itself, at the places a second agent could actually come from:
//
//   1. The plugin's own subagent roles, which stay installed in solo mode
//      behind `hidden: true` — a flag a project entry could override, because
//      installAgents lets the project win on every top-level key.
//   2. The runtime guard, which used to refuse one literal tool name and admit
//      everything else by omission.
//   3. `spawnHandler` / `reuseHandler`, the two functions that actually create
//      or re-start a session, which used to ask the mode nothing at all: the
//      whole block on the spawn machinery in solo mode was the shape of one
//      object literal.
//   4. opencode's own hidden `title` and `summary` agents, which it starts on
//      its own initiative — no tool call, so not one of the plugin's
//      enforcement points is on their path. The third such agent, `compaction`,
//      is switched off in EVERY mode and belongs to
//      test/compaction-policy.test.js; what this file still pins about it is
//      that the solo suppression writes no compaction key of its own.
//   5. The invariant over the lot: driving a solo-mode instance over a client
//      whose `session.create` THROWS must not raise.
//
// One correction to that last one. "session.create is never called" does not
// hold as an absolute, and must not: solo mode deliberately arms the plain
// primary handoff (endlessModeInEffect is false, so `maxPrimaryContext` owns
// the threshold again), and a handoff creates the SUCCESSOR primary. That
// successor is not a second agent — it is the same one agent continuing in a
// fresh session, and what keeps it from becoming a second one is that the
// predecessor's unanswered turn is aborted before the successor is prompted
// (pinned in test/handoff.test.js). The invariant pinned here is therefore the
// one that carries the requirement: no SUBAGENT session is ever created.
//
// Run: node --test test/solo-no-second-agent.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, registry, bySession } from "../src/state.js"
import { recordSessionAgent } from "../src/registry.js"
import {
  AGENTS,
  BUILTIN_AUTO_AGENTS,
  installAgents,
  suppressBuiltinAgentTurns,
} from "../src/agents.js"
import { createTools } from "../src/tools.js"
import {
  AGENT_STARTING_TOOLS,
  SOLO_DENIED_TOOLS,
  createGuardToolExecute,
  resetTurnNotices,
} from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { overrideFindings, resetOverrides } from "../src/overrides.js"
import {
  AGENT_MODE_ORCHESTRATOR,
  AGENT_MODE_SOLO,
  setSettingsPath,
  resetSettings,
  soloModeActive,
} from "../src/settings.js"

const PRIMARY = "ses_primary"
const SUBAGENT = "ses_sub"

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-solo-second-agent-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  resetOverrides()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// The settings this process is LOADED with: the file is written and the latch
// dropped, so the next read decides the mode afresh — a restart, which is what
// changing the mode really takes.
function loadWith(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

function loadSolo(extra = {}) {
  loadWith({ agentMode: AGENT_MODE_SOLO, ...extra })
  assert.equal(soloModeActive(), true)
}

// ===========================================================================
// 1. the plugin's own subagent roles (src/agents.js, installAgents)
// ===========================================================================

const subagentRoles = () =>
  Object.entries(AGENTS)
    .filter(([, def]) => def.mode === "subagent")
    .map(([name]) => name)

function installed(config = { agent: {} }) {
  installAgents(config, { directory: fixtureDir, worktree: fixtureDir })
  return config
}

test("solo mode: every subagent role is installed disabled and hidden", () => {
  loadSolo()
  const config = installed()
  for (const name of subagentRoles()) {
    assert.equal(config.agent[name].disable, true, `${name} must be disabled`)
    assert.equal(config.agent[name].hidden, true, `${name} must stay hidden`)
  }
  assert.ok(subagentRoles().length >= 9, "the roles this covers are still there")
})

test("solo mode: a project entry cannot expose a subagent role", () => {
  // This is the hole: `merged = { ...base, ...projectEntry }` lets a project
  // win on every top-level key, `hidden` included. One line in a project
  // `opencode.json` would otherwise put a fully-configured role back into
  // opencode's `@` autocomplete and its agent switcher, where the user starts
  // it as a session of its own.
  loadSolo()
  const config = installed({
    agent: {
      planner: { hidden: false, disable: false, mode: "primary" },
      coder: { hidden: false },
    },
  })
  for (const name of ["planner", "coder"]) {
    assert.equal(config.agent[name].hidden, true, `${name}: the override must not expose it`)
    assert.equal(config.agent[name].disable, true, `${name}: the override must not re-enable it`)
  }
})

test("solo mode does not report forced reachability fields as overrides", () => {
  loadSolo()
  installed({ agent: { planner: { hidden: false, disable: false } } })
  assert.deepEqual(overrideFindings(), [], "forced disable and hidden are not project overrides")
})

test("solo mode reports other fields without forced reachability fields", () => {
  loadSolo()
  installed({
    agent: {
      planner: { hidden: false, disable: false, prompt: "Project planner." },
    },
  })
  const finding = overrideFindings().find((entry) => entry.agent === "planner")
  assert.ok(finding, "the project prompt is still reported")
  assert.deepEqual([...finding.fields], ["prompt"], "forced fields are omitted from the finding")
})

test("solo mode leaves everything else about a subagent entry alone", () => {
  // `disable` and `hidden` are the two keys that decide reachability; the rest
  // of the entry — the project's model, its prompt, its permission merge — is
  // untouched, and the plugin reads its own roles from AGENTS either way.
  loadSolo()
  const config = installed({ agent: { coder: { model: "cliproxy/some-model" } } })
  assert.equal(config.agent.coder.model, "cliproxy/some-model")
  assert.equal(config.agent.coder.prompt, AGENTS.coder.prompt)
  assert.equal(config.agent.coder.permission.task, AGENTS.coder.permission.task)
})

test("orchestrator mode installs no disable at all — the roles are the point there", () => {
  const config = installed()
  for (const name of subagentRoles()) {
    assert.equal(config.agent[name].disable, undefined, `${name} must stay startable`)
    assert.equal(config.agent[name].hidden, true, "hidden is the shipped default in both modes")
  }
  assert.equal(config.agent.orchestrator.disable, undefined, "the primary is never disabled")
})

test("solo mode never disables the primary itself", () => {
  loadSolo()
  assert.equal(installed().agent.orchestrator.disable, undefined)
})

// ===========================================================================
// 2. opencode's own hidden agents (src/agents.js, suppressBuiltinAgentTurns)
// ===========================================================================
//
// Names and switches established from the installed binary (opencode 1.18.29):
// all three are registered `mode: "primary", hidden: true`; the agent-entry
// schema declares `disable`, and opencode's config merge deletes the registry
// entry for a `disable: true`; the title path then takes its own early return
// on the empty fetch. `compaction` is switched off through the global
// `compaction.auto` instead, because its own path dereferences the fetch
// without a guard — that write is unconditional and lives in
// src/compaction.js, so this section covers `title` and `summary` alone.

test("solo mode switches opencode's title and summary agents off through its own key", () => {
  loadSolo()
  const config = { agent: {} }
  suppressBuiltinAgentTurns(config)
  assert.equal(config.agent.title.disable, true)
  assert.equal(config.agent.summary.disable, true)
})

test("the suppression leaves both the compaction agent and the compaction key alone", () => {
  loadSolo()
  const config = { agent: {} }
  suppressBuiltinAgentTurns(config)
  assert.equal(
    config.agent.compaction,
    undefined,
    "disabling the agent would turn an automatic compaction into a throw, not into a skip",
  )
  assert.equal(
    config.compaction,
    undefined,
    "the global key is written unconditionally elsewhere (src/compaction.js)",
  )
})

test("the suppression keeps every neighbouring key it did not come for", () => {
  loadSolo()
  const config = {
    agent: { title: { model: "cliproxy/small", temperature: 0.5 } },
    compaction: { tail_turns: 15, prune: true },
  }
  suppressBuiltinAgentTurns(config)
  assert.deepEqual(config.agent.title, {
    model: "cliproxy/small",
    temperature: 0.5,
    disable: true,
  })
  assert.deepEqual(config.compaction, { tail_turns: 15, prune: true }, "not this write's key")
})

test("the plugin wins over a project that switched the title agent back on", () => {
  // Not a default to be overridden: in solo mode the backend serves one agent
  // at a time, and a `title` turn beside the primary's own is the failure case.
  loadSolo()
  const config = { agent: { title: { disable: false } } }
  suppressBuiltinAgentTurns(config)
  assert.equal(config.agent.title.disable, true)
})

test("orchestrator mode: the suppression is a no-op", () => {
  const config = { agent: {}, compaction: { auto: true } }
  suppressBuiltinAgentTurns(config)
  assert.deepEqual(config, { agent: {}, compaction: { auto: true } })
})

test("the suppression survives a config it cannot use", () => {
  loadSolo()
  for (const config of [null, undefined, "nope", 7]) {
    assert.doesNotThrow(() => suppressBuiltinAgentTurns(config))
  }
  // A non-object where an object is expected is replaced, not merged into.
  const odd = { agent: { title: "not an object" } }
  suppressBuiltinAgentTurns(odd)
  assert.deepEqual(odd.agent.title, { disable: true })
})

test("the three names opencode really starts on its own are named", () => {
  assert.deepEqual([...BUILTIN_AUTO_AGENTS], ["title", "summary", "compaction"])
  for (const name of BUILTIN_AUTO_AGENTS) {
    assert.equal(AGENTS[name], undefined, `${name} is opencode's, not one of the plugin's roles`)
  }
})

// ===========================================================================
// 3. the runtime guard (src/hooks.js)
// ===========================================================================

const guardOf = () => createGuardToolExecute({}, null)

async function refusal(guard, tool, sessionID = PRIMARY) {
  try {
    await guard({ tool, sessionID, callID: `c_${tool}` })
  } catch (err) {
    return err?.message ?? String(err)
  }
  return ""
}

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

test("the solo deny list is one collection the mode owns, not a literal in a branch", () => {
  // The whole point of finding 3: the old guard refused one literal name and
  // `return`ed on everything else. One collection is what makes the next
  // agent-starting tool one line instead of two edits in two files.
  assert.ok(Array.isArray(SOLO_DENIED_TOOLS))
  assert.ok(Array.isArray(AGENT_STARTING_TOOLS))
  for (const name of AGENT_STARTING_TOOLS) {
    assert.ok(SOLO_DENIED_TOOLS.includes(name), `${name} starts an agent, so solo mode denies it`)
  }
  for (const name of ["spawn", "reuse", "abort"]) {
    assert.ok(
      SOLO_DENIED_TOOLS.includes(name),
      `${name} must be refused however it got into the schema`,
    )
  }
})

test("neither deny list can be edited by an importer — they are frozen authorities", async () => {
  // Both are the SOLE authority for a deny at a guard branch. Exported as
  // mutable Sets, any importer — a test that forgets to restore, a future
  // module — could `.add`/`.delete` the enforcement set at runtime. Frozen
  // arrays, with the membership test running against private derived Sets.
  assert.ok(Object.isFrozen(SOLO_DENIED_TOOLS), "the solo deny list must be frozen")
  assert.ok(Object.isFrozen(AGENT_STARTING_TOOLS), "the agent-starting list must be frozen")

  const soloBefore = [...SOLO_DENIED_TOOLS]
  const startingBefore = [...AGENT_STARTING_TOOLS]
  for (const list of [SOLO_DENIED_TOOLS, AGENT_STARTING_TOOLS]) {
    assert.throws(() => list.push("read"), TypeError, "an added name would deny a working tool")
    assert.throws(() => (list[0] = "read"), TypeError, "a replaced name would redirect the deny")
    assert.throws(() => (list.length = 0), TypeError, "an emptied list would deny nothing at all")
  }
  assert.deepEqual([...SOLO_DENIED_TOOLS], soloBefore)
  assert.deepEqual([...AGENT_STARTING_TOOLS], startingBefore)

  // And the guard still holds after the attempts.
  loadSolo()
  const guard = guardOf()
  assert.match(await refusal(guard, "task"), /solo mode runs one agent/)
  assert.equal(await refusal(guard, "read"), "", "`read` was never added to the deny list")
})

test("solo mode: every name in the deny set is refused at the guard", async () => {
  loadSolo()
  const guard = guardOf()
  for (const tool of SOLO_DENIED_TOOLS) {
    const message = await refusal(guard, tool)
    assert.match(message, /solo mode runs one agent/, `${tool} must be refused`)
    assert.ok(message.includes(tool), `the refusal names ${tool}`)
  }
})

test("solo mode does NOT deny `list` — the name is opencode's directory lister there", () => {
  // `list` is one of the four orchestration tools, but the name is not the
  // plugin's alone: opencode ships a builtin `list` that lists a directory, and
  // in solo mode — where the plugin's `list` is unregistered — that builtin is
  // what the name resolves to. It is a working tool the solo primary needs, and
  // it starts no agent.
  assert.ok(!SOLO_DENIED_TOOLS.includes("list"))
})

test("solo mode: the primary's own working tools still pass the guard", async () => {
  loadSolo()
  const guard = guardOf()
  for (const tool of ["read", "edit", "write", "bash", "glob", "grep", "list", "patch", "todo_add"]) {
    assert.equal(await refusal(guard, tool), "", `${tool} must pass in solo mode`)
  }
})

test("the subagent-side deny reads the agent-starting set, not the solo one", async () => {
  // The two must not drift over which names start an agent — but they are not
  // the same set: the plugin's own `spawn` is a legitimate NESTED spawn for a
  // subagent in the orchestrator pattern, gated in its own handler.
  trackSubagent()
  const guard = guardOf()
  for (const tool of AGENT_STARTING_TOOLS) {
    assert.match(
      await refusal(guard, tool, SUBAGENT),
      /a subagent cannot spawn other agents/,
      `${tool} must be denied to a subagent`,
    )
  }
  assert.equal(await refusal(guard, "spawn", SUBAGENT), "", "a nested spawn is decided in the handler")
})

// ---- the solo primary's per-agent permission deny ---------------------------
//
// Under the orchestrator pattern the primary allowlist (PRIMARY_TOOLS) answers
// everything: nothing outside it gets through at all, so a project's
// `agent.<primary>.permission.<tool> = "deny"` can add nothing. Solo mode drops
// that allowlist — the primary IS the worker — and its denylist is four names,
// which leaves such a deny standing on the LLM-side schema strip alone. These
// pin the runtime re-check that puts the subagent side's defence in depth
// behind it.

function guardWithPermissions(decide) {
  const asked = []
  const guard = createGuardToolExecute(
    {},
    {
      checkToolPermission: async (agent, tool) => {
        asked.push([agent, tool])
        return decide(agent, tool)
      },
    },
  )
  return { guard, asked }
}

test("solo mode: a per-agent permission deny is refused at the guard, not left to the schema strip", async () => {
  loadSolo()
  const { guard, asked } = guardWithPermissions((agent, tool) =>
    tool === "webfetch" ? `agent "${agent}" is not permitted to call "${tool}" (permission.webfetch)` : null,
  )

  const message = await refusal(guard, "webfetch")
  assert.match(message, /permission\.webfetch/, "the refusal carries the guard's own reason")
  assert.match(message, /deny map/, "and names where the decision came from")
  assert.equal(await refusal(guard, "read"), "", "a tool the map allows still passes")
  assert.deepEqual(
    asked,
    [
      ["orchestrator", "webfetch"],
      ["orchestrator", "read"],
    ],
    "the check runs under the primary's own agent name, on every tool",
  )
})

test("solo mode: the re-check runs under the name the session was recorded with", async () => {
  // The deny map hangs under a key of `config.agent`, and a primary called
  // something other than this plugin's default carries its own key.
  loadSolo()
  recordSessionAgent(PRIMARY, "build")
  const { guard, asked } = guardWithPermissions(() => null)
  await refusal(guard, "read")
  assert.deepEqual(asked, [["build", "read"]])
})

test("solo mode: the mode's own deny answers before the permission map is consulted", async () => {
  // A name that would start a second agent must produce the MODE's refusal —
  // the requirement — and not a permission reason that a project could switch
  // off by writing `"allow"`.
  loadSolo()
  const { guard, asked } = guardWithPermissions(() => "the map would have denied this too")
  assert.match(await refusal(guard, "task"), /solo mode runs one agent/)
  assert.deepEqual(asked, [], "the permission map is never asked about an agent-starting name")
})

test("solo mode: a guard built without a permission guard still admits the primary's tools", async () => {
  // The guard is constructed with `null` wherever the config side is absent;
  // the re-check is defence in depth, not a precondition.
  loadSolo()
  const guard = createGuardToolExecute({}, null)
  assert.equal(await refusal(guard, "read"), "")
})

test("orchestrator mode: the primary allowlist answers, and the re-check is not reached", async () => {
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR })
  const { guard, asked } = guardWithPermissions(() => null)
  assert.match(await refusal(guard, "read"), /this is an orchestrator session/)
  assert.deepEqual(asked, [], "nothing outside PRIMARY_TOOLS reaches a permission question")
})

// ===========================================================================
// 4. the two handlers that create or re-start a session (src/tools.js)
// ===========================================================================

// A client that fails loudly on anything that would put a second agent on the
// slot. `session.create` is the one call in the whole source tree that opens a
// session (src/client.js), so a throw here is the invariant made observable.
function makeStrictClient() {
  const calls = []
  return {
    calls,
    client: {
      session: {
        create: async () => {
          calls.push("create")
          throw new Error("session.create must never be reached in solo mode")
        },
        promptAsync: async () => {
          calls.push("promptAsync")
          return { data: undefined }
        },
        abort: async () => ({ data: true }),
        delete: async () => ({ data: true }),
        update: async () => ({ data: {} }),
        status: async () => ({ data: {} }),
        get: async () => ({ data: { directory: fixtureDir } }),
        messages: async () => ({ data: [] }),
      },
      tui: { showToast: async () => ({ data: true }) },
      config: { get: async () => ({ data: { agent: {} } }) },
    },
  }
}

// The tool map as an ORCHESTRATOR process resolves it — that is the only way to
// get at the handlers, and it is exactly the situation the gate is for: opencode
// settles the tool map once, at instance bootstrap, so a map that carries
// `spawn` and a process that is in solo mode is precisely what a refactor, a
// project override or a future direct caller produces.
function toolsResolvedBeforeSolo(client) {
  loadWith({ agentMode: AGENT_MODE_ORCHESTRATOR, maxRetainedSubagents: 3 })
  const tools = createTools({ client, directory: fixtureDir, permissionGuard: null })
  assert.ok(tools.spawn && tools.reuse, "the map is the orchestrator one")
  loadSolo({ maxRetainedSubagents: 3 })
  return tools
}

test("spawnHandler refuses in solo mode however it was reached", async () => {
  const { client, calls } = makeStrictClient()
  const tools = toolsResolvedBeforeSolo(client)

  const res = await tools.spawn.execute(
    { agent: "planner", prompt: "do it" },
    { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" },
  )
  assert.match(res.output, /Spawn refused: solo mode runs one agent/)
  assert.deepEqual(calls, [], "no session was created and nothing was prompted")
})

test("reuseHandler refuses in solo mode ahead of the retention question", async () => {
  // Retention is switched ON here on purpose: the mode decides regardless of
  // how retention stands, so the refusal must be the mode's and not the
  // "retention is off" one.
  const { client, calls } = makeStrictClient()
  const tools = toolsResolvedBeforeSolo(client)

  const res = await tools.reuse.execute(
    { subagent: "planner#1", prompt: "and the other one?" },
    { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" },
  )
  assert.match(res.output, /Reuse refused: solo mode runs one agent/)
  assert.doesNotMatch(res.output, /maxRetainedSubagents/, "the mode refused it, not retention")
  assert.deepEqual(calls, [])
})

// ===========================================================================
// 5. the invariant, over a whole plugin instance
// ===========================================================================

test("a solo-mode instance creates no subagent session, whatever is driven through it", async () => {
  loadSolo({ maxRetainedSubagents: 3, endlessMode: true, maxPrimaryContext: 0 })
  const { client, calls } = makeStrictClient()
  const hooks = await plugin({ client, directory: fixtureDir, worktree: fixtureDir, project: {} })

  // The tool map carries none of the four.
  for (const tool of ["spawn", "abort", "list", "reuse"]) {
    assert.equal(hooks.tool[tool], undefined, `${tool} must not be registered`)
  }

  // The guard, over every name that could start one.
  for (const tool of SOLO_DENIED_TOOLS) {
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool, sessionID: PRIMARY, callID: `c_${tool}` }, {}),
      /solo mode runs one agent/,
      `${tool}`,
    )
  }

  // The idle path, on the primary and on a subagent entry that only a hand
  // could have put there — endless mode is on in the settings above and counts
  // as off, so no cycle is armed and no wind-down planner is started.
  trackSubagent()
  for (const sessionID of [PRIMARY, SUBAGENT]) {
    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } })
  }

  assert.ok(!calls.includes("create"), `no session was created (calls: ${calls.join(", ") || "none"})`)
})

test("the config hook of a solo instance leaves nothing that can start a second agent", async () => {
  loadSolo()
  const { client } = makeStrictClient()
  const hooks = await plugin({ client, directory: fixtureDir, worktree: fixtureDir, project: {} })

  const config = { agent: { planner: { hidden: false } } }
  await hooks.config(config)

  for (const name of subagentRoles()) {
    assert.equal(config.agent[name].disable, true, `${name}`)
  }
  assert.equal(config.agent.title.disable, true)
  assert.equal(config.agent.summary.disable, true)
  assert.equal(config.compaction.auto, false, "written in every mode, src/compaction.js")
  assert.equal(config.agent.orchestrator.disable, undefined, "the one agent there is stays")
})
