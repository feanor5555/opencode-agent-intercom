// Shell-level tests for the evidence readers of the two mid-run drivers.
// `message-task.sh` and `ask-task.sh` decide pass or fail from what
// `test/e2e/lib/midrun-message.py` and `test/e2e/lib/midrun-ask.py` read out of
// a captured session, so those two are driven here with built session trees —
// no server, no model, no cost — and pinned on the figures the criteria rest
// on.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const MESSAGE_READER = resolve(import.meta.dirname, "e2e/lib/midrun-message.py")
const ASK_READER = resolve(import.meta.dirname, "e2e/lib/midrun-ask.py")
const FRAMED_OPENING = "📨 agent-intercom: message from the orchestrator"
const ANSWER_MARKER = "ASK-ANSWER-ALPHA"

const python = spawnSync("python3", ["--version"])
const HAVE_PYTHON = python.status === 0

function read(reader, messages, argument) {
  const dir = mkdtempSync(join(tmpdir(), "midrun-reader-"))
  const file = join(dir, "messages.json")
  writeFileSync(file, JSON.stringify(messages))
  const run = spawnSync("python3", [reader, file, argument], { encoding: "utf8" })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(run.status, 0, `reader failed: ${run.stderr}`)
  const figures = {}
  for (const line of run.stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) figures[line.slice(0, at)] = line.slice(at + 1)
  }
  return figures
}

function user(created, text) {
  return { info: { id: `u${created}`, role: "user", time: { created } }, parts: [{ type: "text", text }] }
}

function step(created, parts = []) {
  return { info: { id: `a${created}`, role: "assistant", time: { created } }, parts }
}

function toolPart(tool, start, end, extra = {}) {
  return {
    type: "tool",
    tool,
    state: { status: end ? "completed" : "running", time: { start, end }, ...extra },
  }
}

// The shape the live run produced: one briefing, one step that opens a slow
// `bash` call, the framed message landing inside that call, and one further
// step after it that makes no tool call at all.
function steeredSession() {
  return [
    user(1000, "your task"),
    step(1100, [toolPart("bash", 1200, 4000)]),
    user(2500, `${FRAMED_OPENING}\nstop after the command you are in`),
    step(4009, [{ type: "text", text: "STEERED-STEP-1-DONE" }]),
  ]
}

test("midrun-message: the framed message inside a tool call, read at the next step", { skip: !HAVE_PYTHON }, () => {
  const figures = read(MESSAGE_READER, steeredSession(), FRAMED_OPENING)
  assert.equal(figures.parsed, "1")
  assert.equal(figures.framed_found, "1")
  assert.equal(figures.framed_time, "2500")
  assert.equal(figures.user_messages, "2")
  assert.equal(figures.assistants_before, "1")
  assert.equal(figures.assistants_after, "1")
  assert.equal(figures.inflight_tool, "bash")
  assert.equal(figures.inflight_start, "1200")
  assert.equal(figures.inflight_end, "4000")
  // The delivery moment itself: the first step after the message began once
  // that call returned.
  assert.equal(figures.step_after_inflight_ms, "9")
  assert.equal(figures.tools_before, "1")
  assert.equal(figures.tools_after, "0")
})

test("midrun-message: a message between two steps is no in-flight landing", { skip: !HAVE_PYTHON }, () => {
  const figures = read(
    MESSAGE_READER,
    [
      user(1000, "your task"),
      step(1100, [toolPart("bash", 1200, 2000)]),
      user(2500, `${FRAMED_OPENING}\nchange of plan`),
      step(2600, [toolPart("bash", 2700, 3000)]),
    ],
    FRAMED_OPENING,
  )
  assert.equal(figures.inflight_tool, "")
  assert.equal(figures.tools_after, "1")
  assert.equal(figures.step_after_inflight_ms, "-1")
})

test("midrun-message: a session without the framed message says so", { skip: !HAVE_PYTHON }, () => {
  const figures = read(MESSAGE_READER, [user(1000, "your task"), step(1100)], FRAMED_OPENING)
  assert.equal(figures.framed_found, "0")
  assert.equal(figures.framed_time, "0")
  assert.equal(figures.assistants_after, "0")
})

test("midrun-message: an unusable capture is reported, not guessed at", { skip: !HAVE_PYTHON }, () => {
  const figures = read(MESSAGE_READER, [], FRAMED_OPENING)
  assert.equal(figures.parsed, "0")
  assert.equal(figures.messages, "0")
  assert.equal(figures.framed_found, undefined)
})

// The shape the live run produced: one `ask` call that stays open for the whole
// wait and comes back carrying the orchestrator's answer, with nothing of the
// subagent's own happening in between.
test("midrun-ask: the answer is the ask call's own output", { skip: !HAVE_PYTHON }, () => {
  const figures = read(
    ASK_READER,
    [
      user(1000, "your task"),
      step(1100, [
        toolPart("ask", 1200, 8694, {
          input: { question: "ALPHA or BETA?" },
          output: `The orchestrator answers: Use ALPHA: ${ANSWER_MARKER}\n\nThat is the decision`,
        }),
      ]),
      step(8800, [{ type: "text", text: "CHOSE-ALPHA" }]),
    ],
    ANSWER_MARKER,
  )
  assert.equal(figures.ask_calls, "1")
  assert.equal(figures.ask_status, "completed")
  assert.equal(figures.ask_ms, "7494")
  assert.equal(figures.ask_question, "1")
  assert.equal(figures.answer_prefix, "1")
  assert.equal(figures.answer_marker, "1")
  assert.equal(figures.tools_during_ask, "0")
  assert.equal(figures.assistants_during_ask, "0")
  assert.equal(figures.assistants_after_ask, "1")
  assert.equal(figures.tools_after_ask, "0")
})

test("midrun-ask: work done inside the ask window is counted", { skip: !HAVE_PYTHON }, () => {
  const figures = read(
    ASK_READER,
    [
      user(1000, "your task"),
      step(1100, [toolPart("ask", 1200, 9000, { input: { question: "ALPHA or BETA?" }, output: "no answer came" })]),
      step(3000, [toolPart("read", 3100, 3500)]),
    ],
    ANSWER_MARKER,
  )
  assert.equal(figures.tools_during_ask, "1")
  assert.equal(figures.assistants_during_ask, "1")
  assert.equal(figures.answer_prefix, "0")
  assert.equal(figures.answer_marker, "0")
})

test("midrun-ask: a run that never asked is not read as one that did", { skip: !HAVE_PYTHON }, () => {
  const figures = read(ASK_READER, [user(1000, "your task"), step(1100, [toolPart("read", 1200, 1300)])], ANSWER_MARKER)
  assert.equal(figures.ask_calls, "0")
  assert.equal(figures.answer_prefix, "0")
  assert.equal(figures.tool_names, "read")
})

// ---------------------------------------------------------------------------
// What makes the ask driver's question unavoidable. The criteria are read off
// the captured session by the reader above; whether the subagent asks AT ALL is
// decided by the task the driver hands it. A prompt that carries the candidate
// words lets a model pick one and finish without ever using the channel — the
// run then measures the model's taste. The invariant pinned here: the word the
// answer decides stands nowhere in the subagent's own prompt, and the
// orchestrator is told not to carry it into the spawn.
// ---------------------------------------------------------------------------

const ASK_DRIVER = readFileSync(resolve(import.meta.dirname, "e2e/ask-task.sh"), "utf8")

function askDriverLine(name) {
  const m = new RegExp(`^${name}="((?:[^"\\\\]|\\\\.)*)"$`, "m").exec(ASK_DRIVER)
  assert.ok(m, `ask-task.sh carries no ${name} assignment on one line`)
  return m[1]
}

test("ask-task.sh: the subagent's task names no candidate word it could pick instead of asking", () => {
  const task = askDriverLine("SUB_TASK")
  assert.match(task, /ask\('/, "the task does not tell the subagent to call ask")
  assert.equal(/ALPHA|BETA/.test(task), false, "the subagent's task carries a candidate word")
  assert.equal(task.includes("$DECISION"), false, "the subagent's task interpolates the decided word")
  assert.match(task, /no list of candidates/)
  assert.match(task, /only place it exists is with the caller/)
})

test("ask-task.sh: the orchestrator is forbidden to carry the answer into the spawn prompt", () => {
  const turn = askDriverLine("TURN1")
  assert.match(turn, /Put nothing else into that prompt/)
  assert.match(turn, /not the word \$DECISION/)
  assert.match(turn, /message\(\\"<its handle>\\", \\"Use \$DECISION: \$ANSWER_MARKER\\"\)/)
})

// ---------------------------------------------------------------------------
// The expiry/clamp driver. It asserts three branches of `askWaitMs`
// (src/agentmsg.js) against a real server, and everything that decides which
// branch a phase lands in is arithmetic over its own pinned defaults and the
// margin the source holds. That arithmetic, the log lines it waits for and the
// tool-result literals it recognises are pinned here, without a server: a
// driver whose expectations have drifted away from the code would otherwise
// only be caught by a live run that costs tokens.
// ---------------------------------------------------------------------------

const EXPIRY_DRIVER = readFileSync(resolve(import.meta.dirname, "e2e/ask-expiry-task.sh"), "utf8")
const MIDRUN_SRC = readFileSync(resolve(import.meta.dirname, "../src/midrun.js"), "utf8")
const AGENTMSG_SRC = readFileSync(resolve(import.meta.dirname, "../src/agentmsg.js"), "utf8")

function expiryDriverString(name) {
  const m = new RegExp(`^${name}="((?:[^"\\\\]|\\\\.)*)"$`, "m").exec(EXPIRY_DRIVER)
  assert.ok(m, `ask-expiry-task.sh carries no ${name} assignment on one line`)
  return m[1]
}

function expiryDriverDefault(name, env) {
  const m = new RegExp(`^${name}=\\$\\{${env}:-(\\d+)\\}$`, "m").exec(EXPIRY_DRIVER)
  assert.ok(m, `ask-expiry-task.sh carries no ${name} default`)
  return Number(m[1])
}

test("ask-expiry-task.sh: the tool-result literals it recognises are the ones src/midrun.js renders", () => {
  const names = [
    "UNANSWERED_MARKER",
    "NOT_WAITING_MARKER",
    "ANSWERED_MARKER",
    "NOROOM_CAUSE_MARKER",
    "OFF_CAUSE_MARKER",
  ]
  for (const name of names) {
    const literal = expiryDriverString(name)
    assert.ok(
      MIDRUN_SRC.includes(literal),
      `${name}="${literal}" is not rendered anywhere in src/midrun.js`,
    )
  }
})

test("ask-expiry-task.sh: the log lines it waits for are the ones src/agentmsg.js writes", () => {
  for (const line of ["ask registered", "ask registered without a wait", "ask expired unanswered"]) {
    assert.ok(AGENTMSG_SRC.includes(`log("${line}"`), `src/agentmsg.js writes no "${line}" line`)
    assert.ok(EXPIRY_DRIVER.includes(line), `the driver waits for no "${line}" line`)
  }
})

test("ask-expiry-task.sh: its three pinned windows hit the three branches of askWaitMs", () => {
  const margin = Number(
    /^export const ASK_WAIT_WATCHDOG_MARGIN_MS = (\d+)$/m.exec(AGENTMSG_SRC)[1],
  )
  const expiryWait = expiryDriverDefault("EXPIRY_WAIT_MS", "ASK_EXPIRY_WAIT_MS")
  const expiryWindow = expiryDriverDefault("EXPIRY_TOOL_CALL_MS", "ASK_EXPIRY_TOOL_CALL_MS")
  const request = expiryDriverDefault("CLAMP_REQUEST_MS", "ASK_CLAMP_REQUEST_MS")
  const clampWindow = expiryDriverDefault("CLAMP_TOOL_CALL_MS", "ASK_CLAMP_TOOL_CALL_MS")
  const noRoomWindow = expiryDriverDefault("NOROOM_TOOL_CALL_MS", "ASK_NOROOM_TOOL_CALL_MS")

  // The expiry phase: a wait that is really taken, and taken whole.
  assert.ok(expiryWait > 0, "the expiry phase pins a wait of 0 and could never expire")
  assert.ok(
    expiryWindow - margin >= expiryWait,
    `the expiry phase would be clamped: ${expiryWindow} - ${margin} < ${expiryWait}`,
  )
  // and short enough that a live run waits it out rather than the suite.
  assert.ok(expiryWait <= 30000, `the expiry phase waits ${expiryWait} ms out; that is a long run`)

  // The clamp phase: a wait cut down to the room, below what was requested.
  assert.ok(clampWindow - margin > 0, "the clamp phase leaves no room and is the no-room branch")
  assert.ok(
    clampWindow - margin < request,
    `the clamp phase would not clamp: ${clampWindow} - ${margin} >= ${request}`,
  )

  // The no-room phase: a window at or below the margin, and not the off switch.
  assert.ok(noRoomWindow > 0, "the no-room phase switches the working window off instead")
  assert.ok(
    noRoomWindow - margin <= 0,
    `the no-room phase still leaves ${noRoomWindow - margin} ms of room`,
  )
})

test("ask-expiry-task.sh: the orchestrator is told to leave the question unanswered", () => {
  const turn = /^ae_turn_prompt\(\) \{\n\s*printf '%s' "([\s\S]*?)"\n\}$/m.exec(EXPIRY_DRIVER)
  assert.ok(turn, "ask-expiry-task.sh carries no ae_turn_prompt body")
  assert.match(turn[1], /Do NOT answer it/)
  assert.match(turn[1], /Do not call message\(\)/)
  const task = /^ae_sub_task\(\) \{\n\s*printf '%s' "([\s\S]*?)"\n\}$/m.exec(EXPIRY_DRIVER)
  assert.ok(task, "ask-expiry-task.sh carries no ae_sub_task body")
  assert.match(task[1], /call ask\('/, "the task does not tell the subagent to call ask")
  assert.match(task[1], /make no other tool call at all/)
})
