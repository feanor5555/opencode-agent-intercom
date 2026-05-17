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
  specCache.clear()
}

// A compact PROJECT.md-driven spec block intended for the SYSTEM PROMPT of every
// agent (orchestrator and subagents alike). Goal: keep ports, key files, runtime
// facts visible on every turn so the model can't fall back on training-set
// defaults (e.g. "Spring Boot runs on 8080", "Postgres on 5432") when this project
// uses different values. The block stays small — full doc still lives in
// PROJECT.md.
//
// When PROJECT.md is absent we still inject a short notice: the spec is unknown,
// and the agent must source operational facts from project files (or escalate
// via MISSING). That stops silent halluzination just as well as the present case.
//
// Cached per directory to keep transformSystem cheap.
const SPEC_MAX = 1500
const specCache = new Map()

export function projectSpecBlock(directory) {
  if (!ENABLED) return ""
  const key = directory ?? ""
  if (specCache.has(key)) return specCache.get(key)
  const value = directory ? buildSpec(directory) : ""
  specCache.set(key, value)
  return value
}

// Test-only: drops a single directory's spec cache so a test can mutate the
// PROJECT.md on disk and see the next call re-read it.
export function forgetProjectSpec(directory) {
  specCache.delete(directory ?? "")
}

function buildSpec(directory) {
  try {
    if (!existsSync(join(directory, "PROJECT.md"))) {
      return (
        "\n\n---\n📌 agent-intercom: project spec.\n" +
        `root: ${directory}\n` +
        "PROJECT.md: NOT PRESENT — operational facts (ports, URLs, key config paths, " +
        "framework versions) are NOT specified for this project. Do NOT fall back on " +
        "framework defaults from your training (e.g. \"Spring Boot port 8080\", \"Postgres " +
        "port 5432\") — those are almost certainly wrong here. Source any fact you need " +
        "from the actual project files (application.properties / application.yml / .env / " +
        "docker-compose.yml / pom.xml / package.json / config/*). When still unknown, " +
        "stop and report `MISSING: <fact>` (subagents: `BLOCKED: T<n> — MISSING: <fact>` " +
        "on the first line) so the orchestrator can spawn a planner to specify it.\n" +
        "---\n"
      )
    }
    const excerpt = projectMdExcerpt(directory)
    if (!excerpt) {
      return (
        "\n\n---\n📌 agent-intercom: project spec.\n" +
        `root: ${directory}\n` +
        "PROJECT.md exists but contains none of the operational sections (Status / Runtime " +
        "facts / Key files / External links). Treat operational facts as unspecified: source " +
        "them from project files, do not guess framework defaults. If you can't resolve a " +
        "fact, report `MISSING: <fact>` (subagents: `BLOCKED: T<n> — MISSING: <fact>` first " +
        "line).\n---\n"
      )
    }
    const capped =
      excerpt.length > SPEC_MAX
        ? excerpt.slice(0, SPEC_MAX) + "\n… (PROJECT.md spec truncated — read PROJECT.md for the rest)"
        : excerpt
    return (
      "\n\n---\n📌 agent-intercom: project spec (from PROJECT.md, authoritative for ports, " +
      "URLs, key files, framework versions). Use these values verbatim — do NOT substitute " +
      "training-set defaults. If a fact you need is not below, read the actual project file; " +
      "if still unknown, report `MISSING: <fact>` (subagents: `BLOCKED: T<n> — MISSING: <fact>` " +
      "first line) so a planner can add it.\n" +
      `root: ${directory}\n\n` +
      capped +
      "\n---\n"
    )
  } catch (err) {
    log("projectSpecBlock failed", errMsg(err))
    return ""
  }
}

function build(directory) {
  try {
    const lines = treeLines(directory, "", 0)
    const truncated = lines.length > MAX_LINES
    const tree = (truncated ? lines.slice(0, MAX_LINES) : lines).join("\n")
    // When PROJECT.md exists, name/description are already authoritative there
    // (Runtime facts + Key files supersede package.json identity); echoing them
    // here just doubles the bytes the subagent sees on every spawn.
    const projectMd = hasProjectMd(directory)
    const meta = projectMd ? "" : packageMeta(directory)
    const excerpt = projectMd ? projectMdExcerpt(directory) : ""
    return (
      "--- agent-intercom: project context (auto-provided, for orientation) ---\n" +
      `root: ${directory}\n` +
      (meta ? meta + "\n" : "") +
      (excerpt ? `PROJECT.md excerpt — authoritative for ports, files, links:\n${excerpt}\n\n` : "") +
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

// Pulls the operational sections out of PROJECT.md so every subagent gets ports,
// key file paths, external links, and current phase/milestone inline — no need
// for the orchestrator to remember and re-tip-toe these into every spawn prompt.
// Total excerpt is capped so it doesn't dominate the context.
const PROJECT_MD_SECTIONS = ["Status", "Runtime facts", "Key files", "External links"]
const PROJECT_MD_MAX = 2000

function projectMdExcerpt(directory) {
  try {
    const content = readFileSync(join(directory, "PROJECT.md"), "utf8")
    const out = []
    for (const name of PROJECT_MD_SECTIONS) {
      const slice = extractMdSection(content, name)
      if (slice) out.push(slice)
    }
    if (out.length === 0) return ""
    const joined = out.join("\n\n")
    return joined.length > PROJECT_MD_MAX
      ? joined.slice(0, PROJECT_MD_MAX) + "\n… (PROJECT.md excerpt truncated)"
      : joined
  } catch {
    return ""
  }
}

function extractMdSection(content, name) {
  const lines = content.split("\n")
  const startRe = new RegExp(`^##\\s+${escapeRegex(name)}\\b`, "i")
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return ""
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join("\n").trim()
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
