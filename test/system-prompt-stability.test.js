// The invariant the two-element system prompt is built on: element [0] does not
// move between two turns of one session unless a person moved a file it reports
// on. It carries the first cache breakpoint, and a provider matches a cached
// prefix in order — so a byte that moves inside it costs the tool definitions
// ahead of it, element [1] and the trailing message breakpoints with it.
//
// The invariant is stated in the layout comment of `createTransformSystem`
// (src/hooks.js). Prose does not fail a build, so it is pinned here, once per
// branch, against the two things that used to move it:
//
//   - the SUBAGENT branch: the nested-spawn quota counts down inside a run, so
//     a delegating subagent's element [0] used to move once per nested spawn —
//     right after a researcher returned, when its own history was longest. The
//     figure is delivered on the last user message now, and that delivery is
//     pinned in test/nested-delegation.test.js;
//   - the PRIMARY branch: `getSessionDirectory` caches successes only and
//     answers undefined when `session.get` fails, so a transient API failure
//     used to collapse the PROJECT.md block and the limits block's
//     fixed-overhead figures for one turn and restore them on the next. Both
//     are read under the latched primary scope now.
//
// Run: node --test test/system-prompt-stability.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { upsertSession, chargeNestedSpawn, entryForSession } from "../src/registry.js"
import { forgetSessionDirectory } from "../src/client.js"
import { resetTurnNotices } from "../src/hooks.js"
import { _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"

// A project with the files the stable element reports on, so the blocks under
// test are actually rendered rather than empty.
const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-stable-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")
writeFileSync(join(fixtureDir, "PROJECT.md"), "# fixture\n\nA project the limits block sizes.\n")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

after(() => rmSync(fixtureDir, { recursive: true, force: true }))

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  forgetSessionDirectory(PRIMARY)
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// `get` is a field so a test can swap in a failing one for a later turn.
function makeCtx() {
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_child" } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { client, directory: fixtureDir, worktree: fixtureDir, project: {} }
}

// The stable element alone — element [1] is `env`, which is allowed to move.
async function stableElement(hooks, sessionID) {
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system[0]
}

test("a nested spawn does not move a delegating subagent's stable element", async () => {
  const hooks = await plugin(makeCtx())
  upsertSession("ses_planner", {
    agent: "planner",
    prompt: "its own task",
    parentID: PRIMARY,
    directory: fixtureDir,
  })

  const before = await stableElement(hooks, "ses_planner")
  // Exactly what admitting a nested spawn does to the caller's entry — the
  // figure `nestedQuotaDecision` reads, and the whole of what used to move the
  // element between the turn that spawned and the turn after the answer.
  assert.equal(chargeNestedSpawn("ses_planner"), 1)
  const after = await stableElement(hooks, "ses_planner")

  assert.equal(after, before, "the nested-spawn counter reached the cached element")
  assert.ok(before.includes("limits on the work you delegate"), "the block under test is there")
})

// The reply-cap block carries a figure, and a figure in element [0] is what
// this file exists to police. It is resolved from the settings file per call,
// so it belongs where the limits block sits: still inside the stable element,
// moving only when a person moves the settings.
test("the reply-cap block sits in the stable element and does not move between turns", async () => {
  const hooks = await plugin(makeCtx())
  upsertSession("ses_researcher", {
    agent: "researcher",
    prompt: "its own task",
    parentID: PRIMARY,
    directory: fixtureDir,
  })

  const before = await stableElement(hooks, "ses_researcher")
  assert.ok(
    before.includes("agent-intercom: your final reply is capped."),
    "the block under test is in element [0]",
  )
  assert.match(before, /at most ~2000 tokens \(~7000 characters\)/)

  const after = await stableElement(hooks, "ses_researcher")
  assert.equal(after, before, "the reply-cap block moved between two turns of one session")
})

test("a failed session.get does not move the primary's stable element", async () => {
  const ctx = makeCtx()
  const hooks = await plugin(ctx)

  const before = await stableElement(hooks, PRIMARY)
  assert.ok(before.includes("A project the limits block sizes."), "PROJECT.md is in the element")

  // The next turn cannot answer the directory: drop the success the first turn
  // cached, then fail the lookup. Without the latch this collapses the
  // PROJECT.md block to "" and the limits block's fixed-overhead figures to
  // their no-PROJECT.md values.
  forgetSessionDirectory(PRIMARY)
  ctx.client.session.get = async () => {
    throw new Error("session.get: connection reset")
  }
  const after = await stableElement(hooks, PRIMARY)

  assert.equal(after, before, "a transient session.get failure reached the cached element")
})

test("a failed session.get does not drop the primary-scope custom prompt", async () => {
  const promptDir = join(fixtureDir, ".opencode", "agent-intercom")
  const promptPath = join(promptDir, "orchestrator.md")
  mkdirSync(promptDir, { recursive: true })
  writeFileSync(
    promptPath,
    "CUSTOM PRIMARY PROMPT\n{{guide}}\n",
  )

  try {
    const ctx = makeCtx()
    const hooks = await plugin(ctx)
    const before = await stableElement(hooks, PRIMARY)
    assert.match(before, /CUSTOM PRIMARY PROMPT/)

    // Force the second turn to lose its per-turn directory while retaining the
    // scope latched by the first turn. Without the fix, the custom loader sees
    // no directory and the auto-assembled prompt replaces the user's template.
    forgetSessionDirectory(PRIMARY)
    ctx.client.session.get = async () => {
      throw new Error("session.get: connection reset")
    }
    const after = await stableElement(hooks, PRIMARY)

    assert.equal(after, before, "a transient session.get failure dropped the custom prompt")
  } finally {
    rmSync(join(fixtureDir, ".opencode"), { recursive: true, force: true })
  }
})

test("the subagent branch reads its directory off its own entry, not the session API", async () => {
  // The mirror of the test above: a subagent never calls session.get for its
  // directory, so the latch is a primary-only concern and the entry is the one
  // source. Pinned so a later change cannot quietly route it through the API.
  const ctx = makeCtx()
  let getCalls = 0
  ctx.client.session.get = async () => {
    getCalls += 1
    return { data: { directory: fixtureDir } }
  }
  const hooks = await plugin(ctx)
  upsertSession("ses_coder", {
    agent: "coder",
    prompt: "its own task",
    parentID: PRIMARY,
    directory: fixtureDir,
  })

  const element = await stableElement(hooks, "ses_coder")
  assert.equal(getCalls, 0, "the subagent branch looked the directory up over the API")
  assert.equal(entryForSession("ses_coder").directory, fixtureDir)
  assert.ok(element.includes("A project the limits block sizes."), "and got the project files")
})
