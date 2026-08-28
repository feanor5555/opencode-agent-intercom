// Unit tests for the sidebar's writes to the settings file
// (tui/src/settings-file.ts, ~/.config/opencode/agent-intercom.json).
//
// The sidebar seeds its two limit signals once at mount. Every write therefore
// re-reads the file and merges in only the limit the user just stepped, so an
// edit made outside the panel meanwhile is not overwritten with stale state.
//
// Run: node --test test/tui-settings-write.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS,
  readSettings,
  setSetting,
  setSettingsPath,
  stepSetting,
} from "../tui/src/settings-file.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-settings-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setSettingsPath(file)
  // The limits resolve file > env > default; keep the env out of it unless a
  // test puts it there itself.
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
})

const onDisk = () => JSON.parse(readFileSync(file, "utf8"))

// A read-only file is still writable for root, so the failed-write case only
// says anything as an unprivileged user.
const rootSkip = process.getuid?.() === 0 ? "root writes read-only files" : false

test("an external edit between mount and a sidebar write survives that write", () => {
  // Mount: the panel reads the file once and keeps that copy in its signals.
  writeFileSync(file, JSON.stringify({ maxSubagents: 2, maxContext: 40000 }))
  const atMount = readSettings()
  assert.deepEqual(atMount, { maxSubagents: 2, maxContext: 40000 })

  // Someone edits the file while the sidebar is open: the other limit, plus a
  // key this TUI knows nothing about.
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: 2, maxContext: 90000, searxngUrl: "http://host:8080" }),
  )

  // The user presses + on the subagent cap.
  const merged = setSetting("maxSubagents", 3)

  assert.deepEqual(merged, { maxSubagents: 3, maxContext: 90000 })
  // The file keeps the foreign key, and the signals agree with it.
  assert.deepEqual(onDisk(), {
    maxSubagents: 3,
    maxContext: 90000,
    searxngUrl: "http://host:8080",
  })
})

test("stepping one limit materialises no key that is absent from the file", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))

  const merged = setSetting("maxContext", 95000)

  assert.deepEqual(Object.keys(onDisk()), ["maxContext"])
  assert.equal("maxSubagents" in onDisk(), false)
  // The signal still shows the default for the limit the file does not carry.
  assert.deepEqual(merged, { maxSubagents: DEFAULT_MAX_SUBAGENTS, maxContext: 95000 })
})

test("a limit absent from the file resolves from the env, and is not written", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  writeFileSync(file, JSON.stringify({ maxSubagents: 2 }))

  const merged = setSetting("maxSubagents", 4)

  assert.deepEqual(merged, { maxSubagents: 4, maxContext: 70000 })
  assert.deepEqual(onDisk(), { maxSubagents: 4 })
})

test("a missing file is treated as empty and written fresh", () => {
  assert.equal(existsSync(file), false)

  const merged = setSetting("maxSubagents", 3)

  assert.deepEqual(onDisk(), { maxSubagents: 3 })
  assert.deepEqual(merged, { maxSubagents: 3, maxContext: DEFAULT_MAX_CONTEXT })
})

test("an unparsable file is left alone rather than replaced", () => {
  // The file is hand-edited and the only home of keys this TUI never displays;
  // one stray character must not cost the user those keys.
  writeFileSync(file, '{ "maxContext": 50000, "exaApiKey": "secret",')
  const before = readFileSync(file, "utf8")

  const merged = setSetting("maxContext", 50000)

  assert.equal(readFileSync(file, "utf8"), before)
  // The panel keeps showing what the plugin runs on for such a file.
  assert.deepEqual(merged, {
    maxSubagents: DEFAULT_MAX_SUBAGENTS,
    maxContext: DEFAULT_MAX_CONTEXT,
  })
})

test("a step starts from the value the file holds, not from the panel's copy", () => {
  // Mount: the panel reads 40000 into its signal.
  writeFileSync(file, JSON.stringify({ maxContext: 40000 }))
  assert.equal(readSettings().maxContext, 40000)

  // Raised outside the panel while the sidebar still shows 40000.
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))

  const merged = stepSetting("maxContext", 5000)

  assert.equal(merged.maxContext, 95000)
  assert.deepEqual(onDisk(), { maxContext: 95000 })
})

test("a step clamps at the floor it is given", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 0 }))

  const merged = stepSetting("maxSubagents", -1, 0)

  assert.equal(merged.maxSubagents, 0)
  assert.deepEqual(onDisk(), { maxSubagents: 0 })
})

test("a write that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 2, maxContext: 90000 }))
  chmodSync(file, 0o444)

  const merged = setSetting("maxSubagents", 5)

  assert.deepEqual(onDisk(), { maxSubagents: 2, maxContext: 90000 })
  assert.deepEqual(merged, { maxSubagents: 2, maxContext: 90000 })
  chmodSync(file, 0o644)
})

test("an invalid value in the file is dropped by the next write", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: -1, maxContext: "lots" }))

  const merged = setSetting("maxSubagents", 0)

  assert.deepEqual(merged, { maxSubagents: 0, maxContext: DEFAULT_MAX_CONTEXT })
  // A value the plugin rejects would otherwise sit in the file for good while
  // the panel shows the env-or-default one instead.
  assert.deepEqual(onDisk(), { maxSubagents: 0 })
})
