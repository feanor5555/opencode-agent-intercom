// TODO.md parser/writer. Single fixed file: `<directory>/TODO.md`.
//
// Format the planner is expected to write:
//
//   - [ ] T5. <short task title>
//       accept: <one-line criterion>
//
//   - [x] T3. <done task>
//   - [!] R2. <blocked finding> (blocked: needs API key)
//
// IDs are immutable project-wide:
//   T<n> — regular tasks (sequence T1, T2, T3, …)
//   R<n> — review findings (separate sequence R1, R2, …)
//
// Only `- [ ]` / `- [x]` / `- [!]` lines with a stable ID prefix are tracked.
// Anything else (headings, prose, blank lines) is preserved verbatim on write.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

// Thrown when TODO.md is not at the expected casing. `kind` lets callers
// distinguish "nothing there" from "file exists but wrong case" so they can
// offer the user the right next step (create vs. rename/migrate). Carries the
// directory and (for wrong-case) the actual filename found.
export class TodoFileMissingError extends Error {
  constructor({ directory, kind, actualName }) {
    const canonical = join(directory, "TODO.md")
    const msg =
      kind === "wrong-case"
        ? `TODO.md not found at ${canonical} — but a case-variant "${actualName}" exists in the same directory`
        : `TODO.md not found at ${canonical}`
    super(msg)
    this.name = "TodoFileMissingError"
    this.kind = kind
    this.directory = directory
    this.actualName = actualName
  }
}

// Case-insensitive scan for a `todo.md` sibling in the same directory. Returns
// the actual filename if a non-canonical variant exists, otherwise undefined.
// We do NOT silently use the variant — convention is uppercase TODO.md and the
// caller decides how to surface the mismatch to the user.
function findTodoCaseVariant(directory) {
  try {
    for (const name of readdirSync(directory)) {
      if (name === "TODO.md") continue
      if (/^todo\.md$/i.test(name)) return name
    }
  } catch {
    // unreadable directory → treat as "no variant"
  }
  return undefined
}

// Status-marker -> internal status name.
const STATUS = {
  " ": "open",
  x: "done",
  X: "done",
  "!": "blocked",
}

// Matches the task header line. Captures: status-char, id (T5 / R2), text.
const TASK_LINE_RE = /^(\s*)- \[([ xX!])\]\s+([TR]\d+)\.\s*(.*)$/
const ACCEPT_LINE_RE = /^\s+accept:\s*(.*)$/i

export function todoFilePath(directory) {
  return join(directory, "TODO.md")
}

// Reads + parses TODO.md. Throws TodoFileMissingError if the canonical
// uppercase TODO.md is absent. When a case-variant (e.g. `todo.md`) exists,
// the error carries `kind: "wrong-case"` and `actualName` so the caller can
// offer the user a rename/migrate path instead of silently using the variant.
export function readTodoFile(directory) {
  const path = todoFilePath(directory)
  if (!existsSync(path)) {
    const variant = findTodoCaseVariant(directory)
    throw new TodoFileMissingError({
      directory,
      kind: variant ? "wrong-case" : "missing",
      actualName: variant,
    })
  }
  return readFileSync(path, "utf8")
}

export function parseTasks(content) {
  const lines = content.split("\n")
  const tasks = []
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE_RE.exec(lines[i])
    if (!m) continue
    const [, indent, marker, id, rest] = m
    const status = STATUS[marker] ?? "open"
    // Pull a `(blocked: ...)` suffix off the end so the displayed text stays clean.
    let text = rest
    let blockedReason = undefined
    const bm = /^(.*?)\s*\(blocked:\s*([^)]*)\)\s*$/.exec(rest)
    if (bm) {
      text = bm[1].trim()
      blockedReason = bm[2].trim()
    }
    // Optional indented `accept:` line right below.
    let accept
    if (i + 1 < lines.length) {
      const am = ACCEPT_LINE_RE.exec(lines[i + 1])
      if (am) accept = am[1].trim()
    }
    tasks.push({ id, status, text: text.trim(), accept, blockedReason, lineIdx: i, indent })
  }
  return tasks
}

// All non-`done` tasks (open + blocked). Each has its accept-criterion attached
// so the orchestrator's `list_open` reply gives the caller everything needed to
// pick the next task without a separate `read` of TODO.md.
export function listOpen(directory) {
  const content = readTodoFile(directory)
  return parseTasks(content).filter((t) => t.status !== "done")
}

// Flips `- [ ]` → `- [x]` for the given task id. Idempotent: a `- [x]` line
// returns `{changed:false, alreadyDone:true}`. Throws if the id doesn't exist —
// the caller (orchestrator or wake-hook) must know that, since it likely means
// either the planner used the wrong format or the subagent hallucinated an id.
export function markDone(directory, id) {
  return flipStatus(directory, id, "x")
}

// Marks a task blocked: `- [ ]` / `- [x]` → `- [!]` and rewrites the suffix to
// `(blocked: <reason>)`. Strips any prior `(blocked: …)` so repeated calls
// don't accumulate suffixes. Idempotent on identical reason.
export function markBlocked(directory, id, reason) {
  const content = readTodoFile(directory)
  const lines = content.split("\n")
  const found = findTaskLine(lines, id)
  if (found == null) throw new Error(`task ${id} not found in TODO.md`)
  const { lineIdx, marker, indent, body } = found
  const cleanBody = body.replace(/\s*\(blocked:[^)]*\)\s*$/, "").trim()
  const newSuffix = reason ? ` (blocked: ${reason.replace(/\s+/g, " ").trim()})` : ""
  const newLine = `${indent}- [!] ${id}. ${cleanBody}${newSuffix}`
  const wasAlready = marker === "!" && lines[lineIdx] === newLine
  lines[lineIdx] = newLine
  if (!wasAlready) writeFileSync(todoFilePath(directory), lines.join("\n"), "utf8")
  return { changed: !wasAlready, alreadyBlocked: marker === "!" }
}

function flipStatus(directory, id, targetMarker) {
  const content = readTodoFile(directory)
  const lines = content.split("\n")
  const found = findTaskLine(lines, id)
  if (found == null) throw new Error(`task ${id} not found in TODO.md`)
  const { lineIdx, marker, indent, body } = found
  if (marker === targetMarker) return { changed: false, alreadyDone: targetMarker === "x" }
  // For done, strip any leftover `(blocked: …)` suffix so a previously blocked
  // task ends up clean once it's resolved.
  const cleanBody = targetMarker === "x" ? body.replace(/\s*\(blocked:[^)]*\)\s*$/, "").trim() : body
  lines[lineIdx] = `${indent}- [${targetMarker}] ${id}. ${cleanBody}`
  writeFileSync(todoFilePath(directory), lines.join("\n"), "utf8")
  return { changed: true, alreadyDone: false }
}

function findTaskLine(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE_RE.exec(lines[i])
    if (!m) continue
    const [, indent, marker, lineId, rest] = m
    if (lineId !== id) continue
    return { lineIdx: i, marker, indent, body: rest }
  }
  return null
}
