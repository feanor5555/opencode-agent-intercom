// A compact, cached project snapshot prepended to every spawned subagent's
// task, so subagents don't start blind: project root, package.json identity if
// present, and a shallow file tree. Computed once per process. Deliberately
// light — this is orientation, not documentation.
//
// Disable with OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT="0".

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs"
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
  projectMdCache.clear()
}

// Injects the full PROJECT.md content into every agent's system prompt, the
// same way opencode injects AGENTS.md. No extraction, no caps, no extra
// instructions — what's in the file is what the model sees. Empty string when
// the file is absent (the `{{project_md}}` placeholder simply collapses).
//
// Mtime-keyed cache so the per-turn cost stays at one stat() call but live
// edits to PROJECT.md are picked up automatically.
const projectMdCache = new Map()

// Default PROJECT.md body written when the file is absent. Lists the two
// load-bearing project documents (ARCHITECTURE.md, TODO.md) with the labels
// the user wants the LLM to see — those labels also nudge subagents toward
// the right file when they look for architecture vs. task content.
const DEFAULT_PROJECT_MD =
  "# Projekt\n" +
  "\n" +
  "## Dokumente\n" +
  "\n" +
  "- [ARCHITECTURE.md](ARCHITECTURE.md) — zentrale Datei für die Softwarearchitektur.\n" +
  "- [TODO.md](TODO.md) — zentrale Datei für Task/TODOs.\n"

// Bootstraps the three project documents at `directory`:
//   - PROJECT.md   → DEFAULT_PROJECT_MD (with links to the other two)
//   - ARCHITECTURE.md → empty
//   - TODO.md      → empty
// Each is created only when absent — never overwrites the user's content.
// Idempotent: re-running with all three present is a no-op.
export function ensureProjectFiles(directory) {
  if (!ENABLED || !directory) return
  try {
    const projectPath = join(directory, "PROJECT.md")
    if (!existsSync(projectPath)) {
      writeFileSync(projectPath, DEFAULT_PROJECT_MD, "utf8")
      log("ensureProjectFiles wrote PROJECT.md", { directory })
    }
    const archPath = join(directory, "ARCHITECTURE.md")
    if (!existsSync(archPath)) {
      writeFileSync(archPath, "", "utf8")
      log("ensureProjectFiles wrote ARCHITECTURE.md", { directory })
    }
    const todoPath = join(directory, "TODO.md")
    if (!existsSync(todoPath)) {
      writeFileSync(todoPath, "", "utf8")
      log("ensureProjectFiles wrote TODO.md", { directory })
    }
  } catch (err) {
    log("ensureProjectFiles failed", { directory, err: errMsg(err) })
  }
}

export function projectMdBlock(directory) {
  if (!ENABLED || !directory) return ""
  ensureProjectFiles(directory)
  const filePath = join(directory, "PROJECT.md")
  let stat
  try {
    stat = statSync(filePath)
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      log("projectMdBlock stat failed", { filePath, err: errMsg(err) })
    }
    projectMdCache.set(directory, { mtimeMs: -1, value: "" })
    return ""
  }
  const cached = projectMdCache.get(directory)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value
  let value = ""
  try {
    const content = readFileSync(filePath, "utf8").trim()
    if (content) {
      value = `\n\n---\n📌 PROJECT.md (project index):\n${content}\n---\n`
    }
  } catch (err) {
    log("projectMdBlock read failed", { filePath, err: errMsg(err) })
  }
  projectMdCache.set(directory, { mtimeMs: stat.mtimeMs, value })
  return value
}

// Test-only: drops a single directory's cache so a test can mutate the
// PROJECT.md on disk and see the next call re-read it.
export function forgetProjectSpec(directory) {
  projectMdCache.delete(directory ?? "")
}

function build(directory) {
  try {
    const lines = treeLines(directory, "", 0)
    const truncated = lines.length > MAX_LINES
    const tree = (truncated ? lines.slice(0, MAX_LINES) : lines).join("\n")
    // PROJECT.md content reaches the LLM separately via the system-prompt
    // `{{project_md}}` placeholder, so the spawn-prompt snapshot stays light:
    // just root, package.json identity (when present), and a shallow tree.
    const meta = packageMeta(directory)
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
