// Todo-file parser/writer. The todo file lives directly in `<directory>` and
// is named `todo.md` or `todos.md` in any casing — `TODO.md`, `todos.md`,
// `Todo.md`, `TODOS.md` all count. Exactly one such file may exist; several
// are a hard error rather than a pick that would depend on the order the
// directory happens to list its entries. When none exists, `ensureTodoFile`
// and `addTask` create the canonical `TODO.md`.
//
// THE MACHINE SECTION. The plugin owns one fenced region of the file and
// nothing outside it:
//
//   ## Intercom tasks
//   <!-- intercom:begin -->
//   - T46: <short task title>
//     accept: <one-line criterion>
//     link: <path §section>
//   <!-- intercom: next-id T47 -->
//   <!-- intercom:end -->
//
// The two HTML-comment markers, not the heading, are the authority: a human
// may rename, translate or demote the heading without the plugin losing its
// section. `ensureSection` creates the region where it is absent; the region
// is never adopted from an existing human section, so human prose stays
// outside the markers.
//
// TWO SHAPES, ONE WRITER. Reading is wide and writing is narrow:
//
//   read  — `/^(\s*)[-*]\s+(T\d+)\s*(?::|—|–|-)?\s+(.*)$/`, so the em-dash and
//           asterisk-bullet lines already standing in existing files are read
//           as the tasks they are instead of being orphaned. Used by
//           `parseTasks`, `listOpen`, the id scan behind `nextFreeId` and the
//           pre-spawn snapshot.
//   write — `- T<n>: title` alone, and only INSIDE the markers. `addTask`
//           emits nothing else, and `editTask` / `removeTask` act on nothing
//           else: they answer `{ unmigrated: true }` for an id that resolves
//           only to a legacy line outside the region. Without that split a
//           subagent's `DONE: T1` would delete a human prose bullet that
//           merely begins with a T-token.
//
// A task owns its header line and the whole contiguous indented run under it,
// so `accept:`, `link:` and `note:` lines travel and die with their task.
//
// IDS ARE MONOTONE. The last line of the machine section carries the watermark
// `<!-- intercom: next-id T<n> -->`. `nextFreeId` reads it and never hands out
// the id of a removed task again; where the watermark is absent it falls back
// to max+1 over a widened scan of every bullet line and writes the watermark
// on the next append. Done tasks are REMOVED from the todo file — there are no
// checkbox markers, no "blocked" state, no done archive. Tasks are ordered
// top-to-bottom by feasibility: the first task is the next one to do.
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

// The READ shape. Captures: indent, id (T5), the text after the separator.
// A separator is optional and may be a colon, an em-dash, an en-dash or a
// hyphen; the bullet may be `-` or `*`. Whitespace after it is required, so a
// cross-reference like `- T5:see below` is not read as a task header.
const TASK_LINE_RE = /^(\s*)[-*]\s+(T\d+)\s*(?::|—|–|-)?\s+(.*)$/

// The WRITE shape: what every writer emits and the only shape `editTask` and
// `removeTask` will touch. Deliberately narrower than the read shape.
const CANONICAL_TASK_LINE_RE = /^(\s*)- (T\d+):\s*(.*)$/

const ACCEPT_LINE_RE = /^\s+accept:\s*(.*)$/i

// The id scan behind `nextFreeId`: every bullet line carrying a T-token, not
// only the ones `parseTasks` returns. An id that stands anywhere in the file
// is taken, whatever shape its line has.
const ID_SCAN_RE = /^\s*[-*]\s+T(\d+)\b/

// The machine section's fence and its heading. The markers are the authority;
// the heading is a courtesy to the human reading the file.
export const SECTION_HEADING = "## Intercom tasks"
export const SECTION_BEGIN_MARKER = "<!-- intercom:begin -->"
export const SECTION_END_MARKER = "<!-- intercom:end -->"

const BEGIN_MARKER_RE = /^\s*<!--\s*intercom:begin\s*-->\s*$/
const END_MARKER_RE = /^\s*<!--\s*intercom:end\s*-->\s*$/
const NEXT_ID_LINE_RE = /^\s*<!--\s*intercom:\s*next-id\s+T(\d+)\s*-->\s*$/

// Where a fresh section is anchored when the file has no markers: immediately
// after the first heading of level 2 or deeper that names the open work. A
// level-1 heading is a document title — `# TODO` at the top of a file names the
// whole file, not a section within it — and is skipped even when its text
// matches, so the machine section lands under a real `## Open` / `## Todo`
// rather than directly beneath the title.
const OPEN_HEADING_RE = /^#{2,6}\s+(open|pending|todo|todos)\b/i

// A `## Intercom tasks` heading that carries no markers is human text, not the
// plugin's section — the fresh section is inserted below it.
const SECTION_HEADING_RE = /^#{1,6}\s+intercom tasks\s*$/i

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

// The endless cycle's prepare step, in one call: resolve the todo file
// (creating an empty canonical TODO.md where the directory has none), lay the
// machine section down where the file carries no valid fence and WRITE that
// change, then hand back the resolved name, path and the current content. A
// directory with several todo files, or a name that is not a regular file,
// propagates the TodoFileMissingError so the cycle abandons before a turn is
// spent instead of writing into a directory a human still has to sort out.
export function prepareTodoFile(directory) {
  const target = ensureTodoFile(directory)
  const original = readAt(directory, target)
  const { content, changed } = ensureSection(original)
  if (changed) writeAt(directory, target, content)
  return { name: target.name, path: target.path, content }
}

// Re-resolves and reads the todo file, keeping its name — the endless cycle's
// V1 read-back after the wind-down subagent has run. Propagates
// TodoFileMissingError ("missing" / "multiple" / "not-a-file") so a file that
// vanished or split under the cycle surfaces rather than reading as empty.
export function readTodoFileNamed(directory) {
  const target = findTodoFile(directory)
  return { name: target.name, content: readAt(directory, target) }
}

// Overwrites the resolved todo file with `content` — the endless cycle's
// snapshot restore, run when the wind-down rewrite fails verification. Goes
// through the same O_NOFOLLOW, regular-file-confirmed descriptor every other
// write uses, so the restore cannot be redirected through a swapped symlink.
export function writeTodoFile(directory, content) {
  const target = findTodoFile(directory)
  writeAt(directory, target, String(content ?? ""))
  return { name: target.name }
}

// The machine section as line indices over `content.split("\n")`.
//
// `valid` is the whole fence test: exactly ONE begin marker and exactly ONE
// end marker, in that order. A file that lost, duplicated or reordered them
// has no section — no write goes into it and `ensureSection` lays a fresh one
// down beside what is there.
//
// `inside` are the lines strictly between the markers (the region a wind-down
// subagent may rewrite), `outside` every line not in the inclusive marked
// range (the region that must stay untouched).
export function splitSections(content) {
  const lines = String(content ?? "").split("\n")
  let beginIdx = -1
  let endIdx = -1
  let beginCount = 0
  let endCount = 0
  for (let i = 0; i < lines.length; i++) {
    if (BEGIN_MARKER_RE.test(lines[i])) {
      beginCount += 1
      if (beginIdx === -1) beginIdx = i
    } else if (END_MARKER_RE.test(lines[i])) {
      endCount += 1
      if (endIdx === -1) endIdx = i
    }
  }
  const valid = beginCount === 1 && endCount === 1 && beginIdx < endIdx
  return {
    lines,
    beginIdx,
    endIdx,
    beginCount,
    endCount,
    valid,
    inside: valid ? lines.slice(beginIdx + 1, endIdx) : [],
    outside: valid ? [...lines.slice(0, beginIdx), ...lines.slice(endIdx + 1)] : [...lines],
  }
}

// Inserts the heading and the two markers where the file has no valid fence,
// and answers `{ content, changed }`. Pure — the caller writes.
//
// The anchor, in order:
//   1. immediately below a marker-less `## Intercom tasks` heading, which is
//      human text this function does not adopt;
//   2. immediately after the first heading of level 2 or deeper naming the open
//      work (`## Open` / `## Pending` / `## Todo` / `## Todos`); a level-1
//      document title is skipped even when its text matches;
//   3. at the end of the file, where no such heading exists.
// An existing human section is never taken over: its prose stays outside the
// markers, where nothing this plugin writes may touch it.
export function ensureSection(content) {
  const text = typeof content === "string" ? content : ""
  if (splitSections(text).valid) return { content: text, changed: false }
  const lines = text.split("\n")

  let at = -1
  for (let i = 0; i < lines.length && at === -1; i++) {
    if (SECTION_HEADING_RE.test(lines[i])) at = i + 1
  }
  if (at === -1) {
    for (let i = 0; i < lines.length && at === -1; i++) {
      if (OPEN_HEADING_RE.test(lines[i])) at = i + 1
    }
  }
  if (at === -1) {
    // End of file, but before the blank lines it ends with, so the file keeps
    // its trailing newline instead of gaining a marker after it.
    at = lines.length
    while (at > 0 && lines[at - 1].trim() === "") at -= 1
  }

  const block = [SECTION_HEADING, SECTION_BEGIN_MARKER, SECTION_END_MARKER]
  if (at > 0 && lines[at - 1].trim() !== "") block.unshift("")
  if (at < lines.length && lines[at].trim() !== "") block.push("")
  lines.splice(at, 0, ...block)
  return { content: lines.join("\n"), changed: true }
}

// Every task in `content`, top-to-bottom (= feasibility order), read through
// the WIDE shape. A task owns its header line and the contiguous indented run
// under it: `blockEndIdx` is that run's last line (the header's own index when
// there is no run), which is what `removeTask` deletes and what the wind-down
// verification treats as one block.
//
// The run ends at a blank line, at the first line that is not indented, and at
// a line that is itself a task header — so two tasks never own one line.
export function parseTasks(content) {
  const lines = String(content ?? "").split("\n")
  const tasks = []
  for (let i = 0; i < lines.length; i++) {
    const m = TASK_LINE_RE.exec(lines[i])
    if (!m) continue
    const [, indent, id, rest] = m
    let accept
    let acceptLineIdx
    let blockEndIdx = i
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === "") break
      if (!/^\s/.test(line)) break
      if (TASK_LINE_RE.test(line)) break
      blockEndIdx = j
      if (accept === undefined) {
        const am = ACCEPT_LINE_RE.exec(line)
        if (am) {
          accept = am[1].trim()
          acceptLineIdx = j
        }
      }
    }
    tasks.push({ id, text: rest.trim(), accept, lineIdx: i, acceptLineIdx, blockEndIdx, indent })
  }
  return tasks
}

// All tasks currently in the todo file, top-to-bottom (= feasibility order).
export function listOpen(directory) {
  const content = readTodoFile(directory)
  return parseTasks(content)
}

// Every T-number that stands on a bullet line of `content`, however that line
// is shaped. Wider than `parseTasks` on purpose: an id is taken as soon as it
// is written down anywhere, so no allocation can collide with a line the
// parser does not return as a task.
export function usedIdsFrom(content) {
  const ids = new Set()
  for (const line of String(content ?? "").split("\n")) {
    const m = ID_SCAN_RE.exec(line)
    if (m) ids.add(Number(m[1]))
  }
  return ids
}

// The highest watermark the file carries, or 0 when it carries none.
function watermarkFrom(content) {
  let watermark = 0
  for (const line of String(content ?? "").split("\n")) {
    const m = NEXT_ID_LINE_RE.exec(line)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > watermark) watermark = n
    }
  }
  return watermark
}

// Next free T-id for already-read content. The watermark wins where it is
// present, so the id of a removed task is never handed out a second time; the
// widened scan is the floor under it, so a hand-written id above the watermark
// still cannot be collided with.
function nextFreeIdFrom(content) {
  let max = 0
  for (const n of usedIdsFrom(content)) {
    if (Number.isFinite(n) && n > max) max = n
  }
  return `T${Math.max(max + 1, watermarkFrom(content))}`
}

// Next free T-id: the watermark, or max(existing T-ids) + 1, or T1 when the
// file is empty or absent. A directory whose todo file exists but cannot be
// used ("multiple", "not-a-file") is not a greenfield and propagates —
// answering T1 there would hand out an id that already exists in the file we
// failed to read.
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
export function ensureTodoFile(directory) {
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

// Appends `block` to the machine section and re-writes the watermark as the
// section's last line. `content` must already carry a valid fence.
function insertIntoSection(content, block, nextId) {
  const split = splitSections(content)
  if (!split.valid) throw new Error("insertIntoSection: the machine section is not fenced")
  const inside = split.inside.filter((line) => !NEXT_ID_LINE_RE.test(line))
  // Drop a blank line the section ends with, so appended tasks stay contiguous
  // and the watermark stays the last line.
  while (inside.length > 0 && inside[inside.length - 1].trim() === "") inside.pop()
  const next = [
    ...split.lines.slice(0, split.beginIdx + 1),
    ...inside,
    ...block,
    `<!-- intercom: next-id ${nextId} -->`,
    ...split.lines.slice(split.endIdx),
  ]
  return next.join("\n")
}

// Add a new task with the next free id, INSIDE the machine section. Creates an
// empty TODO.md if the directory has no todo file at all, and lays the section
// down where the file has none — there is one insertion point and no second
// way into the file, so nothing is ever appended under whatever heading the
// file happens to end with.
export function addTask(directory, { title, accept } = {}) {
  const cleanTitle = (title ?? "").trim()
  if (!cleanTitle) throw new Error("addTask: title is required")
  const target = ensureTodoFile(directory)
  const prepared = ensureSection(readAt(directory, target)).content
  const id = nextFreeIdFrom(prepared)
  const cleanAccept = (accept ?? "").trim()
  const block = [`- ${id}: ${cleanTitle}`]
  if (cleanAccept) block.push(`  accept: ${cleanAccept}`)
  writeAt(directory, target, insertIntoSection(prepared, block, `T${Number(id.slice(1)) + 1}`))
  return { id }
}

// The one task a writer may act on: canonical shape, inside the markers.
//
// `unmigrated` is the id that exists in the file but only as a legacy line —
// outside the markers, or in a shape no writer emits. Such a line is left
// exactly as it stands; the next wind-down migrates it into the section.
function findWritableTask(content, id) {
  const split = splitSections(content)
  const withId = parseTasks(content).filter((t) => t.id === id)
  if (withId.length === 0) return { task: null, unmigrated: false }
  if (!split.valid) return { task: null, unmigrated: true }
  const writable = withId.find(
    (t) =>
      t.lineIdx > split.beginIdx &&
      t.lineIdx < split.endIdx &&
      CANONICAL_TASK_LINE_RE.test(split.lines[t.lineIdx]),
  )
  return { task: writable ?? null, unmigrated: !writable }
}

// Edit a task's title or accept criterion. Either field is optional — only
// the provided ones change. Passing `accept: ""` deletes the accept line.
// Throws if the id doesn't exist; answers `{ changed: false, unmigrated: true }`
// for an id that stands only in a legacy line outside the machine section.
export function editTask(directory, id, { title, accept } = {}) {
  const target = loadTodoFile(directory)
  const { task: t, unmigrated } = findWritableTask(target.content, id)
  if (!t) {
    if (unmigrated) return { changed: false, unmigrated: true, id }
    throw new Error(`task ${id} not found in ${target.name}`)
  }
  const lines = target.content.split("\n")
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

// Remove a task: its header line and the whole contiguous indented run under
// it, so an `accept:` or `link:` line never survives its task as an orphan.
// Throws if the id doesn't exist — caller decides whether to treat that as a
// no-op. Answers `{ changed: false, unmigrated: true }` for an id that stands
// only in a legacy line outside the machine section: that line is human text
// until a wind-down migrates it, and deleting it here is exactly the silent
// loss the read/write split exists against.
export function removeTask(directory, id) {
  const target = loadTodoFile(directory)
  const { task: t, unmigrated } = findWritableTask(target.content, id)
  if (!t) {
    if (unmigrated) return { changed: false, unmigrated: true, id }
    throw new Error(`task ${id} not found in ${target.name}`)
  }
  const lines = target.content.split("\n")
  lines.splice(t.lineIdx, t.blockEndIdx - t.lineIdx + 1)
  writeAt(directory, target, lines.join("\n"))
  return { changed: true }
}
