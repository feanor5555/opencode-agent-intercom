// The in-session re-scan of a project's prompt files, and where it is called
// from.
//
// `scanPromptFiles` only ever adds, and it runs once per directory. A file the
// user repairs mid-session is therefore still reported by the register until
// `rescanPromptFiles` re-judges the directory and replaces its finding set.
// `concepts/prompt-file-rescan.md` is the design this pins.
//
// The probes, the stamp and the eager first scan are
// test/prompt-file-staleness.test.js; the pinned element text is
// test/prompt-contract-pin.test.js.
//
// Run: node --test test/prompt-file-rescan.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import plugin from "../src/index.js"
import { upsertSession } from "../src/registry.js"
import { overrideFindings, overrideBlock, claimPromptFileScan } from "../src/overrides.js"
import {
  writeDefaultPromptsFiles,
  renderDefaultsFile,
  scanPromptFiles,
  rescanPromptFiles,
  getPromptFilePath,
} from "../src/promptsfile.js"
import {
  newProject,
  cleanupProjects,
  resetPromptFileState,
  writePromptFile,
  rewritePromptFile,
  makeCtx,
  nextPrimary,
  primaryTransform,
  roleOf,
  preBlockedCore,
} from "./helpers/prompt-files.js"

after(cleanupProjects)
beforeEach(resetPromptFileState)

test("a rescan drops the finding of a repaired file", () => {
  const dir = newProject()
  writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(dir).map((f) => f.agent), ["coder"])

  // The repair the plugin itself prescribes: the file re-rendered from the
  // current contract, carrying today's stamp.
  rewritePromptFile(dir, "coder", renderDefaultsFile("coder"))

  assert.equal(rescanPromptFiles(dir), true, "the set changed, so the caller may log it")
  assert.deepEqual(overrideFindings(dir), [], "no restart needed — the finding is gone")
  assert.equal(overrideBlock(dir), "", "the last line gone means no block at all")
})

test("a rescan drops the finding of a file the user deleted", () => {
  const dir = newProject()
  const filePath = writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(dir).map((f) => f.agent), ["coder"])

  // The other repair the README's instructions lead to: delete the
  // customisation and fall back on the plugin's own prompt. This is the loader's
  // second way of answering "no content", and the one the unreadable flag must
  // NOT claim: a file that is not there carries no stale contract, so its
  // finding goes — and the block stops naming a path that no longer exists.
  rmSync(filePath, { force: true })

  assert.equal(rescanPromptFiles(dir), true)
  assert.deepEqual(overrideFindings(dir), [], "an absent file is clean, not unreadable")
  assert.equal(overrideBlock(dir), "", "and the block it was the last line of is gone")
})

test("a rescan picks up a file broken after the first scan", () => {
  const dir = newProject()
  writeDefaultPromptsFiles(dir, { overwrite: true })
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(dir), [])

  // The claim is spent, so `scanPromptFiles` is blind to this from here on.
  const filePath = rewritePromptFile(dir, "planner", `${roleOf("planner")}\n${preBlockedCore}\n`)
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(dir), [], "the eager scan stays once per directory")

  assert.equal(rescanPromptFiles(dir), true)
  const findings = overrideFindings(dir)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].agent, "planner")
  assert.equal(findings[0].file, filePath)
  // The planner's own role prompt carries the `Blocked:` contract and the DONE
  // marker, so the delegation block is the one element this file lacks.
  assert.deepEqual([...findings[0].missing], ["delegation-block"])
})

test("a rescan keeps the finding of a file that became unreadable", () => {
  const dir = newProject()
  const filePath = writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  writePromptFile(dir, "planner", "bare template")
  scanPromptFiles(dir)
  assert.deepEqual(overrideFindings(dir).map((f) => f.agent), ["coder", "planner"])

  // A directory where the loader expects a file: statSync succeeds, readFileSync
  // throws EISDIR. Nothing is known about the role — which is not the same as
  // knowing it is clean, so its finding must survive the replace.
  rmSync(filePath, { force: true })
  mkdirSync(filePath, { recursive: true })
  const later = new Date(Date.now() + 2000)
  utimesSync(filePath, later, later)

  assert.equal(rescanPromptFiles(dir), false, "an unreadable role changes nothing")
  const findings = overrideFindings(dir)
  assert.deepEqual(findings.map((f) => f.agent), ["coder", "planner"])
  assert.equal(findings[0].file, filePath)
  assert.deepEqual([...findings[0].missing], ["blocked-contract", "delegation-block"])
})

test("a file that stays broken is logged once, not once per rescan", () => {
  // The rescan runs on every primary idle, so an unconditional log line in a
  // failure branch writes one per turn into the debug log for the life of the
  // session. Driven in a child process because the log path is derived from HOME
  // when src/log.js is loaded.
  const home = mkdtempSync(join(tmpdir(), "intercom-rescan-home-"))
  const dir = newProject()
  mkdirSync(getPromptFilePath(dir, "reviewer"), { recursive: true })

  const promptsfileURL = new URL("../src/promptsfile.js", import.meta.url).href
  const script = `
    import { rescanPromptFiles } from ${JSON.stringify(promptsfileURL)}
    for (let i = 0; i < 5; i++) rescanPromptFiles(${JSON.stringify(dir)})
  `
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, HOME: home, OPENCODE_AGENT_INTERCOM_DEBUG: "1" },
  })
  assert.equal(run.status, 0, run.error?.message ?? run.stderr)

  const debugLog = readFileSync(join(home, ".cache", "opencode-agent-intercom", "debug.log"), "utf8")
  const failures = debugLog.split("\n").filter((line) => line.includes("promptsfile read failed"))
  assert.equal(failures.length, 1, `five rescans over one broken file wrote ${failures.length} lines`)
  assert.match(failures[0], /EISDIR|illegal operation on a directory/)
  rmSync(home, { recursive: true, force: true })
})

test("a rescan over an unchanged directory changes nothing", () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")
  scanPromptFiles(dir)
  const before = overrideBlock(dir)

  assert.equal(rescanPromptFiles(dir), false)
  assert.equal(overrideBlock(dir), before, "byte-identical — nothing on disk moved")
  assert.equal(rescanPromptFiles(dir), false, "and it stays that way however often it runs")
})

test("a rescan is scoped to its directory and refuses an unusable one", () => {
  const first = newProject()
  const second = newProject()
  writePromptFile(first, "coder", "bare template")
  writePromptFile(second, "coder", "bare template")
  scanPromptFiles(first)
  scanPromptFiles(second)

  rewritePromptFile(first, "coder", renderDefaultsFile("coder"))
  assert.equal(rescanPromptFiles(first), true)
  assert.deepEqual(overrideFindings(first), [])
  assert.deepEqual(
    overrideFindings(second).map((f) => f.agent),
    ["coder"],
    "the other project's findings are not this rescan's business",
  )

  assert.equal(rescanPromptFiles(""), false, "no directory, no work")
  assert.equal(rescanPromptFiles(undefined), false)
  assert.equal(overrideFindings().length, 1, "and nothing was cleared under a null scope")
})

test("a rescan needs no claim and does not spend one", () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")

  // Before any eager scan: the rescan is the first thing to touch this
  // directory, and it still judges it.
  assert.equal(rescanPromptFiles(dir), true)
  assert.deepEqual(overrideFindings(dir).map((f) => f.agent), ["coder"])
  assert.equal(claimPromptFileScan(dir), true, "the eager scan's claim is untouched")
})

// ---- the wiring: the primary's `session.idle` -------------------------------
//
// Where the re-scan is called from, and what the two gates in front of it let
// through. The block's own guarantee is the pair at the end: it moves between
// turns and only for a file that actually changed, and it never moves for an
// idle that found nothing.

const idleFor = (hooks, sessionID) =>
  hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

test("a primary's idle re-judges the directory and the next turn drops the line", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  const sid = nextPrimary()

  const before = await primaryTransform(hooks, sid)
  const block = overrideBlock(dir)
  assert.match(before.system[0], /- coder: the prompt file predates/)
  assert.ok(block !== "" && before.system[0].includes(block), "the block is in the stable element")

  // The repair, and the turn boundary that lets the plugin see it.
  rewritePromptFile(dir, "coder", renderDefaultsFile("coder"))
  await idleFor(hooks, sid)

  assert.deepEqual(overrideFindings(dir), [], "no restart needed")
  const after = await primaryTransform(hooks, sid)
  assert.doesNotMatch(after.system[0], /- coder: the prompt file predates/)
  assert.equal(
    after.system[0],
    before.system[0].replace(block, ""),
    "the block's own text is the only thing that moved",
  )
})

test("a file broken mid-session reaches the block on the turn after the next idle", async () => {
  const dir = newProject()
  writeDefaultPromptsFiles(dir, { overwrite: true })
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  const sid = nextPrimary()

  const before = await primaryTransform(hooks, sid)
  assert.doesNotMatch(before.system[0], /project files are overriding/)

  rewritePromptFile(dir, "planner", `${roleOf("planner")}\n${preBlockedCore}\n`)
  await idleFor(hooks, sid)

  const after = await primaryTransform(hooks, sid)
  assert.match(after.system[0], /- planner: the prompt file predates the current prompt contract/)
  assert.ok(after.system[0].includes(getPromptFilePath(dir, "planner")), "the block names the file")
})

test("a subagent's idle re-judges nothing — the scope belongs to the primary", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  const sid = nextPrimary()
  await primaryTransform(hooks, sid)
  upsertSession("ses_sub_idle", {
    agent: "researcher",
    prompt: "task",
    parentID: sid,
    directory: dir,
  })

  rewritePromptFile(dir, "coder", renderDefaultsFile("coder"))
  await idleFor(hooks, "ses_sub_idle")

  assert.deepEqual(
    overrideFindings(dir).map((f) => f.agent),
    ["coder"],
    "a subagent holds no project scope, so its idle is not a re-scan trigger",
  )
})

test("an idle for a session no turn has scoped does nothing", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", `${roleOf("coder")}\n${preBlockedCore}\n`)
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  await primaryTransform(hooks, nextPrimary())

  rewritePromptFile(dir, "coder", renderDefaultsFile("coder"))
  await idleFor(hooks, "ses_unknown_to_this_plugin")

  assert.deepEqual(
    overrideFindings(dir).map((f) => f.agent),
    ["coder"],
    "no held directory, no directory to re-judge",
  )
})

// ---- the stability pins ----------------------------------------------------
//
// Stated in the negative, because they are what stops a later change from
// quietly taking the guarantee away. The first half — two turns with no idle
// between them — is "the block holds its bytes across the turns of a session"
// above, which must keep passing unchanged.

test("an idle that finds nothing changed leaves the next turn byte-identical", async () => {
  const dir = newProject()
  writePromptFile(dir, "coder", "bare template")
  const { ctx } = makeCtx(dir)
  const hooks = await plugin(ctx)
  const sid = nextPrimary()

  const first = await primaryTransform(hooks, sid)
  await idleFor(hooks, sid)
  const second = await primaryTransform(hooks, sid)

  assert.equal(second.system[0], first.system[0], "nine stats, nothing moved")
  assert.match(second.system[0], /- coder: the prompt file predates/, "and the finding still stands")
})
