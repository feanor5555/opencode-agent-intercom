// Tests for the project-document bootstrap in src/project.js and its use of
// the todo-file lookup (src/todofile.js `findTodoFile`):
//
//   - ensureProjectFiles resolves an existing todo file under ANY accepted
//     name (`todo.md` / `todos.md`, any casing) and creates no second file
//     beside it; it creates the canonical TODO.md only in a directory that
//     has no todo file at all.
//   - the generated PROJECT.md links the todo file that was actually found.
//   - readPlannedSteps reads that same file, not a hardcoded TODO.md.
//   - the mtime-keyed cache on ensureProjectFiles does not blind it to a
//     document that is removed or added afterwards.
//
// The "primary turn" cases drive the REAL transform hook
// (`experimental.chat.system.transform`), which is the production path that
// calls projectMdBlock → ensureProjectFiles on every primary turn.
//
// Run: node --test test/project-files.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { resetState } from "../src/state.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { resetPermissionGuardCache } from "../src/config.js"
import {
  ensureProjectFiles,
  defaultProjectMd,
  readPlannedSteps,
  resetProjectContext,
} from "../src/project.js"
import { CANONICAL_TODO_NAME } from "../src/todofile.js"

// Every test gets its own fixture directory — the bootstrap writes into it and
// the directory's own mtime is what the ensure-cache keys on.
const fixtures = []

function makeDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "intercom-project-files-"))
  fixtures.push(dir)
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

// The bootstrap only caches a directory mtime that is already a full second
// old (ENSURE_CACHE_MIN_AGE_MS in src/project.js). Backdating the fixture
// directory drives that boundary without a sleep in the test. Whole-second
// timestamps only, so passing the returned value back restores byte-identical
// mtime and a test can reproduce a cache hit deliberately.
function ageDirectory(dir, atMs = Math.floor(Date.now() / 1000) * 1000 - 5000) {
  const at = new Date(atMs)
  utimesSync(dir, at, at)
  return atMs
}

const settingsDir = mkdtempSync(join(tmpdir(), "intercom-project-files-settings-"))
fixtures.push(settingsDir)
const settingsFile = join(settingsDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  resetState()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

after(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
})

// Minimal mock opencode client, enough for the transform hook on a primary
// session. `session.get` is what `getSessionDirectory` reads the project
// directory from.
function makeCtx(directory) {
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_sub1" } }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory } }),
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { client, directory, worktree: directory, project: {} }
}

// Drives one primary turn through the real transform hook and returns the
// assembled system prompt.
async function primaryTurn(directory, sessionID) {
  const hooks = await plugin(makeCtx(directory))
  const out = { system: ["base prompt"] }
  await hooks["experimental.chat.system.transform"]({ sessionID }, out)
  return out.system.join("")
}

const TODOS_SEED = `# Todos

- T1: wire the export endpoint
  accept: GET /export returns 200
- T2: cover it with a test
`

// ===========================================================================
// A variant-named todo file survives a primary turn
// ===========================================================================

test("primary turn in a todos.md project creates no stray TODO.md", async () => {
  const dir = makeDir({ "todos.md": TODOS_SEED })

  await primaryTurn(dir, "ses_variant_1")

  assert.equal(
    existsSync(join(dir, CANONICAL_TODO_NAME)),
    false,
    "no second todo file may be created beside todos.md",
  )
  assert.equal(readFileSync(join(dir, "todos.md"), "utf8"), TODOS_SEED, "todos.md untouched")
  // The other two documents are still bootstrapped as before.
  assert.equal(existsSync(join(dir, "PROJECT.md")), true)
  assert.equal(existsSync(join(dir, "ARCHITECTURE.md")), true)
  assert.deepEqual(
    readdirSync(dir).filter((n) => /^todos?\.md$/i.test(n)),
    ["todos.md"],
    "exactly one todo file in the directory",
  )
})

test("repeated primary turns in a todos.md project stay a no-op", async () => {
  const dir = makeDir({ "Todo.md": TODOS_SEED })

  await primaryTurn(dir, "ses_variant_2")
  const afterFirst = readdirSync(dir).sort()
  await primaryTurn(dir, "ses_variant_3")

  assert.deepEqual(readdirSync(dir).sort(), afterFirst, "second turn creates nothing")
  assert.deepEqual(
    afterFirst.filter((n) => /^todos?\.md$/i.test(n)),
    ["Todo.md"],
  )
})

// ===========================================================================
// The generated PROJECT.md names the todo file that was found
// ===========================================================================

test("defaultProjectMd links the todo file it is given, TODO.md by default", () => {
  assert.match(defaultProjectMd("todos.md"), /- \[todos\.md\]\(todos\.md\) — canonical file for tasks\/TODOs\./)
  assert.equal(defaultProjectMd("todos.md").includes("[TODO.md]"), false)
  assert.match(defaultProjectMd(), /- \[TODO\.md\]\(TODO\.md\) — canonical file for tasks\/TODOs\./)
  // The architecture link is unchanged in both cases.
  assert.match(defaultProjectMd("todos.md"), /- \[ARCHITECTURE\.md\]\(ARCHITECTURE\.md\)/)
})

test("generated PROJECT.md links the variant todo file, and the turn injects it", async () => {
  const dir = makeDir({ "TODOS.md": TODOS_SEED })

  const system = await primaryTurn(dir, "ses_variant_4")

  const projectMd = readFileSync(join(dir, "PROJECT.md"), "utf8")
  assert.match(projectMd, /\[TODOS\.md\]\(TODOS\.md\)/)
  assert.equal(projectMd.includes("[TODO.md](TODO.md)"), false, "the dead link must be gone")
  assert.match(system, /\[TODOS\.md\]\(TODOS\.md\)/, "PROJECT.md reaches the system prompt")
})

test("a greenfield project gets TODO.md and a PROJECT.md linking it", () => {
  const dir = makeDir()

  const name = ensureProjectFiles(dir)

  assert.equal(name, CANONICAL_TODO_NAME)
  assert.equal(readFileSync(join(dir, CANONICAL_TODO_NAME), "utf8"), "")
  assert.match(readFileSync(join(dir, "PROJECT.md"), "utf8"), /\[TODO\.md\]\(TODO\.md\)/)
})

test("an existing PROJECT.md is never overwritten", () => {
  const dir = makeDir({ "todos.md": TODOS_SEED, "PROJECT.md": "# mine\n" })

  ensureProjectFiles(dir)

  assert.equal(readFileSync(join(dir, "PROJECT.md"), "utf8"), "# mine\n")
})

// ===========================================================================
// ensureProjectFiles: return value and the non-greenfield states
// ===========================================================================

test("ensureProjectFiles returns the name of the todo file in use", () => {
  assert.equal(ensureProjectFiles(makeDir({ "todos.md": TODOS_SEED })), "todos.md")
  assert.equal(ensureProjectFiles(makeDir({ "Todo.md": TODOS_SEED })), "Todo.md")
  assert.equal(ensureProjectFiles(makeDir()), CANONICAL_TODO_NAME)
  assert.equal(ensureProjectFiles(""), CANONICAL_TODO_NAME, "no directory → canonical name")
})

test("several todo files: nothing is created, the other documents still are", () => {
  const dir = makeDir({ "todo.md": "- T1: a\n", "todos.md": "- T1: b\n" })

  const name = ensureProjectFiles(dir)

  assert.equal(name, CANONICAL_TODO_NAME, "the link falls back to the canonical name")
  assert.equal(
    existsSync(join(dir, CANONICAL_TODO_NAME)),
    false,
    "an ambiguous directory is not created over",
  )
  assert.equal(readFileSync(join(dir, "todo.md"), "utf8"), "- T1: a\n")
  assert.equal(readFileSync(join(dir, "todos.md"), "utf8"), "- T1: b\n")
  assert.equal(existsSync(join(dir, "ARCHITECTURE.md")), true)
})

test("a todo-file name that is not a regular file is not created over", () => {
  const dir = makeDir()
  mkdirSync(join(dir, "TODO.md"))

  const name = ensureProjectFiles(dir)

  assert.equal(name, CANONICAL_TODO_NAME)
  assert.equal(existsSync(join(dir, "PROJECT.md")), true, "the run still bootstraps the rest")
})

// ===========================================================================
// The mtime-keyed cache must not blind the bootstrap
// ===========================================================================

test("a directory whose mtime is unchanged is served from the cache", () => {
  const dir = makeDir({ "todos.md": TODOS_SEED })
  ensureProjectFiles(dir) // bootstraps PROJECT.md + ARCHITECTURE.md
  const mtimeMs = ageDirectory(dir)

  assert.equal(ensureProjectFiles(dir), "todos.md", "this run records the mtime")
  // Remove a document AND restore the recorded mtime: the cached answer stands
  // and the run is skipped. This is the documented limit of the mtime key —
  // only a change that leaves the directory mtime untouched can hide.
  rmSync(join(dir, "ARCHITECTURE.md"))
  ageDirectory(dir, mtimeMs)

  assert.equal(ensureProjectFiles(dir), "todos.md")
  assert.equal(existsSync(join(dir, "ARCHITECTURE.md")), false, "cache hit skipped the run")
})

test("a document removed after a cached run is recreated on the next one", () => {
  const dir = makeDir({ "todos.md": TODOS_SEED })
  ensureProjectFiles(dir)
  ageDirectory(dir)
  ensureProjectFiles(dir) // this run records the mtime

  rmSync(join(dir, "ARCHITECTURE.md")) // bumps the directory mtime to now

  ensureProjectFiles(dir)
  assert.equal(existsSync(join(dir, "ARCHITECTURE.md")), true, "the change is seen")
  assert.equal(existsSync(join(dir, CANONICAL_TODO_NAME)), false)
})

test("a fresh directory mtime is not cached, so a same-tick change is still seen", () => {
  const dir = makeDir({ "todos.md": TODOS_SEED })
  ensureProjectFiles(dir) // wrote → nothing cached
  ensureProjectFiles(dir) // mtime is from this second → still nothing cached

  rmSync(join(dir, "ARCHITECTURE.md"))
  ensureProjectFiles(dir)

  assert.equal(existsSync(join(dir, "ARCHITECTURE.md")), true)
})

test("a todo file added after a cached run replaces the canonical answer", () => {
  const dir = makeDir()

  assert.equal(ensureProjectFiles(dir), CANONICAL_TODO_NAME, "greenfield creates TODO.md")
  ageDirectory(dir)
  ensureProjectFiles(dir) // records the mtime
  rmSync(join(dir, CANONICAL_TODO_NAME))
  writeFileSync(join(dir, "todos.md"), TODOS_SEED)

  assert.equal(ensureProjectFiles(dir), "todos.md")
  assert.equal(existsSync(join(dir, CANONICAL_TODO_NAME)), false)
})

// ===========================================================================
// readPlannedSteps follows the same lookup
// ===========================================================================

test("readPlannedSteps resolves a variant todo-file name", () => {
  const dir = makeDir({ "todos.md": TODOS_SEED })

  assert.deepEqual(readPlannedSteps(dir), [
    "T1: wire the export endpoint",
    "accept: GET /export returns 200",
    "T2: cover it with a test",
  ])
})

test("readPlannedSteps reads an uppercase TODOS.md and honours `## Offen`", () => {
  const dir = makeDir({
    "TODOS.md": ["# Todos", "", "## Offen", "", "- T4: ship it", "", "## Done", "", "- T0: seed"].join("\n"),
  })

  assert.deepEqual(readPlannedSteps(dir), ["T4: ship it"])
})

test("readPlannedSteps returns [] when several todo files match", () => {
  const dir = makeDir({ "todo.md": "- T1: a\n", "todos.md": "- T1: b\n" })

  assert.deepEqual(readPlannedSteps(dir), [], "an ambiguous directory yields no planned steps")
})

test("readPlannedSteps returns [] when the todo-file name is a directory", () => {
  const dir = makeDir()
  mkdirSync(join(dir, "todos.md"))

  assert.deepEqual(readPlannedSteps(dir), [])
})
