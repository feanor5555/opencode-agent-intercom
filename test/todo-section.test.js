// The machine section of the todo file (src/todofile.js): the fence, the
// widened read shape, the narrowed write shape, the block a task owns and the
// monotone id watermark.
//
// Imports todofile.js and node builtins alone — no plugin, no client, no
// settings file.
//
// Run: node --test test/todo-section.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  parseTasks,
  splitSections,
  ensureSection,
  usedIdsFrom,
  nextFreeId,
  addTask,
  editTask,
  removeTask,
  listOpen,
  ensureTodoFile,
  readTodoFile,
  findTodoFile,
  CANONICAL_TODO_NAME,
  SECTION_HEADING,
  SECTION_BEGIN_MARKER,
  SECTION_END_MARKER,
} from "../src/todofile.js"

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-todo-section-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function seed(dir, content) {
  writeFileSync(join(dir, CANONICAL_TODO_NAME), content)
  return dir
}

const MARKED = (...inside) =>
  `${SECTION_HEADING}\n${SECTION_BEGIN_MARKER}\n${inside.join("\n")}\n${SECTION_END_MARKER}\n`

// ---------------------------------------------------------------------------
// The widened read shape
// ---------------------------------------------------------------------------

// The lines the live file was found to carry: an em-dash instead of a colon.
// Under the old expression `listOpen` answered [] on a file full of tasks and
// the id allocation restarted at T1 over ids already in use.
test("parseTasks: reads the em-dash lines already standing in real files", () => {
  const tasks = parseTasks(
    "- T45 — docs catch-up: bring the README up to date\n" +
      "  accept: the README names the current flags\n" +
      "- T8 – en-dash variant\n" +
      "* T9: asterisk bullet\n" +
      "- T10 plain gap\n",
  )
  assert.deepEqual(
    tasks.map((t) => t.id),
    ["T45", "T8", "T9", "T10"],
  )
  assert.equal(tasks[0].text, "docs catch-up: bring the README up to date")
  assert.equal(tasks[0].accept, "the README names the current flags")
  assert.equal(tasks[3].text, "plain gap")
})

test("parseTasks: a cross-reference without a gap after the id is not a task", () => {
  assert.deepEqual(parseTasks("- see plans/T3.md for the detail\n- T5:no gap\n"), [])
})

// A task owns its whole contiguous indented run, so `link:` and `note:` lines
// travel and die with it instead of surviving as orphans.
test("parseTasks: a task owns its whole indented block", () => {
  const tasks = parseTasks(
    "- T1: first\n" +
      "  accept: it is done\n" +
      "  link: specs/endless-mode.md §3.4\n" +
      "  note: two lines of detail\n" +
      "\n" +
      "- T2: second\n",
  )
  assert.equal(tasks[0].lineIdx, 0)
  assert.equal(tasks[0].blockEndIdx, 3, "the run ends at the blank line")
  assert.equal(tasks[0].accept, "it is done")
  assert.equal(tasks[1].blockEndIdx, tasks[1].lineIdx, "a task with no run owns its header alone")
})

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

test("splitSections: one begin and one end, in that order, or no section at all", () => {
  const ok = splitSections(MARKED("- T1: x"))
  assert.equal(ok.valid, true)
  assert.deepEqual(ok.inside, ["- T1: x"])
  assert.deepEqual(ok.outside, [SECTION_HEADING, ""])
  assert.equal(splitSections("nothing here\n").valid, false)
  assert.equal(
    splitSections(`${SECTION_END_MARKER}\n${SECTION_BEGIN_MARKER}\n`).valid,
    false,
    "reordered markers are not a section",
  )
  assert.equal(
    splitSections(`${SECTION_BEGIN_MARKER}\n${SECTION_BEGIN_MARKER}\n${SECTION_END_MARKER}\n`).valid,
    false,
    "a duplicated marker is not a section",
  )
})

test("ensureSection: a file with no markers gets the heading and the fence at its end", () => {
  const { content, changed } = ensureSection("# Notes\n\nsome prose\n")
  assert.equal(changed, true)
  assert.equal(
    content,
    `# Notes\n\nsome prose\n\n${SECTION_HEADING}\n${SECTION_BEGIN_MARKER}\n${SECTION_END_MARKER}\n`,
  )
  assert.equal(splitSections(content).valid, true)
  assert.equal(ensureSection(content).changed, false, "a fenced file is left alone")
})

// The human section is never adopted: its prose must stay outside the markers,
// where nothing this plugin writes may reach it.
test("ensureSection: anchors below a human open heading without adopting it", () => {
  const { content } = ensureSection("# Project notes\n\n## Open\n\nNone. Everything is done.\n")
  const split = splitSections(content)
  assert.equal(split.valid, true)
  assert.ok(
    split.outside.includes("None. Everything is done."),
    "the human prose stays outside the markers",
  )
  assert.deepEqual(split.inside, [], "the fresh section is empty")
  assert.ok(
    content.indexOf("## Open") < content.indexOf(SECTION_BEGIN_MARKER),
    "the section is anchored below the open heading",
  )
})

// The anchor is the first heading of level 2 or deeper whose text names the
// open work. A level-1 document title is skipped even when it matches, so a
// `# TODO` title does not pull the machine section up above the prose under it.
test("ensureSection: a level-1 title that matches is skipped for the anchor", () => {
  const { content } = ensureSection("# TODO\n\n## Open\n\nNone.\n")
  assert.ok(
    content.indexOf("## Open") < content.indexOf(SECTION_BEGIN_MARKER),
    "the `# TODO` title is skipped; the level-2 `## Open` heading takes the anchor",
  )
})

// Where no level-2-or-deeper heading names the open work, the section goes at
// the end of the file — a matching level-1 title alone is not an anchor.
test("ensureSection: with only a matching level-1 title the section goes at the end", () => {
  const { content } = ensureSection("# TODO\n\nsome prose\n")
  assert.ok(
    content.indexOf("some prose") < content.indexOf(SECTION_BEGIN_MARKER),
    "the section is appended after the whole document",
  )
})

test("ensureSection: a marker-less `## Intercom tasks` heading is human text", () => {
  const { content } = ensureSection("## Intercom tasks\n\nwritten by a human\n")
  const split = splitSections(content)
  assert.equal(split.valid, true)
  assert.ok(split.outside.includes("written by a human"))
  assert.equal(
    content.split(SECTION_HEADING).length - 1,
    2,
    "the plugin adds its own heading below the human one rather than taking it over",
  )
})

test("ensureSection: an empty file gets the section and nothing else", () => {
  assert.equal(
    ensureSection("").content,
    `${SECTION_HEADING}\n${SECTION_BEGIN_MARKER}\n${SECTION_END_MARKER}\n`,
  )
})

// ---------------------------------------------------------------------------
// The section-anchored insert
// ---------------------------------------------------------------------------

test("addTask: inserts between the markers, never at the end of the file", () =>
  withTempDir((dir) => {
    seed(dir, "# TODO\n\n## Open\n\nNone.\n\n## Not now\n\n- someday: rewrite it all\n")
    assert.equal(addTask(dir, { title: "wire the endpoint", accept: "200 with JSON" }).id, "T1")
    const content = readTodoFile(dir)
    const split = splitSections(content)
    assert.deepEqual(split.inside, [
      "- T1: wire the endpoint",
      "  accept: 200 with JSON",
      "<!-- intercom: next-id T2 -->",
    ])
    assert.ok(
      split.outside.includes("- someday: rewrite it all"),
      "the human `## Not now` section is untouched",
    )
    assert.ok(
      content.indexOf(SECTION_END_MARKER) < content.indexOf("## Not now"),
      "the task did not land under the human heading the file ends with",
    )
  }))

test("addTask: the second task follows the first inside the same section", () =>
  withTempDir((dir) => {
    addTask(dir, { title: "first" })
    addTask(dir, { title: "second" })
    assert.deepEqual(splitSections(readTodoFile(dir)).inside, [
      "- T1: first",
      "- T2: second",
      "<!-- intercom: next-id T3 -->",
    ])
  }))

test("ensureTodoFile: resolves an existing file and creates the canonical one otherwise", () =>
  withTempDir((dir) => {
    assert.equal(ensureTodoFile(dir).name, CANONICAL_TODO_NAME)
    assert.equal(readFileSync(join(dir, CANONICAL_TODO_NAME), "utf8"), "")
    assert.equal(findTodoFile(dir).name, CANONICAL_TODO_NAME)
  }))

// ---------------------------------------------------------------------------
// Monotone ids
// ---------------------------------------------------------------------------

test("usedIdsFrom: every bullet line carrying a T-token, not only parsed tasks", () => {
  assert.deepEqual(
    [...usedIdsFrom("- T1: one\n- T45 — legacy\n* T7\n  - T9: indented\nT3: no bullet\n")].sort(
      (a, b) => a - b,
    ),
    [1, 7, 9, 45],
  )
})

// The id-reuse class the live run exposed: a removed task's id was handed out
// again on the next append, and the file then carried two different tasks under
// one id across cycles.
test("the watermark keeps an id from being handed out again after its task is removed", () =>
  withTempDir((dir) => {
    assert.equal(addTask(dir, { title: "first" }).id, "T1")
    assert.equal(addTask(dir, { title: "second" }).id, "T2")
    assert.equal(removeTask(dir, "T2").changed, true)
    assert.deepEqual(
      listOpen(dir).map((t) => t.id),
      ["T1"],
    )
    assert.equal(nextFreeId(dir), "T3", "T2 is gone from the file but not free again")
    assert.equal(addTask(dir, { title: "third" }).id, "T3")
  }))

test("nextFreeId: falls back to max+1 over the widened scan where no watermark stands", () =>
  withTempDir((dir) => {
    seed(dir, MARKED("- T45 — legacy shape", "- T8: canonical"))
    assert.equal(nextFreeId(dir), "T46")
  }))

test("nextFreeId: a hand-written id above the watermark still cannot be collided with", () =>
  withTempDir((dir) => {
    seed(dir, MARKED("- T60: written by hand", "<!-- intercom: next-id T5 -->"))
    assert.equal(nextFreeId(dir), "T61")
  }))

// ---------------------------------------------------------------------------
// The narrowed write shape
// ---------------------------------------------------------------------------

// The reason the widening may not reach the deleting path: `autoMarkTask` fires
// on any subagent's `DONE: T<n>` all session long, in every project, with no
// verification anywhere near it. A prose bullet that merely starts with a
// T-token is not a task to delete.
test("removeTask: a legacy line outside the markers is answered `unmigrated`, not deleted", () =>
  withTempDir((dir) => {
    const before =
      "# TODO\n\n## Open\n\n- T1 — reverse the arrows in the diagram\n  a human note under it\n\n" +
      MARKED("- T2: a real task", "<!-- intercom: next-id T3 -->")
    seed(dir, before)
    assert.deepEqual(removeTask(dir, "T1"), { changed: false, unmigrated: true, id: "T1" })
    assert.equal(readTodoFile(dir), before, "not one byte moved")
    assert.deepEqual(editTask(dir, "T1", { title: "renamed" }), {
      changed: false,
      unmigrated: true,
      id: "T1",
    })
    assert.equal(readTodoFile(dir), before)
  }))

test("removeTask: an id inside the markers but not in the canonical shape is unmigrated too", () =>
  withTempDir((dir) => {
    seed(dir, MARKED("- T4 — em-dash inside the section"))
    assert.equal(removeTask(dir, "T4").unmigrated, true)
  }))

test("removeTask: a file with no fence at all has nothing a writer may touch", () =>
  withTempDir((dir) => {
    seed(dir, "- T1: looks canonical but stands in an unfenced file\n")
    assert.equal(removeTask(dir, "T1").unmigrated, true)
    assert.throws(() => removeTask(dir, "T99"), /T99 not found/)
  }))

test("removeTask: deletes the whole block, so a link line never outlives its task", () =>
  withTempDir((dir) => {
    seed(
      dir,
      MARKED(
        "- T1: first",
        "  accept: done when it runs",
        "  link: specs/endless-mode.md §3.4",
        "- T2: second",
        "<!-- intercom: next-id T3 -->",
      ),
    )
    assert.equal(removeTask(dir, "T1").changed, true)
    const content = readTodoFile(dir)
    assert.doesNotMatch(content, /link:/)
    assert.doesNotMatch(content, /accept: done when it runs/)
    assert.match(content, /- T2: second/)
  }))
