// Shell-level tests for the run-ceiling evidence reader and the driver's wiring.
// `test/e2e/run-ceiling-task.sh` decides neither-old / wrap-up from what
// `test/e2e/lib/run-ceiling.py` reads out of a session capture and the plugin's
// request log, so that reader is driven here with built records — no server, no
// model, no cost. The live criteria (reap notice, rescued result file, list slot,
// the control that a 120 s call is not cut, the hand-back that records
// NOT ASSERTED) stay on the driver: they need a running subagent.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const READER = resolve(import.meta.dirname, "e2e/lib/run-ceiling.py")
const DRIVER = readFileSync(resolve(import.meta.dirname, "e2e/run-ceiling-task.sh"), "utf8")
const RUN_ALL = readFileSync(resolve(import.meta.dirname, "e2e/run-all.sh"), "utf8")
const PROMPTS = readFileSync(resolve(import.meta.dirname, "../src/prompts.js"), "utf8")
const SETTINGS = readFileSync(resolve(import.meta.dirname, "../src/settings.js"), "utf8")
const NOTICES = readFileSync(resolve(import.meta.dirname, "../src/notices.js"), "utf8")
const SESSION = "ses_poller"

const python = spawnSync("python3", ["--version"])
const HAVE_PYTHON = python.status === 0

const WRAP_HEAD = "⏳ RUN CEILING AHEAD."
const SPAWN_ISO = "2026-09-13T10:00:00.000Z"
const WRAP_ISO = "2026-09-13T10:03:00.000Z"
const AFTER_ISO = "2026-09-13T10:03:01.000Z"
const SPAWN_MS = Date.parse(SPAWN_ISO)
const WRAP_AT_MS = 180000
const MAX_CALL_MS = 600000
const MAX_AGE_MS = 90000

function runReader({ messages, records, sessionID = SESSION, spawnMs = SPAWN_MS, wrapAt = WRAP_AT_MS, maxCall = MAX_CALL_MS, maxAge = MAX_AGE_MS }) {
  const dir = mkdtempSync(join(tmpdir(), "run-ceiling-reader-"))
  const capture = join(dir, "messages.json")
  const requests = join(dir, "requests.jsonl")
  const dump = join(dir, "wrap.txt")
  writeFileSync(capture, JSON.stringify(messages ?? []))
  writeFileSync(requests, (records ?? []).map((r) => JSON.stringify(r)).join("\n") + ((records ?? []).length ? "\n" : ""))
  const result = spawnSync(
    "python3",
    [READER, capture, requests, sessionID, dump, String(maxCall), String(maxAge), String(spawnMs), String(wrapAt)],
    { encoding: "utf8" },
  )
  assert.equal(result.status, 0, `reader failed: ${result.stderr}`)
  const figures = {}
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) figures[line.slice(0, at)] = line.slice(at + 1)
  }
  let wrapText = ""
  try {
    wrapText = readFileSync(dump, "utf8")
  } catch {
    wrapText = ""
  }
  rmSync(dir, { recursive: true, force: true })
  figures._dump = wrapText
  return figures
}

function toolPart(tool, start, end) {
  return {
    type: "tool",
    tool,
    state: { status: "completed", time: { start, end } },
  }
}

function sessionMessages(calls, sessionID = SESSION) {
  return [
    {
      info: { id: "msg_u", role: "user", sessionID },
      parts: [{ type: "text", text: "poll" }],
    },
    {
      info: { id: "msg_a", role: "assistant", sessionID },
      parts: calls.map((c) => toolPart(c.tool, c.start, c.end)),
    },
  ]
}

function wrapMessages(sessionID = SESSION) {
  return [
    {
      info: { id: "msg_u", role: "user", sessionID },
      parts: [{ type: "text", text: "poll" }],
    },
    {
      info: { id: "msg_c", role: "user", sessionID, id: "msg_c-agent-intercom-turn" },
      parts: [
        {
          type: "text",
          text: `\n\n---\n${WRAP_HEAD} agent-intercom: this run has been going for 3 min of the 4 min run ceiling (\`maxSubagentRunMs\`) — about 1 min left. Nothing is denied on this turn: every tool still works and nothing is being wound up for you.\n---\n`,
        },
      ],
    },
  ]
}

test("neither-old is 1 when every call and every gap sits inside both windows", { skip: !HAVE_PYTHON }, () => {
  const t0 = SPAWN_MS + 1000
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: t0, end: t0 + 15000 },
      { tool: "bash", start: t0 + 20000, end: t0 + 35000 },
      { tool: "bash", start: t0 + 40000, end: t0 + 55000 },
    ]),
  })
  assert.equal(figures.parsed, "1")
  assert.equal(figures.tools, "3")
  assert.equal(figures.longest_call_ms, "15000")
  assert.equal(figures.longest_gap_ms, "5000")
  assert.equal(figures.neither_old, "1")
})

test("neither-old is 0 when the longest call reaches maxSubagentToolCallMs", { skip: !HAVE_PYTHON }, () => {
  const t0 = SPAWN_MS + 1000
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: t0, end: t0 + 15000 },
      { tool: "bash", start: t0 + 20000, end: t0 + 20000 + MAX_CALL_MS },
    ]),
  })
  assert.equal(figures.neither_old, "0")
  assert.equal(figures.longest_call_ms, String(MAX_CALL_MS))
})

test("neither-old is 0 when the longest gap reaches maxSubagentAgeMs", { skip: !HAVE_PYTHON }, () => {
  const t0 = SPAWN_MS + 1000
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: t0, end: t0 + 1000 },
      { tool: "bash", start: t0 + 1000 + MAX_AGE_MS, end: t0 + 1000 + MAX_AGE_MS + 1000 },
    ]),
  })
  assert.equal(figures.neither_old, "0")
  assert.equal(figures.longest_gap_ms, String(MAX_AGE_MS))
})

test("neither-old is 0 with a single completed call — gaps cannot be proven", { skip: !HAVE_PYTHON }, () => {
  const t0 = SPAWN_MS + 1000
  const figures = runReader({
    messages: sessionMessages([{ tool: "bash", start: t0, end: t0 + 120000 }]),
  })
  assert.equal(figures.tools, "1")
  assert.equal(figures.neither_old, "0")
})

test("wrap-up is read from the request log, not the session capture, at or after 0.75", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: SPAWN_MS + 1000, end: SPAWN_MS + 16000 },
      { tool: "bash", start: SPAWN_MS + 20000, end: SPAWN_MS + 35000 },
    ]),
    records: [
      { type: "messages", ts: WRAP_ISO, messages: wrapMessages() },
      { type: "tool.execute.after", ts: AFTER_ISO, sessionID: SESSION, tool: "bash", callID: "c2" },
    ],
  })
  assert.equal(figures.wrap_records, "1")
  assert.equal(figures.wrap_elapsed_ms, "180000")
  assert.equal(figures.wrap_at_or_after, "1")
  assert.equal(figures.wrap_tool_after, "1")
  assert.match(figures._dump, /RUN CEILING AHEAD/)
})

test("a wrap-up before 0.75 of the ceiling is not at-or-after", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: SPAWN_MS + 1000, end: SPAWN_MS + 2000 },
      { tool: "bash", start: SPAWN_MS + 3000, end: SPAWN_MS + 4000 },
    ]),
    records: [{ type: "messages", ts: "2026-09-13T10:01:00.000Z", messages: wrapMessages() }],
  })
  assert.equal(figures.wrap_records, "1")
  assert.equal(figures.wrap_elapsed_ms, "60000")
  assert.equal(figures.wrap_at_or_after, "0")
})

test("another session's wrap-up is not read", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: SPAWN_MS + 1000, end: SPAWN_MS + 2000 },
      { tool: "bash", start: SPAWN_MS + 3000, end: SPAWN_MS + 4000 },
    ]),
    records: [
      { type: "messages", ts: WRAP_ISO, messages: wrapMessages("ses_other") },
      { type: "tool.execute.after", ts: AFTER_ISO, sessionID: "ses_other", tool: "bash" },
    ],
  })
  assert.equal(figures.wrap_records, "0")
  assert.equal(figures.wrap_tool_after, "0")
})

test("a tool.execute.after before the wrap-up is not the same-turn call", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: SPAWN_MS + 1000, end: SPAWN_MS + 2000 },
      { tool: "bash", start: SPAWN_MS + 3000, end: SPAWN_MS + 4000 },
    ]),
    records: [
      { type: "tool.execute.after", ts: "2026-09-13T10:02:00.000Z", sessionID: SESSION, tool: "bash" },
      { type: "messages", ts: WRAP_ISO, messages: wrapMessages() },
    ],
  })
  assert.equal(figures.wrap_records, "1")
  assert.equal(figures.wrap_tool_after, "0")
})

test("WRAP_HEAD quoted in the spawn prompt is not counted as the wrap-up band", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader({
    messages: sessionMessages([
      { tool: "bash", start: SPAWN_MS + 1000, end: SPAWN_MS + 2000 },
      { tool: "bash", start: SPAWN_MS + 3000, end: SPAWN_MS + 4000 },
    ]),
    records: [
      {
        type: "messages",
        ts: SPAWN_ISO,
        messages: [
          {
            info: { id: "msg_u", role: "user", sessionID: SESSION },
            parts: [{ type: "text", text: `When you receive a notice headed "${WRAP_HEAD}", reply Blocked:` }],
          },
        ],
      },
    ],
  })
  assert.equal(figures.wrap_records, "0")
  assert.equal(figures.wrap_at_or_after, "0")
})

test("runWrapUpBlock still starts with the head the reader looks for", () => {
  assert.match(PROMPTS, /⏳ RUN CEILING AHEAD\./)
  assert.match(PROMPTS, /export function runWrapUpBlock/)
  assert.match(SETTINGS, /export const RUN_WRAP_UP = 0\.75/)
  assert.match(NOTICES, /cut off on its run ceiling/)
  assert.match(NOTICES, /What it produced before it was cut off/)
})

test("run-all.sh: the run-ceiling driver runs after context-bands-task.sh", () => {
  assert.match(RUN_ALL, /"\$HERE\/run-ceiling-task\.sh" \|\| ASSERTING_FAILED=/)
  const ceiling = RUN_ALL.indexOf('"$HERE/run-ceiling-task.sh"')
  const bands = RUN_ALL.indexOf('"$HERE/context-bands-task.sh"')
  const mcp = RUN_ALL.indexOf('"$HERE/mcp-after-task.sh"')
  const endless = RUN_ALL.indexOf('"$HERE/endless-task.sh"')
  assert.ok(ceiling > bands, "run-ceiling-task.sh is sequenced after context-bands-task.sh")
  assert.ok(ceiling < mcp, "run-ceiling-task.sh is sequenced before mcp-after-task.sh")
  assert.ok(ceiling < endless, "run-ceiling-task.sh is sequenced before endless-task.sh")
  assert.ok(RUN_ALL.includes("20-run-ceiling.report.txt"), "the suite's failure line names no report for it")
})

test("the driver pins maxSubagentRunMs in its isolated agent-intercom.json and owns port 4612", () => {
  assert.match(DRIVER, /e2e_iso_create/)
  const isoJson = DRIVER.match(/e2e_iso_create[\s\S]*?printf '(\{[^']*\})'/)
  assert.ok(isoJson, "e2e_iso_create is given a printf JSON argument")
  assert.match(isoJson[1], /"maxSubagentRunMs":%s/)
  assert.match(isoJson[1], /"maxSubagentAgeMs":%s/)
  assert.match(isoJson[1], /"maxSubagentToolCallMs":%s/)
  assert.match(DRIVER, /RUN_CEILING_PORT:-4612/)
  assert.doesNotMatch(DRIVER, /RUN_CEILING_PORT:-4567/)
  assert.match(DRIVER, /OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1/)
  assert.match(DRIVER, /OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE/)
  assert.match(DRIVER, /NOT ASSERTED/)
  assert.match(DRIVER, /neither-old/)
  assert.match(DRIVER, /RUN_WRAP_UP/)
  assert.match(DRIVER, /rc_rescued_decide/)
  assert.match(DRIVER, /STILL-WAITING for \$WAIT_FILE/)
  assert.doesNotMatch(DRIVER, /CONTROL_MARKER hits=\$\{CONTROL_HIT:-0\}\); longest_call/)
  assert.match(readFileSync(READER, "utf8"), /CARRIER_SUFFIX/)
})

const DRIVER_PATH = resolve(import.meta.dirname, "e2e/run-ceiling-task.sh")

function assistantText(text) {
  return {
    info: { id: "msg_a_text", role: "assistant", sessionID: SESSION },
    parts: [{ type: "text", text }],
  }
}

function runRescuedDecide({
  capture,
  resultFile = false,
  rescuedHit = 0,
  sessionGone = 1,
  securedLine = '{"file":null,"secured":true,"sessionID":"ses_poller"}',
  parsed,
  tools,
}) {
  const dir = mkdtempSync(join(tmpdir(), "run-ceiling-rescued-"))
  const project = join(dir, "project")
  mkdirSync(join(project, "work"), { recursive: true })
  const capturePath = join(dir, "messages.json")
  if (capture !== "missing") {
    writeFileSync(capturePath, JSON.stringify(capture))
  }
  const filePath = join(project, "work", "agent-intercom-result-h-ses_poller.md")
  if (resultFile) writeFileSync(filePath, "STILL-WAITING for e2e-run-ceiling-never.txt\n")

  const script = `
set -uo pipefail
RC_SOURCE_ONLY=1
. ${JSON.stringify(DRIVER_PATH)}
PROJECT=${JSON.stringify(project)}
RESULT_FILE=${resultFile ? JSON.stringify(filePath) : '""'}
RESCUED_HIT=${rescuedHit}
SESSION_GONE=${sessionGone}
SECURED_LINE=${JSON.stringify(securedLine)}
USABLE=$(rc_usable_assistant ${JSON.stringify(capture === "missing" ? join(dir, "absent.json") : capturePath)})
R_parsed=${parsed}
R_tools=${tools}
rc_rescued_decide
printf 'RC_DECIDE_ok=%s\\n' "$RC_RESCUED_OK"
printf 'RC_DECIDE_usable=%s\\n' "$USABLE"
printf 'RC_DECIDE_evidence=%s\\n' "$RC_RESCUED_EVIDENCE"
`
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", cwd: resolve(import.meta.dirname, "e2e") })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(result.status, 0, `rescued decide failed to run: ${result.stderr || result.stdout}`)
  const figures = {}
  for (const line of result.stdout.split("\n")) {
    if (!line.startsWith("RC_DECIDE_")) continue
    const at = line.indexOf("=")
    if (at > 0) figures[line.slice("RC_DECIDE_".length, at)] = line.slice(at + 1)
  }
  return figures
}

test("rescued decide: nonempty capture requires a project work file and the produced-text marker", () => {
  const t0 = SPAWN_MS + 1000
  const capture = [
    ...sessionMessages([
      { tool: "bash", start: t0, end: t0 + 15000 },
      { tool: "bash", start: t0 + 20000, end: t0 + 35000 },
    ]),
    assistantText("STILL-WAITING for e2e-run-ceiling-never.txt"),
  ]
  const missing = runRescuedDecide({ capture, parsed: 1, tools: 2, rescuedHit: 0, resultFile: false })
  assert.equal(missing.usable, "1")
  assert.equal(missing.ok, "0")
  assert.match(missing.evidence, /result file=none/)

  const ok = runRescuedDecide({ capture, parsed: 1, tools: 2, rescuedHit: 1, resultFile: true })
  assert.equal(ok.usable, "1")
  assert.equal(ok.ok, "1")
  assert.match(ok.evidence, /result file /)
  assert.match(ok.evidence, /What it produced before it was cut off/)
})

test("rescued decide: parsed capture with tools>=2 and USABLE=0 plus file:null secured:true is empty PASS", () => {
  const t0 = SPAWN_MS + 1000
  const capture = sessionMessages([
    { tool: "bash", start: t0, end: t0 + 15000 },
    { tool: "bash", start: t0 + 20000, end: t0 + 35000 },
  ])
  const figures = runRescuedDecide({
    capture,
    parsed: 1,
    tools: 2,
    rescuedHit: 0,
    resultFile: false,
    sessionGone: 1,
    securedLine: 'subagent state secured {"sessionID":"ses_poller","file":null,"secured":true}',
  })
  assert.equal(figures.usable, "0")
  assert.equal(figures.ok, "1")
  assert.match(figures.evidence, /no usable assistant text/)
})

test("rescued decide: missing capture is FAIL even with session gone and file:null secured:true", () => {
  const figures = runRescuedDecide({
    capture: "missing",
    parsed: 0,
    tools: 0,
    rescuedHit: 0,
    resultFile: false,
    sessionGone: 1,
    securedLine: 'subagent state secured {"sessionID":"ses_poller","file":null,"secured":true}',
  })
  assert.equal(figures.usable, "0")
  assert.equal(figures.ok, "0")
  assert.match(figures.evidence, /usable unknown — capture missing\/unparsed/)
})
