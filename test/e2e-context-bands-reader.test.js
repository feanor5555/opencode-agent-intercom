// Shell-level tests for the evidence reader of the context-band driver.
// `test/e2e/context-bands-task.sh` decides pass or fail from what
// `test/e2e/lib/context-bands.py` reads out of the plugin's request log, so
// that reader is driven here with built records — no server, no model, no cost
// — and pinned on the figures the criteria rest on: which band a notice is,
// where in the array it sat, and the token figures it names.
//
// It also pins the four literals the reader classifies by against src/hooks.js
// itself: a band whose wording moves would otherwise leave the driver reporting
// "not reached" for a band that fired.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const READER = resolve(import.meta.dirname, "e2e/lib/context-bands.py")
const HOOKS = resolve(import.meta.dirname, "../src/hooks.js")
const SESSION = "ses_sub1"
const SUFFIX = "-agent-intercom-turn"

const python = spawnSync("python3", ["--version"])
const HAVE_PYTHON = python.status === 0

// The heads the reader classifies by, as the driver's criteria name them.
const PLAN_HEAD = "🧭 PLAN YOUR HANDOVER."
const RESERVE_HEAD = "⚠️ WRAP UP NOW."
const HOLD_HEAD = "⏳ HOLD."
const STOP_BODY = "Your work tools are now DISABLED"

function planText(ctx = "28.1k", budget = "40.0k", left = "11.9k") {
  return (
    `\n\n---\n${PLAN_HEAD} agent-intercom: your context has reached ${ctx} tokens of the ` +
    `${budget} budget — about ${left} left. Nothing is denied on this turn and nothing is ` +
    `being wound up: carry on, and finish what you are holding.\n---\n`
  )
}

function reserveText(ctx = "36.4k", budget = "40.0k", left = "3.6k") {
  return (
    `\n\n---\n${RESERVE_HEAD} agent-intercom: your context has reached ${ctx} tokens of the ` +
    `${budget} budget — about ${left} left. At the budget every work tool is DISABLED.\n\n` +
    `Finish only what you are already holding, then write a plain-text message beginning with ` +
    `"Done:" (or "Blocked:") naming what you accomplished.\n---\n`
  )
}

function stopText(ctx = "41.2k", budget = "40.0k") {
  return (
    `\n\n---\n🛑 STOP. agent-intercom: your context has reached ${ctx} tokens (budget ` +
    `${budget}). ${STOP_BODY} — every such tool call will be rejected with an error.\n---\n`
  )
}

function userMessage(id, text) {
  return {
    info: { id, role: "user", sessionID: SESSION },
    parts: [{ id: `${id}-part`, type: "text", text }],
  }
}

function assistantMessage(id, tools = 0) {
  const parts = []
  for (let i = 0; i < tools; i++) {
    parts.push({ id: `${id}-t${i}`, type: "tool", tool: "bash", state: { status: "completed" } })
  }
  return { info: { id, role: "assistant", sessionID: SESSION }, parts }
}

// A notice in the carrier the plugin appends: a copy of the user message's info
// under an id ending in the suffix, pushed to the END of the array.
function withTailCarrier(messages, text) {
  const id = `msg_u0${SUFFIX}`
  return [
    ...messages,
    {
      info: { id, role: "user", sessionID: SESSION },
      parts: [{ id, type: "text", text, synthetic: true }],
    },
  ]
}

// The placement the carrier exists to replace: the notice left on message 0.
function onMessageZero(messages, text) {
  const copy = messages.map((m) => ({ info: { ...m.info }, parts: [...m.parts] }))
  copy[0].parts.push({ id: `msg_u0${SUFFIX}`, type: "text", text, synthetic: true })
  return copy
}

function run(records, sessionID = SESSION) {
  const dir = mkdtempSync(join(tmpdir(), "context-bands-reader-"))
  const file = join(dir, "requests.jsonl")
  const dumps = join(dir, "dump")
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const result = spawnSync("python3", [READER, file, sessionID, dumps], { encoding: "utf8" })
  assert.equal(result.status, 0, `reader failed: ${result.stderr}`)
  const figures = {}
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) figures[line.slice(0, at)] = line.slice(at + 1)
  }
  const dumped = {}
  for (const band of ["plan", "reserve", "hold", "stop"]) {
    const path = `${dumps}.${band}.txt`
    dumped[band] = existsSync(path) ? readFileSync(path, "utf8") : null
  }
  rmSync(dir, { recursive: true, force: true })
  return { figures, dumped }
}

function messagesRecord(messages) {
  return { type: "messages", ts: "2026-09-13T10:00:00.000Z", messages }
}

// The shape a live run produces: a quiet first request, then one request per
// band, each with the notice in an appended carrier at the tail.
function bandRun() {
  const base = [userMessage("msg_u0", "your task"), assistantMessage("msg_a1", 1)]
  return [
    messagesRecord(base),
    messagesRecord(withTailCarrier([...base, assistantMessage("msg_a2", 1)], planText())),
    messagesRecord(withTailCarrier([...base, assistantMessage("msg_a3", 2)], reserveText())),
    messagesRecord(withTailCarrier([...base, assistantMessage("msg_a4", 3)], stopText())),
  ]
}

test("the three bands, their order and their figures", { skip: !HAVE_PYTHON }, () => {
  const { figures, dumped } = run(bandRun())

  assert.equal(figures.parsed, "1")
  assert.equal(figures.records, "4")
  assert.equal(figures.quiet_records, "1")
  assert.equal(figures.band_records, "3")
  assert.equal(figures.first_band, "plan")
  assert.equal(figures.band_order, "plan,reserve,stop")
  assert.equal(figures.plan_records, "1")
  assert.equal(figures.reserve_records, "1")
  assert.equal(figures.stop_records, "1")
  assert.equal(figures.hold_records, "0")

  // The figures the plan and reserve criteria are decided on, read back out of
  // the plugin's own rendering: "28.1k" is 28100 tokens.
  assert.equal(figures.plan_ctx, "28100")
  assert.equal(figures.plan_budget, "40000")
  assert.equal(figures.plan_left, "11900")
  assert.equal(figures.plan_arith, "1")
  assert.equal(figures.reserve_ctx, "36400")
  assert.equal(figures.reserve_left, "3600")
  assert.equal(figures.reserve_arith, "1")
  assert.equal(figures.stop_ctx, "41200")
  assert.equal(figures.stop_budget, "40000")

  // And the text of each band is kept where the driver greps its literals.
  assert.match(dumped.plan, /PLAN YOUR HANDOVER/)
  assert.match(dumped.reserve, /WRAP UP NOW/)
  assert.match(dumped.stop, /work tools are now DISABLED/)
  assert.equal(dumped.hold, null)
})

test("a tail carrier is read as one, at the end and not on message 0", { skip: !HAVE_PYTHON }, () => {
  const { figures } = run(bandRun())

  assert.equal(figures.band_carrier_tail, "3")
  assert.equal(figures.band_carrier_appended, "3")
  assert.equal(figures.band_carrier_user, "3")
  assert.equal(figures.band_carrier_synthetic, "3")
  assert.equal(figures.band_carrier_msg0, "0")
  assert.equal(figures.plan_is_tail, "1")
  assert.equal(figures.plan_is_msg0, "0")
  assert.equal(figures.plan_index, "3")
  assert.equal(figures.plan_total, "4")
})

test("a notice left on message 0 is reported as exactly that", { skip: !HAVE_PYTHON }, () => {
  const base = [userMessage("msg_u0", "your task"), assistantMessage("msg_a1", 1)]
  const { figures } = run([messagesRecord(onMessageZero(base, planText()))])

  assert.equal(figures.band_records, "1")
  assert.equal(figures.band_carrier_msg0, "1")
  assert.equal(figures.band_carrier_tail, "0")
  assert.equal(figures.band_carrier_appended, "0")
  assert.equal(figures.plan_is_msg0, "1")
  assert.equal(figures.plan_is_tail, "0")
})

test("the tool tally around the lockdown", { skip: !HAVE_PYTHON }, () => {
  const base = [userMessage("msg_u0", "your task")]
  const records = [
    messagesRecord(withTailCarrier([...base, assistantMessage("msg_a1", 2)], stopText())),
    messagesRecord(withTailCarrier([...base, assistantMessage("msg_a1", 2), assistantMessage("msg_a2", 1)], stopText())),
  ]
  const { figures } = run(records)

  // Two tool parts stood on the lockdown's own request and three on the last:
  // the subagent went on calling work tools, which is what tells "reached and
  // not denied" from "attempted nothing".
  assert.equal(figures.stop_tool_parts, "2")
  assert.equal(figures.last_tool_parts, "3")
  assert.equal(figures.last_record, "2")
})

test("another session's requests are not read", { skip: !HAVE_PYTHON }, () => {
  const foreign = {
    type: "messages",
    ts: "2026-09-13T10:00:00.000Z",
    messages: withTailCarrier(
      [{ info: { id: "msg_x0", role: "user", sessionID: "ses_other" }, parts: [] }],
      planText(),
    ).map((m) => ({ ...m, info: { ...m.info, sessionID: "ses_other" } })),
  }
  const { figures } = run([foreign, ...bandRun()])

  assert.equal(figures.records, "4", "only this session's requests count")
  assert.equal(figures.band_records, "3")
})

test("a log with nothing for this session parses to nothing rather than failing", { skip: !HAVE_PYTHON }, () => {
  const { figures } = run(bandRun(), "ses_nobody")

  assert.equal(figures.parsed, "0")
  assert.equal(figures.records, "0")
  assert.equal(figures.band_records, "0")
  assert.equal(figures.first_band, "none")
})

// The four literals the reader classifies by are the plugin's own. Pinned
// against the source, because a band whose wording moved would show up as a
// band that never fired — the one failure mode the live run cannot tell apart
// by itself.
test("the band literals still stand in src/hooks.js", () => {
  const source = readFileSync(HOOKS, "utf8")
  for (const literal of [PLAN_HEAD, RESERVE_HEAD, HOLD_HEAD, STOP_BODY]) {
    assert.ok(
      source.includes(literal),
      `contextLimitNotice no longer carries ${literal} — test/e2e/lib/context-bands.py classifies bands by it`,
    )
  }
})

// ---------- the driver's own wiring -----------------------------------------

const DRIVER = readFileSync(resolve(import.meta.dirname, "e2e/context-bands-task.sh"), "utf8")
const RUN_ALL = readFileSync(resolve(import.meta.dirname, "e2e/run-all.sh"), "utf8")

test("run-all.sh: the context-band driver runs in the suite and its status decides the exit code", () => {
  assert.match(RUN_ALL, /"\$HERE\/context-bands-task\.sh" \|\| ASSERTING_FAILED=/)
  assert.ok(
    RUN_ALL.includes("17-context-bands.report.txt"),
    "the suite's failure line names no report for it",
  )
  // It owns its server, so it has to run after the suite's own is stopped —
  // the same place ask-expiry-task.sh sits.
  assert.ok(
    RUN_ALL.indexOf('"$HERE/context-bands-task.sh"') >
      RUN_ALL.indexOf("--- stopping the suite server before the endless driver ---"),
    "it is sequenced before the suite server goes down",
  )
})

test("the driver pins its own budget and switches compaction off", () => {
  // agentContext for the driven role, not the flat maxContext every other
  // driver runs under, and `compaction: false` — with compaction on, the budget
  // crossing is a compaction and the lockdown never fires.
  assert.match(DRIVER, /"agentContext":\{"%s":%s\}/)
  assert.match(DRIVER, /"compaction":false/)
  // The two shares are read out of the source, never repeated as literals.
  assert.match(DRIVER, /CTX_NEAR_BUDGET = \(\[0-9\.\]\+\)/)
  assert.match(DRIVER, /CTX_STOP_RESERVE = \(\[0-9\.\]\+\)/)
})

test("every band is recorded in both branches and uncovered where it was not reached", () => {
  for (const band of [
    "plan band — the plan block fired while the context was in its range",
    "reserve band — the reserve block fired while the context was in its range",
    "lockdown — the STOP block fired at or above the budget",
  ]) {
    const lines = DRIVER.split("\n").filter((line) => line.includes(band))
    // One PASS, one FAIL for "reached and did not fire", one NOT ASSERTED for
    // "never reached" — a band the run did not produce is never silent.
    assert.ok(lines.length >= 3, `${band}: recorded in ${lines.length} branch(es), expected 3`)
  }
  assert.ok(
    DRIVER.includes("NOT REACHED:"),
    "an unreached band has to say so in its own evidence",
  )
  assert.match(DRIVER, /mr_die "the subagent's FIRST measured turn already reads/)
})

// ---------- the step sizing -------------------------------------------------

// The driver's shipped defaults, read out of the driver itself, and the two
// shares read out of src/hooks.js: the same three figures the preflight
// computes with. A default that stopped landing a sample in the reserve band
// fails here, without a server and without cost.
function driverDefault(name, envName = name) {
  const hit = new RegExp(`^${name}=\\$\\{${envName}:-(\\d+)\\}`, "m").exec(DRIVER)
  assert.ok(hit, `the driver no longer defaults ${name} out of ${envName}`)
  return Number(hit[1])
}

const HOOKS_SOURCE = readFileSync(HOOKS, "utf8")
function share(name) {
  const hit = new RegExp(`^const ${name} = ([0-9.]+)`, "m").exec(HOOKS_SOURCE)
  assert.ok(hit, `src/hooks.js no longer declares ${name}`)
  return Number(hit[1])
}

test("a default run lands at least one sample in the reserve band by construction", () => {
  const budget = driverDefault("BUDGET", "CONTEXT_BUDGET")
  const blockChars = driverDefault("BLOCK_CHARS")
  const perKchar = driverDefault("STEP_TOKENS_PER_KCHAR")
  const nearShare = share("CTX_NEAR_BUDGET")
  const reserveShare = share("CTX_STOP_RESERVE")

  const step = Math.floor((blockChars * perKchar) / 1000)
  const reserveWidth = budget - Math.round(budget * reserveShare)
  // The relation the preflight enforces: a step is at most half the narrowest
  // band, so two samples land in it and one still does at twice the growth.
  assert.ok(
    step * 2 <= reserveWidth,
    `a step of ~${step} tokens against a reserve range ${reserveWidth} wide can jump the band`,
  )
  // Both thresholds have to be whole tokens, or the driver refuses the budget.
  assert.equal(budget * nearShare, Math.round(budget * nearShare))
  assert.equal(budget * reserveShare, Math.round(budget * reserveShare))
  // The measured baseline of a subagent on this driver's first live run was
  // ~7100 tokens; the plan threshold has to sit clear of it by half as much
  // again, or a slightly heavier baseline ends the run as a setup error before
  // a band can be observed opening. The shipped default sits at 14000, 1.97x
  // that baseline.
  assert.ok(
    budget * nearShare >= 1.5 * 7100,
    `the plan threshold at ${budget * nearShare} leaves too little room over a ~7100-token baseline`,
  )
  // And the climb has to stay short enough to be worth running: every step is
  // an LLM turn carrying the whole context so far.
  assert.ok(
    Math.floor(budget / step) <= 40,
    `the climb to ${budget} takes up to ${Math.floor(budget / step)} turns`,
  )
})

test("the preflight refuses a block that could jump the reserve band", () => {
  // The relation itself, not just the defaults that satisfy it today.
  assert.match(DRIVER, /RESERVE_WIDTH=\$\(\( BUDGET - RESERVE_AT \)\)/)
  assert.match(DRIVER, /STEP_TOKENS=\$\(\( BLOCK_CHARS \* STEP_TOKENS_PER_KCHAR \/ 1000 \)\)/)
  assert.match(DRIVER, /\[ \$\(\(STEP_TOKENS \* 2\)\) -le "\$RESERVE_WIDTH" \] \|\|/)
  // The plugin's characters-over-four estimate is what let a whole band be
  // stepped over; it must not come back as the sizing figure.
  assert.ok(
    !/BLOCK_TOKENS=\$\(\(BLOCK_CHARS \/ 4\)\)/.test(DRIVER),
    "the driver is sizing its step off estimateTokens again",
  )
})

// ---------- the call the lockdown has to refuse -----------------------------

test("the subagent is told to test the lockdown's claim with one more call", () => {
  const task = DRIVER.slice(DRIVER.indexOf("cb_sub_task() {"), DRIVER.indexOf("cb_turn_prompt() {"))
  assert.ok(task.includes("NO notice ends this task"), "a notice may still end the task")
  assert.ok(
    task.includes("make the next call anyway"),
    "nothing tells the subagent to attempt a call after the lockdown, so no call is there to be denied",
  )
  assert.ok(
    task.includes("comes back as an error refusing to run it"),
    "the stopping condition is no longer an actual refusal",
  )
  // None of the literals the criteria decide on may stand in the prompt: a hit
  // has to be the plugin speaking, never the task text echoed back.
  for (const literal of [
    PLAN_HEAD,
    RESERVE_HEAD,
    STOP_BODY,
    "Your context budget is exhausted; work tools are disabled",
  ]) {
    assert.ok(!task.includes(literal), `the subagent's prompt carries the criterion literal ${literal}`)
  }
})

test("the denial stays able to come back NOT ASSERTED", () => {
  // Telling the subagent to attempt a call does not make the denial green: the
  // three outcomes stand unchanged — denied (PASS), went on calling and nothing
  // was refused (FAIL), attempted nothing (NOT ASSERTED).
  const lines = DRIVER.split("\n").filter((line) =>
    line.includes("lockdown — a work-tool call was denied over the budget"),
  )
  assert.ok(lines.length >= 4, `the denial is recorded in ${lines.length} branch(es), expected 4`)
  assert.ok(
    lines.some((line) => line.includes("mr_record") && line.trimEnd().endsWith(" 1 \\")),
    "no passing branch",
  )
  assert.ok(
    lines.some((line) => line.includes("mr_record") && line.trimEnd().endsWith(" 0 \\")),
    "no failing branch for a subagent that went on calling and was never refused",
  )
  assert.ok(
    lines.some((line) => line.includes("mr_note_uncovered")),
    "no NOT ASSERTED branch for a lockdown with no call attempted after it",
  )
  assert.match(
    DRIVER,
    /NOT REACHED: the lockdown fired, and the subagent attempted no further work tool afterwards/,
  )
})
