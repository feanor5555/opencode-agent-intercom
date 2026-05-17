// `outline` custom tool — returns the top-level declarations of a source file
// (signatures only, no bodies). Lets subagents skim a file's structure at a
// fraction of `read`'s token cost when they only need to know what it declares.
//
// Powered by **universal-ctags** as an external binary. The plugin installer
// (`bin/install.js`) ensures it is on PATH: Windows downloads a prebuilt zip,
// Linux/macOS build from source when no system ctags is present. ctags speaks
// ~100 languages out of the box (Java, C/C++, Kotlin, Swift, Ruby, PHP, …),
// so this tool inherits that coverage — no per-language regex to maintain.
//
// We avoid JSON output (`--output-format=json`) because that requires the
// optional libjansson build dep; the legacy `u-ctags` tab format ships in every
// build and is just as parseable.
//
// Disable entirely with OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE=1.

import { tool } from "@opencode-ai/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { log, errMsg } from "./log.js"

const z = tool.schema
const execFileP = promisify(execFile)

// Hard cap on emitted declarations per file. Catches runaway generated files
// (huge protobuf bindings etc.) from blowing the reply budget. The tail is
// counted and reported so the caller knows how much was hidden.
const MAX_DECLARATIONS = 200

// Timeout for the ctags subprocess. ctags is fast — even huge files finish in
// well under a second; anything taking longer than 10s is something pathological.
const CTAGS_TIMEOUT_MS = 10_000

// Cache the resolved ctags binary path across calls in the same process. We
// also check ~/.local/bin/ctags as a fallback for the case where the installer
// put the binary there but `~/.local/bin` is not on PATH for whatever reason
// (some shell startup files only add it under specific conditions).
let resolvedCtagsPath = null

function resolveCtagsBinary() {
  if (resolvedCtagsPath !== null) return resolvedCtagsPath || null
  // First choice: rely on PATH — this is what every working install ends up at.
  resolvedCtagsPath = "ctags"
  // Fallback: if our installer placed it in ~/.local/bin but the user's PATH
  // doesn't include that dir, fall back to the absolute path so the tool still
  // works without a shell reload.
  const localBin = join(homedir(), ".local", "bin", "ctags")
  if (existsSync(localBin)) resolvedCtagsPath = localBin
  return resolvedCtagsPath
}

// Parse one line of u-ctags output. Format:
//   <name>\t<file>\t<pattern>;"\t<key:value>\t<key:value>...
// where pattern is `/^...$/` (the original source line, anchored), and the
// trailing key:value fields carry kind, line, signature, scope, etc.
// Returns null on lines we can't parse (header comments, blank lines).
function parseTagLine(line) {
  if (!line || line.startsWith("!")) return null
  const cols = line.split("\t")
  if (cols.length < 3) return null
  const name = cols[0]
  // cols[2] is the ex-pattern `/^...$/;"` (or `?^...?;"`), with `;"` separating
  // the pattern from the trailing key:value fields. The pattern delimiter is `/`
  // OR `?` (chosen so it doesn't appear inside the line). The `$` end-anchor is
  // present for full-line matches but absent for partial matches and at EOF
  // without trailing newline — strip both forms.
  let pattern = cols[2]
  if (pattern.endsWith(';"')) pattern = pattern.slice(0, -2)
  if (pattern.length >= 2 && (pattern[0] === "/" || pattern[0] === "?")) {
    const delim = pattern[0]
    let start = 1
    if (pattern[1] === "^") start = 2
    let end = pattern.length
    if (pattern[end - 1] === delim) end -= 1
    if (end > 0 && pattern[end - 1] === "$") end -= 1
    pattern = pattern.slice(start, end)
  }
  // Un-escape ctags pattern escapes (`\\` → `\`, `\/` → `/`, `\?` → `?`).
  pattern = pattern
    .replace(/\\\\/g, "\\")
    .replace(/\\\//g, "/")
    .replace(/\\\?/g, "?")
  const fields = {}
  for (let i = 3; i < cols.length; i += 1) {
    const idx = cols[i].indexOf(":")
    if (idx < 0) continue
    fields[cols[i].slice(0, idx)] = cols[i].slice(idx + 1)
  }
  return {
    name,
    pattern,
    line: Number(fields.line) || 0,
    kind: fields.kind || "",
    scope: fields.class || fields.struct || fields.namespace || fields.module || "",
    signature: fields.signature || "",
  }
}

// Strip the body opener off a source line so we emit just the signature.
// Cuts at the first `{`, `=>`, or `:` followed by EOL. Falls back to trimming
// trailing punctuation if no body opener is found.
function stripBody(pattern) {
  let cut = -1
  const brace = pattern.indexOf("{")
  const arrow = pattern.indexOf("=>")
  if (brace >= 0) cut = brace
  if (arrow >= 0 && (cut < 0 || arrow < cut)) cut = arrow
  if (cut >= 0) return pattern.slice(0, cut).trimEnd()
  return pattern.trimEnd().replace(/[;,]$/, "")
}

// Build the outline text from ctags' raw stdout. Returns the full string the
// tool will emit (one `path:line: signature` per declaration, optionally a
// truncation marker at the end). Returns the empty-decl message when the file
// is parseable but produces no tags.
function formatTags(displayPath, stdout) {
  const lines = stdout.split("\n")
  // ctags emits tags in alphabetical order by default — sort by line number so
  // the outline reads top-to-bottom of the file.
  const tags = []
  const seen = new Set()
  for (const raw of lines) {
    const tag = parseTagLine(raw)
    if (!tag) continue
    // ctags occasionally emits the same symbol twice (e.g. a Go method appears
    // both with the receiver-as-class scope and as a standalone function).
    // Dedup by (line, name) so the outline reads cleanly.
    const key = `${tag.line}:${tag.name}`
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  tags.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))

  const decls = []
  let truncated = 0
  for (const tag of tags) {
    if (decls.length < MAX_DECLARATIONS) {
      decls.push(`${displayPath}:${tag.line}: ${stripBody(tag.pattern)}`)
    } else {
      truncated += 1
    }
  }

  if (decls.length === 0) {
    return `outline: no declarations found in ${displayPath}`
  }
  if (truncated > 0) {
    decls.push(`[truncated — ${truncated} more declarations]`)
  }
  return decls.join("\n")
}

export function isOutlineEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_OUTLINE !== "1"
}

// Exposed for tests so they can detect whether ctags is installed and skip
// outline tests gracefully when it isn't.
export async function probeCtags() {
  try {
    const { stdout } = await execFileP(resolveCtagsBinary(), ["--version"], {
      timeout: 5000,
    })
    return stdout.includes("Universal Ctags")
  } catch {
    return false
  }
}

export function createOutlineTool({ directory }) {
  return tool({
    description:
      "Return the top-level declarations of a source file (function/class/type/method/variable " +
      "signatures, no bodies). Use this INSTEAD of `read` when you only need to know what a file " +
      "declares — a 500-line file becomes ~30 lines of signatures. Reserve `read` for files whose " +
      "internals you actually need. Powered by universal-ctags: covers ~100 languages including " +
      "JS/TS, Python, Java, C/C++, C#, Go, Rust, Kotlin, Swift, Ruby, PHP, and many more.",
    args: {
      path: z
        .string()
        .min(1)
        .describe("File path (absolute or relative to the project root)"),
    },
    execute: async (args) => {
      const target = isAbsolute(args.path) ? args.path : resolvePath(directory, args.path)
      if (!existsSync(target)) {
        return { output: `outline: file not found: ${args.path}` }
      }
      try {
        const { stdout } = await execFileP(
          resolveCtagsBinary(),
          [
            "--output-format=u-ctags",
            "--fields=+nzKS",
            "--kinds-all=*",
            "--sort=no",
            "-f",
            "-",
            target,
          ],
          { timeout: CTAGS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        )
        return { output: formatTags(args.path, stdout) }
      } catch (err) {
        // ENOENT on the binary itself = ctags not installed. Give a clear
        // install hint instead of a confusing spawn error.
        if (err && err.code === "ENOENT") {
          return {
            output:
              "outline failed: ctags not found on PATH. Run `npx opencode-agent-intercom-install` " +
              "to install it (or install universal-ctags via your package manager).",
          }
        }
        log("outline ctags failed", errMsg(err))
        return { output: `outline failed: ${errMsg(err)}` }
      }
    },
  })
}
