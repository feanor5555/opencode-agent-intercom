// User-editable system prompts, one file per agent. When a project has
// `<project>/.opencode/agent-intercom/<agent>.md`, this loader replaces the
// auto-assembled system prompt for that agent wholesale with the file
// contents (after substituting `{{placeholder}}` tokens for the runtime
// parts).
//
// Layout (per agent):
//   <project>/.opencode/agent-intercom/orchestrator.md
//   <project>/.opencode/agent-intercom/coder.md
//   ...                                  ← 9 files total
//
// File format: free Markdown. The file content IS the system prompt the
// model will see, modulo placeholder substitution at LLM-call time. A
// top-of-file HTML comment (<!-- ... -->) is treated as an author-facing
// note and stripped before substitution.
//
// Placeholders (all optional — remove one to drop that section):
//   {{env}}            opencode's <env> block (cwd, date, platform, git)
//   {{agents_md}}      project AGENTS.md content (opencode injects)
//   {{project_md}}     project PROJECT.md content (agent-intercom injects)
//   {{limits}}         current maxSubagents / maxContext (orchestrator only)
//   {{snapshot}}       list of active subagents (orchestrator only)
//   {{context_budget}} STOP notice when subagent is over budget
//   {{abort_notice}}   STOP notice when this session is aborted
//
// Hot-reload: the loader is mtime-keyed. Editing a file in any editor busts
// the cache on the next stat(); the companion TUI's "reload" button bumps
// the mtime of every file via fs.utimes without an edit.

import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { log, errMsg } from "./log.js"
import { AGENTS } from "./agents.js"
import {
  ORCHESTRATION_GUIDE,
  SUBAGENT_GUIDE_CORE,
  SUBAGENT_OUTLINE_GUIDE,
} from "./prompts.js"

export const PROMPTS_DIRNAME = ".opencode/agent-intercom"
// Read-only reference files showing what opencode would inject WITHOUT this
// plugin's transform hook. Written next to the active per-agent files for
// side-by-side comparison. The plugin does NOT read these.
export const OPENCODE_DEFAULTS_SUBDIR = "_opencode-defaults"

export const AGENT_NAMES = [
  "orchestrator",
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "researcher",
  "designer",
  "gitter",
]

// Which subagents get an outline-discipline block in their default template
// (mirrors hooks.js OUTLINE_DISABLED_AGENTS, inverted).
const HAS_OUTLINE = new Set([
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "researcher",
])

// Which agents get AGENTS.md in their default template (mirrors hooks.js
// AGENTS_MD_SUBAGENTS = {coder, debugger, reviewer} plus orchestrator, which
// is treated as primary there and always keeps AGENTS.md).
const HAS_AGENTS_MD = new Set([
  "orchestrator",
  "coder",
  "debugger",
  "reviewer",
])

export function getPromptsDir(directory) {
  return join(directory, PROMPTS_DIRNAME)
}

export function getPromptFilePath(directory, agent) {
  return join(getPromptsDir(directory), `${agent}.md`)
}

export function getOpencodeDefaultsDir(directory) {
  return join(getPromptsDir(directory), OPENCODE_DEFAULTS_SUBDIR)
}

export function getOpencodeDefaultFilePath(directory, agent) {
  return join(getOpencodeDefaultsDir(directory), `${agent}.md`)
}

// filePath -> { mtimeMs, content } | { mtimeMs: -1, content: null }
const cache = new Map()

// Load (with mtime cache) and return the raw file contents, or null when the
// file is absent / unreadable. Caller substitutes placeholders.
export function loadCustomPrompt(directory, agent) {
  if (!directory || !agent) return null
  const filePath = getPromptFilePath(directory, agent)
  let stat
  try {
    stat = statSync(filePath)
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      log("promptsfile stat failed", { filePath, err: errMsg(err) })
    }
    cache.set(filePath, { mtimeMs: -1, content: null })
    return null
  }
  const entry = cache.get(filePath)
  if (entry && entry.mtimeMs === stat.mtimeMs) return entry.content
  let raw
  try {
    raw = readFileSync(filePath, "utf8")
  } catch (err) {
    log("promptsfile read failed", { filePath, err: errMsg(err) })
    cache.set(filePath, { mtimeMs: -1, content: null })
    return null
  }
  cache.set(filePath, { mtimeMs: stat.mtimeMs, content: raw })
  log("promptsfile loaded", { filePath })
  return raw
}

// Strip a single top-of-file HTML comment block so the file can carry an
// author-facing note that does not bleed into the LLM prompt.
function stripFrontmatterComment(s) {
  return String(s).replace(/^\s*<!--[\s\S]*?-->\s*/, "")
}

// Substitute {{key}} tokens. Keys are case-insensitive [a-z_][a-z0-9_]*.
// Unknown keys are LEFT IN PLACE so typos are visible to the user instead of
// silently dropping content. Empty-string values from the vars map (e.g.
// snapshot when no subagents are active) collapse normally.
export function substitutePrompt(template, vars) {
  return String(template).replace(/\{\{([a-z_][a-z0-9_]*)\}\}/gi, (match, key) => {
    const k = key.toLowerCase()
    return Object.prototype.hasOwnProperty.call(vars, k) ? (vars[k] ?? "") : match
  })
}

// Apply the full custom-prompt pipeline: drop the frontmatter comment, then
// substitute placeholders. Returns the assembled system-prompt string.
export function applyCustomPrompt(template, vars) {
  return substitutePrompt(stripFrontmatterComment(template), vars)
}

// ----------------------------------------------------------------------------
// Default-file rendering used by `bin/init-prompts.js`.

// The built-in guides include `---` lines as visual frames. The user-facing
// file is a single combined Markdown document, so we drop those frames from
// the default content — the user can re-add their own separators inline.
function stripVisualSeparators(s) {
  return String(s)
    .split(/\r?\n/)
    .filter((l) => !/^-{3,}\s*$/.test(l))
    .join("\n")
}

function placeholderLegend(agent) {
  const isOrch = agent === "orchestrator"
  const lines = [
    "{{env}}            opencode's <env> block (cwd, date, platform, git)",
  ]
  if (HAS_AGENTS_MD.has(agent)) {
    lines.push("{{agents_md}}      project AGENTS.md content (opencode injects)")
  }
  lines.push("{{project_md}}     project PROJECT.md content (agent-intercom injects)")
  if (isOrch) {
    lines.push("{{limits}}         current maxSubagents / maxContext")
    lines.push("{{snapshot}}       list of active subagents")
  } else {
    lines.push("{{context_budget}} STOP notice when this subagent is over budget")
  }
  lines.push("{{abort_notice}}   STOP notice when this session is aborted")
  return lines.map((l) => `   ${l}`).join("\n")
}

// Renders the default prompt file for one agent. The result is what the LLM
// would see (modulo placeholders) if the user did nothing else — so the
// "blank-slate" file IS the current behaviour, and the user customises by
// editing.
export function renderDefaultsFile(agent) {
  const isOrch = agent === "orchestrator"
  const def = AGENTS[agent]
  const role = stripVisualSeparators(def?.prompt ?? "").trim()
  const guide = stripVisualSeparators(
    isOrch ? ORCHESTRATION_GUIDE : SUBAGENT_GUIDE_CORE,
  ).trim()
  const outline = HAS_OUTLINE.has(agent)
    ? stripVisualSeparators(SUBAGENT_OUTLINE_GUIDE).trim()
    : null

  const header =
    `<!--\n` +
    ` System prompt for the ${agent} agent. This file is read on every LLM\n` +
    ` call (mtime-cached) and REPLACES the auto-assembled prompt. Edit freely.\n` +
    ` Placeholder tokens are substituted at call time:\n${placeholderLegend(agent)}\n` +
    ` Remove a token to drop that section entirely. Unknown tokens are left in\n` +
    ` place so typos stay visible. This HTML comment is stripped before the\n` +
    ` prompt reaches the model.\n` +
    `-->\n\n`

  const parts = [header, role, "\n\n{{env}}\n"]
  if (HAS_AGENTS_MD.has(agent)) parts.push("\n{{agents_md}}\n")
  parts.push("\n", guide, "\n")
  if (outline) parts.push("\n", outline, "\n")
  parts.push("\n{{project_md}}\n")
  if (isOrch) {
    parts.push("\n{{limits}}\n")
    parts.push("\n{{snapshot}}\n")
  } else {
    parts.push("\n{{context_budget}}\n")
  }
  parts.push("\n{{abort_notice}}\n")
  return parts.join("")
}

// Renders the opencode-default reference file for one agent. Shows what
// opencode WOULD assemble as the system prompt if this plugin's transform
// hook were not in the way. Read-only side-by-side comparison; the plugin
// never reads these files at runtime.
export function renderOpencodeDefaultFile(agent) {
  const def = AGENTS[agent]
  const role = stripVisualSeparators(def?.prompt ?? "").trim()
  const stripsAgentsMd = !HAS_AGENTS_MD.has(agent)

  const stripNotes = [
    "  - opencode's \"You are powered by the model named …\" boilerplate line",
    "    (the plugin always strips this — zero signal, ~150 bytes of noise)",
  ]
  if (stripsAgentsMd) {
    stripNotes.push(
      `  - the AGENTS.md block (the plugin strips it for the ${agent} agent` +
        " — this role does not benefit from project conventions)",
    )
  }
  const addNotes = [
    `  - the agent-intercom guide block (${agent === "orchestrator" ? "ORCHESTRATION_GUIDE" : "SUBAGENT_GUIDE_CORE"}` +
      (HAS_OUTLINE.has(agent) ? " + SUBAGENT_OUTLINE_GUIDE" : "") +
      ") appended by the plugin",
    "  - {{project_md}} block (the full PROJECT.md content, agent-intercom injects)",
  ]
  if (agent === "orchestrator") {
    addNotes.push("  - {{limits}} and {{snapshot}} blocks (orchestrator only)")
  } else {
    addNotes.push("  - {{context_budget}} STOP notice when over the token budget")
  }
  addNotes.push("  - {{abort_notice}} STOP notice when the session is aborted")

  const header =
    `<!--\n` +
    ` Reference: opencode's default system prompt for the ${agent} agent —\n` +
    ` what opencode would assemble WITHOUT this plugin's transform-hook\n` +
    ` intervention. Side-by-side with ../${agent}.md (the active prompt) to\n` +
    ` compare what the plugin keeps, strips, and adds.\n` +
    ` THE PLUGIN DOES NOT READ THIS FILE — edits have no effect.\n` +
    `\n` +
    ` What THIS reference template contains that the plugin STRIPS from the\n` +
    ` active prompt:\n${stripNotes.join("\n")}\n` +
    `\n` +
    ` What the active prompt contains that this reference template LACKS\n` +
    ` (added by the plugin):\n${addNotes.join("\n")}\n` +
    `-->\n\n`

  const parts = [
    header,
    role,
    "\n\nYou are powered by the model named <model-name> (<model-id>).\n",
    "(opencode appends the real model name and id at runtime — this line is" +
      " plain boilerplate, always stripped by the plugin.)\n",
    "\n{{env}}\n",
  ]
  // The reference template ALWAYS includes AGENTS.md because that is what
  // opencode itself would do — the active <agent>.md may omit it for some
  // roles (planner/documenter/researcher/designer/gitter); the difference is
  // exactly what the strip-notes above describe.
  parts.push("\n{{agents_md}}\n")
  return parts.join("")
}

// Write one default file per agent + one opencode-default reference file per
// agent (under `_opencode-defaults/`). Idempotent only on `overwrite: true`;
// by default refuses to clobber existing files so user edits are safe.
export function writeDefaultPromptsFiles(directory, { overwrite = false } = {}) {
  const dir = getPromptsDir(directory)
  const refDir = getOpencodeDefaultsDir(directory)
  mkdirSync(dir, { recursive: true })
  mkdirSync(refDir, { recursive: true })
  const results = []
  for (const agent of AGENT_NAMES) {
    const filePath = getPromptFilePath(directory, agent)
    if (!overwrite && existsSync(filePath)) {
      results.push({ agent, filePath, written: false, reason: "exists", kind: "active" })
    } else {
      writeFileSync(filePath, renderDefaultsFile(agent), "utf8")
      cache.delete(filePath)
      results.push({ agent, filePath, written: true, kind: "active" })
    }
    const refPath = getOpencodeDefaultFilePath(directory, agent)
    if (!overwrite && existsSync(refPath)) {
      results.push({ agent, filePath: refPath, written: false, reason: "exists", kind: "reference" })
    } else {
      writeFileSync(refPath, renderOpencodeDefaultFile(agent), "utf8")
      results.push({ agent, filePath: refPath, written: true, kind: "reference" })
    }
  }
  return results
}

// Test seam.
export function resetCache() {
  cache.clear()
}
