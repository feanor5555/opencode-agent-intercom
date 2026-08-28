// Unit tests for the disk half the three sidebar stores share
// (tui/src/json-object-file.ts): the path seam, the guarded read and the
// guarded write. The merge semantics of each store are tested in its own file.
//
// Run: node --test test/tui-json-object-file.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonObjectFile } from "../tui/src/json-object-file.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-json-object-"))
const file = join(dir, "store.json")
const store = createJsonObjectFile("store.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  store.setPath(file)
})

// A read-only file is still writable for root, so the failed-write case only
// says anything as an unprivileged user.
const rootSkip = process.getuid?.() === 0 ? "root writes read-only files" : false

test("a file that is not there reads as empty", () => {
  assert.equal(existsSync(file), false)

  assert.deepEqual(store.readRaw(), {})
})

test("the file's own object comes back as it stands", () => {
  writeFileSync(file, JSON.stringify({ a: 1, exaApiKey: "secret" }))

  assert.deepEqual(store.readRaw(), { a: 1, exaApiKey: "secret" })
})

// The branch that catches a hand edit turning the body into something that is
// not a plain object. There is no entry in such a body to keep, so it reads as
// empty and the next write replaces it.
for (const body of ["[]", "null", "42", '"x"']) {
  test(`a body of ${body} reads as empty and is replaced by the next write`, () => {
    writeFileSync(file, body)

    assert.deepEqual(store.readRaw(), {})
    assert.equal(store.write({ a: 1 }), true)
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 })
  })
}

test("a file that is there but does not parse throws rather than reading as empty", () => {
  writeFileSync(file, "{ not json")

  assert.throws(() => store.readRaw(), SyntaxError)
})

test("a read error other than a missing file throws", () => {
  // A directory in the file's place: the read fails with EISDIR, which must not
  // be mistaken for "no file yet".
  store.setPath(dir)

  assert.throws(() => store.readRaw(), (err) => err.code === "EISDIR")
})

test("a write creates the directory and ends the file with a newline", () => {
  const nested = join(dir, "nested", "deep", "store.json")
  store.setPath(nested)

  assert.equal(store.write({ a: 1 }), true)
  assert.equal(readFileSync(nested, "utf8"), JSON.stringify({ a: 1 }, null, 2) + "\n")
  rmSync(join(dir, "nested"), { recursive: true, force: true })
})

test("a write that cannot reach the disk reports false", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ a: 1 }))
  chmodSync(file, 0o444)

  assert.equal(store.write({ a: 2 }), false)
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 })
  chmodSync(file, 0o644)
})

test("each store instance keeps its own path", () => {
  const other = createJsonObjectFile("other.json")
  const otherFile = join(dir, "other.json")
  other.setPath(otherFile)

  store.write({ a: 1 })
  other.write({ b: 2 })

  assert.deepEqual(store.readRaw(), { a: 1 })
  assert.deepEqual(other.readRaw(), { b: 2 })
  rmSync(otherFile, { force: true })
})
