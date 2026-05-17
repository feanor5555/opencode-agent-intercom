// Runtime-tunable settings: the subagent concurrency cap and the subagent
// context budget. Resolved as file > env var > built-in default, so the
// companion TUI plugin can change them live by writing the shared JSON file —
// no opencode restart needed.
//
// Shared file path (the TUI plugin hardcodes the same path, it is a separate
// npm package and cannot import this module):
//   ~/.config/opencode/agent-intercom.json   { "maxSubagents": N, "maxContext": N }

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./log.js"

const DEFAULT_MAX_SUBAGENTS = 1
const DEFAULT_MAX_CONTEXT = 40000
const TTL_MS = 2000

let settingsPath = join(homedir(), ".config", "opencode", "agent-intercom.json")
let cache = null
let cachedAt = 0

// Reads a non-negative integer env var, falling back to `def` when unset/invalid.
function envNum(name, def) {
  const env = process.env[name]
  if (env === undefined || env === "") return def
  const n = Number(env)
  return Number.isInteger(n) && n >= 0 ? n : def
}

// Current settings: { maxSubagents, maxContext }. Cached for TTL_MS so the
// hot paths (spawn, every subagent transform) don't stat the file constantly.
export function getSettings() {
  const now = Date.now()
  if (cache && now - cachedAt < TTL_MS) return cache
  const resolved = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
  }
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"))
    if (Number.isInteger(raw?.maxSubagents) && raw.maxSubagents >= 0) {
      resolved.maxSubagents = raw.maxSubagents
    }
    if (Number.isInteger(raw?.maxContext) && raw.maxContext >= 0) {
      resolved.maxContext = raw.maxContext
    }
  } catch {
    // no file / unreadable -> env + defaults; not an error
  }
  cache = resolved
  cachedAt = now
  log("settings resolved", resolved)
  return cache
}

// Test-only: point at a different file and drop the cache.
export function setSettingsPath(p) {
  settingsPath = p
  resetSettings()
}

// Test-only: invalidate the cache so the next getSettings() re-reads the file.
export function resetSettings() {
  cache = null
  cachedAt = 0
}
