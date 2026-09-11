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
