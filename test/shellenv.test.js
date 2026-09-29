// The `shell.env` hook: a subagent's shell gets the plugin's `bin/shims` in
// front of its PATH and its own `PW_SESSION`; every other session's shell is
// left as it is, and a failure inside the hook never reaches the shell call.
//
// Run: node --test test/shellenv.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, statSync, readFileSync } from "node:fs"
import { delimiter, join } from "node:path"

import plugin from "../src/index.js"
import { upsertSession } from "../src/registry.js"
import { SHIM_DIR, shellEnvHook } from "../src/shellenv.js"
import { newProject, cleanupProjects, resetPromptFileState, makeCtx } from "./helpers/prompt-files.js"

after(cleanupProjects)
beforeEach(resetPromptFileState)

function subagent(sessionID, agent = "verifier") {
  upsertSession(sessionID, { agent, prompt: "check it", parentID: "ses_parent", directory: "/tmp/proj" })
}

test("a subagent session gets the shim directory first on PATH and its own PW_SESSION", () => {
  subagent("ses_sub")
  const output = { env: {} }
  shellEnvHook({ sessionID: "ses_sub", cwd: "/tmp/proj" }, output)
  const entries = output.env.PATH.split(delimiter)
  assert.equal(entries[0], SHIM_DIR)
  assert.deepEqual(entries.slice(1), (process.env.PATH ?? "").split(delimiter))
  assert.equal(output.env.PW_SESSION, "ses_sub")
})

test("a PATH already in the output is the one the shims go in front of", () => {
  subagent("ses_sub")
  const output = { env: { PATH: `/opt/a${delimiter}/opt/b` } }
  shellEnvHook({ sessionID: "ses_sub" }, output)
  assert.equal(output.env.PATH, `${SHIM_DIR}${delimiter}/opt/a${delimiter}/opt/b`)
})

test("every subagent role gets it, the debugger included", () => {
  subagent("ses_debug", "debugger")
  const output = { env: {} }
  shellEnvHook({ sessionID: "ses_debug" }, output)
  assert.ok(output.env.PATH.startsWith(SHIM_DIR))
  assert.equal(output.env.PW_SESSION, "ses_debug")
})

test("a primary or unknown session's env is left untouched", () => {
  for (const sessionID of ["ses_primary", undefined, ""]) {
    const output = { env: { KEEP: "1" } }
    shellEnvHook({ sessionID }, output)
    assert.deepEqual(output.env, { KEEP: "1" }, String(sessionID))
  }
})

test("a throw inside the hook is caught", () => {
  subagent("ses_sub")
  const output = {}
  Object.defineProperty(output, "env", {
    get() {
      throw new Error("env exploded")
    },
  })
  assert.doesNotThrow(() => shellEnvHook({ sessionID: "ses_sub" }, output))
})

test("the plugin registers the hook, and the shim it points at runs bin/pw.js", async () => {
  const { ctx } = makeCtx(newProject())
  const hooks = await plugin(ctx)
  assert.equal(typeof hooks["shell.env"], "function")
  subagent("ses_sub")
  const output = { env: {} }
  await hooks["shell.env"]({ sessionID: "ses_sub", cwd: "/tmp/proj" }, output)
  assert.equal(output.env.PW_SESSION, "ses_sub")

  const shim = join(SHIM_DIR, "pw")
  assert.ok(existsSync(shim), "bin/shims/pw ships with the plugin")
  assert.ok((statSync(shim).mode & 0o111) !== 0, "the shim is executable")
  assert.match(readFileSync(shim, "utf8"), /^#!\/bin\/sh\nexec node "\$\(dirname "\$0"\)\/\.\.\/pw\.js" "\$@"\n$/)
})
