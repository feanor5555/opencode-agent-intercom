// The request logger's tool-hook records: what the MCP-after e2e driver reads
// to decide whether opencode fired `tool.execute.after`. ENABLED is latched at
// import, so each case is a fresh process with the env set before the import.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const REQLOG = resolve(import.meta.dirname, "../src/reqlog.js")
const REQLOG_URL = pathToFileURL(REQLOG).href

function runCapture(env, script) {
  const dir = mkdtempSync(join(tmpdir(), "reqlog-"))
  const file = join(dir, "requests.jsonl")
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.env.OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE = ${JSON.stringify(file)};
${script}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  )
  const body = existsSync(file) ? readFileSync(file, "utf8") : ""
  rmSync(dir, { recursive: true, force: true })
  return { ...result, body, file }
}

test("captureToolExecute writes type=tool.execute.after with tool, sessionID, callID", () => {
  const r = runCapture(
    { OPENCODE_AGENT_INTERCOM_LOG_REQUESTS: "1" },
    `const { captureToolExecute } = await import(${JSON.stringify(REQLOG_URL)});
captureToolExecute("after", { sessionID: "ses_sub", tool: "e2eping_ping", callID: "call_1" });
captureToolExecute("before", { sessionID: "ses_sub", tool: "e2eping_ping", callID: "call_1" });`,
  )
  assert.equal(r.status, 0, r.stderr)
  const lines = r.body.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].type, "tool.execute.after")
  assert.equal(lines[0].tool, "e2eping_ping")
  assert.equal(lines[0].sessionID, "ses_sub")
  assert.equal(lines[0].callID, "call_1")
  assert.equal(lines[1].type, "tool.execute.before")
  assert.equal(lines[1].tool, "e2eping_ping")
})

test("captureToolExecute writes nothing when the request log is off", () => {
  const r = runCapture(
    { OPENCODE_AGENT_INTERCOM_LOG_REQUESTS: "0" },
    `const { captureToolExecute, isEnabled } = await import(${JSON.stringify(REQLOG_URL)});
if (isEnabled()) throw new Error("expected disabled");
captureToolExecute("after", { sessionID: "ses_sub", tool: "e2eping_ping", callID: "call_1" });`,
  )
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.body, "")
})
