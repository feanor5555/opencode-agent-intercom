// Unit tests for detector B (concept step 5): a customised prompt file under
// `.opencode/agent-intercom/<agent>.md` that predates the current prompt
// contract.
//
// Two mechanisms and both are pinned here, because neither covers the whole
// population on its own:
//
//   - the CONTRACT PROBES, which work on the files that exist on disk today —
//     those carry no stamp, and each probe is one element the auto-assembled
//     prompt would inject for that role;
//   - the CONTRACT STAMP, which covers every file written from now on and is
//     what keeps a `{{guide}}` file (step 6) from being read as stale.
//
// Plus the parity test the concept asks for: every probe still matches the
// constant it mirrors, so an edit to prompts.js that drops a contract element
// fails here instead of silently making every file on disk look fresh.
//
// Run: node --test test/prompt-file-staleness.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { upsertSession } from "../src/registry.js"
import { resetTurnNotices, TODO_AGENTS } from "../src/hooks.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { AGENTS, mayDelegate } from "../src/agents.js"
import { PROMPT_CONTRACT, guideBlocks, SUBAGENT_GUIDE_CORE } from "../src/prompts.js"
import {
  resetOverrides,
  overrideFindings,
  overrideBlock,
  classifyPromptFile,
  claimPromptFileScan,
  readContractStamp,
  PROMPT_FILE_PROBES,
  CONTRACT_STAMP_KEY,
} from "../src/overrides.js"
import {
  AGENT_NAMES,
  writeDefaultPromptsFiles,
  scanPromptFiles,
  getPromptFilePath,
  resetCache,
} from "../src/promptsfile.js"

const dirs = []
const settingsFile = join(mkdtempSync(join(tmpdir(), "intercom-stale-cfg-")), "agent-intercom.json")
setSettingsPath(settingsFile)

// One directory per test: the scan is claimed once per directory for the life
// of the process, and a fresh path also keeps the loader's mtime cache from
// answering with the previous test's file.
function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "intercom-stale-"))
  dirs.push(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
  mkdirSync(join(dir, ".opencode", "agent-intercom"), { recursive: true })
  return dir
}

function writePromptFile(dir, agent, text) {
  const filePath = getPromptFilePath(dir, agent)
  writeFileSync(filePath, text)
  return filePath
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  resetOverrides()
  resetCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

function makeCtx(dir) {
  const toasts = []
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_sub1" } }),
      promptAsync: async () => ({ data: undefined }),
      get: async () => ({ data: { directory: dir } }),
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
  return { ctx: { client, directory: dir, worktree: dir, project: {} }, toasts }
}

// A fresh session id per test: `getSessionDirectory` caches the directory per
// SESSION for the life of the process, so a reused id would answer with the
// previous test's project.
let primaryCounter = 0
const nextPrimary = () => `ses_primary_${++primaryCounter}`

async function primaryTransform(hooks, sessionID = nextPrimary()) {
  const out = { system: ["# Role: Orchestrator\n\nbase prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out
}

// The role prompt heads every file the user starts from, so the fixtures below
// carry it too — several probes would otherwise be answered by the guide alone.
const roleOf = (agent) => AGENTS[agent].prompt

// The subagent core guide as it read BEFORE the `Blocked:` contract: the one
// line that carries it, removed from the current constant, so the fixture
// cannot drift away from what the file it stands for actually looked like.
const preBlockedCore = SUBAGENT_GUIDE_CORE.split("\n")
  .filter((line) => !line.startsWith("Blocked:"))
  .join("\n")

// ---- the probe table itself ------------------------------------------------

test("every probe still matches the guide the auto path injects for its roles", () => {
  // The parity the concept asks for: the probes mirror the constants in
  // prompts.js, and a change there that drops a contract element must fail HERE
  // rather than turn every file on disk into a "fresh" one.
  for (const agent of AGENT_NAMES) {
    const guide = guideBlocks({
      primary: agent === "orchestrator",
      agent,
      delegates: mayDelegate(agent),
    })
    const text = roleOf(agent) + guide
    for (const probe of PROMPT_FILE_PROBES) {
      if (probe.agents !== null && !probe.agents.includes(agent)) continue
      assert.ok(
        probe.re.test(text),
        `probe ${probe.id} no longer matches what ${agent} is injected — ${probe.why}`,
      )
    }
  }
})

test("the probe role sets are the sets they mirror, not a list that can drift", () => {
  const byId = Object.fromEntries(PROMPT_FILE_PROBES.map((p) => [p.id, p]))

  assert.equal(byId["blocked-contract"].agents, null, "the blocked contract binds every role")

  // The marker does something for the six roles that own TODO.md, plus the
  // orchestrator, which writes the contract into every task-tracked spawn.
  assert.deepEqual(
    [...byId["done-marker"].agents].sort(),
    [...TODO_AGENTS, "orchestrator"].sort(),
  )

  // The delegation block goes to exactly the roles whose permission map holds
  // `spawn`.
  assert.deepEqual(
    [...byId["delegation-block"].agents].sort(),
    AGENT_NAMES.filter((a) => mayDelegate(a)).sort(),
  )

  assert.deepEqual(byId["spawn-protocol"].agents, ["orchestrator"])
})

// ---- the probes on the files that exist today ------------------------------

test("a file carrying the pre-`Blocked:` guide reports blocked-contract", () => {
  // A researcher file: no TODO marker, no delegation and no spawn protocol
  // apply to it, so the one finding is the contract element it really lost.
  const body = `${roleOf("researcher")}\n${preBlockedCore}\n`
  assert.deepEqual(classifyPromptFile("researcher", { body }), {
    missing: ["blocked-contract"],
    detail: "",
  })
})

test("a delegating role's file with no spawn(\"researcher\" reports delegation-block", () => {
  // The second instance already on disk in every file: the delegation block was
  // never rendered into a template at all, so a delegating role driven from a
  // prompt file is told nothing about spawning.
  const body =
    roleOf("coder") +
    guideBlocks({ agent: "coder", delegates: false }) // core + no-spawn + outline
  const { missing } = classifyPromptFile("coder", { body })
  assert.deepEqual(missing, ["delegation-block"])
})

test("a file that lost several elements names them all, in table order", () => {
  const { missing } = classifyPromptFile("coder", { body: "just a prompt, nothing else" })
  assert.deepEqual(missing, ["blocked-contract", "done-marker", "delegation-block"])
})

test("a probe that does not apply to a role is not reported for it", () => {
  // `spawn-protocol` is the orchestrator's alone; `done-marker` skips the two
  // roles that own no TODO task.
  const { missing } = classifyPromptFile("gitter", { body: "nothing at all" })
  assert.deepEqual(missing, ["blocked-contract"])
})

// ---- the stamp -------------------------------------------------------------

test("the stamp is read from the header comment and decides on its own", () => {
  assert.equal(readContractStamp(` ${CONTRACT_STAMP_KEY}: 3 `), 3)
  assert.equal(readContractStamp("no stamp here"), null)
  assert.equal(readContractStamp(undefined), null)

  // A stamp below the current contract is stale even where the probes pass...
  const current = roleOf("coder") + guideBlocks({ agent: "coder", delegates: true })
  const old = classifyPromptFile("coder", {
    header: `${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT - 1}`,
    body: current,
  })
  assert.deepEqual(old.missing, ["contract-stamp"])
  assert.match(old.detail, new RegExp(`rendered against prompt contract ${PROMPT_CONTRACT - 1}`))
  assert.match(old.detail, new RegExp(`current contract is ${PROMPT_CONTRACT}`))

  // ...and a current stamp answers for the file, probes and all: its author saw
  // the contract the stamp names.
  assert.deepEqual(
    classifyPromptFile("coder", {
      header: `${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT}`,
      body: "a prompt of my own",
    }),
    { missing: [], detail: "" },
  )
})

test("an unstamped file that carries {{guide}} is not stale — the guide arrives at call time", () => {
  assert.deepEqual(classifyPromptFile("coder", { body: "my own prompt\n\n{{GUIDE}}\n" }), {
    missing: [],
    detail: "",
  })
})

// ---- the scan --------------------------------------------------------------

test("a directory freshly written by writeDefaultPromptsFiles scans clean", () => {
  const dir = newProject()
  writeDefaultPromptsFiles(dir, { overwrite: true })
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(), [], "the current renderer must not produce a stale file")
})

test("the scan reports a stale file with its path and the elements it lacks", () => {
  const dir = newProject()
  const filePath = writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  scanPromptFiles(dir)

  const findings = overrideFindings()
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, "prompt-file")
  assert.equal(findings[0].agent, "coder")
  assert.equal(findings[0].file, filePath)
  assert.deepEqual([...findings[0].missing], ["blocked-contract", "delegation-block"])
})

test("the same stale role in two scanned projects stays scoped", () => {
  const first = newProject()
  const second = newProject()
  const firstFile = writePromptFile(first, "coder", "first project template")
  const secondFile = writePromptFile(second, "coder", "second project template")

  scanPromptFiles(first)
  scanPromptFiles(second)

  assert.deepEqual(overrideFindings(first).map((finding) => finding.file), [firstFile])
  assert.deepEqual(overrideFindings(second).map((finding) => finding.file), [secondFile])
  assert.equal(overrideFindings().length, 2, "the process register retains both project findings")
})

test("the scan runs once per directory — it is not per-request work", () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")
  scanPromptFiles(dir)
  assert.equal(overrideFindings().length, 1)

  // A second stale file appearing after the claim is NOT picked up: the scan is
  // eager and once, which is what keeps the block's text stable for the session.
  writePromptFile(dir, "planner", "bare template")
  scanPromptFiles(dir)
  assert.equal(overrideFindings().length, 1, "the second call must do no work")

  assert.equal(claimPromptFileScan(dir), false, "the claim is held")
  assert.equal(claimPromptFileScan(""), false, "an unusable directory claims nothing")
  assert.equal(claimPromptFileScan(newProject()), true, "another directory has its own claim")
})

test("a directory with no prompt files at all produces no finding", () => {
  const dir = newProject()
  scanPromptFiles(dir)
  assert.equal(overrideFindings().length, 0)
  assert.equal(overrideBlock(), "")
})

// ---- the outlet: the same register, the same block --------------------------

test("the scan fires at the primary transform and its finding reaches the primary's block", async () => {
  const dir = newProject()
  const filePath = writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  const { ctx, toasts } = makeCtx(dir)
  const hooks = await plugin(ctx)
  await hooks.config({})

  const out = await primaryTransform(hooks)
  assert.match(out.system[0], /agent-intercom: project files are overriding this plugin's roles/)
  assert.match(
    out.system[0],
    /- coder: the prompt file predates the current prompt contract, missing: blocked-contract, delegation-block/,
  )
  assert.ok(out.system[0].includes(filePath), "the block names the file")
  assert.match(out.system[0], /Tell the user about this in your next answer/)

  // Outlet two: the same one-shot toast the agent-entry finding uses.
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].variant, "warning")
  assert.match(toasts[0].message, /1 prompt file out of date/)
})

test("the block holds its bytes across the turns of a session", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  const first = await primaryTransform(hooks)
  const second = await primaryTransform(hooks)
  assert.equal(first.system[0], second.system[0])
})

test("a subagent turn neither scans nor carries the block", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  upsertSession("ses_sub", {
    agent: "researcher",
    prompt: "task",
    parentID: "ses_primary",
    directory: dir,
  })

  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_sub" }, out)
  assert.deepEqual(overrideFindings(), [], "the scan belongs to the primary transform")
  assert.doesNotMatch(out.system.join(""), /project files are overriding/)

  // The primary's turn then scans, and the subagent's directory finding is in
  // the primary's block — one process-wide register.
  const primary = await primaryTransform(hooks)
  assert.match(primary.system[0], /- coder: the prompt file predates/)
})

test("an unreadable file costs the other roles nothing", () => {
  const dir = newProject()
  // A directory where the loader expects a file: statSync succeeds, readFileSync
  // throws EISDIR, and loadCustomPrompt answers null for it.
  mkdirSync(getPromptFilePath(dir, "reviewer"), { recursive: true })
  writePromptFile(dir, "coder", "bare template")
  scanPromptFiles(dir)
  assert.deepEqual(
    overrideFindings().map((f) => f.agent),
    ["coder"],
  )
})
