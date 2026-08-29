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
//   {{limits}}         current maxSubagents + per-agent context budgets (orchestrator only)
//   {{guide}}          the plugin's guide blocks for this role, as the
//                      auto-assembled prompt would inject them
//
// The live active-subagent snapshot, the over-budget STOP notice and the
// abort notice are NOT template-controlled: they are delivered as a message
// part on the turn they belong to, so that the system prompt stays byte-stable
// and the provider's cached prefix holds. `{{snapshot}}`, `{{context_budget}}`
// and `{{abort_notice}}` still substitute to the empty string, so a file
// written before they were retired keeps working.
//
// `{{guide}}` is what keeps a file from going stale: the guide blocks are
// substituted at call time from the constants in prompts.js, so a change to the
// contract reaches a file that carries the token. A file with the guide text
// inlined instead — every file written before this token existed — freezes the
// contract it was rendered from, which is what `scanPromptFiles` below reports:
// by the contract probes where the file carries no stamp, and by the stamp
// alone where it does, i.e. once the plugin's contract number moves past it.
//
// Hot-reload: the loader is mtime-keyed. Editing a file in any editor busts
// the cache on the next stat(); the companion TUI's "reload" button bumps
// the mtime of every file via fs.utimes without an edit.

import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { log, errMsg } from "./log.js"
import { AGENTS, mayDelegate } from "./agents.js"
import { PROMPT_CONTRACT, OUTLINE_DISABLED_AGENTS } from "./prompts.js"
import {
  classifyPromptFile,
  claimPromptFileScan,
  recordPromptFileOverride,
  CONTRACT_STAMP_KEY,
} from "./overrides.js"

export const PROMPTS_DIRNAME = ".opencode/agent-intercom"
// Read-only reference files showing what opencode would inject WITHOUT this
// plugin's transform hook. Written next to the active per-agent files for
// side-by-side comparison. The plugin does NOT read these.
export const OPENCODE_DEFAULTS_SUBDIR = "_opencode-defaults"

// Every role the plugin installs, the orchestrator included: each one gets a
// template file. Derived from AGENTS so a role added or removed there cannot
// drift out of the template set.
export const AGENT_NAMES = Object.keys(AGENTS)

// Which subagents the plugin gives the outline-discipline block to: derived
// from prompts.js OUTLINE_DISABLED_AGENTS rather than listed, so a role added
// there cannot drift out of this set. The orchestrator is excluded because it is
// not a subagent and gets ORCHESTRATION_GUIDE alone (prompts.js guideBlocks).
// The active template gets the block through `{{guide}}`; this set is what the
// read-only opencode-defaults reference file names in its what-the-plugin-adds
// note.
const HAS_OUTLINE = new Set(
  AGENT_NAMES.filter((agent) => agent !== "orchestrator" && !OUTLINE_DISABLED_AGENTS.has(agent)),
)

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

// A single top-of-file HTML comment block: the author-facing note, and the only
// place the contract stamp is read from.
const FRONTMATTER_COMMENT = /^\s*<!--([\s\S]*?)-->\s*/

// Strip the comment so it does not bleed into the LLM prompt.
function stripFrontmatterComment(s) {
  return String(s).replace(FRONTMATTER_COMMENT, "")
}

// The comment's contents, or the empty string when the file opens with none.
function frontmatterComment(s) {
  const m = FRONTMATTER_COMMENT.exec(String(s))
  return m ? m[1] : ""
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

// Detector B: the prompt files this project has on disk, judged against the
// current prompt contract (overrides.js). Findings go into the same register the
// config-hook detector writes to and out through the same three outlets — the
// debug log here, the toast and the primary's system-prompt block in hooks.js.
// Report only: nothing is refused and no file is touched.
//
// Eager and once per directory, at the first primary system transform. The claim
// is held by the register so the scan cannot become per-request work, and so the
// finding set is complete before the first block is rendered.
//
// Reads through `loadCustomPrompt`, so the scan shares the loader's mtime cache
// and costs one stat per role on a directory whose files are already loaded.
export function scanPromptFiles(directory) {
  if (!claimPromptFileScan(directory)) return
  for (const agent of AGENT_NAMES) {
    try {
      const raw = loadCustomPrompt(directory, agent)
      if (raw === null) continue
      const { missing, detail } = classifyPromptFile(agent, {
        header: frontmatterComment(raw),
        body: stripFrontmatterComment(raw),
      })
      if (!missing.length) continue
      const filePath = getPromptFilePath(directory, agent)
      if (recordPromptFileOverride({ agent, missing, detail, file: filePath, directory })) {
        log("override: stale prompt file", { agent, missing, file: filePath, directory })
      }
    } catch (err) {
      // A single unreadable file must not cost the other eight their scan.
      log("promptsfile scan failed", { directory, agent, err: errMsg(err) })
    }
  }
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
  lines.push("{{guide}}          the plugin's guide blocks for this role")
  lines.push("{{project_md}}     project PROJECT.md content (agent-intercom injects)")
  if (isOrch) {
    lines.push("{{limits}}         current maxSubagents + per-agent context budgets")
  }
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

  const header =
    `<!--\n` +
    ` System prompt for the ${agent} agent. This file is read on every LLM\n` +
    ` call (mtime-cached) and REPLACES the auto-assembled prompt. Edit freely.\n` +
    ` ${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT}\n` +
    ` Placeholder tokens are substituted at call time:\n${placeholderLegend(agent)}\n` +
    ` Remove a token to drop that section entirely. Unknown tokens are left in\n` +
    ` place so typos stay visible. This HTML comment is stripped before the\n` +
    ` prompt reaches the model.\n` +
    ` {{guide}} carries the plugin's own guide blocks for this role — the\n` +
    ` subagent or orchestration discipline, the delegation block and, where the\n` +
    ` role has the tool, the reading discipline. It is substituted from the\n` +
    ` plugin's constants on every call, so this file keeps the CURRENT contract\n` +
    ` as the plugin is updated. Pasting that text in place of the token freezes\n` +
    ` it at today's wording instead, which is the point of doing so — the file\n` +
    ` then holds contract ${PROMPT_CONTRACT} whatever the plugin does next, and\n` +
    ` the plugin reports it as out of date once its own contract number moves\n` +
    ` past the ${CONTRACT_STAMP_KEY} stamp above. While the two numbers match,\n` +
    ` the stamp answers for the file and its content is not judged.\n` +
    ` The live subagent snapshot, the over-budget STOP notice and the abort\n` +
    ` notice are not placeholders here: they are delivered as a message on the\n` +
    ` turn they apply to, which keeps this prompt byte-stable and the\n` +
    ` provider's cached prefix valid. They cannot be turned off from this file.\n` +
    `-->\n\n`

  const parts = [header, role, "\n\n{{env}}\n"]
  if (HAS_AGENTS_MD.has(agent)) parts.push("\n{{agents_md}}\n")
  parts.push("\n{{guide}}\n")
  parts.push("\n{{project_md}}\n")
  if (isOrch) parts.push("\n{{limits}}\n")
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
  // The blocks prompts.js `guideBlocks` assembles for this role, all of them:
  // the orchestrator gets ORCHESTRATION_GUIDE alone, every subagent gets the
  // core plus exactly one of the two spawn blocks plus, unless its outline tool
  // is gated off, the reading discipline.
  const guideNames =
    agent === "orchestrator"
      ? "ORCHESTRATION_GUIDE"
      : [
          "SUBAGENT_GUIDE_CORE",
          mayDelegate(agent) ? "SUBAGENT_DELEGATION_GUIDE" : "SUBAGENT_NO_SPAWN_GUIDE",
          ...(HAS_OUTLINE.has(agent) ? ["SUBAGENT_OUTLINE_GUIDE"] : []),
        ].join(" + ")
  const addNotes = [
    `  - the agent-intercom guide block (${guideNames}) appended by the plugin`,
    "  - {{project_md}} block (the full PROJECT.md content, agent-intercom injects)",
  ]
  if (mayDelegate(agent)) {
    addNotes.push(
      "  - SUBAGENT_NO_SPAWN_GUIDE stands in for SUBAGENT_DELEGATION_GUIDE" +
        " while nested spawning is switched off (maxNestedSpawns = 0)",
    )
  }
  if (agent === "orchestrator") {
    addNotes.push("  - the {{limits}} block (orchestrator only)")
  }
  addNotes.push(
    "  - a per-turn message part carrying the live subagent snapshot, the" +
      " over-budget STOP notice and the abort notice (delivered on the message" +
      " list, not in the system prompt)",
  )

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
