// Opt-in request logger. Captures everything opencode hands to the LLM:
// system prompt array, full messages history, sampling params — and, when a
// tool actually runs, the `tool.execute.before` / `tool.execute.after` hook
// pair (type, tool, sessionID, callID). Writes one JSONL record per hook call
// to a file. Off unless OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1. The tool-hook
// records are what an end-to-end run reads to see whether opencode fired
// `after` for an MCP tool; the LLM captures cannot show that.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { log, errMsg, cacheDir } from "./log.js"

const ENABLED = process.env.OPENCODE_AGENT_INTERCOM_LOG_REQUESTS === "1"
const FILE =
  process.env.OPENCODE_AGENT_INTERCOM_LOG_REQUESTS_FILE ||
  join(cacheDir(), "requests.jsonl")

let dirEnsured = false
function ensureDir() {
  if (dirEnsured) return
  try {
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 })
    dirEnsured = true
  } catch (err) {
    log("reqlog mkdir failed", errMsg(err))
  }
}

function write(record) {
  if (!ENABLED) return
  ensureDir()
  try {
    appendFileSync(FILE, JSON.stringify(record) + "\n")
  } catch (err) {
    log("reqlog write failed", errMsg(err))
  }
}

export function isEnabled() {
  return ENABLED
}

export function captureSystem(input, output) {
  if (!ENABLED) return
  write({
    type: "system",
    ts: new Date().toISOString(),
    sessionID: input?.sessionID,
    model: input?.model,
    system: output?.system,
  })
}

export function captureMessages(_input, output) {
  if (!ENABLED) return
  write({
    type: "messages",
    ts: new Date().toISOString(),
    messages: output?.messages,
  })
}

export function captureParams(input, output) {
  if (!ENABLED) return
  write({
    type: "params",
    ts: new Date().toISOString(),
    sessionID: input?.sessionID,
    agent: input?.agent,
    model: input?.model,
    params: {
      temperature: output?.temperature,
      topP: output?.topP,
      topK: output?.topK,
      maxOutputTokens: output?.maxOutputTokens,
      options: output?.options,
    },
  })
}

// phase is "before" or "after". The record's `type` is `tool.execute.<phase>`
// and `tool` is the name opencode put on the call — MCP tools included, with
// whatever namespace opencode gave them.
export function captureToolExecute(phase, input) {
  if (!ENABLED) return
  const kind = phase === "after" ? "after" : "before"
  write({
    type: `tool.execute.${kind}`,
    ts: new Date().toISOString(),
    sessionID: input?.sessionID,
    tool: input?.tool,
    callID: input?.callID,
  })
}
