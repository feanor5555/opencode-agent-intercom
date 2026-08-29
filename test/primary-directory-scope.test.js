// Unit tests for the primary session's held project scope in registry.js:
//
//   - rememberPrimaryDirectory writes it once and answers with what is held
//   - primaryDirectoryOf reads it and writes nothing
//
// The two are deliberately separate operations. The transform resolves a
// directory per turn and may write; every other caller — the event path — may
// only read, because it has no answer of `getSessionDirectory` to offer and a
// write from there could bind the session to a scope the transform never saw.
//
// Tests import ONLY state.js and registry.js — never hooks.js or client.js,
// because importing those starts long-lived plugin handles that keep
// `node --test` from exiting.
//
// Run: node --test test/primary-directory-scope.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { primaryDirectory } from "../src/state.js"
import { rememberPrimaryDirectory, primaryDirectoryOf, forgetPrimary } from "../src/registry.js"

beforeEach(() => {
  primaryDirectory.clear()
})

test("primaryDirectoryOf answers null until a turn has resolved a directory", () => {
  assert.equal(primaryDirectoryOf("ses_1"), null, "nothing held yet")
  assert.equal(primaryDirectory.size, 0, "and the read left no entry behind")

  rememberPrimaryDirectory("ses_1", "/proj")
  assert.equal(primaryDirectoryOf("ses_1"), "/proj")
})

test("primaryDirectoryOf is a read, not a write", () => {
  // The event path calls it on every primary idle. Ten reads of an unknown
  // session may not grow the map, and a read may not fix a scope.
  for (let i = 0; i < 10; i++) assert.equal(primaryDirectoryOf("ses_unknown"), null)
  assert.equal(primaryDirectory.size, 0)

  // The transform's write is still the one that decides the scope afterwards.
  assert.equal(rememberPrimaryDirectory("ses_unknown", "/proj"), "/proj")
  assert.equal(primaryDirectoryOf("ses_unknown"), "/proj")
})

test("primaryDirectoryOf refuses an unusable session id instead of guessing", () => {
  rememberPrimaryDirectory("ses_1", "/proj")
  assert.equal(primaryDirectoryOf(""), null)
  assert.equal(primaryDirectoryOf(undefined), null)
  assert.equal(primaryDirectoryOf(null), null)
  assert.equal(primaryDirectoryOf(7), null)
  assert.equal(primaryDirectoryOf({}), null)
})

test("the held scope survives a turn that resolved nothing, and dies with the session", () => {
  rememberPrimaryDirectory("ses_1", "/proj")
  // A `session.get` that failed answers undefined; the scope must not collapse.
  assert.equal(rememberPrimaryDirectory("ses_1", undefined), "/proj")
  assert.equal(rememberPrimaryDirectory("ses_1", "/somewhere-else"), "/proj", "written once")
  assert.equal(primaryDirectoryOf("ses_1"), "/proj")

  forgetPrimary("ses_1")
  assert.equal(primaryDirectoryOf("ses_1"), null, "pruned with the session")
})

test("two primaries hold their own scopes", () => {
  rememberPrimaryDirectory("ses_a", "/project-a")
  rememberPrimaryDirectory("ses_b", "/project-b")
  assert.equal(primaryDirectoryOf("ses_a"), "/project-a")
  assert.equal(primaryDirectoryOf("ses_b"), "/project-b")
})
