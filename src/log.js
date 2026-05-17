// Debug logging — on by default, off only with OPENCODE_AGENT_INTERCOM_DEBUG="0".

import fs from "node:fs"

const DEBUG = process.env.OPENCODE_AGENT_INTERCOM_DEBUG !== "0"
const LOG_DIR = "/tmp/opencode-agent-intercom"
const LOG_PATH = `${LOG_DIR}/debug.log`

// Normalizes a thrown value to a short message string.
export function errMsg(err) {
  return String(err?.message ?? err)
}

function formatArgs(args) {
  return args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
}

export function log(...args) {
  if (!DEBUG) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${formatArgs(args)}\n`)
  } catch {
    // logging must never break the plugin
  }
}
