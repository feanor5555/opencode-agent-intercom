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
import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"
import {
  isAbsolute,
  resolve as resolvePath,
  relative as relativePath,
  dirname,
  basename,
  join,
} from "node:path"
import { homedir } from "node:os"
import { existsSync, realpathSync } from "node:fs"
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

// Message shown when no usable Universal Ctags binary can be resolved. Kept as
// a single constant so the resolution short-circuit and the runtime ENOENT
// branch report identically.
const CTAGS_MISSING_MSG =
  "outline failed: ctags not found on PATH. Run `npx opencode-agent-intercom-install` " +
  "to install it (or install universal-ctags via your package manager)."

// The `--version` probe. Returns true only for a genuine Universal Ctags —
// Exuberant/BSD ctags reject the flags we pass and would otherwise fail
// cryptically on the first real outline call. Runs synchronously so the
// resolver stays a plain sync function at its call sites. Injectable via
// `setCtagsProbe` for tests.
function defaultCtagsProbe(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 })
  return r.status === 0 && typeof r.stdout === "string" && r.stdout.includes("Universal Ctags")
}
let ctagsProbe = defaultCtagsProbe

// Test seam: swap the probe and clear the per-process cache. Call with no
// argument to restore the real probe. Not part of the tool's public surface.
export function setCtagsProbe(fn) {
  ctagsProbe = fn || defaultCtagsProbe
  resolvedCtagsPath = undefined
}

// Resolved ctags binary, cached across calls in the same process: `undefined`
// = not yet resolved, a string = the chosen binary, `null` = none usable.
let resolvedCtagsPath

// Prefer the installer's own self-built universal-ctags 6.2.1 under
// ~/.local/bin/ctags — a known-good, deterministic build — over whatever
// `ctags` sits on PATH. Each candidate must pass the Universal-Ctags probe; if
// the local build is absent or fails (interrupted build, wrong variant), fall
// back to the PATH candidate, which must pass the same probe. Result cached.
function resolveCtagsBinary() {
  if (resolvedCtagsPath !== undefined) return resolvedCtagsPath
  resolvedCtagsPath = null
  for (const bin of [join(homedir(), ".local", "bin", "ctags"), "ctags"]) {
    if (ctagsProbe(bin)) {
      resolvedCtagsPath = bin
      break
    }
  }
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

// Resolve a path to its canonical (symlink-free) form. When the path itself
// does not exist yet (e.g. a file the caller mistyped), canonicalise the
// deepest existing ancestor and re-append the trailing segments, so a symlink
// anywhere in the existing prefix is still followed. Falls back to a plain
// lexical resolve if even the root is unreadable.
function canonicalize(p) {
  try {
    return realpathSync(p)
  } catch {
    const parent = dirname(p)
    if (parent === p) return resolvePath(p)
    return join(canonicalize(parent), basename(p))
  }
}

// True when `target` is `base` itself or lives underneath it. Uses a
// path.relative test (not string startsWith, which mis-fires on sibling dirs
// sharing a name prefix) against the canonicalised forms of both, so a
// symlink pointing outside the tree is caught too.
function isInsideDirectory(base, target) {
  const rel = relativePath(canonicalize(base), canonicalize(target))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

// Exposed for tests so they can detect whether a usable Universal Ctags is
// installed and skip outline tests gracefully when it isn't.
export async function probeCtags() {
  return resolveCtagsBinary() !== null
}

// `dirFor(toolCtx)` resolves the session's authoritative project directory per
// call (GET /session/<id> → info.directory), mirroring the TODO tools. The
// plugin factory runs once per project/process, so a factory-captured directory
// would be `opencode serve`'s cwd — NOT the session directory set via
// `?directory=`. Resolving per call keeps relative paths anchored correctly.
export function createOutlineTool({ dirFor }) {
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
    execute: async (args, toolCtx) => {
      const directory = await dirFor(toolCtx)
      const target = isAbsolute(args.path) ? args.path : resolvePath(directory, args.path)
      // Containment: the resolved target must stay inside the session directory.
      // Rejects `../` traversal, absolute paths pointing elsewhere, and symlink
      // escapes (canonicalize follows links before the comparison). Reported as
      // a normal tool-error string, never thrown.
      if (!isInsideDirectory(directory, target)) {
        return { output: `outline: path escapes the project directory: ${args.path}` }
      }
      if (!existsSync(target)) {
        return { output: `outline: file not found: ${args.path}` }
      }
      const bin = resolveCtagsBinary()
      if (!bin) {
        return { output: CTAGS_MISSING_MSG }
      }
      try {
        const { stdout } = await execFileP(
          bin,
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
        // ENOENT on the binary itself = ctags vanished between probe and call.
        // Give a clear install hint instead of a confusing spawn error.
        if (err && err.code === "ENOENT") {
          return { output: CTAGS_MISSING_MSG }
        }
        log("outline ctags failed", errMsg(err))
        return { output: `outline failed: ${errMsg(err)}` }
      }
    },
  })
}
