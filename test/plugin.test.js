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
import { resetState, aborted, pendingTaskIds, lastPrimaryTool } from "../src/state.js"
import { entryForSession, forgetPrimary, trackPrimary, isPrimary } from "../src/registry.js"
import { getSessionDirectory } from "../src/client.js"
import { resetProjectContext } from "../src/project.js"
import { setSettingsPath, resetSettings, getSearxngUrl, getSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  rewritePendingTools,
  resetTurnNotices,
  TODO_TOOLS,
  timeoutSubagent,
} from "../src/hooks.js"
import { AGENTS } from "../src/agents.js"
import { setParamsPath, resetCache as resetLlmParams } from "../src/llmparams.js"
import { setModelsPath, resetCache as resetLlmModels } from "../src/llmmodel.js"
import {
  normalizeUrl,
  parseExaEntries,
  searxToEntries,
  mergeAndDedup,
} from "../src/searchcore.js"
import { setCtagsProbe, probeCtags } from "../src/outline.js"
import { renderDefaultsFile, applyCustomPrompt } from "../src/promptsfile.js"

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
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
  // Restore the real ctags probe + clear its per-process cache so a mock-probe
  // test cannot leak a fake binary path into the real-ctags outline tests.
  setCtagsProbe()
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

// Drives `experimental.chat.messages.transform` the way opencode does — with a
// message list whose last user message belongs to `sessionID` — and returns the
// text the plugin pushed onto it, or "" when it pushed nothing. This is where
// the per-turn blocks live: the abort notice, the primary's active-subagent
// snapshot and the subagent's over-budget STOP notice.
async function turnNotice(hooks, sessionID, messageID = "msg_user1") {
  const messages = [
    { info: { id: messageID, role: "user", sessionID }, parts: [{ type: "text", text: "task" }] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}

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

test("forgetPrimary drops the old primary's directory cache and last-tool marker", async () => {
  const sid = "ses_old_primary"
  trackPrimary(sid)
  lastPrimaryTool.set(sid, "list")

  // Populate the client.js sessionDirCache and count how often the underlying
  // session.get is hit so we can prove the cache was cleared (not just missed).
  let getCalls = 0
  const client = {
    session: {
      get: async () => {
        getCalls += 1
        return { data: { directory: "/tmp/proj" } }
      },
    },
  }
  assert.equal(await getSessionDirectory(client, sid), "/tmp/proj")
  assert.equal(await getSessionDirectory(client, sid), "/tmp/proj") // cached
  assert.equal(getCalls, 1, "second lookup should have been cached")

  forgetPrimary(sid)

  assert.equal(lastPrimaryTool.has(sid), false, "lastPrimaryTool not cleared")
  // Cache was dropped → the next lookup re-fetches.
  assert.equal(await getSessionDirectory(client, sid), "/tmp/proj")
  assert.equal(getCalls, 2, "directory cache was not cleared by forgetPrimary")
})

test("spawn cleans up the orphaned child session when the prompt fails", async () => {
  // createChildSession succeeds, then promptSession throws. Without cleanup the
  // opencode session (and any provisional registry entry) would leak. The
  // handler must best-effort delete the session and report the error.
  const { ctx, created, deleted } = makeCtx()
  ctx.client.session.promptAsync = async () => {
    throw new Error("boom prompt")
  }
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "do x" }, toolCtx)

  assert.match(res.output, /spawn failed: .*boom prompt/i, "original error not surfaced")
  const subID = created[0]
  assert.ok(subID, "a child session should have been created")
  assert.ok(deleted.includes(subID), "orphaned session was not deleted")
  assert.equal(entryForSession(subID), undefined, "a registry entry leaked after the failed spawn")
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

test("abort is ownership-scoped: a primary cannot abort another primary's subagent", async () => {
  // Handles are per-role numbered (researcher#1, …) and the registry is shared
  // across every primary in one opencode serve process, so resolve() can return
  // a subagent owned by a *different* orchestrator. abort() must refuse unless
  // the caller is the parent that spawned it — otherwise two parallel
  // orchestrators would clobber each other's children. The foreign case looks
  // identical to a nonexistent handle ("Unknown subagent") on purpose.
  const { ctx, created, aborted: abortCalls } = makeCtx()
  const hooks = await plugin(ctx)

  const ctxB = { sessionID: "ses_primaryB", agent: "orchestrator", messageID: "mB" }
  const { metadata } = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, ctxB)
  const subID = created[0]

  // Parent A (ses_primary) tries to abort parent B's subagent → refused.
  const res = await hooks.tool.abort.execute({ subagent: metadata.handle }, toolCtx)
  assert.match(res.output, /Unknown subagent/)
  assert.deepEqual(abortCalls, []) // no cooperative abort was signalled
  assert.equal(aborted.has(subID), false) // not marked aborted
  assert.ok(entryForSession(subID)) // the foreign entry is left untouched

  // The rightful parent B can still abort it.
  const ownRes = await hooks.tool.abort.execute({ subagent: metadata.handle }, ctxB)
  assert.match(ownRes.output, /Abort signalled/)
  assert.deepEqual(abortCalls, [subID])
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
  assert.doesNotMatch(await turnNotice(hooks, subID), /ABORTED/)
})

test("session.error teardown keeps the abort marker until deleteSession is through: an in-flight tool call is denied as ABORTED, not misclassified as a primary", async () => {
  // Regression: onSessionError used to run removeEntry (which clears the
  // `aborted` marker) BEFORE deleteSession. In that window the registry entry
  // is gone but the opencode session still exists, so a tool call that raced
  // the teardown fell through to primary-classification (checked against
  // PRIMARY_TOOLS) instead of the hard abort-deny. We gate deleteSession to
  // freeze the teardown mid-flight and assert the classification.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]

  let releaseDelete
  const deleteGate = new Promise((r) => { releaseDelete = r })
  let deleteEntered
  const deleteReached = new Promise((r) => { deleteEntered = r })
  ctx.client.session.delete = async () => {
    deleteEntered()
    await deleteGate
    return { data: true }
  }

  // Fire session.error without awaiting — teardown parks on the delete gate.
  const teardown = hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: subID, error: { name: "SomeError", data: { message: "boom" } } },
    },
  })
  await deleteReached

  // Mid-teardown: registry entry already removed, opencode session not yet
  // deleted. The guard must still deny as ABORTED (not as an orchestrator
  // primary-tool violation).
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: subID, callID: "race" }),
    /aborted by the orchestrator/,
  )

  releaseDelete()
  await teardown

  // No unbounded growth: the marker is cleared once teardown finishes.
  assert.equal(aborted.has(subID), false)
  assert.equal(aborted.size, 0)
})

test("watchdog timeout teardown keeps the abort marker until deleteSession is through, then clears it", async () => {
  // Same invariant as the session.error path, via timeoutSubagent (the
  // inactivity watchdog). deleteSession is gated to inspect mid-teardown state.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  const entry = entryForSession(subID)

  let releaseDelete
  const deleteGate = new Promise((r) => { releaseDelete = r })
  let deleteEntered
  const deleteReached = new Promise((r) => { deleteEntered = r })
  ctx.client.session.delete = async () => {
    deleteEntered()
    await deleteGate
    return { data: true }
  }

  const teardown = timeoutSubagent(entry, 1000, 1000)
  await deleteReached

  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: subID, callID: "race" }),
    /aborted by the orchestrator/,
  )

  releaseDelete()
  await teardown

  assert.equal(aborted.has(subID), false)
  assert.equal(aborted.size, 0)
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
    "glob", "grep", "todos_open", "todo_done", "todo_add", "todo_edit",
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

test("orchestrator permission map denies exactly the TODO tools that exist", () => {
  const perm = AGENTS.orchestrator.permission
  // every real TODO tool must carry an explicit deny — otherwise it stays
  // visible in the orchestrator schema, PRIMARY_TOOLS rejects it, and the guard
  // throws into a denial loop. This test fails the moment a TODO tool is renamed.
  for (const t of TODO_TOOLS) {
    assert.equal(perm[t], "deny", `orchestrator must deny TODO tool ${t}`)
  }
  // no stale deny entries for TODO tools that no longer exist (e.g. todo_block).
  for (const key of Object.keys(perm)) {
    if (/^todo(s)?_/.test(key)) {
      assert.ok(TODO_TOOLS.has(key), `orchestrator has stale TODO deny "${key}" not in TODO_TOOLS`)
    }
  }
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

test("tool.execute.before lets a tracked subagent run work tools (but not delegation)", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  // a tracked subagent is not a primary — it may do actual work itself. The one
  // thing it may NOT do is delegate (spawn/task); that is covered separately.
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: created[0], callID: "s0" })
  await hooks["tool.execute.before"]({ tool: "read", sessionID: created[0], callID: "s1" })
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

test("tool.execute.before hard-denies the native `task` tool from a subagent", async () => {
  // Only the orchestrator delegates: a subagent must not spawn work of its own.
  // checkToolPermission still SKIPS `task` (config.js) — `permission.task` has
  // allowlist / schema-strip semantics, not a plain per-tool deny — so the
  // refusal here comes from a dedicated, UNCONDITIONAL guard line in the
  // subagent branch, independent of config. Even with no `task: "deny"` in the
  // mock config the call is rejected (a project override could not re-open it).
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "task", sessionID: created[0], callID: "t1" }),
    /subagent cannot spawn/i,
  )
})

// --- only-the-orchestrator-delegates enforcement ---------------------------

// The five roles that may delegate: they hold `spawn`, and a spawn of theirs is
// gated at run time (one target, no task id, a per-run quota) rather than by the
// permission map. The three that may not: researcher, because it is the one role
// WITH web tools and its own denial is what bounds nesting at one level;
// designer and gitter, because neither does token-heavy preparatory reading.
const DELEGATING_ROLES = ["planner", "coder", "debugger", "reviewer", "documenter"]
const NON_DELEGATING_ROLES = ["researcher", "designer", "gitter"]

test("spawn is granted to five subagent roles and denied to three; task never", () => {
  const subagents = Object.entries(AGENTS).filter(([, def]) => def.mode === "subagent")
  assert.equal(subagents.length, 8, "expected 8 subagent roles")
  assert.deepEqual(
    subagents.map(([name]) => name).sort(),
    [...DELEGATING_ROLES, ...NON_DELEGATING_ROLES].sort(),
    "every subagent role must be accounted for on one side of the grant",
  )
  for (const [name, def] of subagents) {
    // Unchanged for all eight: opencode's blocking `task` tool and the
    // orchestrator's own fleet controls stay the orchestrator's alone.
    assert.equal(def.permission?.task, "deny", `${name} must deny task`)
    assert.equal(def.permission?.abort, "deny", `${name} must deny abort`)
    assert.equal(def.permission?.list, "deny", `${name} must deny list`)
  }
  for (const name of NON_DELEGATING_ROLES) {
    assert.equal(AGENTS[name].permission?.spawn, "deny", `${name} must deny spawn`)
  }
  for (const name of DELEGATING_ROLES) {
    // Absence, not `"allow"`: an absent key leaves the tool in the schema and
    // lets checkSpawnPermission fall through to allow, and it is what a project
    // override of `permission.spawn` can still close.
    assert.equal(
      AGENTS[name].permission?.spawn, undefined,
      `${name} must carry no spawn key — the absence is the grant`,
    )
  }
  // the orchestrator keeps spawn/abort/list; it is the only role with all three.
  assert.notEqual(AGENTS.orchestrator.permission?.spawn, "deny")
  assert.notEqual(AGENTS.orchestrator.permission?.abort, "deny")
  assert.notEqual(AGENTS.orchestrator.permission?.list, "deny")
})

// --- web access is concentrated in the researcher ---------------------------

const WEB_TOOLS = ["webfetch", "websearch", "web_search", "forum_search"]

test("only the researcher role keeps the web tools — every other role denies all four", () => {
  for (const [name, def] of Object.entries(AGENTS)) {
    if (name === "researcher") continue
    for (const t of WEB_TOOLS) {
      assert.equal(
        def.permission?.[t], "deny",
        `${name} must deny web tool ${t} — only the researcher searches`,
      )
    }
  }
  // the researcher is the single web-capable role: no deny entry on any of the four.
  for (const t of WEB_TOOLS) {
    assert.notEqual(
      AGENTS.researcher.permission?.[t], "deny",
      `researcher must keep web tool ${t}`,
    )
  }
})

test("the denied roles' prompts route a lookup to the researcher instead of searching", () => {
  // no role but the researcher may name a web tool as something IT calls.
  for (const [name, def] of Object.entries(AGENTS)) {
    if (name === "researcher") continue
    assert.doesNotMatch(
      def.prompt ?? "", /web_search|forum_search|webfetch/,
      `${name} prompt must not instruct the role to use a web tool`,
    )
  }
  // the two prompts that used to search now name the researcher route.
  assert.match(AGENTS.planner.prompt, /versions and their compatibility come from a `researcher`/)
  assert.match(AGENTS.debugger.prompt, /cryptic error the lookup comes from a `researcher`/)
  // designer neither searches nor advertises that it can.
  assert.doesNotMatch(AGENTS.designer.description, /research|web/i)
  assert.match(AGENTS.designer.prompt, /no web tools/)
  // the researcher's carve-out: it searches itself and does not hand that on.
  assert.match(AGENTS.researcher.prompt, /never delegate the searching/)
})

test("spawn from a NON-DELEGATING subagent is refused as a tool result and creates no session", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  // the orchestrator spawns a subagent (this also proves the orchestrator path works)
  await hooks.tool.spawn.execute({ agent: "designer", prompt: "x" }, toolCtx)
  const subID = created[0]
  const countBefore = created.length
  // the subagent now tries to spawn another agent -> friendly refusal, no throw,
  // no new session, and the subagent's session is NOT misregistered as primary.
  // designer carries `spawn: "deny"`, so the caller gate refuses before any
  // session is created; the five roles that hold `spawn` take the nested path
  // instead (test/nested-spawn.test.js).
  const subCtx = { sessionID: subID, agent: "designer", messageID: "m2" }
  const res = await hooks.tool.spawn.execute({ agent: "researcher", prompt: "y" }, subCtx)
  assert.match(res.output, /you are a subagent/i)
  assert.equal(created.length, countBefore, "no new session may be created for a subagent spawn")
  assert.equal(isPrimary(subID), false, "subagent caller must not be tracked as a primary")
})

test("the orchestrator (a primary) can still spawn subagents", async () => {
  const { ctx, created, prompted } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute({ agent: "planner", prompt: "do x" }, toolCtx)
  assert.match(res.output, /Spawned subagent "planner#1"/)
  assert.equal(created.length, 1)
  assert.deepEqual(prompted, [created[0]])
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

test("the messages hook shows a primary a live snapshot of its spawned subagents", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const notice = await turnNotice(hooks, "ses_primary")
  assert.match(notice, /active subagents across all orchestrator sessions/i)
  assert.match(notice, /researcher#1 \(researcher\)/)

  // and never in the system prompt, which must hold its bytes across turns
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  assert.doesNotMatch(out.system.join(""), /active subagents across all orchestrator sessions/i)
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

test("orchestration guide exposes the three tools and marker contract without TODO tools", async () => {
  // The guide lists the tool protocol, spawn-prompt format, and marker contract.
  // TODO tools remain absent because the wake hook handles task removal.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  const joined = out.system.join("")
  assert.match(joined, /spawn\(agent, prompt\)/, "guide must list spawn")
  assert.match(joined, /abort\(handle\)/, "guide must list abort")
  assert.match(joined, /\blist\(\)/, "guide must list list()")
  assert.match(joined, /DONE: T<n>.*FIRST or LAST non-empty line/i, "guide must state the marker position")
  assert.match(joined, /marker must occupy a whole line/i, "guide must state whole-line strictness")
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

test("parallel spawns with the same task-id: exactly one wins, the other is refused as duplicate (TOCTOU race)", async () => {
  // Raise the cap well above 2 so the ONLY thing that can refuse a spawn here
  // is the duplicate-task guard, not the concurrency cap — a cap-only reject
  // would mask a broken task-id reservation.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 5 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const results = await Promise.all(
    [0, 1].map(() =>
      hooks.tool.spawn.execute({ agent: "coder", prompt: "T5: build the thing" }, toolCtx),
    ),
  )
  const spawned = results.filter((r) => /Spawned subagent/.test(r.output))
  const refused = results.filter((r) => /already has a subagent running/.test(r.output))
  assert.strictEqual(spawned.length, 1, "exactly one spawn for a task-id may pass")
  assert.strictEqual(refused.length, 1, "the duplicate must be refused, not started")
  assert.equal(pendingTaskIds.size, 0, "no task-id reservation may leak after the spawns settle")
})

test("a spawn that throws still releases its task-id reservation (finally)", async () => {
  const { ctx } = makeCtx()
  // Force the underlying session creation to blow up AFTER the task-id has been
  // reserved but before upsertSession writes it onto an entry — the finally
  // must still drop the reservation.
  ctx.client.session.create = async () => {
    throw new Error("boom")
  }
  const hooks = await plugin(ctx)
  const res = await hooks.tool.spawn.execute({ agent: "coder", prompt: "T9: do it" }, toolCtx)
  assert.match(res.output, /spawn failed/)
  assert.equal(pendingTaskIds.size, 0, "the reservation must be released on the throw path")
})

test("two prefix-free spawns in the same turn do not block each other", async () => {
  // Prefix-free spawns opt out of the task-id guard entirely; raise the cap so
  // the concurrency limit does not interfere with what we are asserting.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 5 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const results = await Promise.all(
    [0, 1].map((i) =>
      hooks.tool.spawn.execute({ agent: "coder", prompt: `ad-hoc question ${i}` }, toolCtx),
    ),
  )
  const spawned = results.filter((r) => /Spawned subagent/.test(r.output))
  const refused = results.filter((r) => /already has a subagent running/.test(r.output))
  assert.strictEqual(spawned.length, 2, "prefix-free spawns must both start")
  assert.strictEqual(refused.length, 0, "no prefix-free spawn may be treated as a duplicate")
  assert.equal(pendingTaskIds.size, 0, "prefix-free spawns must not touch pendingTaskIds")
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

test("a user abort (session.error MessageAbortedError) produces exactly one abort-worded notice, not a failure", async () => {
  const { ctx, created, notices } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "a" }, toolCtx)
  const subID = created[0]
  const before = notices.length
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: subID, error: { name: "MessageAbortedError", data: {} } },
    },
  })
  const emitted = notices.slice(before)
  assert.equal(emitted.length, 1, "exactly one wake notice for the aborted subagent")
  assert.match(emitted[0], /aborted by user/)
  assert.doesNotMatch(emitted[0], /failed/)

  // No second notice can fire afterwards: a stray session.idle for the same
  // (now removed + latched) session is a no-op.
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: subID } } })
  assert.equal(notices.length, before + 1, "no second notice from a following idle event")
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

test("maxSubagents=0 from the file is passed through as 0 (unlimited), not raised to the default", () => {
  // 0 is the documented "no cap" value and must survive verbatim; only invalid
  // values fall back to the built-in default.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 0 }))
  resetSettings()
  assert.equal(getSettings().maxSubagents, 0)
})

test("maxSubagents from the file falls back to the default on negative/non-numeric/missing values", () => {
  for (const bad of [-1, "3", 2.5, null]) {
    writeFileSync(settingsFile, JSON.stringify({ maxSubagents: bad }))
    resetSettings()
    assert.equal(getSettings().maxSubagents, 1, `bad value ${JSON.stringify(bad)} must fall to default`)
  }
  // key entirely absent -> default too
  writeFileSync(settingsFile, JSON.stringify({ maxContext: 12345 }))
  resetSettings()
  assert.equal(getSettings().maxSubagents, 1)
})

test("maxContext=0 from the file is passed through as 0 (budget off)", () => {
  writeFileSync(settingsFile, JSON.stringify({ maxContext: 0 }))
  resetSettings()
  assert.equal(getSettings().maxContext, 0)
})

test("maxSubagents=0 disables the concurrency cap — spawns are unlimited", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 0 }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  for (let i = 0; i < 12; i += 1) {
    const r = await hooks.tool.spawn.execute({ agent: "coder", prompt: `t${i}` }, toolCtx)
    assert.match(r.output, /Spawned subagent/, `spawn ${i} must succeed with the cap disabled`)
    assert.doesNotMatch(r.output, /Subagent limit reached/)
  }
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
  // newest assistant message reports ~70k tokens -> over coder's 60k built-in
  // per-type budget
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 70000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "still working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)

  const notice = await turnNotice(hooks, created[0])
  assert.match(notice, /context has reached/i)
  assert.match(notice, /tool calls are now DISABLED/i)

  // and over budget, the tool-execute guard hard-denies every tool call
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: created[0], callID: "c1" }),
    /context budget/i,
  )
})

test("ignored STOP injections escalate in tone and notify the primary once — no auto-abort", async () => {
  // newest assistant message reports ~70k tokens -> over coder's 60k built-in
  // per-type budget
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 70000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "still working" }],
    },
  ]
  const { ctx, created, notices, aborted: abortedSessions, deleted, toasts } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const subID = created[0]
  const spawnNotice = notices.length // baseline so we can find later additions

  // Turn 1: the messages hook injects the first STOP (warning 1/3), then the
  // LLM still emits a tool call which is denied. No parent notice yet.
  const turn1 = await turnNotice(hooks, subID)
  assert.match(turn1, /warning 1\/3/i)
  assert.match(turn1, /Done:/)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c1" }),
    /context budget/i,
  )
  assert.ok(
    !notices.slice(spawnNotice).some((n) => /stuck/i.test(n)),
    "denial-loop notice fired after only one ignored STOP",
  )

  // Turn 2: warning 2/3 (SECOND WARNING). Still no parent notice.
  const turn2 = await turnNotice(hooks, subID)
  assert.match(turn2, /SECOND WARNING/)
  assert.match(turn2, /warning 2\/3/i)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: subID, callID: "c2" }),
    /SECOND WARNING/,
  )
  assert.ok(
    !notices.slice(spawnNotice).some((n) => /stuck/i.test(n)),
    "denial-loop notice fired after only two ignored STOPs",
  )

  // Turn 3: warning 3/3 (FINAL) AND the parent is notified (once). The counter
  // ticks per LLM call, not per user message: a subagent is one-shot and lives
  // its whole life under the same user message, so the escalation has to run
  // without one arriving.
  const turn3 = await turnNotice(hooks, subID)
  assert.match(turn3, /FINAL WARNING/)
  assert.match(turn3, /warning 3\/3/i)
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
  await turnNotice(hooks, subID)
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

test("the context budget bites per agent type, not globally", async () => {
  // 20k of context: over the coder's configured 10k, well under the
  // researcher's built-in 60k. One budget must not govern the other type.
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 5, agentContext: { coder: 10000 } }))
  resetSettings()
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 20000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "y" }, toolCtx)
  const [coderID, researcherID] = created

  assert.match(await turnNotice(hooks, coderID), /context has reached/i)
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "edit", sessionID: coderID, callID: "c1" }),
    /context budget/i,
  )

  assert.doesNotMatch(await turnNotice(hooks, researcherID), /context has reached/i)
  await hooks["tool.execute.before"]({ tool: "read", sessionID: researcherID, callID: "c2" })
})

test("a file holding only the flat maxContext still governs every agent type", async () => {
  // The legacy key is the migration seed: with no agentContext map, its value
  // is the budget of every type, so 20k of context trips a researcher whose
  // built-in default (60k) would not have bitten.
  writeFileSync(settingsFile, JSON.stringify({ maxContext: 10000 }))
  resetSettings()
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 20000, output: 0, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)

  const notice = await turnNotice(hooks, created[0])
  assert.match(notice, /context has reached/i)
  assert.match(notice, /budget 10.0k/)
})

test("the orchestrator limits block lists the context budget of every spawnable role", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxSubagents: 3, agentContext: { gitter: 0 } }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  const joined = out.system.join("")
  assert.match(joined, /current limits — maxSubagents = 3\./)
  assert.match(joined, /Context budget per agent: /)
  // built-in per-type default, the configured 0 as "off", and no orchestrator
  // entry — the budget governs subagents only.
  assert.match(joined, /coder 60\.0k/)
  assert.match(joined, /researcher 60\.0k/)
  assert.match(joined, /designer 30\.0k/)
  assert.match(joined, /gitter off/)
  assert.doesNotMatch(joined, /orchestrator \d/)
  assert.doesNotMatch(joined, /maxContext = /)
})

test("the limits block tells the orchestrator its notices are hidden, only while hideChatter is on", async () => {
  // With the switch on, a subagent's completion notice is the only copy of
  // its result and nothing renders it, so the orchestrator is told it is the
  // channel to the user.
  writeFileSync(settingsFile, JSON.stringify({ hideChatter: true }))
  resetSettings()
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)
  assert.match(out.system.join(""), /hidden from the user's screen/)
  assert.match(out.system.join(""), /Relay the substance of a subagent's result/)

  // Off — the default — the block is exactly what it was.
  writeFileSync(settingsFile, JSON.stringify({ hideChatter: false }))
  resetSettings()
  const offOut = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, offOut)
  assert.match(offOut.system.join(""), /current limits — maxSubagents = /)
  assert.doesNotMatch(offOut.system.join(""), /hidden from the user's screen/)
})

test("a subagent under the context budget gets no per-turn notice at all", async () => {
  const messages = [
    {
      info: { role: "assistant", tokens: { input: 500, output: 50, cache: { read: 0, write: 0 } } },
      parts: [{ type: "text", text: "working" }],
    },
  ]
  const { ctx, created } = makeCtx({ messages })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)

  assert.equal(await turnNotice(hooks, created[0]), "")
})

test("an empty subagent snapshot is not re-fetched on every tool call (fetch timestamp advances even with no tokens)", async () => {
  // Regression: contextLimitNotice only stamped entry.lastTokensFetchAt when the
  // snapshot carried a token count. With a persistently empty snapshot (no
  // assistant step yet) the timestamp stayed 0, so `cacheFresh` never held and
  // the full-history HTTP fetch re-ran before EVERY subagent LLM call.
  const { ctx, created } = makeCtx({ messages: [] })
  let fetchCalls = 0
  ctx.client.session.messages = async () => {
    fetchCalls += 1
    return { data: [] } // empty → fetchSnapshot yields no ctxTokens
  }
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const subID = created[0]

  // Two transforms back-to-back (well within CTX_TTL_MS). The first fetches;
  // the second must be served from the cache the timestamp now guards.
  await turnNotice(hooks, subID)
  await turnNotice(hooks, subID)
  assert.equal(fetchCalls, 1, "empty snapshot was re-fetched on the second call")
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

test("no role definition carries a sampling parameter — temperature starts unset", async () => {
  // The per-agent sampling params are the user's to set (TUI sidebar ->
  // ~/.config/opencode/llm-params.json). A role that ships a `temperature`
  // would make opencode resolve a value, the sidebar would show it as a
  // pre-filled default instead of "not set", and every request would carry it.
  for (const [name, def] of Object.entries(AGENTS)) {
    assert.ok(!("temperature" in def), `${name} must not define a temperature`)
    assert.ok(!("topP" in def) && !("top_p" in def), `${name} must not define top_p`)
  }
  // and the installed config carries none either
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const config = {}
  await hooks.config(config)
  for (const name of Object.keys(AGENTS)) {
    assert.ok(
      !("temperature" in config.agent[name]),
      `installed ${name} must not carry a temperature`,
    )
  }
})

test("the wired chat.params hook: unset sends nothing, a user value goes through", async () => {
  // End-to-end over the hook opencode actually calls, not just the module
  // function: with the roles carrying no temperature, an agent the user has
  // not tuned must leave the params output without a temperature field.
  const dir = mkdtempSync(join(tmpdir(), "aic-llmparams-"))
  const file = join(dir, "llm-params.json")
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)

    setParamsPath(file) // no file on disk yet
    const untouched = { options: undefined }
    await hooks["chat.params"]({ sessionID: "ses_primary", agent: "coder" }, untouched)
    assert.equal("temperature" in untouched, false, "unset must send no temperature")

    writeFileSync(file, JSON.stringify({ coder: { temperature: 0.42 } }))
    resetLlmParams()
    const tuned = { options: undefined }
    await hooks["chat.params"]({ sessionID: "ses_primary", agent: "coder" }, tuned)
    assert.equal(tuned.temperature, 0.42, "a user-set value must reach the request unchanged")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    setParamsPath(join(homedir(), ".config", "opencode", "llm-params.json"))
  }
})

test("the wired chat.message hook: unset keeps opencode's model, a choice overrides it", async () => {
  // End-to-end over the hook opencode actually calls. `chat.params` cannot
  // carry a model (its output has only sampling fields), so the per-agent model
  // choice lands on the outgoing user message instead.
  const dir = mkdtempSync(join(tmpdir(), "aic-llmmodels-"))
  const file = join(dir, "llm-models.json")
  const outputFor = (agent) => ({
    message: { id: "msg_1", sessionID: "ses_primary", role: "user", agent,
      model: { providerID: "opencode", modelID: "resolved-default" } },
    parts: [],
  })
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)

    setModelsPath(file) // no file on disk yet
    const untouched = outputFor("coder")
    await hooks["chat.message"]({ sessionID: "ses_primary", agent: "coder" }, untouched)
    assert.deepEqual(
      untouched.message.model,
      { providerID: "opencode", modelID: "resolved-default" },
      "unset must leave opencode's resolved model in place",
    )

    writeFileSync(file, JSON.stringify({ coder: { providerID: "anthropic", modelID: "claude-x" } }))
    resetLlmModels()
    const chosen = outputFor("coder")
    await hooks["chat.message"]({ sessionID: "ses_primary", agent: "coder" }, chosen)
    assert.deepEqual(chosen.message.model, { providerID: "anthropic", modelID: "claude-x" })

    // a different agent in the same run is unaffected
    const other = outputFor("reviewer")
    await hooks["chat.message"]({ sessionID: "ses_primary", agent: "reviewer" }, other)
    assert.equal(other.message.model.modelID, "resolved-default")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    setModelsPath(join(homedir(), ".config", "opencode", "llm-models.json"))
  }
})

test("the wired config hook: a stored choice persists as agent.model, others stay bare", async () => {
  // The other half of the same store: what `chat.message` applies per call, the
  // `config` hook writes into the agent definition, so it also holds for a
  // prompt that never reaches the message hook. Bootstrap-only by nature — this
  // drives the hook opencode calls at instance start.
  const dir = mkdtempSync(join(tmpdir(), "aic-configmodels-"))
  const file = join(dir, "llm-models.json")
  try {
    const { ctx } = makeCtx()
    const hooks = await plugin(ctx)

    setModelsPath(file) // no file on disk yet
    const untouched = {}
    await hooks.config(untouched)
    assert.ok(untouched.agent.coder.prompt.length > 0) // roles still installed
    for (const name of Object.keys(untouched.agent)) {
      assert.equal("model" in untouched.agent[name], false, `${name} must carry no model`)
    }

    writeFileSync(
      file,
      JSON.stringify({
        coder: { providerID: "anthropic", modelID: "claude-x" },
        nosuchagent: { providerID: "anthropic", modelID: "claude-x" },
      }),
    )
    resetLlmModels()
    const chosen = {}
    await hooks.config(chosen)
    assert.equal(chosen.agent.coder.model, "anthropic/claude-x")
    assert.equal("model" in chosen.agent.reviewer, false, "an unchosen role stays bare")
    assert.equal(chosen.agent.nosuchagent, undefined, "a stale name creates no agent")

    // and the two halves agree on that same choice
    const message = {
      message: { id: "msg_1", sessionID: "ses_primary", role: "user", agent: "coder",
        model: { providerID: "opencode", modelID: "resolved-default" } },
      parts: [],
    }
    await hooks["chat.message"]({ sessionID: "ses_primary", agent: "coder" }, message)
    assert.equal(
      chosen.agent.coder.model,
      `${message.message.model.providerID}/${message.message.model.modelID}`,
    )

    // an unparseable store leaves the roles exactly as installAgents left them
    writeFileSync(file, "{ not json")
    resetLlmModels()
    const broken = {}
    await hooks.config(broken)
    assert.equal("model" in broken.agent.coder, false)
    assert.ok(broken.agent.orchestrator.prompt.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    setModelsPath(join(homedir(), ".config", "opencode", "llm-models.json"))
  }
})

test("a project that sets a temperature keeps it through the config hook", async () => {
  // The plugin sets none, but the merge must still let a project pin one.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const config = { agent: { coder: { temperature: 0.15 } } }
  await hooks.config(config)
  assert.equal(config.agent.coder.temperature, 0.15)
  assert.ok(config.agent.coder.prompt.length > 0) // plugin fields still merged in
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

test("web_search sends EXA_API_KEY as an x-api-key header, never in the URL query", async () => {
  // The key is a secret: a `?exaApiKey=<secret>` query string would land in
  // proxy/server access logs. It must travel in a header instead. (The live
  // endpoint honors the header — verified out-of-band.)
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  process.env.EXA_API_KEY = "sk-secret-abc123"
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const originalFetch = globalThis.fetch
  let capturedUrl
  let capturedHeaders
  globalThis.fetch = async (url, init) => {
    capturedUrl = url
    capturedHeaders = init.headers
    return {
      ok: true,
      status: 200,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: X\\nURL: https://example.org"}]}}\n',
    }
  }
  try {
    await hooks.tool.web_search.execute({ query: "x" }, {})
    assert.equal(capturedUrl, "https://mcp.exa.ai/mcp", "key must not be appended to the URL")
    assert.doesNotMatch(String(capturedUrl), /exaApiKey/, "secret leaked into the URL query")
    assert.equal(capturedHeaders["x-api-key"], "sk-secret-abc123", "key not sent as x-api-key header")
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.EXA_API_KEY
  }
})

test("web_search omits the x-api-key header when EXA_API_KEY is unset (anonymous tier)", async () => {
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  delete process.env.EXA_API_KEY
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  const originalFetch = globalThis.fetch
  let capturedHeaders
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init.headers
    return {
      ok: true,
      status: 200,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Title: X\\nURL: https://example.org"}]}}\n',
    }
  }
  try {
    await hooks.tool.web_search.execute({ query: "x" }, {})
    assert.equal(capturedHeaders["x-api-key"], undefined)
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

test("web_search names the reason on an Exa isError reply", async () => {
  // HTTP 200 with `isError: true` and the limit text as content is how Exa's
  // free tier answers a rate limit: a failed leg with a reason, never content.
  delete process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":' +
      '[{"type":"text","text":"You\'ve hit Exa\'s free MCP rate limit."}]}}\n',
  })
  try {
    const out = await hooks.tool.web_search.execute({ query: "x" }, {})
    assert.match(out.output, /^websearch failed: exa: You've hit Exa's free MCP rate limit/)
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

// --- ctags binary resolution (probe order + cache) — probe injected, no real
// ctags needed. resolveCtagsBinary tries ~/.local/bin/ctags first (the
// installer's deterministic build), PATH `ctags` only as a fallback; each
// candidate must pass a Universal-Ctags probe.
const localCtags = join(homedir(), ".local", "bin", "ctags")

test("ctags resolution prefers the self-built ~/.local/bin/ctags and skips PATH when it is valid", async () => {
  const probed = []
  setCtagsProbe((bin) => {
    probed.push(bin)
    return bin === localCtags
  })
  assert.equal(await probeCtags(), true)
  // local build passed on the first probe → PATH `ctags` is never probed
  assert.deepEqual(probed, [localCtags])
})

test("ctags resolution falls back to PATH when the self-built binary fails the probe", async () => {
  const probed = []
  setCtagsProbe((bin) => {
    probed.push(bin)
    return bin === "ctags"
  })
  // local build fails the probe, PATH candidate passes → resolution succeeds
  assert.equal(await probeCtags(), true)
  assert.deepEqual(probed, [localCtags, "ctags"])
})

test("ctags resolution yields the existing tool-error (no throw) when neither candidate is valid", async () => {
  const probed = []
  setCtagsProbe((bin) => {
    probed.push(bin)
    return false
  })
  assert.equal(await probeCtags(), false)
  assert.deepEqual(probed, [localCtags, "ctags"])

  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const file = join(fixtureDir, "resolve-none.js")
  writeFileSync(file, "export function a(){}\n")
  const res = await hooks.tool.outline.execute({ path: file }, {})
  assert.match(res.output, /ctags not found on PATH/)
})

test("ctags resolution probes once per process and caches the result", async () => {
  let calls = 0
  setCtagsProbe(() => {
    calls += 1
    return true
  })
  await probeCtags()
  await probeCtags()
  await probeCtags()
  // local candidate passes on the first probe; every later resolution is served
  // from the cache → exactly one probe call total
  assert.equal(calls, 1)
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

test("outline resolves a relative path against the session directory, not the factory directory", skipNoCtags, async () => {
  // The plugin factory runs once per process, so its captured directory is
  // `opencode serve`'s cwd — NOT the session's directory (set per-session via
  // ?directory=). Relative paths must anchor to the SESSION directory, which
  // dirFor pulls from GET /session/<id> → info.directory. Set up a session
  // directory distinct from the factory dir and plant a same-named decoy in the
  // factory dir: correct resolution reads the session copy, never the decoy.
  const sessionDir = mkdtempSync(join(tmpdir(), "intercom-outline-sess-"))
  writeFileSync(join(sessionDir, "rel.js"), "export const RIGHT = 1\n")
  writeFileSync(join(fixtureDir, "rel.js"), "export const WRONG = 2\n")
  const { ctx } = makeCtx()
  ctx.client.session.get = async () => ({ data: { directory: sessionDir } })
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute(
    { path: "rel.js" },
    { sessionID: "ses_outline_rel" },
  )
  assert.match(res.output, /rel\.js:1: export const RIGHT = 1/)
  assert.doesNotMatch(res.output, /WRONG/)
  rmSync(sessionDir, { recursive: true, force: true })
})

test("outline rejects a relative path that escapes the session directory", async () => {
  // `../` traversal resolves outside the session directory — refused as a plain
  // tool-error string (not thrown), before any ctags call. No ctags needed.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute(
    { path: "../escape.js" },
    { sessionID: "ses_outline_escape" },
  )
  assert.match(res.output, /escapes the project directory/)
})

test("outline rejects an absolute path outside the session directory", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute(
    { path: "/etc/hosts" },
    { sessionID: "ses_outline_absout" },
  )
  assert.match(res.output, /escapes the project directory/)
})

test("outline accepts an absolute path inside the session directory", skipNoCtags, async () => {
  const file = join(fixtureDir, "abs-inside.js")
  writeFileSync(file, "export const A = 1\n")
  const { ctx } = makeCtx()
  // Default mock session.get returns fixtureDir, so the session directory is the
  // factory dir here; the absolute path lives inside it and must be accepted.
  const hooks = await plugin(ctx)
  const res = await hooks.tool.outline.execute(
    { path: file },
    { sessionID: "ses_outline_absin" },
  )
  assert.match(res.output, /abs-inside\.js:1: export const A = 1/)
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


// ---------------------------------------------------------------------------
// System-prompt / message split. The system prompt carries only text that holds
// its bytes across the turns of a session, so the provider's cached prefix —
// tool definitions plus system prompt — keeps matching; everything that moves
// per turn is delivered on the message list instead.

// A system string shaped the way opencode assembles one: role prompt, the
// model-identity boilerplate, the <env> block, then the AGENTS.md inject.
// parseOpencodeSystem needs all three markers to produce non-empty slices.
function opencodeSystem({ date = "Sat Aug 29 2026", cwd = "/tmp/proj" } = {}) {
  return (
    "# Role: Orchestrator\nYou coordinate.\n\n" +
    "You are powered by the model named test. The exact model ID is p/test\n" +
    "Here is some useful information about the environment you are running in:\n" +
    `<env>\n  Working directory: ${cwd}\n  Today's date: ${date}\n</env>\n` +
    "Instructions from: /tmp/proj/AGENTS.md\nProject conventions here.\n"
  )
}

test("the system prompt is two elements: the stable mass, then env on its own", async () => {
  // opencode marks the first two system messages for caching and one array
  // element becomes one system message, so both elements get a breakpoint.
  // env stands alone because it is the only block on the stable side that can
  // change by itself — a date rollover or a cwd change then costs the env
  // element instead of the whole mass behind it.
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const out = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, out)

  assert.equal(out.system.length, 2, "expected exactly two system elements")
  assert.match(out.system[0], /# Role: Orchestrator/)
  assert.match(out.system[0], /Project conventions here/)
  assert.match(out.system[0], /orchestration protocol/i)
  assert.match(out.system[0], /current limits — maxSubagents/)
  assert.doesNotMatch(out.system[0], /<env>/, "env leaked into the stable element")

  assert.match(out.system[1], /<env>/)
  assert.match(out.system[1], /Today's date: Sat Aug 29 2026/)
  assert.doesNotMatch(out.system[1], /# Role: Orchestrator/)

  // the model-identity boilerplate is dropped from both
  assert.doesNotMatch(out.system.join(""), /You are powered by the model named/)
})

test("a date or cwd change moves the env element only; the stable element holds its bytes", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  const day1 = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, day1)
  const day2 = { system: [opencodeSystem({ date: "Sun Aug 30 2026", cwd: "/tmp/other" })] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, day2)

  assert.equal(day2.system[0], day1.system[0], "the stable element moved with the date")
  assert.notEqual(day2.system[1], day1.system[1])
})

test("nothing turn-varying leaks into the stable system element", async () => {
  // The orchestrator's normal working state: a subagent running, its snapshot
  // changing on every turn. The system prompt must come out byte-identical.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  const idle = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, idle)

  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  assert.match(await turnNotice(hooks, "ses_primary", "msg_a"), /researcher#1/)

  const busy = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_primary" }, busy)
  assert.deepEqual(busy.system, idle.system, "spawning a subagent changed the system prompt")

  // and the same for a subagent driven over its budget: the STOP notice is on
  // the message list, so its prompt does not move either.
  const subID = created[0]
  const before = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, before)
  entryForSession(subID).ctxTokens = 900000
  entryForSession(subID).lastTokensFetchAt = Date.now()
  assert.match(await turnNotice(hooks, subID, "msg_b"), /context has reached/i)
  const after = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, after)
  assert.deepEqual(after.system, before.system, "the STOP notice moved the system prompt")
})

test("the snapshot is rendered once per user turn and re-rendered on the next one", async () => {
  // Every step of a multi-step tool loop runs the messages hook again. The
  // block hangs off the last user message, which by then has assistant and
  // tool messages behind it, so re-rendering it mid-loop would move the prefix
  // of the loop's own history.
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]

  const step1 = await turnNotice(hooks, "ses_primary", "msg_turn1")
  assert.match(step1, /\? ctx/, "the fresh subagent should have no token count yet")

  entryForSession(subID).ctxTokens = 12345
  const step2 = await turnNotice(hooks, "ses_primary", "msg_turn1")
  assert.equal(step2, step1, "the snapshot was re-rendered inside one user turn")

  const nextTurn = await turnNotice(hooks, "ses_primary", "msg_turn2")
  assert.match(nextTurn, /12.3k ctx/, "the next user turn did not pick up the new figure")
})

test("the abort notice rides on the message list, not the system prompt", async () => {
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const subID = created[0]
  aborted.add(subID)

  assert.match(await turnNotice(hooks, subID), /ABORTED/)
  const out = { system: [opencodeSystem()] }
  await hooks["experimental.chat.system.transform"]({ sessionID: subID }, out)
  assert.doesNotMatch(out.system.join(""), /ABORTED/)
})

test("the per-turn notice is pushed once even if the same message array is transformed twice", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const messages = [
    { info: { id: "msg_u", role: "user", sessionID: "ses_primary" }, parts: [] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  const synthetic = messages[0].parts.filter((part) => part.synthetic)
  assert.equal(synthetic.length, 1, "the notice was appended twice")
  assert.equal(synthetic[0].messageID, "msg_u")
  assert.equal(synthetic[0].sessionID, "ses_primary")
  assert.equal(synthetic[0].type, "text")
})

test("the messages hook is a noop without a user message to hang the notice off", async () => {
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "researcher", prompt: "x" }, toolCtx)
  const messages = [{ info: { id: "msg_a", role: "assistant", sessionID: "ses_primary" }, parts: [] }]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  assert.equal(messages[0].parts.length, 0)
  // and null-safe on the shapes opencode can hand us
  await hooks["experimental.chat.messages.transform"]({}, {})
  await hooks["experimental.chat.messages.transform"]({}, { messages: [null, {}, { info: {} }] })
})

test("the default prompt file no longer advertises the retired placeholders", async () => {
  // The three blocks are delivered as a message and are not template-controlled.
  for (const agent of ["orchestrator", "coder"]) {
    const file = renderDefaultsFile(agent)
    assert.doesNotMatch(file, /\{\{snapshot\}\}/, `${agent} file still writes {{snapshot}}`)
    assert.doesNotMatch(file, /\{\{context_budget\}\}/)
    assert.doesNotMatch(file, /\{\{abort_notice\}\}/)
    assert.match(file, /\{\{env\}\}/)
    assert.match(file, /\{\{project_md\}\}/)
    assert.match(file, /delivered as a message on the/)
  }
  assert.match(renderDefaultsFile("orchestrator"), /\{\{limits\}\}/)
})

test("a user file written before the placeholders were retired degrades to empty, not to a raw token", async () => {
  // substitutePrompt leaves an UNKNOWN key in place so typos stay visible, so
  // the three keys must keep being supplied — as the empty string.
  const rendered = applyCustomPrompt("head {{snapshot}}{{context_budget}}{{abort_notice}} tail", {
    snapshot: "",
    context_budget: "",
    abort_notice: "",
  })
  assert.equal(rendered, "head  tail")
})
