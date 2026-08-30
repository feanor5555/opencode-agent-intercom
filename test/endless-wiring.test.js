// The wiring that decides whether endless mode ever runs at all — the two
// seams above the well-covered layers underneath:
//
//   - the schedule side, `experimental.chat.system.transform` (src/hooks.js):
//     which of the two branches a primary turn takes, and which latch each one
//     leaves standing. Driven through the REAL plugin factory against a real
//     settings file, so the branch is read the way production reads it.
//   - the idle side, `maybeRunPendingEndless` (src/handoffwiring.js): whether
//     a latched cycle may start, and which settings reach the cycle.
//
// Stop #5 of the design is "the switch": turning the sidebar row off stops the
// mode. The transform hook's off-branch cannot serve that on its own — it
// needs another turn from the primary, and the ordinary sequence sets the
// latch during the turn that crosses the ceiling with the idle event following
// it immediately. So the setting is read on the idle side too, before the
// claim.
//
// Run: node --test --test-timeout=4000 test/endless-wiring.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState, pendingSpawns } from "../src/state.js"
import {
  markEndlessPending,
  isEndlessPaused,
  pauseEndless,
  markHandoffPending,
  claimPendingEndless,
  hasEndlessPending,
  hasHandoffPending,
  isEndlessInProgress,
  endlessCooldownActive,
  recordPrimaryContext,
  beginHandoffDrain,
  bindHandoffDrainTarget,
  flushHandoffDrain,
} from "../src/registry.js"
import { maybeRunPendingEndless } from "../src/handoffwiring.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"

const SID = "ses-endless-wiring"

// A client that would throw on any use: nothing in these cases may reach the
// session API — the decision is taken before the first round trip.
const noClient = new Proxy(
  {},
  {
    get() {
      throw new Error("the client must not be touched before the cycle is claimed")
    },
  },
)

// The project the primary turn runs in, and the settings file beside it. One
// directory for the whole file: `settings` rewrites that same file, which is
// how the sidebar toggle reaches the plugin.
const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-endless-wiring-"))
writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-proj" }))
const settingsFile = join(fixtureDir, "agent-intercom.json")

function settings(content) {
  writeFileSync(settingsFile, JSON.stringify(content))
  setSettingsPath(settingsFile)
  resetSettings()
}

beforeEach(() => {
  resetState()
  setSettingsPath(settingsFile)
  resetProjectContext()
  resetPermissionGuardCache()
  resetSettings()
})

// A mock opencode client, enough for one primary turn through the transform
// hook and for the idle path's own session read.
function makeCtx() {
  const created = []
  const toasts = []
  const client = {
    session: {
      create: async () => {
        created.push("ses_sub")
        return { data: { id: `ses_sub${created.length}` } }
      },
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      update: async () => ({ data: {} }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async (args) => (toasts.push(args), { data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created, toasts }
}

// One primary turn through the REAL transform hook, with the context count
// seeded so the hook's own TTL-guarded refresh leaves it standing.
async function primaryTurn(hooks, ctxTokens) {
  recordPrimaryContext(SID, ctxTokens)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: SID }, out)
}

test("no latch: the idle path leaves before any session call", async () => {
  settings({ endlessMode: true })
  assert.equal(await maybeRunPendingEndless(noClient, SID), null)
})

test("the mode switched off drops the latched cycle instead of running it", async () => {
  settings({ endlessMode: false })
  markEndlessPending(SID)
  assert.equal(await maybeRunPendingEndless(noClient, SID), null)
  assert.equal(
    hasEndlessPending(SID),
    false,
    "the latch is cleared, so the freeze lifts and spawn works again",
  )
})

test("a cycle already executing is not stopped by the switch", async () => {
  settings({ endlessMode: false })
  markEndlessPending(SID)
  claimPendingEndless(SID)
  // hasEndlessPending is false once the claim consumed the latch, so the idle
  // path returns before the settings read — and the running cycle, which has
  // written to the todo file, is left to finish.
  assert.equal(await maybeRunPendingEndless(noClient, SID), null)
  assert.equal(isEndlessInProgress(SID), true)
})

// ---------------------------------------------------------------------------
// The schedule side: which branch a primary turn takes
// ---------------------------------------------------------------------------

test("the transform hook arms the endless latch when the mode is on", async () => {
  settings({ endlessMode: true, endlessContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  await primaryTurn(hooks, 5000)

  assert.equal(hasEndlessPending(SID), true, "endlessContext is the threshold in effect")
  assert.equal(hasHandoffPending(SID), false, "the plain handoff does not own this crossing")
})

test("the transform hook arms the plain handoff when the mode is off", async () => {
  settings({ endlessMode: false, maxPrimaryContext: 1, endlessContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)

  await primaryTurn(hooks, 5000)

  assert.equal(hasHandoffPending(SID), true)
  assert.equal(hasEndlessPending(SID), false)
})

test("the switch turned off between two turns drops the endless latch and hands the threshold back", async () => {
  settings({ endlessMode: true, endlessContext: 1, maxPrimaryContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  await primaryTurn(hooks, 5000)
  assert.equal(hasEndlessPending(SID), true)

  settings({ endlessMode: false, endlessContext: 1, maxPrimaryContext: 1 })
  await primaryTurn(hooks, 5000)

  assert.equal(hasEndlessPending(SID), false, "the freeze lifts with the latch")
  assert.equal(hasHandoffPending(SID), true, "the plain handoff owns the threshold again")
})

test("the switch turned on drops an unclaimed plain-handoff latch", async () => {
  // Both latches live at once otherwise, and the idle handler fires both
  // executors on the same primary.
  settings({ endlessMode: true, endlessContext: 1, maxPrimaryContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  markHandoffPending(SID)

  await primaryTurn(hooks, 5000)

  assert.equal(hasHandoffPending(SID), false, "only one executor may fire on this primary")
  assert.equal(hasEndlessPending(SID), true)
})

// ---------------------------------------------------------------------------
// The idle side: the event handler reaches the executor, and with which settings
// ---------------------------------------------------------------------------

test("a primary's session.idle event reaches maybeRunPendingEndless", async () => {
  // Read through stop #5: the mode is off, so the executor's own settings read
  // drops the latch. That drop is the observable proof the event handler got
  // there, and it costs no session call — everything before the drop is
  // synchronous.
  settings({ endlessMode: false })
  const { ctx, created } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(SID)

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: SID } } })

  assert.equal(hasEndlessPending(SID), false)
  assert.deepEqual(created, [], "no replacement session was created")
})

test("endlessQuiesceTimeoutMs reaches the cycle: a busy process abandons at quiesce", async () => {
  // The one settings value the cycle spends before it touches anything. At 0
  // the very first poll is already over the bound, so a reserved-but-unentered
  // spawn slot — which counts as running — abandons the cycle immediately.
  settings({ endlessMode: true, endlessQuiesceTimeoutMs: 0 })
  const { ctx, created, toasts } = makeCtx()
  markEndlessPending(SID)
  pendingSpawns.count = 1

  const res = await maybeRunPendingEndless(ctx.client, SID)

  assert.equal(res.outcome, "abandoned")
  assert.equal(res.stage, "quiesce")
  assert.match(res.reason, /still busy after 0ms/)
  assert.deepEqual(created, [], "the primary is not replaced")
  assert.equal(hasEndlessPending(SID), false, "the latch is released, so the freeze lifts")
  assert.equal(endlessCooldownActive(SID), true, "an abandoned cycle arms the cooldown")
  assert.match(toasts.at(-1).body.message, /cycle abandoned at quiesce/)
})

test("endlessMaxCycles reaches the cycle: a spent ceiling stops it before the quiesce wait", async () => {
  // handoffGeneration counts the redirect chain, so one completed handoff puts
  // this primary at generation 2 — one cycle done. With the ceiling at 1 the
  // next cycle is refused, and the refusal PAUSES this primary without writing
  // a byte of the settings file: the mode is on by default, and a self-stop
  // that persisted `endlessMode: false` would disable that default for good.
  settings({ endlessMode: true, endlessMaxCycles: 1 })
  const before = readFileSync(settingsFile, "utf8")
  const { ctx, created, toasts } = makeCtx()
  beginHandoffDrain("ses-endless-wiring-prev")
  bindHandoffDrainTarget("ses-endless-wiring-prev", SID)
  flushHandoffDrain("ses-endless-wiring-prev")
  markEndlessPending(SID)

  const res = await maybeRunPendingEndless(ctx.client, SID)

  assert.equal(res.outcome, "ceiling")
  assert.deepEqual(created, [], "nothing is written or replaced at the ceiling")
  assert.match(toasts.at(-1).body.message, /cycle ceiling reached \(1\/1\)/)
  assert.equal(readFileSync(settingsFile, "utf8"), before, "the settings file is untouched")
  assert.equal(isEndlessPaused(SID), true, "the stop holds as a pause on this primary")
  assert.equal(endlessCooldownActive(SID), false, "a deliberate stop arms no cooldown")
})

// ---------------------------------------------------------------------------
// The pause a self-stop leaves behind
// ---------------------------------------------------------------------------

test("a paused primary arms the plain handoff instead of a cycle", async () => {
  // The stop ends the loop, not the session's relief from its own context: with
  // the endless threshold left in effect nothing would arm at all — the pause
  // refuses the cycle — and the session would grow until the provider's own
  // limit ended it.
  settings({ endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "cycle ceiling reached (1/1) — paused for this session")

  await primaryTurn(hooks, 100000)

  assert.equal(hasEndlessPending(SID), false, "the pause suppresses the re-arm")
  assert.equal(
    hasHandoffPending(SID),
    true,
    "maxPrimaryContext owns the threshold on a paused primary, and it is crossed",
  )
})

test("a paused primary below maxPrimaryContext arms neither", async () => {
  settings({ endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "no open points left — paused for this session")

  await primaryTurn(hooks, 50000)

  assert.equal(hasEndlessPending(SID), false)
  assert.equal(hasHandoffPending(SID), false, "the plain threshold is a threshold, not a trigger")
})

test("the plain handoff a paused primary arms does not lift the pause", async () => {
  // The re-entry the pause exists to prevent: were the pause cleared by the
  // branch that arms the plain handoff, endless mode would own the threshold
  // again on the very next turn and the stop would have lasted one turn.
  settings({ endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "cycle ceiling reached (1/1) — paused for this session")

  await primaryTurn(hooks, 100000)
  await primaryTurn(hooks, 300000)

  assert.equal(isEndlessPaused(SID), true, "the pause survives the handoff decision")
  assert.equal(
    hasEndlessPending(SID),
    false,
    "even over endlessContext the paused primary starts no cycle",
  )
  assert.equal(hasHandoffPending(SID), true)
})

test("a paused primary drops an unclaimed endless latch on its next turn", async () => {
  // The latch can only be one set before the stop landed. It has to go, or the
  // spawn freeze holds on a session that will never run the cycle.
  settings({ endlessMode: true, endlessContext: 250000, maxPrimaryContext: 80000 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  markEndlessPending(SID)
  pauseEndless(SID, "no open points left — paused for this session")

  await primaryTurn(hooks, 100000)

  assert.equal(hasEndlessPending(SID), false, "the freeze lifts with the latch")
  assert.equal(hasHandoffPending(SID), true)
})

test("the paused primary is told so in its own limits block", async () => {
  settings({ endlessMode: true, endlessContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "no open points left — paused for this session")

  recordPrimaryContext(SID, 5000)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID: SID }, out)
  const system = out.system.join("\n")

  assert.match(system, /Endless mode is PAUSED for this session — no open points left/)
  assert.match(system, /nothing was written to the settings/)
  assert.match(
    system,
    /ordinary orchestrator handoff still applies/,
    "the block stays truthful: the paused session is still relieved at the plain limit",
  )
  assert.doesNotMatch(
    system,
    /no further context refresh/,
    "the sentence that described the unrelieved paused session is gone",
  )
})

test("a fresh primary is not paused, so the mode is available again after a replacement", async () => {
  settings({ endlessMode: true, endlessContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "cycle ceiling reached (1/1) — paused for this session")

  recordPrimaryContext("ses-endless-wiring-new", 5000)
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses-endless-wiring-new" },
    out,
  )

  assert.equal(hasEndlessPending("ses-endless-wiring-new"), true)
  assert.doesNotMatch(out.system.join("\n"), /Endless mode is PAUSED/)
})

test("a paused primary that still carries a latch has it dropped on the idle side", async () => {
  settings({ endlessMode: true })
  markEndlessPending(SID)
  pauseEndless(SID, "no open points left — paused for this session")

  assert.equal(await maybeRunPendingEndless(noClient, SID), null)
  assert.equal(hasEndlessPending(SID), false, "the latch is dropped, so the freeze lifts")
})

test("the user switching the mode off clears the pause and hands the threshold back", async () => {
  settings({ endlessMode: true, endlessContext: 1, maxPrimaryContext: 1 })
  const { ctx } = makeCtx()
  const hooks = await plugin(ctx)
  pauseEndless(SID, "cycle ceiling reached (1/1) — paused for this session")

  settings({ endlessMode: false, endlessContext: 1, maxPrimaryContext: 1 })
  await primaryTurn(hooks, 5000)

  assert.equal(isEndlessPaused(SID), false, "the pause belongs to a mode nobody is running")
  assert.equal(hasHandoffPending(SID), true, "the plain handoff owns the threshold again")
})
