// Shared fixture for the prompt-file suites — `prompt-file-staleness.test.js`
// (the probes, the stamp, the eager scan and its outlets) and
// `prompt-file-rescan.test.js` (the in-session re-scan and its `session.idle`
// wiring). Both drive real files in a temp project through the real plugin, and
// this is the part of that setup neither owns alone.
//
// Not a suite of its own: `npm test` collects `test/*.test.js`, so nothing under
// `test/helpers/` is run as a test file.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetState } from "../../src/state.js"
import { resetTurnNotices } from "../../src/hooks.js"
import { resetProjectContext } from "../../src/project.js"
import { resetPermissionGuardCache } from "../../src/config.js"
import { setSettingsPath, resetSettings } from "../../src/settings.js"
import { resetOverrides } from "../../src/overrides.js"
import { getPromptFilePath, resetCache } from "../../src/promptsfile.js"
import { AGENTS } from "../../src/agents.js"
import { SUBAGENT_GUIDE_CORE } from "../../src/prompts.js"

const dirs = []

// `node --test` gives each suite file its own process, so the importing suites
// get one settings file each rather than sharing this one.
const settingsFile = join(
  mkdtempSync(join(tmpdir(), "intercom-promptfile-cfg-")),
  "agent-intercom.json",
)
setSettingsPath(settingsFile)

// One directory per test: the scan is claimed once per directory for the life
// of the process, and a fresh path also keeps the loader's mtime cache from
// answering with the previous test's file.
export function newProject() {
  const dir = mkdtempSync(join(tmpdir(), "intercom-promptfile-"))
  dirs.push(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
  mkdirSync(join(dir, ".opencode", "agent-intercom"), { recursive: true })
  return dir
}

// For the suite's `after` hook.
export function cleanupProjects() {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
}

// For the suite's `beforeEach` hook: every process-wide register these tests
// write to, back to empty.
export function resetPromptFileState() {
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  resetOverrides()
  resetCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
}

// The settings file these suites resolve against: written whole, cache dropped,
// so the next read sees it. The retention latch goes with the cache — a suite
// that wants retention offered writes the file BEFORE the first read that
// latches it.
export function writeSettings(values) {
  writeFileSync(settingsFile, JSON.stringify(values))
  resetSettings()
}

export function writePromptFile(dir, agent, text) {
  const filePath = getPromptFilePath(dir, agent)
  writeFileSync(filePath, text)
  return filePath
}

// Rewrites a prompt file and moves its mtime, which is what the loader keys its
// cache on. The bump is explicit rather than left to the clock: two writes
// inside one filesystem timestamp tick would otherwise be one file to the
// loader.
export function rewritePromptFile(dir, agent, text) {
  const filePath = writePromptFile(dir, agent, text)
  const later = new Date(Date.now() + 2000)
  utimesSync(filePath, later, later)
  return filePath
}

export function makeCtx(dir) {
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
export const nextPrimary = () => `ses_primary_${++primaryCounter}`

export async function primaryTransform(hooks, sessionID = nextPrimary()) {
  const out = { system: ["# Role: Orchestrator\n\nbase prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out
}

// The role prompt heads every file the user starts from, so the fixtures below
// carry it too — several probes would otherwise be answered by the guide alone.
export const roleOf = (agent) => AGENTS[agent].prompt

// The subagent core guide as it read BEFORE the `Blocked:` contract: the one
// line that carries it, removed from the current constant, so the fixture
// cannot drift away from what the file it stands for actually looked like.
export const preBlockedCore = SUBAGENT_GUIDE_CORE.split("\n")
  .filter((line) => !line.startsWith("Blocked:"))
  .join("\n")
