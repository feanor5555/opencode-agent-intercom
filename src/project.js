// A compact, cached project snapshot prepended to every spawned subagent's
// task, so subagents don't start blind: project root, package.json identity if
// present, and a shallow file tree. Computed once per process. Deliberately
// light — this is orientation, not documentation.
//
// Disable with OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT="0".

import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { log, errMsg } from "./log.js"

const ENABLED = process.env.OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT !== "0"

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  ".cache", "vendor", "__pycache__", ".venv", "target", ".idea",
])
const MAX_DEPTH = 2
const MAX_LINES = 70

// Per-directory cache so an `opencode serve` instance spanning multiple project
// roots gets the correct snapshot for each — keying on `directory` alone would
// otherwise pin the snapshot to whichever root called first.
const cache = new Map()

// Returns the project-context block for `directory` (empty string if disabled
// or unreadable). Cached per `directory` after the first call.
export function projectContext(directory) {
  if (!ENABLED) return ""
  const key = directory ?? ""
  if (cache.has(key)) return cache.get(key)
  const value = directory ? build(directory) : ""
  cache.set(key, value)
  return value
}

// Test-only: clears the cache so a test can point at a fresh fixture directory.
export function resetProjectContext() {
  cache.clear()
}

function build(directory) {
  try {
    const lines = treeLines(directory, "", 0)
    const truncated = lines.length > MAX_LINES
    const tree = (truncated ? lines.slice(0, MAX_LINES) : lines).join("\n")
    // When PROJECT.md exists, name/description are already authoritative there
    // (Runtime facts + Key files supersede package.json identity); echoing them
    // here just doubles the bytes the subagent sees on every spawn.
    const meta = hasProjectMd(directory) ? "" : packageMeta(directory)
    return (
      "--- agent-intercom: project context (auto-provided, for orientation) ---\n" +
      `root: ${directory}\n` +
      (meta ? meta + "\n" : "") +
      `file tree (depth ${MAX_DEPTH}, vendored/build dirs omitted):\n` +
      tree +
      (truncated ? "\n… (tree truncated)" : "") +
      "\n--- end project context ---"
    )
  } catch (err) {
    log("projectContext failed", errMsg(err))
    return ""
  }
}

function hasProjectMd(directory) {
  try {
    return existsSync(join(directory, "PROJECT.md"))
  } catch {
    return false
  }
}

function treeLines(dir, prefix, depth) {
  if (depth >= MAX_DEPTH) return []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries = entries
    .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .sort((a, b) => {
      const ad = a.isDirectory()
      const bd = b.isDirectory()
      return ad === bd ? a.name.localeCompare(b.name) : ad ? -1 : 1
    })
  const out = []
  for (const e of entries) {
    const isDir = e.isDirectory()
    out.push(`${prefix}${e.name}${isDir ? "/" : ""}`)
    if (isDir) out.push(...treeLines(join(dir, e.name), prefix + "  ", depth + 1))
  }
  return out
}

function packageMeta(directory) {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
    const bits = []
    if (pkg.name) bits.push(`name: ${pkg.name}`)
    if (pkg.description) bits.push(`description: ${pkg.description}`)
    return bits.length > 0 ? `package.json — ${bits.join(", ")}` : ""
  } catch {
    return "" // no package.json / not a node project — fine
  }
}
