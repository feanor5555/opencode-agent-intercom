// TODO.md parser/writer. Single fixed file: `<directory>/TODO.md`.
//
// Format:
//
//   - T1: <short task title>
//     accept: <one-line criterion>
//
//   - T2: <another task>
//     accept: <criterion>
//
// IDs are assigned sequentially by `addTask` (next free T<n> above the current
// max) and never re-used. Done tasks are REMOVED from TODO.md — there are no
// checkbox markers, no "blocked" state, no done archive. Tasks should be
// ordered top-to-bottom by feasibility: the first task is the next one to do.
// Edits to a task's title or accept-criterion go through `editTask`, which
// preserves the id.

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

// Matches the task header line. Captures: indent, id (T5), text after the colon.
const TASK_LINE_RE = /^(\s*)- (T\d+):\s*(.*)$/
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
    const [, indent, id, rest] = m
    let accept
    let acceptLineIdx
    if (i + 1 < lines.length) {
      const am = ACCEPT_LINE_RE.exec(lines[i + 1])
      if (am) {
        accept = am[1].trim()
        acceptLineIdx = i + 1
      }
    }
    tasks.push({ id, text: rest.trim(), accept, lineIdx: i, acceptLineIdx, indent })
  }
  return tasks
}

// All tasks currently in TODO.md, top-to-bottom (= feasibility order).
export function listOpen(directory) {
  const content = readTodoFile(directory)
  return parseTasks(content)
}

// Next free T-id: max(existing T-ids) + 1, or T1 when empty / file absent.
export function nextFreeId(directory) {
  let content
  try {
    content = readTodoFile(directory)
  } catch (err) {
    if (err instanceof TodoFileMissingError) return "T1"
    throw err
  }
  const tasks = parseTasks(content)
  if (tasks.length === 0) return "T1"
  let max = 0
  for (const t of tasks) {
    const n = parseInt(t.id.slice(1), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `T${max + 1}`
}

// Append a new task with the next free id. Creates an empty TODO.md if absent.
export function addTask(directory, { title, accept } = {}) {
  const cleanTitle = (title ?? "").trim()
  if (!cleanTitle) throw new Error("addTask: title is required")
  const path = todoFilePath(directory)
  if (!existsSync(path)) writeFileSync(path, "", "utf8")
  const id = nextFreeId(directory)
  const content = readFileSync(path, "utf8")
  const cleanAccept = (accept ?? "").trim()
  const block =
    `- ${id}: ${cleanTitle}\n` + (cleanAccept ? `  accept: ${cleanAccept}\n` : "")
  const sep = content === "" || content.endsWith("\n") ? "" : "\n"
  writeFileSync(path, content + sep + block, "utf8")
  return { id }
}

// Edit a task's title or accept criterion. Either field is optional — only
// the provided ones change. Passing `accept: ""` deletes the accept line.
// Throws if the id doesn't exist.
export function editTask(directory, id, { title, accept } = {}) {
  const content = readTodoFile(directory)
  const lines = content.split("\n")
  const tasks = parseTasks(content)
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error(`task ${id} not found in TODO.md`)
  let changed = false
  if (title !== undefined) {
    const newTitle = String(title).trim()
    if (newTitle && newTitle !== t.text) {
      lines[t.lineIdx] = `${t.indent}- ${id}: ${newTitle}`
      changed = true
    }
  }
  if (accept !== undefined) {
    const newAccept = String(accept).trim()
    if (t.acceptLineIdx != null) {
      if (newAccept) {
        const newLine = `${t.indent}  accept: ${newAccept}`
        if (lines[t.acceptLineIdx] !== newLine) {
          lines[t.acceptLineIdx] = newLine
          changed = true
        }
      } else {
        lines.splice(t.acceptLineIdx, 1)
        changed = true
      }
    } else if (newAccept) {
      lines.splice(t.lineIdx + 1, 0, `${t.indent}  accept: ${newAccept}`)
      changed = true
    }
  }
  if (changed) writeFileSync(todoFilePath(directory), lines.join("\n"), "utf8")
  return { changed }
}

// Remove a task (its header line + optional accept line). Throws if the id
// doesn't exist — caller decides whether to treat that as a no-op.
export function removeTask(directory, id) {
  const content = readTodoFile(directory)
  const lines = content.split("\n")
  const tasks = parseTasks(content)
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error(`task ${id} not found in TODO.md`)
  // Delete in reverse line order so the header index stays valid.
  if (t.acceptLineIdx != null) lines.splice(t.acceptLineIdx, 1)
  lines.splice(t.lineIdx, 1)
  writeFileSync(todoFilePath(directory), lines.join("\n"), "utf8")
  return { changed: true }
}
