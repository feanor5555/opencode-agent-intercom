// Unit tests for opencode-agent-intercom.
//
// The plugin's default export is the factory: call it with a mock `ctx`
// (fake opencode client), get back the hooks object, then drive the tools
// and hooks directly. No running opencode needed.
//
// Run: node --test test/

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings, getSearxngUrl } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { bytes } from "../src/format.js"
import { rewritePendingTools } from "../src/hooks.js"
import {
  normalizeUrl,
  parseExaEntries,
  searxToEntries,
  mergeAndDedup,
} from "../src/websearch.js"

// outline tests need a working `universal-ctags` binary on PATH or in
// ~/.local/bin. CI/dev machines may not have it; in that case those tests are
// skipped instead of failing — the plugin's installer is what makes ctags
// available, and unit tests should not depend on that side effect.
function detectCtags() {
  for (const exe of ["ctags", join(homedir(), ".local", "bin", "ctags")]) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" })
    if (r.status === 0 && r.stdout && r.stdout.includes("Universal Ctags")) return true
  }
  return false
}
const ctagsAvailable = detectCtags()
const skipNoCtags = ctagsAvailable
  ? {}
  : { skip: "universal-ctags not installed (run npx opencode-agent-intercom-install)" }

// A small, deterministic project directory so the project-context snapshot is
// stable across runs (the mock ctx points `directory` here).
const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-test-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

// Point the settings file at a controlled path so tests are not affected by a
// real ~/.config/opencode/agent-intercom.json on the dev machine.
const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

// The plugin keeps shared state at module scope (opencode instantiates the
// factory once per session within one process, so cross-session state must be
// module-level). Reset it between tests for isolation. `resetState` is imported
// straight from state.js — index.js must stay single-export (see note there).
beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// Builds a fresh mock ctx. `taskPerm` optionally seeds an agent's
// `permission.task` map so the permission path can be exercised. `agentPerm`
// optionally seeds a per-agent `permission` map (e.g. `{ planner: { permission:
// { bash: "deny" } } }`) so the runtime per-agent-deny guard can be exercised;
// when both are set, `agentPerm` is merged over the `taskPerm` seed (so a test
// can pin `orchestrator.permission.task` and add a subagent deny in one mock).
function makeCtx({ taskPerm, agentPerm, messages = [] } = {}) {
  let counter = 0
  const created = []
  const aborted = []
  const deleted = []
  const prompted = []
  const notices = []
  const toasts = []
  const baseAgentConfig = taskPerm ? { orchestrator: { permission: { task: taskPerm } } } : {}
  const agentConfig = agentPerm ? { ...baseAgentConfig, ...agentPerm } : baseAgentConfig
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        prompted.push(opts?.path?.id)
        notices.push((opts?.body?.parts ?? []).map((p) => p?.text ?? "").join(""))
        return { data: undefined }
      },
      abort: async (opts) => {
        aborted.push(opts?.path?.id)
        return { data: true }
      },
      delete: async (opts) => {
        deleted.push(opts?.path?.id)
        return { data: true }
      },
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: messages }),
    },
    tui: {
      showToast: async (opts) => {
        toasts.push(opts?.body)
        return { data: true }
      },
    },
    config: { get: async () => ({ data: { agent: agentConfig } }) },
  }
  return {
    ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} },
    created,
    aborted,
    deleted,
    prompted,
    notices,
    toasts,
  }
}

const toolCtx = { sessionID: "ses_primary", agent: "orchestrator", messageID: "m1" }

test("spawn registers a subagent and returns a friendly handle", async () => {
  const { ctx, created, prompted } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)
  assert.match(res.output, /Spawned subagent "researcher#1"/)
  assert.equal(res.metadata.handle, "researcher#1")
  assert.equal(res.metadata.sessionID, created[0])
  assert.deepEqual(prompted, [created[0]])

  const listed = await hooks.tool.list.execute({}, toolCtx)
  // exactly one entry — no duplicate from the session.created event path
  assert.equal(listed.output.trim().split("\n").length, 1)
  assert.match(listed.output, /researcher#1/)
})

test("the send_message tool is not registered (one-shot subagent lifecycle)", async () => {
  // send_message was removed: subagents are one-shot — they run to a single
  // reply and are then destroyed. The orchestrator cannot inject mid-flight.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  assert.equal(hooks.tool.send_message, undefined)
})

test("abort cleans the subagent up: cooperative abort signal + best-effort session delete + entry reap", async () => {
  // Confirms the abort handler's no-leak behavior:
  //   1. session.abort was called (cooperative signal sent to opencode)
  //   2. session.delete was called (best-effort cleanup of the underlying
  //      opencode session — this is the leak fix)
  //   3. a second abort referencing the same handle returns Unknown (the
  //      registry entry was reaped; the entry must not linger)
  // Pre-cleanup the subagent's tool calls pass through (no false-deny).
  const { ctx, created, aborted, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  const { metadata } = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]

  // before abort: tool calls from the subagent pass through
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: subID, callID: "c0" })

  await hooks.tool.abort.execute({ subagent: metadata.handle }, toolCtx)
  assert.deepEqual(aborted, [subID]) // cooperative abort was signalled
  assert.deepEqual(deleted, [subID]) // AND the opencode session is best-effort deleted (no leak)

  // After abort+cleanup the registry is purged, so a re-abort returns Unknown.
  // This is the user-facing consequence of "no leak": a torn-down subagent is
  // truly gone, not parked as aborted.
  const reabort = await hooks.tool.abort.execute({ subagent: metadata.handle }, toolCtx)
  assert.match(reabort.output, /Unknown subagent/)
})

test("abort cleanup removes the entry: the transform hook does NOT inject ABORTED after the abort handler ran", async () => {
  // Aborting a subagent used to leave the entry in the registry with status
  // "aborted" so the transform hook could inject a hard STOP at the LLM level.
  // That path is now retired: the abort handler itself cleans the entry up, so
  // a subsequent transform finds no aborted entry to annotate. The subagent
  // session is dead at the opencode level anyway (tool calls stop on their own),
  // so the leftover STOPlet would have been belt-and-braces.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const { metadata } = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]

  await hooks.tool.abort.execute({ subagent: metadata.handle }, toolCtx)

  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, out)
  assert.doesNotMatch(out.system.join(""), /ABORTED/)
})

test("spawn honors the caller's permission.task allowlist", async () => {
  const { ctx } = makeCtx({ taskPerm: { "*": "deny", coder: "allow" } })
  const hooks = await plugin(ctx)

  const denied = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  assert.match(denied.output, /Denied/)

  const allowed = await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  assert.match(allowed.output, /Spawned subagent "coder#1"/)
})

test("tool.execute.before restricts a primary to the orchestration tools (spawn/abort/list only)", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  // native task -> denied, redirected to spawn
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_primary", callID: "t0" }),
    /spawn/i,
  )
  // every "do it yourself" tool, including glob/grep and the TODO trio, is now denied
  for (const t of [
    "read", "edit", "write", "bash", "webfetch", "outline",
    "glob", "grep", "todos_open", "todo_done", "todo_block",
  ]) {
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: t, sessionID: "ses_primary", callID: `d-${t}` }),
      /orchestrator/i,
    )
  }
  // only the orchestration tools pass the guard
  for (const t of ["spawn", "abort", "list"]) {
    await hooks["tool.execute.before"]({ tool: t, sessionID: "ses_primary", callID: `a-${t}` })
  }
  // send_message was removed — it must be rejected like any non-orchestration tool
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "send_message", sessionID: "ses_primary", callID: "d-sm" }),
    /orchestrator/i,
  )
})

test("tool.execute.before denies back-to-back list calls from a primary", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  // first list -> allowed
  await hooks["tool.execute.before"]({ tool: "list", sessionID: "ses_primary", callID: "l1" })
  // second consecutive list -> denied
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "list", sessionID: "ses_primary", callID: "l2" }),
    /twice in a row/i,
  )
  // any other primary tool resets the streak -> list is allowed again. glob is
  // no longer allowed for primaries, so route through `spawn` (which DOES reset).
  await hooks["tool.execute.before"]({ tool: "spawn", sessionID: "ses_primary", callID: "sp1" })
  await hooks["tool.execute.before"]({ tool: "list", sessionID: "ses_primary", callID: "l3" })
  // and back-to-back denial still works after the reset
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "list", sessionID: "ses_primary", callID: "l4" }),
    /twice in a row/i,
  )
})

test("tool.execute.before lets a tracked subagent run any tool", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  // a tracked subagent is not a primary — it may do work itself
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: created[0], callID: "s0" })
  await hooks["tool.execute.before"]({ tool: "task", sessionID: created[0], callID: "s1" })
})

// --- per-agent `permission.<tool> = "deny"` runtime re-enforcement ---------
// The agents.js schema strip hides denied tools from the LLM, but the
// guard is a defense-in-depth re-check in case a project override or future
// opencode change re-exposes a denied tool. These tests cover the four
// observable behaviors of that re-check.

test("tool.execute.before hard-denies a subagent calling a tool in its deny map", async () => {
  // planner has `bash: "deny"` — even though the schema strip is what hides
  // `bash` from the planner's LLM, the runtime guard must still hard-deny
  // if the tool is somehow invoked.
  const { ctx, created } = makeCtx({
    agentPerm: { planner: { permission: { bash: "deny" } } },
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "planner", prompt: "x" }, toolCtx)
  await assert.rejects(
    () =>
      hooks["tool.execute.before"]({
        tool: "bash",
        sessionID: created[0],
        callID: "p0",
      }),
    /not permitted to call "bash"/,
  )
})

test("tool.execute.before allows a subagent calling a tool NOT in its deny map", async () => {
  // coder has `bash: "deny"` (matches agents.js config) but no entry for
  // `edit` — the runtime re-check must not over-deny other tools.
  const { ctx, created } = makeCtx({
    agentPerm: { coder: { permission: { bash: "deny" } } },
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  // `edit` is not in the deny map -> allowed
  await hooks["tool.execute.before"]({
    tool: "edit",
    sessionID: created[0],
    callID: "c-edit",
  })
  // `bash` IS in the deny map -> denied
  await assert.rejects(
    () =>
      hooks["tool.execute.before"]({
        tool: "bash",
        sessionID: created[0],
        callID: "c-bash",
      }),
    /not permitted to call "bash"/,
  )
})

test("tool.execute.before does NOT consult the new check for the `task` tool", async () => {
  // `permission.task` is an allowlist, not a plain deny, and its enforcement
  // lives in spawn's checkTaskPermission. A bare `task: "deny"` in the agent
  // config is the signal the schema strip uses to HIDE opencode's native
  // `task` tool from the LLM — it must NOT cause the runtime guard to
  // over-deny when the subagent calls `task`. checkToolPermission explicitly
  // short-circuits on `tool === "task"` and returns null, so the new
  // per-agent-deny path is bypassed.
  const { ctx, created } = makeCtx({
    agentPerm: { researcher: { permission: { task: "deny" } } },
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  // Calling `task` must NOT trip the new per-agent-deny path. For a
  // subagent the existing guard lets `task` through (the schema strip is
  // what hides it from the LLM; the runtime guard doesn't deny it), so
  // this call resolves without throwing.
  await hooks["tool.execute.before"]({
    tool: "task",
    sessionID: created[0],
    callID: "t1",
  })
})

test("tool.execute.before primary behavior is unchanged after the new per-agent-deny check", async () => {
  // The new check is a subagent-only layer (it sits inside the
  // `if (entry)` branch in hooks.js). The primary's existing guard
  // (orchestration-only allowlist, back-to-back list denial) must still
  // work exactly as before.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  // primary calling a non-orchestration tool -> denied (orchestrator reason)
  await assert.rejects(
    () =>
      hooks["tool.execute.before"]({
        tool: "bash",
        sessionID: "ses_primary",
        callID: "p-bash",
      }),
    /orchestrator/i,
  )
  // primary's allowed tools still pass
  for (const t of ["spawn", "abort", "list"]) {
    await hooks["tool.execute.before"]({
      tool: t,
      sessionID: "ses_primary",
      callID: `p-${t}`,
    })
  }
})

test("transform hook injects the orchestration protocol into a primary session", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  assert.match(out.system.join(""), /orchestration protocol/i)
  assert.match(out.system.join(""), /spawn\(agent, prompt\)/)
})

test("transform hook shows a primary a live snapshot of its spawned subagents", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  assert.match(out.system.join(""), /active subagents across all orchestrator sessions/i)
  assert.match(out.system.join(""), /researcher#1 \(researcher\)/)
})

test("list filters subagents by the caller's parentID — no cross-primary leakage", async () => {
  // The subagent cap is GLOBAL (shared across primaries) — raise it so this
  // test isolates the list-filtering concern it actually exercises.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 5 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  // Primary A spawns researcher#1
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  // Primary B spawns its own coder#1 (different sessionID for the caller)
  const otherCtx = { sessionID: "ses_other_primary", agent: "orchestrator", messageID: "m2" }
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "y" }, otherCtx)

  const outA = await hooks.tool.list.execute({}, toolCtx)
  assert.match(outA.output, /researcher#1/)
  assert.doesNotMatch(outA.output, /coder#1/, "primary A must not see primary B's coder")

  const outB = await hooks.tool.list.execute({}, otherCtx)
  assert.match(outB.output, /coder#1/)
  assert.doesNotMatch(outB.output, /researcher#1/, "primary B must not see primary A's researcher")
})

test("orchestration guide exposes the three tools and stays free of TODO mechanics", async () => {
  // The trimmed guide lists only the tool protocol + spawn-prompt format.
  // TODO/DONE-marker mechanics are NOT documented in the orchestrator guide —
  // the orchestrator has no TODO tools and the wake-notice self-explains when
  // a marker is missing or mismatched.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  const joined = out.system.join("")
  assert.match(joined, /spawn\(agent, prompt\)/, "guide must list spawn")
  assert.match(joined, /abort\(handle\)/, "guide must list abort")
  assert.match(joined, /\blist\(\)/, "guide must list list()")
  assert.doesNotMatch(joined, /DONE:/, "guide must not mention DONE-marker mechanics anymore")
  assert.doesNotMatch(joined, /todo_done|todos_open|todo_add|todo_edit/, "guide must not mention TODO tools")
  assert.doesNotMatch(joined, /BLOCKED/, "the blocked feature is gone — guide must not mention it")
})

test("transform hook does not inject the orchestration protocol into a subagent", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: created[0] }, out)
  assert.doesNotMatch(out.system.join(""), /orchestration protocol/i)
})

test("spawn prepends a project-context snapshot to the subagent's task", async () => {
  const { ctx, notices } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "MY ACTUAL TASK" }, toolCtx)
  // notices[0] is the prompt sent to the freshly spawned subagent
  assert.match(notices[0], /project context/i)
  assert.match(notices[0], /fixture-proj/) // package.json name
  assert.match(notices[0], /main\.js/) // file tree
  assert.match(notices[0], /MY ACTUAL TASK/) // the real task is still there
})

test("transform hook injects subagent discipline into a subagent session", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: created[0] }, out)
  assert.match(out.system.join(""), /subagent discipline/i)
  assert.match(out.system.join(""), /[Rr]ead.*before editing/)
})

test("spawn enforces the concurrent-subagent cap and a finished subagent frees a slot", async () => {
  // raise the cap above the default of 1 so we can spawn several without hitting it
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 5 }))
  resetSettings()
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  for (let i = 0; i < 5; i += 1) {
    const r = await hooks.tool.spawn.execute({ agent: "coder", prompt: `t${i}` }, toolCtx)
    assert.match(r.output, /Spawned subagent/)
  }
  const refused = await hooks.tool.spawn.execute({ agent: "coder", prompt: "t6" }, toolCtx)
  assert.match(refused.output, /Subagent limit reached/)

  // a subagent going idle (finishing) frees a slot
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  const afterIdle = await hooks.tool.spawn.execute({ agent: "coder", prompt: "t7" }, toolCtx)
  assert.match(afterIdle.output, /Spawned subagent/)
})

test("parallel spawns in the same turn cannot bypass the concurrency cap (race)", async () => {
  // default cap of 1 — fire 4 spawns simultaneously, exactly 1 must succeed
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const results = await Promise.all(
    [0, 1, 2, 3].map((i) =>
      hooks.tool.spawn.execute({ agent: "coder", prompt: `p${i}` }, toolCtx),
    ),
  )
  const spawned = results.filter((r) => /Spawned subagent/.test(r.output))
  const refused = results.filter((r) => /Subagent limit reached/.test(r.output))
  assert.strictEqual(spawned.length, 1, "exactly one parallel spawn must succeed")
  assert.strictEqual(refused.length, 3, "the other three must be refused by the cap")
})

test("spawn output reports remaining slots; the last allowed spawn says CAP REACHED", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 2 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const first = await hooks.tool.spawn.execute({ agent: "coder", prompt: "a" }, toolCtx)
  assert.match(first.output, /Subagent slots: 1\/2 \(global, across all sessions\) — 1 free/)
  const second = await hooks.tool.spawn.execute({ agent: "coder", prompt: "b" }, toolCtx)
  assert.match(second.output, /CAP REACHED/)
})

test("the completion notice tells the primary how many slots are now free", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 2 }))
  resetSettings()
  const { ctx, created, notices } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "a" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "b" }, toolCtx)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  const wake = notices.find((n) => /finished and been destroyed/.test(n))
  assert.ok(wake, "primary must be woken with the completion notice")
  assert.match(wake, /Subagent slots: 1\/2 \(global, across all sessions\) — 1 free/)
})

test("the settings file overrides the subagent cap at runtime", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 2 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  assert.match((await hooks.tool.spawn.execute({ agent: "coder", prompt: "a" }, toolCtx)).output, /Spawned/)
  assert.match((await hooks.tool.spawn.execute({ agent: "coder", prompt: "b" }, toolCtx)).output, /Spawned/)
  const refused = await hooks.tool.spawn.execute({ agent: "coder", prompt: "c" }, toolCtx)
  assert.match(refused.output, /Subagent limit reached \(2\/2/)
})

test("searxngUrl resolves file > env > empty default", () => {
  const ENV = "OPENCODE_AGENT_INTERCOM_SEARXNG_URL"
  const saved = process.env[ENV]
  try {
    // no file, no env -> empty (searxng disabled)
    delete process.env[ENV]
    resetSettings()
    assert.equal(getSearxngUrl(), "")

    // env only -> env value wins, trailing slash stripped
    process.env[ENV] = "http://env-host:30080/"
    resetSettings()
    assert.equal(getSearxngUrl(), "http://env-host:30080")

    // file present -> file wins over env
    writeFileSync(settingsFile, JSON.stringify({ searxngUrl: "http://file-host:9999/" }))
    resetSettings()
    assert.equal(getSearxngUrl(), "http://file-host:9999")
  } finally {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
    resetSettings()
  }
})

test("a subagent over the context budget gets a wrap-up instruction injected", async () => {
  // newest assistant message reports ~50k tokens -> over the 40k default budget
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 50000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "still working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)

  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: created[0] }, out)
  assert.match(out.system.join(""), /context has reached/i)
  assert.match(out.system.join(""), /tool calls are now DISABLED/i)

  // and over budget, the tool-execute guard hard-denies every tool call
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: created[0], callID: "c1" }),
    /context budget/i,
  )
})

test("ignored STOP injections escalate in tone and notify the primary once — no auto-abort", async () => {
  // newest assistant message reports ~50k tokens -> over the 40k default budget
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 50000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "still working" }],
    },
  ]
  const { ctx, created, notices, aborted: abortedSessions, deleted, toasts } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const subID = created[0]
  const spawnNotice = notices.length // baseline so we can find later additions

  // Turn 1: transformSystem injects the first STOP (warning 1/3), then the
  // LLM still emits a tool call which is denied. No parent notice yet.
  const sys1 = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, sys1)
  assert.match(sys1.system.join(""), /warning 1\/3/i)
  assert.match(sys1.system.join(""), /Done:/)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c1" }),
    /context budget/i,
  )
  assert.ok(
    !notices.slice(spawnNotice).some((n) => /stuck/i.test(n)),
    "denial-loop notice fired after only one ignored STOP",
  )

  // Turn 2: warning 2/3 (SECOND WARNING). Still no parent notice.
  const sys2 = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, sys2)
  assert.match(sys2.system.join(""), /SECOND WARNING/)
  assert.match(sys2.system.join(""), /warning 2\/3/i)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c2" }),
    /SECOND WARNING/,
  )
  assert.ok(
    !notices.slice(spawnNotice).some((n) => /stuck/i.test(n)),
    "denial-loop notice fired after only two ignored STOPs",
  )

  // Turn 3: warning 3/3 (FINAL) AND the parent is notified (once).
  const sys3 = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, sys3)
  assert.match(sys3.system.join(""), /FINAL WARNING/)
  assert.match(sys3.system.join(""), /warning 3\/3/i)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c3" }),
    /FINAL/,
  )

  // Flush microtasks so the fire-and-forget notify completes.
  await new Promise((r) => setImmediate(r))
  const stuckNotice = notices.slice(spawnNotice).find((n) => /stuck/i.test(n))
  assert.ok(stuckNotice, "primary was not notified at the threshold")
  assert.match(stuckNotice, /OVER its context budget/)
  assert.match(stuckNotice, /abort is user-only/)
  assert.ok(
    toasts.some((t) => /stuck/i.test(t?.message ?? "")),
    "no toast was shown to the user",
  )

  // Crucially: subagent must NOT be aborted/deleted. Abort is user-only.
  assert.equal(abortedSessions.includes(subID), false, "subagent was auto-aborted (must not happen)")
  assert.equal(deleted.includes(subID), false, "subagent session was auto-deleted (must not happen)")

  // Turn 4: still over budget, still calling tools. Parent must NOT be notified again.
  const noticesBefore = notices.length
  const sys4 = { system: ["base"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, sys4)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c4" }),
    /FINAL/,
  )
  await new Promise((r) => setImmediate(r))
  assert.equal(
    notices.slice(noticesBefore).filter((n) => /stuck/i.test(n)).length,
    0,
    "denial-loop notice was sent more than once",
  )
})

test("a subagent under the context budget gets no wrap-up instruction", async () => {
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 500, output: 50, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)

  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: created[0] }, out)
  assert.doesNotMatch(out.system.join(""), /WRAP UP/)
})

test("a finished subagent's full result is pushed to the primary's wake notice", async () => {
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "THE FULL SUBAGENT RESULT" }],
    },
  ]
  const { ctx, created, notices } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  assert.match(notices.at(-1), /THE FULL SUBAGENT RESULT/)
})

test("an oversized subagent result is truncated before it lands in the wake notice", async () => {
  // 20 000 chars >> default 8000-char cap; the orchestrator must NOT see the tail.
  const huge = "A".repeat(10000) + "MIDDLE_MARKER" + "B".repeat(10000)
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: huge }],
    },
  ]
  const { ctx, created, notices } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  const wake = notices.find((n) => /finished and been destroyed/.test(n))
  assert.ok(wake, "wake notice missing")
  assert.match(wake, /\[truncated — \d+ more characters omitted/)
  // The tail of the original output must be gone (we kept only the head).
  assert.doesNotMatch(wake, /B{100}/)
  // The completion notice still fits comfortably — well under the 20 000-char
  // unsafe size, with reasonable headroom for the notice framing.
  assert.ok(wake.length < 12000, `wake notice unexpectedly large: ${wake.length} chars`)
})

test("spawn and subagent-idle emit TUI toasts", async () => {
  const { ctx, created, toasts } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  assert.match(toasts.at(-1).message, /spawned researcher#1/)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: created[0] } } })
  assert.match(toasts.at(-1).message, /researcher#1 finished/)
  assert.equal(toasts.at(-1).variant, "success")
})

test("a subagent going idle wakes its primary with a completion notice", async () => {
  const { ctx, created, prompted } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  // so far only the spawn prompt went to the subagent itself
  assert.deepEqual(prompted, [subID])

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  // the primary session got woken via promptAsync
  assert.deepEqual(prompted, [subID, "ses_primary"])

  // idempotent: a repeated idle event finds no entry (the subagent has been
  // destroyed) and is a silent no-op — the primary is NOT woken again
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  assert.deepEqual(prompted, [subID, "ses_primary"])
})

test("a subagent's opencode session is deleted as soon as it goes idle (one-shot cleanup)", async () => {
  const { ctx, created, deleted } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  // the opencode session was deleted in the same idle handler — no timer, no
  // grace period. A one-shot subagent is gone the moment it replies.
  assert.deepEqual(deleted, [subID])
})

test("a finished subagent disappears from the registry — list returns 'No active subagents'", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  const listed = await hooks.tool.list.execute({}, toolCtx)
  assert.match(listed.output, /No active subagents/)
})

test("an aborted subagent going idle does not wake the primary", async () => {
  const { ctx, created, prompted } = makeCtx()
  const hooks = await plugin(ctx)
  const { metadata } = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  await hooks.tool.abort.execute({ subagent: metadata.handle }, toolCtx)

  const before = [...prompted]
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  assert.deepEqual(prompted, before)
})

test("abort resolves the friendly handle and cleans the entry so a re-abort returns Unknown", async () => {
  // The friendly handle resolves via resolve(). After abort, cleanup removes
  // the entry from the registry, so a second abort referencing either the
  // handle or the raw sessionID no longer matches anything. This is the
  // intended behavior — re-aborting a torn-down subagent is meaningless and
  // a no-op signal must NOT leave a fresh entry dangling in the registry.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  const byHandle = await hooks.tool.abort.execute({ subagent: "researcher#1" }, toolCtx)
  assert.match(byHandle.output, /Abort signalled/)

  // After abort+cleanup the entry is gone; a repeat abort returns Unknown.
  const byHandleAgain = await hooks.tool.abort.execute({ subagent: "researcher#1" }, toolCtx)
  assert.match(byHandleAgain.output, /Unknown subagent/)
  const bySessionID = await hooks.tool.abort.execute({ subagent: created[0] }, toolCtx)
  assert.match(bySessionID.output, /Unknown subagent/)

  const unknown = await hooks.tool.abort.execute({ subagent: "nope#9" }, toolCtx)
  assert.match(unknown.output, /Unknown subagent/)
})

test("the config hook installs the plugin's agent roles", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const config = {}
  await hooks.config(config)
  assert.equal(config.agent.orchestrator.mode, "primary")
  for (const name of ["planner", "coder", "debugger", "reviewer", "documenter", "researcher", "designer", "gitter"]) {
    assert.equal(config.agent[name].mode, "subagent")
    assert.ok(config.agent[name].prompt.length > 0)
  }
  // the orchestrator must not have the do-it-yourself tools
  assert.equal(config.agent.orchestrator.permission.bash, "deny")
  assert.equal(config.agent.orchestrator.permission.edit, "deny")
  // and it is made the startup primary
  assert.equal(config.default_agent, "orchestrator")
})

test("the config hook merges non-destructively — a project agent is kept", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const config = { agent: { coder: { prompt: "PROJECT OVERRIDE" } }, default_agent: "build" }
  await hooks.config(config)
  assert.equal(config.agent.coder.prompt, "PROJECT OVERRIDE") // project wins
  assert.ok(config.agent.orchestrator) // other roles still added
  assert.equal(config.default_agent, "build") // explicit default_agent is respected
})

test("the web_search tool is registered by default", async () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  assert.ok(hooks.tool.web_search, "expected web_search tool to be present")
  assert.match(hooks.tool.web_search.description, /Exa AI/i)
})

test("OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH=1 omits the web_search tool", async () => {
  process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH = "1"
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)
    assert.equal(hooks.tool.web_search, undefined)
  } finally {
    delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  }
})

test("web_search hits the Exa MCP endpoint and unwraps the SSE result", async () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  delete process.env.EXA_API_KEY
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const originalFetch = globalThis.fetch
  let capturedUrl
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedBody = JSON.parse(init.body)
    const sse =
      'event: message\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: Spring docs\\nURL: https://example.org\\nHighlights: blah"}]}}\n'
    return {
      ok: true,
      status: 200,
      text: async () => sse,
    }
  }

  try {
    const out = await hooks.tool.web_search.execute(
      { query: "spring framework docs", numResults: 3 },
      {},
    )
    assert.equal(capturedUrl, "https://mcp.exa.ai/mcp")
    assert.equal(capturedBody.method, "tools/call")
    assert.equal(capturedBody.params.name, "web_search_exa")
    assert.equal(capturedBody.params.arguments.numResults, 3)
    assert.match(out.output, /Spring docs/)
    assert.match(out.output, /example\.org/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("web_search surfaces Exa JSON-RPC errors instead of throwing", async () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rate limited"}}\n',
  })
  try {
    const out = await hooks.tool.web_search.execute({ query: "x" }, {})
    assert.match(out.output, /rate limited/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("web_search merges Exa + searxng and de-dupes by normalized URL", () => {
  const exaText =
    "Title: Plugins - OpenCode\n" +
    "URL: https://opencode.ai/docs/plugins/\n" +
    "Published: 2026-07-04\n" +
    "Author: N/A\n" +
    "Highlights:\n" +
    "Plugins allow you to extend OpenCode by hooking into events.\n" +
    "\n---\n" +
    "Title: Exa-only page\n" +
    "URL: https://exa.example/only\n" +
    "Highlights:\n" +
    "unique to exa"

  const searxResults = [
    // same page as Exa but with scheme/trailing-slash noise -> must collapse
    { url: "http://opencode.ai/docs/plugins", title: "Plugins - OpenCode", content: "short" },
    // searxng-only page
    { url: "https://github.com/awesome-opencode/awesome-opencode", title: "awesome", content: "list" },
  ]

  const exaEntries = parseExaEntries(exaText)
  const searxEntries = searxToEntries(searxResults)
  assert.equal(exaEntries.length, 2, "two Exa entries parsed")
  assert.equal(searxEntries.length, 2, "two searxng entries mapped")

  const { merged, duplicates } = mergeAndDedup(exaEntries, searxEntries)
  assert.equal(duplicates, 1, "one duplicate collapsed")
  assert.equal(merged.length, 3, "3 unique URLs after dedup")

  const keys = merged.map((e) => normalizeUrl(e.url))
  assert.equal(new Set(keys).size, keys.length, "no duplicate normalized URLs remain")

  const shared = merged.find((e) => normalizeUrl(e.url) === "opencode.ai/docs/plugins")
  assert.deepEqual([...shared.sources].sort(), ["exa", "searxng"], "shared URL keeps both sources")
  // richer Exa snippet wins over searxng's "short"
  assert.match(shared.content, /extend OpenCode/)

  const sources = new Set(merged.flatMap((e) => e.sources))
  assert.ok(sources.has("exa") && sources.has("searxng"), "merged list has entries of both sources")
})

test("normalizeUrl strips scheme, lowercases host, drops trailing slash", () => {
  assert.equal(normalizeUrl("https://Example.COM/Path/"), "example.com/Path")
  assert.equal(normalizeUrl("http://example.com/path"), "example.com/path")
  assert.equal(normalizeUrl("HTTPS://example.com/a?b=1"), "example.com/a?b=1")
  assert.equal(normalizeUrl(""), "")
  assert.equal(normalizeUrl(null), "")
})

test("the outline tool is registered by default", async () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  assert.ok(hooks.tool.outline, "expected outline tool to be present")
  assert.match(hooks.tool.outline.description, /top-level declarations/i)
})

test("OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE=1 omits the outline tool", async () => {
  process.env.OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE = "1"
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)
    assert.equal(hooks.tool.outline, undefined)
  } finally {
    delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE
  }
})

test("outline emits JS/TS top-level declarations without bodies", skipNoCtags, async () => {
  const file = join(fixtureDir, "outline-js.js")
  writeFileSync(
    file,
    [
      "// header comment",
      "import { foo } from 'bar'",
      "",
      "export function alpha(x) {",
      "  return x + 1",
      "}",
      "",
      "export const beta = 42",
      "",
      "class Gamma {",
      "  constructor(name) {",
      "    this.name = name",
      "  }",
      "  greet() {",
      "    return 'hi ' + this.name",
      "  }",
      "}",
      "",
      "async function delta() {}",
    ].join("\n"),
  )
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /:4: export function alpha\(x\)/)
  assert.match(res.output, /:8: export const beta = 42/)
  assert.match(res.output, /:10: class Gamma/)
  assert.match(res.output, /:11:\s+constructor\(name\)/)
  assert.match(res.output, /:14:\s+greet\(\)/)
  assert.match(res.output, /:19: async function delta\(\)/)
  // bodies must NOT leak through
  assert.doesNotMatch(res.output, /return x \+ 1/)
  assert.doesNotMatch(res.output, /this\.name = name/)
})

test("outline emits Python def/class lines with their colon", skipNoCtags, async () => {
  const file = join(fixtureDir, "outline-py.py")
  writeFileSync(
    file,
    [
      "import os",
      "",
      "def alpha(x):",
      "    return x + 1",
      "",
      "async def beta():",
      "    pass",
      "",
      "class Gamma:",
      "    def greet(self):",
      "        return 'hi'",
      "",
      "    @staticmethod",
      "    def helper():",
      "        return 0",
    ].join("\n"),
  )
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /:3: def alpha\(x\):/)
  assert.match(res.output, /:6: async def beta\(\):/)
  assert.match(res.output, /:9: class Gamma:/)
  assert.match(res.output, /:10:\s+def greet\(self\):/)
  assert.match(res.output, /:14:\s+def helper\(\):/)
  // bodies must NOT leak through
  assert.doesNotMatch(res.output, /return x \+ 1/)
  assert.doesNotMatch(res.output, /return 'hi'/)
})

test("outline emits Rust top-level declarations", skipNoCtags, async () => {
  const file = join(fixtureDir, "outline-rs.rs")
  writeFileSync(
    file,
    [
      "use std::io;",
      "",
      "pub fn alpha(x: i32) -> i32 {",
      "    x + 1",
      "}",
      "",
      "pub(crate) struct Gamma {",
      "    name: String,",
      "}",
      "",
      "impl Gamma {",
      "    pub fn greet(&self) -> String {",
      "        self.name.clone()",
      "    }",
      "}",
      "",
      "pub trait Doable {",
      "    fn run(&self);",
      "}",
    ].join("\n"),
  )
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /:3: pub fn alpha\(x: i32\) -> i32/)
  assert.match(res.output, /:7: pub\(crate\) struct Gamma/)
  assert.match(res.output, /:11: impl Gamma/)
  assert.match(res.output, /:17: pub trait Doable/)
  // bodies must NOT leak through
  assert.doesNotMatch(res.output, /self\.name\.clone\(\)/)
})

test("outline emits Go top-level declarations including methods with receivers", skipNoCtags, async () => {
  const file = join(fixtureDir, "outline-go.go")
  writeFileSync(
    file,
    [
      "package main",
      "",
      "import \"fmt\"",
      "",
      "type Gamma struct {",
      "    Name string",
      "}",
      "",
      "func (g *Gamma) Greet() string {",
      "    return g.Name",
      "}",
      "",
      "func Alpha(x int) int {",
      "    return x + 1",
      "}",
      "",
      "var counter int = 0",
      "const Pi = 3.14",
    ].join("\n"),
  )
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /:5: type Gamma struct/)
  assert.match(res.output, /:9: func \(g \*Gamma\) Greet\(\) string/)
  assert.match(res.output, /:13: func Alpha\(x int\) int/)
  assert.match(res.output, /:17: var counter int = 0/)
  assert.match(res.output, /:18: const Pi = 3\.14/)
  // bodies must NOT leak through
  assert.doesNotMatch(res.output, /return g\.Name/)
})

test("outline emits Markdown heading outline", skipNoCtags, async () => {
  const file = join(fixtureDir, "outline-md.md")
  writeFileSync(
    file,
    [
      "# Title",
      "",
      "intro paragraph",
      "",
      "## Section one",
      "",
      "content",
      "",
      "### Subsection",
      "",
      "more content",
      "",
      "## Section two",
    ].join("\n"),
  )
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /:1: # Title/)
  assert.match(res.output, /:5: ## Section one/)
  assert.match(res.output, /:9: ### Subsection/)
  assert.match(res.output, /:13: ## Section two/)
  assert.doesNotMatch(res.output, /intro paragraph/)
})

test("outline reports no declarations when ctags finds nothing in the file", skipNoCtags, async () => {
  // No keywords, no extension ctags recognises → no tags emitted.
  const file = join(fixtureDir, "outline-empty.xyz")
  writeFileSync(file, "just some random plain text\nwith another line\n")
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /no declarations found/)
})

test("outline reports file-not-found cleanly", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute(
    { path: join(fixtureDir, "does-not-exist.js") },
    {},
  )
  assert.match(res.output, /file not found/)
})

test("outline truncates after the per-file declaration cap", skipNoCtags, async () => {
  const lines = []
  // 250 top-level functions — exceeds the 200-cap by 50.
  for (let i = 0; i < 250; i += 1) lines.push(`function fn${i}() { return ${i} }`)
  const file = join(fixtureDir, "outline-huge.js")
  writeFileSync(file, lines.join("\n"))
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /\[truncated — 50 more declarations\]/)
  // The first 200 declarations are present, the 200th cannot be the cutoff
  // sentinel itself.
  assert.match(res.output, /:1: function fn0\(\)/)
  assert.match(res.output, /:200: function fn199\(\)/)
  assert.doesNotMatch(res.output, /:201: function fn200\(\)/)
})

test("outline resolves a relative path against the project directory", skipNoCtags, async () => {
  writeFileSync(join(fixtureDir, "rel.js"), "export const Z = 1\n")
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute({ path: "rel.js" }, {})
  assert.match(res.output, /rel\.js:1: export const Z = 1/)
})

test("the config hook disables outline for designer, gitter and orchestrator", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const config = {}
  await hooks.config(config)
  assert.equal(config.agent.designer.permission.outline, "deny")
  assert.equal(config.agent.gitter.permission.outline, "deny")
  assert.equal(config.agent.orchestrator.permission.outline, "deny")
  // a regular subagent leaves outline enabled (no entry in the permission map)
  assert.equal(config.agent.planner.permission?.outline, undefined)
})

// Formatter tests for bytes()
test("bytes formatter returns raw number for values under 1 KB", () => {
  assert.equal(bytes(0), "0")
  assert.equal(bytes(512), "512")
  assert.equal(bytes(1023), "1023")
  assert.equal(bytes(100), "100")
})

test("bytes formatter returns KB for values between 1 KB and 1 MB", () => {
  assert.equal(bytes(1024), "1.0 KB")
  assert.equal(bytes(1536), "1.5 KB")
  assert.equal(bytes(2048), "2.0 KB")
  assert.equal(bytes(5120), "5.0 KB")
  assert.equal(bytes(1024 * 1023), "1023.0 KB")
})

test("bytes formatter returns MB for values between 1 MB and 1 GB", () => {
  assert.equal(bytes(1024 * 1024), "1.0 MB")
  assert.equal(bytes(1572864), "1.5 MB")
  assert.equal(bytes(1024 * 1024 * 512), "512.0 MB")
  assert.equal(bytes(1024 * 1024 * 1023), "1023.0 MB")
})

test("bytes formatter returns GB for values 1 GB and above", () => {
  assert.equal(bytes(1024 * 1024 * 1024), "1.0 GB")
  assert.equal(bytes(1572864000), "1.5 GB")
  assert.equal(bytes(1024 * 1024 * 1024 * 100), "100.0 GB")
})

test("bytes formatter returns (unknown) for null/undefined", () => {
  assert.equal(bytes(null), "(unknown)")
  assert.equal(bytes(undefined), "(unknown)")
  assert.equal(bytes(NaN), "(unknown)")
})

// rewritePendingTools — see hooks.js for the full rationale (root cause of
// the llama.cpp prefill-400 plugin-class).
test("rewritePendingTools converts a pending tool-part to completed with a denial output", () => {
  const messages = [
    { info: { role: "user", id: "1" }, parts: [{ type: "text", text: "hi" }] },
    {
      info: { role: "assistant", id: "2" },
      parts: [
        { type: "step-start" },
        { type: "reasoning", text: "" },
        { type: "tool", tool: "list", state: { status: "pending", input: {} } },
      ],
    },
  ]
  const n = rewritePendingTools(messages)
  assert.equal(n, 1)
  const part = messages[1].parts[2]
  assert.equal(part.state.status, "completed")
  assert.match(part.state.output, /agent-intercom/)
  assert.equal(part.state.metadata.truncated, false)
  assert.ok(part.state.time?.start != null && part.state.time?.end != null)
})

test("rewritePendingTools leaves completed and errored tool-parts unchanged", () => {
  const completedOutput = "actual tool result"
  const messages = [
    {
      info: { role: "assistant", id: "1" },
      parts: [
        { type: "tool", tool: "spawn", state: { status: "completed", input: {}, output: completedOutput } },
        { type: "tool", tool: "abort", state: { status: "error", input: {}, output: "boom" } },
      ],
    },
  ]
  const n = rewritePendingTools(messages)
  assert.equal(n, 0)
  assert.equal(messages[0].parts[0].state.output, completedOutput)
  assert.equal(messages[0].parts[1].state.status, "error")
})

test("rewritePendingTools rewrites multiple pending tools and ignores non-assistant messages", () => {
  const messages = [
    {
      info: { role: "user", id: "1" },
      parts: [{ type: "tool", tool: "x", state: { status: "pending", input: {} } }],
    },
    {
      info: { role: "assistant", id: "2" },
      parts: [
        { type: "tool", tool: "list", state: { status: "pending", input: {} } },
        { type: "tool", tool: "spawn", state: { status: "pending", input: {} } },
      ],
    },
  ]
  const n = rewritePendingTools(messages)
  assert.equal(n, 2)
  assert.equal(messages[0].parts[0].state.status, "pending")
  assert.equal(messages[1].parts[0].state.status, "completed")
  assert.equal(messages[1].parts[1].state.status, "completed")
})

test("rewritePendingTools is null-safe", () => {
  assert.equal(rewritePendingTools(undefined), 0)
  assert.equal(rewritePendingTools(null), 0)
  assert.equal(rewritePendingTools([]), 0)
  assert.equal(rewritePendingTools([null, {}, { info: null }]), 0)
  assert.equal(rewritePendingTools([{ info: { role: "assistant" }, parts: null }]), 0)
  assert.equal(
    rewritePendingTools([{ info: { role: "assistant" }, parts: [{ type: "tool", state: null }] }]),
    0,
  )
})
