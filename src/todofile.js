// Todo-file parser/writer. The todo file lives directly in `<directory>` and
// is named `todo.md` or `todos.md` in any casing — `TODO.md`, `todos.md`,
// `Todo.md`, `TODOS.md` all count. Exactly one such file may exist; several
// are a hard error rather than a pick that would depend on the order the
// directory happens to list its entries. When none exists, `addTask` creates
// the canonical `TODO.md`.
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
// max) and never re-used. Done tasks are REMOVED from the todo file — there
// are no checkbox markers, no "blocked" state, no done archive. Tasks should
// be ordered top-to-bottom by feasibility: the first task is the next one to
// do. Edits to a task's title or accept-criterion go through `editTask`,
// which preserves the id.
//
// Every read and every write goes through a descriptor opened with
// `O_NOFOLLOW` and confirmed by `fstat` to be a regular file, so a symlink,
// a directory or a device node carrying a todo-file name can neither be read
// from nor written to.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  fstatSync,
  openSync,
  closeSync,
  constants,
} from "node:fs"
import { join } from "node:path"

// Name the todo file gets when we create it.
export const CANONICAL_TODO_NAME = "TODO.md"

// Every accepted todo-file name: `todo.md` / `todos.md` in any casing.
const TODO_NAME_RE = /^todos?\.md$/i

// `O_NOFOLLOW` is POSIX-only; on platforms without it the flag degrades to 0
// and the `fstat` regular-file check remains the sole guard.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

// Error codes that mean "the path does not name a directory we can list".
const DIR_ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"])

// Error codes an `O_NOFOLLOW` open produces for a name that exists in the
// listing but is not a regular file we may open: a symlink (ELOOP), a
// dangling symlink or a race (ENOENT), a symlink to a non-directory prefix
// (ENOTDIR), a directory on platforms that refuse to open one (EISDIR).
const NOT_A_FILE_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR", "EISDIR"])

// Thrown when no usable todo file can be resolved in `directory`. `kind` lets
// callers tell the three cases apart:
//   "missing"    — no name in the directory matches; `names` is empty.
//   "multiple"   — several different names match; `names` lists them sorted.
//   "not-a-file" — exactly one name matches but it is not a regular file
//                  (symlink, directory, device); `names` holds that one name.
// Only "missing" is a greenfield state a caller may quietly create over; the
// other two describe a directory a human has to sort out.
export class TodoFileMissingError extends Error {
  constructor({ directory, kind, names = [] }) {
    super(todoFileMissingMessage(directory, kind, names))
    this.name = "TodoFileMissingError"
    this.kind = kind
    this.directory = directory
    this.names = names
  }
}

function todoFileMissingMessage(directory, kind, names) {
  switch (kind) {
    case "multiple":
      return (
        `several todo files in ${directory}: ${names.join(", ")} — ` +
        `exactly one of todo.md / todos.md (any casing) may exist`
      )
    case "not-a-file":
      return `${join(directory, names[0] ?? CANONICAL_TODO_NAME)} is not a regular file`
    default:
      return (
        `no todo file in ${directory} — expected ${CANONICAL_TODO_NAME} ` +
        `(or todo.md / todos.md in any casing)`
      )
  }
}

// Matches the task header line. Captures: indent, id (T5), text after the colon.
const TASK_LINE_RE = /^(\s*)- (T\d+):\s*(.*)$/
const ACCEPT_LINE_RE = /^\s+accept:\s*(.*)$/i

// The path a todo file gets when this module creates one. Not necessarily the
// path of the file in use — `findTodoFile` resolves that.
export function todoFilePath(directory) {
  return join(directory, CANONICAL_TODO_NAME)
}

// All todo-file names present in `directory`, sorted so the result never
// depends on the order the filesystem lists entries in. A directory that does
// not exist has no todo file; every other failure to list it (EACCES, EMFILE,
// ENFILE …) is a real fault and propagates — swallowing it would report a
// greenfield "no todo file" for a directory whose todo file we simply could
// not see, and callers act destructively on that answer.
function listTodoNames(directory) {
  let entries
  try {
    entries = readdirSync(directory)
  } catch (err) {
    if (DIR_ABSENT_CODES.has(err?.code)) return []
    throw err
  }
  return entries.filter((name) => TODO_NAME_RE.test(name)).sort()
}

// Resolves the one todo file in `directory` to `{ name, path }`, or throws
// TodoFileMissingError with kind "missing" / "multiple".
//
// The `statSync` fast path keeps the common case off a synchronous walk of the
// whole project directory: when the canonical TODO.md is there as a regular
// file it is the file, no listing needed. That gives TODO.md precedence over a
// differently-cased sibling; the "multiple" error covers the variants among
// which no such precedence exists. A failing stat says nothing on its own and
// simply falls through to the listing, which classifies the directory itself.
export function findTodoFile(directory) {
  const canonical = todoFilePath(directory)
  try {
    if (statSync(canonical).isFile()) return { name: CANONICAL_TODO_NAME, path: canonical }
  } catch {
    // Not a regular canonical TODO.md — the listing below decides.
  }
  const names = listTodoNames(directory)
  if (names.length === 0) throw new TodoFileMissingError({ directory, kind: "missing" })
  if (names.length > 1) throw new TodoFileMissingError({ directory, kind: "multiple", names })
  return { name: names[0], path: join(directory, names[0]) }
}

// Opens `target.path` once with O_NOFOLLOW, confirms through the handle that
// it is a regular file and reads from that same descriptor, so nothing between
// the listing and the read can substitute another file. Anything that is not a
// regular file surfaces as TodoFileMissingError, never as a raw ENOENT/ELOOP.
function readAt(directory, target) {
  let fd
  try {
    fd = openSync(target.path, constants.O_RDONLY | O_NOFOLLOW)
  } catch (err) {
    if (NOT_A_FILE_CODES.has(err?.code)) {
      throw new TodoFileMissingError({ directory, kind: "not-a-file", names: [target.name] })
    }
    throw err
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new TodoFileMissingError({ directory, kind: "not-a-file", names: [target.name] })
    }
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

// Writes `content` through an O_NOFOLLOW descriptor confirmed to be a regular
// file, so a todo-file name swapped for a symlink cannot redirect the write to
// an arbitrary target.
function writeAt(directory, target, content) {
  let fd
  try {
    fd = openSync(target.path, constants.O_WRONLY | constants.O_TRUNC | O_NOFOLLOW)
  } catch (err) {
    if (NOT_A_FILE_CODES.has(err?.code)) {
      throw new TodoFileMissingError({ directory, kind: "not-a-file", names: [target.name] })
    }
    throw err
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new TodoFileMissingError({ directory, kind: "not-a-file", names: [target.name] })
    }
    writeFileSync(fd, content, "utf8")
  } finally {
    closeSync(fd)
  }
}

// Resolves the todo file and reads it in one step, keeping the path the
// content came from so a subsequent write goes back to that same file.
function loadTodoFile(directory) {
  const target = findTodoFile(directory)
  return { ...target, content: readAt(directory, target) }
}

// Reads + parses the todo file. Throws TodoFileMissingError when none can be
// resolved (kind "missing"), when several match (kind "multiple") or when the
// one that matches is not a regular file (kind "not-a-file").
export function readTodoFile(directory) {
  return loadTodoFile(directory).content
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

// All tasks currently in the todo file, top-to-bottom (= feasibility order).
export function listOpen(directory) {
  const content = readTodoFile(directory)
  return parseTasks(content)
}

// Next free T-id for already-read content: max(existing T-ids) + 1, T1 when
// there is no task in it.
function nextFreeIdFrom(content) {
  const tasks = parseTasks(content)
  let max = 0
  for (const t of tasks) {
    const n = parseInt(t.id.slice(1), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `T${max + 1}`
}

// Next free T-id: max(existing T-ids) + 1, or T1 when the file is empty or
// absent. A directory whose todo file exists but cannot be used ("multiple",
// "not-a-file") is not a greenfield and propagates — answering T1 there would
// hand out an id that already exists in the file we failed to read.
export function nextFreeId(directory) {
  let content
  try {
    content = readTodoFile(directory)
  } catch (err) {
    if (err instanceof TodoFileMissingError && err.kind === "missing") return "T1"
    throw err
  }
  return nextFreeIdFrom(content)
}

// Resolves the todo file, creating an empty canonical TODO.md when the
// directory has none. Exclusive creation (`wx`) so an entry that appeared
// meanwhile is never truncated or followed; the retry then resolves it.
function ensureTodoFile(directory) {
  try {
    return findTodoFile(directory)
  } catch (err) {
    if (!(err instanceof TodoFileMissingError) || err.kind !== "missing") throw err
  }
  const path = todoFilePath(directory)
  try {
    writeFileSync(path, "", { flag: "wx" })
  } catch (err) {
    if (err?.code !== "EEXIST") throw err
    return findTodoFile(directory)
  }
  return { name: CANONICAL_TODO_NAME, path }
}

// Append a new task with the next free id. Creates an empty TODO.md if the
// directory has no todo file at all.
export function addTask(directory, { title, accept } = {}) {
  const cleanTitle = (title ?? "").trim()
  if (!cleanTitle) throw new Error("addTask: title is required")
  const target = ensureTodoFile(directory)
  const content = readAt(directory, target)
  const id = nextFreeIdFrom(content)
  const cleanAccept = (accept ?? "").trim()
  const block =
    `- ${id}: ${cleanTitle}\n` + (cleanAccept ? `  accept: ${cleanAccept}\n` : "")
  const sep = content === "" || content.endsWith("\n") ? "" : "\n"
  writeAt(directory, target, content + sep + block)
  return { id }
}

// Edit a task's title or accept criterion. Either field is optional — only
// the provided ones change. Passing `accept: ""` deletes the accept line.
// Throws if the id doesn't exist.
export function editTask(directory, id, { title, accept } = {}) {
  const target = loadTodoFile(directory)
  const lines = target.content.split("\n")
  const tasks = parseTasks(target.content)
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error(`task ${id} not found in ${target.name}`)
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
  if (changed) writeAt(directory, target, lines.join("\n"))
  return { changed }
}

// Remove a task (its header line + optional accept line). Throws if the id
// doesn't exist — caller decides whether to treat that as a no-op.
export function removeTask(directory, id) {
  const target = loadTodoFile(directory)
  const lines = target.content.split("\n")
  const tasks = parseTasks(target.content)
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error(`task ${id} not found in ${target.name}`)
  // Delete in reverse line order so the header index stays valid.
  if (t.acceptLineIdx != null) lines.splice(t.acceptLineIdx, 1)
  lines.splice(t.lineIdx, 1)
  writeAt(directory, target, lines.join("\n"))
  return { changed: true }
}
