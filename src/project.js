// A compact, cached project snapshot prepended to every spawned subagent's
// task, so subagents don't start blind: project root, package.json identity if
// present, and a shallow file tree. Computed once per process. Deliberately
// light — this is orientation, not documentation.
//
// Disable with OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT="0".

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs"
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
  "# Project\n" +
  "\n" +
  "## Documents\n" +
  "\n" +
  "- [ARCHITECTURE.md](ARCHITECTURE.md) — canonical file for software architecture.\n" +
  "- [TODO.md](TODO.md) — canonical file for tasks/TODOs.\n"

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

// --- Primary-agent handoff summary ------------------------------------------
//
// The "primary summary" is a short markdown brief captured by the orchestrator
// at handoff time: where the project stands, what to watch out for, and what
// the next orchestrator session should do. Persisted under a per-plugin state
// dir so it lives alongside (not inside) the user's project documents —
// distinct from PROJECT.md, which is user-editable project index content.

// Per-plugin state dir, mirroring opencode's own `.opencode/` convention so
// the plugin's persisted artifacts don't clutter the project root.
const PRIMARY_SUMMARY_DIR = ".opencode/agent-intercom"
const PRIMARY_SUMMARY_FILE = "primary-summary.md"

// The three section headers, in fixed order. Kept as constants so a later
// slice (content gathering + threshold compare) reads them back the same way
// `formatPrimarySummary` writes them.
const SECTION_STAND = "Stand / Aktueller Zustand"
const SECTION_NOTES = "Zu beachtende Punkte"
const SECTION_PLANNED = "Geplante Schritte"

// Returns the absolute path where the primary handoff summary lives for
// `directory`. Pure — no filesystem access.
export function primarySummaryPath(directory) {
  return join(directory, PRIMARY_SUMMARY_DIR, PRIMARY_SUMMARY_FILE)
}

// Renders a markdown primary summary from structured input. PURE: deterministic
// output, no I/O, no timestamps. `stand` accepts a string (rendered as a
// paragraph) or an array of strings (rendered as a bulleted list, mirroring
// notes/plannedSteps). Empty / missing sections render as a bare header so the
// consuming agent can see they were intentionally empty, not forgotten.
export function formatPrimarySummary({ stand, notes, plannedSteps } = {}) {
  const lines = []
  lines.push(`## ${SECTION_STAND}`)
  lines.push("")
  lines.push(...renderStandSection(stand))
  lines.push("")
  lines.push(`## ${SECTION_NOTES}`)
  lines.push("")
  lines.push(...renderListSection(notes))
  lines.push("")
  lines.push(`## ${SECTION_PLANNED}`)
  lines.push("")
  lines.push(...renderListSection(plannedSteps))
  return lines.join("\n") + "\n"
}

function renderStandSection(stand) {
  if (stand == null) return []
  if (Array.isArray(stand)) return renderListSection(stand)
  const text = String(stand).trim()
  return text ? [text] : []
}

function renderListSection(items) {
  if (!Array.isArray(items)) return []
  const cleaned = items.map((s) => String(s ?? "").trim()).filter(Boolean)
  return cleaned.map((s) => `- ${s}`)
}

// Writes the primary summary markdown to disk, creating the per-plugin state
// dir if needed. Thin I/O — caller is responsible for providing already-
// formatted markdown (use formatPrimarySummary).
export function writePrimarySummary(directory, markdown) {
  if (!directory) return
  const filePath = primarySummaryPath(directory)
  try {
    mkdirSync(join(directory, PRIMARY_SUMMARY_DIR), { recursive: true })
    writeFileSync(filePath, markdown ?? "", "utf8")
  } catch (err) {
    log("writePrimarySummary failed", { filePath, err: errMsg(err) })
  }
}

// Returns the primary summary markdown for `directory`, or "" when absent /
// unreadable. Parallel to projectMdBlock: same "empty string when missing"
// contract so the system-prompt placeholder collapses cleanly.
export function readPrimarySummary(directory) {
  if (!directory) return ""
  const filePath = primarySummaryPath(directory)
  try {
    return readFileSync(filePath, "utf8")
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      log("readPrimarySummary failed", { filePath, err: errMsg(err) })
    }
    return ""
  }
}

// --- TODO.md: planned-step extraction for handoff ---------------------------
//
// Reads `<directory>/TODO.md` and returns the OPEN / planned task lines as a
// flat string array. Used by `performPrimaryHandoff` (handoff.js, step 1) to
// populate the "Geplante Schritte" section of the new orchestrator's kickoff
// summary — the new orchestrator is a fresh session and needs to see what was
// still on the list before the handoff.
//
// Parse heuristic (deliberately tolerant — the project may use either layout):
//
//   1. If the file contains a `## Offen` (German) heading, return the list
//      items under it — everything between that heading and the next `## …`
//      heading (or EOF). Items are de-bulleted (`- ` prefix stripped) and
//      trimmed. Continuation lines (the indented `accept:` block under a
//      `- T<n>: …` header) are kept as-is — they belong to the task and the
//      new orchestrator needs to see the acceptance criterion.
//
//   2. Otherwise, treat the whole file as the candidate list and return any
//      non-empty markdown list item whose first character is `- ` or `* `.
//      This handles the canonical `todofile.js` layout (`- T5: …` lines,
//      flat top-to-bottom) AND a loose checkbox layout (`- [ ] …`).
//
//   3. If the file is absent, unreadable, or empty, return `[]` — same
//      "graceful empty" contract as `readPrimarySummary` so the handoff
//      summary's plannedSteps section simply renders as a bare header.
//
// The parser is intentionally NOT linked to `todofile.parseTasks`:
// `readPlannedSteps` returns plain strings (one per planned step) suitable
// for direct rendering in the markdown summary, whereas `parseTasks` returns
// structured `{id, text, accept, …}` records intended for the TODO tools.
export function readPlannedSteps(directory) {
  if (!directory) return []
  const filePath = join(directory, "TODO.md")
  let content
  try {
    content = readFileSync(filePath, "utf8")
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      log("readPlannedSteps failed", { filePath, err: errMsg(err) })
    }
    return []
  }
  return extractPlannedStepLines(content)
}

// Pure parser — split out from readPlannedSteps so a unit test can drive it
// without touching the filesystem.
function extractPlannedStepLines(content) {
  const lines = content.split("\n")
  // Step 1: find a `## Offen` section and bound it by the next `## ` heading.
  const offenIdx = lines.findIndex((l) => /^##\s+Offen\s*$/i.test(l))
  let region
  if (offenIdx >= 0) {
    let endIdx = lines.length
    for (let i = offenIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        endIdx = i
        break
      }
    }
    region = lines.slice(offenIdx + 1, endIdx)
    return region.map(stripBullet).filter(nonEmpty)
  }
  // Step 2: no Offen heading — fall back to top-level list items across the
  // whole file. Anything that starts with `- ` or `* ` (with optional leading
  // whitespace — but we don't accept deeply-nested items; they're a different
  // document). Continuation lines (the indented `accept:` block) are kept as
  // their own strings, glued to their parent task by file order. Heading
  // lines (`# …` / `## …`) are stripped — they're document structure, not
  // tasks, and we don't want the title "TODO" appearing in the handoff
  // summary.
  return lines
    .map(stripBullet)
    .filter((s) => s.length > 0 && !/^#{1,6}\s/.test(s))
}

// Strips a leading `- ` / `* ` / `- [ ] ` / `- [x] ` bullet (with optional
// whitespace before) and trims. Non-bullet lines are returned unchanged
// (trimmed) — that lets `accept:` continuation lines flow through.
function stripBullet(line) {
  const trimmed = line.replace(/^\s+/, "").replace(/\s+$/, "")
  const m = /^(?:[-*])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(trimmed)
  return m ? m[1].trim() : trimmed
}

function nonEmpty(s) {
  return s.length > 0
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
