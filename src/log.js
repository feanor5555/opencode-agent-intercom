// Debug logging — on by default, off only with OPENCODE_AGENT_INTERCOM_DEBUG="0".

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DEBUG = process.env.OPENCODE_AGENT_INTERCOM_DEBUG !== "0"

// User-private cache dir for all plugin logs. Deliberately NOT under /tmp:
// a world-traversable directory with a fixed name lets any local user pre-create
// or symlink the target, and appendFileSync follows symlinks.
export function cacheDir() {
  return path.join(os.homedir(), ".cache", "opencode-agent-intercom")
}

// Best-effort mkdir of the cache dir (0700). Never throws — logging must never
// break the plugin.
export function ensureCacheDir() {
  const dir = cacheDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // ignore — caller's own write will simply fail and get swallowed
  }
  return dir
}

const LOG_PATH = path.join(cacheDir(), "debug.log")

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
    ensureCacheDir()
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${formatArgs(args)}\n`)
  } catch {
    // logging must never break the plugin
  }
}
