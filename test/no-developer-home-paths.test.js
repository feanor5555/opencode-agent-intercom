// The repository is public: no tracked file may name a developer's home
// directory. A hard-coded `/home/<name>/…` discloses the local username and
// is also wrong for anyone else who checks the tree out.
//
// Every place that used to carry one now carries a form that survives the
// move to another machine:
//
//   - prose and documentation: `~/opencode-agent-intercom`, `$HOME/…`, or
//     `/absolute/path/to/…` in a config example the reader fills in;
//   - shell drivers: `${PROJECT_DIR:-$HOME/testopencode}` and friends, and
//     `todo-driver.mjs` derives this checkout from its own module URL;
//   - captures under `test/e2e/golden/` and `test/fixtures/`: the home
//     directory is redacted to the placeholder `/home/user/`, which is the
//     single spelling this test allows.
//
// The scan runs over `git ls-files`, so it sees exactly what is published and
// ignores the untracked `work/` scratch. It skips itself — the file has to be
// able to spell the pattern it forbids — and skips silently where git is not
// available or the tree is not a checkout.
//
// Run: node --test test/no-developer-home-paths.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, relative } from "node:path"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const selfPath = relative(repoRoot, fileURLToPath(import.meta.url))

// The redaction placeholder used in the recorded captures. Everything else
// under /home/ is a real account name.
const PLACEHOLDER = "user"

// `/home/<name>` where <name> is anything but the placeholder.
const HOME_PATH = /\/home\/([A-Za-z0-9._-]+)/g

function trackedFiles() {
  const git = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (git.error || git.status !== 0) return null
  return git.stdout.split("\0").filter(Boolean)
}

test("no tracked file names a developer home directory", () => {
  const files = trackedFiles()
  if (!files) {
    // Not a git checkout (a published tarball, say) — nothing to scan.
    return
  }
  assert.ok(files.length > 0, "git ls-files returned no files — wrong cwd?")

  const offenders = []
  for (const file of files) {
    if (file === selfPath) continue
    let text
    try {
      text = readFileSync(join(repoRoot, file), "utf8")
    } catch {
      continue // binary or unreadable (images under designs/, say)
    }
    if (!text.includes("/home/")) continue
    for (const match of text.matchAll(HOME_PATH)) {
      if (match[1] === PLACEHOLDER) continue
      offenders.push(`${file}: ${match[0]}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `tracked files name a home directory; use ~/…, $HOME/… or the /home/${PLACEHOLDER}/ capture placeholder instead:\n${offenders.join("\n")}`,
  )
})

test("the scan would catch a home path if one came back", () => {
  // Guards the matcher itself, so a green suite cannot mean "matched nothing".
  const sample = 'PROJECT=${PROJECT_DIR:-/home/user/testopencode}\n"plugin": ["/home/user/x"]'
  const hits = [...sample.matchAll(HOME_PATH)]
    .filter((m) => m[1] !== PLACEHOLDER)
    .map((m) => m[0])
  assert.deepEqual(hits, ["/home/user"])
})
