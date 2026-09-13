// Shell-level tests for the MCP-after evidence reader and the local ping server.
// `test/e2e/mcp-after-task.sh` decides FIRES / DOES_NOT_FIRE / TOOL_NOT_SEEN from
// what `test/e2e/lib/mcp-after.py` reads out of the plugin's request log, so that
// reader is driven here with built records — no server, no model, no cost.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const READER = resolve(import.meta.dirname, "e2e/lib/mcp-after.py")
const SERVER = resolve(import.meta.dirname, "e2e/lib/mcp-ping-server.js")
const INDEX = resolve(import.meta.dirname, "../src/index.js")
const REQLOG = resolve(import.meta.dirname, "../src/reqlog.js")
const DRIVER = readFileSync(resolve(import.meta.dirname, "e2e/mcp-after-task.sh"), "utf8")
const RUN_ALL = readFileSync(resolve(import.meta.dirname, "e2e/run-all.sh"), "utf8")
const SESSION = "ses_sub1"

const python = spawnSync("python3", ["--version"])
const HAVE_PYTHON = python.status === 0

function runReader(records, sessionID = SESSION) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-after-reader-"))
  const file = join(dir, "requests.jsonl")
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""))
  const result = spawnSync("python3", [READER, file, sessionID], { encoding: "utf8" })
  assert.equal(result.status, 0, `reader failed: ${result.stderr}`)
  const figures = {}
  for (const line of result.stdout.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) figures[line.slice(0, at)] = line.slice(at + 1)
  }
  rmSync(dir, { recursive: true, force: true })
  return figures
}

function hook(type, tool, sessionID = SESSION) {
  return { type, ts: "2026-09-13T10:00:00.000Z", sessionID, tool, callID: "call_1" }
}

function messagesRecord(tool, sessionID = SESSION) {
  return {
    type: "messages",
    ts: "2026-09-13T10:00:00.000Z",
    messages: [
      {
        info: { id: "msg_a1", role: "assistant", sessionID },
        parts: [{ id: "p1", type: "tool", tool, state: { status: "completed" } }],
      },
    ],
  }
}

test("FIRES when tool.execute.after ran for the MCP ping", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([
    hook("tool.execute.before", "e2eping_ping"),
    hook("tool.execute.after", "e2eping_ping"),
  ])
  assert.equal(figures.verdict, "FIRES")
  assert.equal(figures.invoked, "1")
  assert.equal(figures.before_count, "1")
  assert.equal(figures.after_count, "1")
  assert.equal(figures.after_tool, "e2eping_ping")
})

test("DOES_NOT_FIRE when the ping was invoked and after wrote nothing", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([hook("tool.execute.before", "e2eping_ping")])
  assert.equal(figures.verdict, "DOES_NOT_FIRE")
  assert.equal(figures.invoked, "1")
  assert.equal(figures.after_count, "0")
  assert.equal(figures.before_count, "1")
})

test("DOES_NOT_FIRE when only a messages tool-part named the ping", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([messagesRecord("e2eping_ping")])
  assert.equal(figures.verdict, "DOES_NOT_FIRE")
  assert.equal(figures.part_count, "1")
  assert.equal(figures.part_tool, "e2eping_ping")
  assert.equal(figures.before_count, "0")
  assert.equal(figures.after_count, "0")
})

test("TOOL_NOT_SEEN is distinct from DOES_NOT_FIRE", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([
    hook("tool.execute.before", "bash"),
    hook("tool.execute.after", "bash"),
    messagesRecord("bash"),
  ])
  assert.equal(figures.verdict, "TOOL_NOT_SEEN")
  assert.equal(figures.invoked, "0")
})

test("another session's hook records are not read", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([
    hook("tool.execute.after", "e2eping_ping", "ses_other"),
    hook("tool.execute.before", "e2eping_ping", "ses_other"),
  ])
  assert.equal(figures.parsed, "0")
  assert.equal(figures.verdict, "TOOL_NOT_SEEN")
})

test("a namespaced MCP name still counts as the ping", { skip: !HAVE_PYTHON }, () => {
  const figures = runReader([hook("tool.execute.after", "mcp_e2eping_ping")])
  assert.equal(figures.verdict, "FIRES")
  assert.equal(figures.after_tool, "mcp_e2eping_ping")
})

test("the ping server returns pong and lists ping", () => {
  const child = spawnSync(
    process.execPath,
    [SERVER],
    {
      encoding: "utf8",
      input:
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ping", arguments: {} } }) +
        "\n",
      timeout: 5000,
    },
  )
  assert.equal(child.status, 0, child.stderr)
  const replies = child.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]))
  assert.equal(byId[1].result.serverInfo.name, "e2eping")
  assert.equal(byId[2].result.tools[0].name, "ping")
  assert.equal(byId[3].result.content[0].text, "pong")
})

test("src/index.js logs before and after into reqlog", () => {
  const source = readFileSync(INDEX, "utf8")
  assert.match(source, /captureToolExecute\("before"/)
  assert.match(source, /captureToolExecute\("after"/)
  const reqlog = readFileSync(REQLOG, "utf8")
  assert.match(reqlog, /type: `tool\.execute\.\$\{kind\}`/)
})

test("run-all.sh: the mcp-after driver runs after context-bands-task.sh", () => {
  assert.match(RUN_ALL, /"\$HERE\/mcp-after-task\.sh" \|\| ASSERTING_FAILED=/)
  const afterBands = RUN_ALL.indexOf('"$HERE/mcp-after-task.sh"')
  const bands = RUN_ALL.indexOf('"$HERE/context-bands-task.sh"')
  const endless = RUN_ALL.indexOf('"$HERE/endless-task.sh"')
  assert.ok(afterBands > bands, "mcp-after-task.sh is sequenced after context-bands-task.sh")
  assert.ok(afterBands < endless, "mcp-after-task.sh is sequenced before endless-task.sh")
  assert.ok(RUN_ALL.includes("18-mcp-after.report.txt"), "the suite's failure line names no report for it")
})

test("the driver patches MCP into the isolated opencode.json and uses its own port", () => {
  assert.match(DRIVER, /e2e_iso_create/)
  const isoJson = DRIVER.match(/e2e_iso_create[\s\S]*?printf '(\{[^']*\})'/)
  assert.ok(isoJson, "e2e_iso_create is given a printf JSON argument")
  assert.doesNotMatch(isoJson[1], /mcp/, "e2e_iso_create is not given an mcp argument")
  const assigned = DRIVER.match(/cfg\["mcp"\] = \{([\s\S]*?)^\}/m)
  assert.ok(assigned, 'the driver assigns cfg["mcp"] as a whole object')
  const topKeys = [...assigned[1].matchAll(/^ {4}"([^"]+)":/gm)].map((m) => m[1])
  assert.deepEqual(topKeys, ["e2eping"], "the assigned mcp object has e2eping only")
  assert.match(DRIVER, /mcp-ping-server\.js/)
  assert.match(DRIVER, /MCP_AFTER_PORT:-4608/)
  assert.doesNotMatch(DRIVER, /MCP_AFTER_PORT:-4567/)
  assert.match(DRIVER, /OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1/)
  assert.match(DRIVER, /OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE/)
  assert.match(DRIVER, /VERDICT /)
})
