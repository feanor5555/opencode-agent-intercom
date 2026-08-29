// Unit tests for the sidebar's writes to the settings file
// (tui/src/settings-file.ts, ~/.config/opencode/agent-intercom.json).
//
// The sidebar seeds its signals once at mount. Every write therefore re-reads
// the file and merges in only the setting the user just touched, so an edit made
// outside the panel meanwhile is not overwritten with stale state. That holds
// for the endless toggle as much as for a stepped limit: the value it flips is
// the one on disk at that moment.
//
// The context ceiling is the one write that materialises keys: it is a value per
// agent type, so the first edit freezes the budget every listed type has in
// effect into `agentContext` and drops the flat legacy `maxContext` key. What
// that write must not do is change any type's budget while doing so.
//
// Run: node --test test/tui-settings-write.test.js

import test, { beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_AGENT_CONTEXT,
  DEFAULT_ENDLESS_CONTEXT,
  DEFAULT_ENDLESS_MODE,
  DEFAULT_MAX_CONTEXT,
  DEFAULT_MAX_SUBAGENTS,
  readSettings,
  setEndlessMode,
  setSetting,
  setSettingsPath,
  stepAgentContext,
  stepSetting,
  toggleEndlessMode,
} from "../tui/src/settings-file.ts"

const dir = mkdtempSync(join(tmpdir(), "tui-settings-"))
const file = join(dir, "agent-intercom.json")

after(() => rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(file, { force: true })
  setSettingsPath(file)
  // The settings resolve file > env > default; keep the env out of it unless a
  // test puts it there itself.
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS
  delete process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT
  delete process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_MODE
  delete process.env.OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT
})

const onDisk = () => JSON.parse(readFileSync(file, "utf8"))

// The whole state a store call hands back, with every setting the case does not
// name at its built-in default — the panel resolves them all on every write.
// A case that names a maxContext has it from the file unless it says otherwise.
const state = (over = {}) => ({
  maxSubagents: DEFAULT_MAX_SUBAGENTS,
  maxContext: DEFAULT_MAX_CONTEXT,
  maxContextSource: over.maxContext === undefined ? "default" : "file",
  agentContext: {},
  endlessMode: DEFAULT_ENDLESS_MODE,
  endlessContext: DEFAULT_ENDLESS_CONTEXT,
  ...over,
})

// The agent list the sidebar's cycler offers a ceiling step; the freeze covers
// exactly these.
const AGENTS = ["planner", "coder", "researcher"]

// A read-only file is still writable for root, so the failed-write case only
// says anything as an unprivileged user.
const rootSkip = process.getuid?.() === 0 ? "root writes read-only files" : false

test("an external edit between mount and a sidebar write survives that write", () => {
  // Mount: the panel reads the file once and keeps that copy in its signals.
  writeFileSync(file, JSON.stringify({ maxSubagents: 2, maxContext: 40000 }))
  const atMount = readSettings()
  assert.deepEqual(atMount, state({ maxSubagents: 2, maxContext: 40000 }))

  // Someone edits the file while the sidebar is open: the other limit, plus a
  // key this TUI knows nothing about.
  writeFileSync(
    file,
    JSON.stringify({ maxSubagents: 2, maxContext: 90000, searxngUrl: "http://host:8080" }),
  )

  // The user presses + on the subagent cap.
  const merged = setSetting("maxSubagents", 3)

  assert.deepEqual(merged, state({ maxSubagents: 3, maxContext: 90000 }))
  // The file keeps the foreign key, and the signals agree with it.
  assert.deepEqual(onDisk(), {
    maxSubagents: 3,
    maxContext: 90000,
    searxngUrl: "http://host:8080",
  })
})

test("stepping one limit materialises no key that is absent from the file", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))

  const merged = setSetting("endlessContext", 300000)

  assert.deepEqual(Object.keys(onDisk()), ["maxContext", "endlessContext"])
  assert.equal("maxSubagents" in onDisk(), false)
  // The signal still shows the default for the limit the file does not carry.
  assert.deepEqual(merged, state({ maxContext: 90000, endlessContext: 300000 }))
})

test("a limit absent from the file resolves from the env, and is not written", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"
  writeFileSync(file, JSON.stringify({ maxSubagents: 2 }))

  const merged = setSetting("maxSubagents", 4)

  assert.deepEqual(
    merged,
    state({ maxSubagents: 4, maxContext: 70000, maxContextSource: "env" }),
  )
  assert.deepEqual(onDisk(), { maxSubagents: 4 })
})

test("a missing file is treated as empty and written fresh", () => {
  assert.equal(existsSync(file), false)

  const merged = setSetting("maxSubagents", 3)

  assert.deepEqual(onDisk(), { maxSubagents: 3 })
  assert.deepEqual(merged, state({ maxSubagents: 3 }))
})

test("an unparsable file is left alone rather than replaced", () => {
  // The file is hand-edited and the only home of keys this TUI never displays;
  // one stray character must not cost the user those keys.
  writeFileSync(file, '{ "maxContext": 50000, "exaApiKey": "secret",')
  const before = readFileSync(file, "utf8")

  const merged = setSetting("maxSubagents", 2)

  assert.equal(readFileSync(file, "utf8"), before)
  // The panel keeps showing what the plugin runs on for such a file.
  assert.deepEqual(merged, state())
})

test("a step starts from the value the file holds, not from the panel's copy", () => {
  // Mount: the panel reads 40000 into its signal.
  writeFileSync(file, JSON.stringify({ endlessContext: 40000 }))
  assert.equal(readSettings().endlessContext, 40000)

  // Raised outside the panel while the sidebar still shows 40000.
  writeFileSync(file, JSON.stringify({ endlessContext: 90000 }))

  const merged = stepSetting("endlessContext", 10000)

  assert.equal(merged.endlessContext, 100000)
  assert.deepEqual(onDisk(), { endlessContext: 100000 })
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
  assert.deepEqual(merged, state({ maxSubagents: 2, maxContext: 90000 }))
  chmodSync(file, 0o644)
})

test("an invalid value in the file is dropped by the next write", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: -1, maxContext: "lots" }))

  const merged = setSetting("maxSubagents", 0)

  assert.deepEqual(merged, state({ maxSubagents: 0 }))
  // A value the plugin rejects would otherwise sit in the file for good while
  // the panel shows the env-or-default one instead.
  assert.deepEqual(onDisk(), { maxSubagents: 0 })
})

test("the endless threshold steps like the other limits and is written alone", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))

  const merged = stepSetting("endlessContext", 10000)

  // Stepped from the env-or-default resolution, and only that key is written.
  assert.equal(merged.endlessContext, DEFAULT_ENDLESS_CONTEXT + 10000)
  assert.deepEqual(onDisk(), {
    maxContext: 90000,
    endlessContext: DEFAULT_ENDLESS_CONTEXT + 10000,
  })
})

test("setEndlessMode writes only its own key and leaves the rest as it found it", () => {
  writeFileSync(
    file,
    JSON.stringify({
      maxSubagents: 2,
      maxContext: 90000,
      searxngUrl: "http://host:8080",
      endlessQuiesceTimeoutMs: 600000,
    }),
  )

  const merged = setEndlessMode(true)

  assert.deepEqual(merged, state({ maxSubagents: 2, maxContext: 90000, endlessMode: true }))
  assert.deepEqual(onDisk(), {
    maxSubagents: 2,
    maxContext: 90000,
    searxngUrl: "http://host:8080",
    endlessQuiesceTimeoutMs: 600000,
    endlessMode: true,
  })
})

test("a file without endlessMode reads false and keeps the key absent until toggled", () => {
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))
  assert.equal(readSettings().endlessMode, false)
  assert.equal("endlessMode" in onDisk(), false)

  const merged = toggleEndlessMode()

  assert.equal(merged.endlessMode, true)
  assert.deepEqual(onDisk(), { maxContext: 90000, endlessMode: true })
})

test("the toggle flips the value the file holds, not the panel's copy", () => {
  // Mount: the panel reads "on" into its signal.
  writeFileSync(file, JSON.stringify({ endlessMode: true }))
  assert.equal(readSettings().endlessMode, true)

  // Switched off outside the panel — by hand, or by the plugin's own bounds.
  writeFileSync(file, JSON.stringify({ endlessMode: false }))

  const merged = toggleEndlessMode()

  // A flip of the panel's stale copy would have written false a second time.
  assert.equal(merged.endlessMode, true)
  assert.deepEqual(onDisk(), { endlessMode: true })
})

test("stepping a limit does not delete the boolean beside it", () => {
  // The trap the per-key validators exist for: endlessMode is not an integer,
  // so a merge that pruned every key by the limit rule would drop it here.
  setEndlessMode(true)
  assert.deepEqual(onDisk(), { endlessMode: true })

  const merged = stepSetting("endlessContext", 10000)

  assert.deepEqual(
    merged,
    state({ endlessContext: DEFAULT_ENDLESS_CONTEXT + 10000, endlessMode: true }),
  )
  assert.deepEqual(onDisk(), {
    endlessMode: true,
    endlessContext: DEFAULT_ENDLESS_CONTEXT + 10000,
  })
})

test("an endlessMode the plugin rejects is dropped by the next write", () => {
  // "true" is a string: the plugin leaves the default standing and the panel
  // would otherwise keep displaying false against a file that looks switched on.
  writeFileSync(file, JSON.stringify({ endlessMode: "true", maxSubagents: 2 }))

  const merged = setSetting("maxSubagents", 3)

  assert.deepEqual(merged, state({ maxSubagents: 3 }))
  assert.deepEqual(onDisk(), { maxSubagents: 3 })
})

test("a toggle that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ endlessMode: false, maxContext: 90000 }))
  chmodSync(file, 0o444)

  const merged = toggleEndlessMode()

  assert.deepEqual(onDisk(), { endlessMode: false, maxContext: 90000 })
  assert.deepEqual(merged, state({ endlessMode: false, maxContext: 90000 }))
  chmodSync(file, 0o644)
})

test("the first ceiling edit freezes every listed agent and drops the flat key", () => {
  // A file from before the per-agent scheme: one flat number governing all.
  writeFileSync(
    file,
    JSON.stringify({ maxContext: 90000, searxngUrl: "http://host:8080" }),
  )

  const merged = stepAgentContext("coder", 5000, AGENTS)

  // Every listed type keeps the budget it had; only the stepped one moves. The
  // flat key is gone, and the foreign key is untouched.
  const frozen = { planner: 90000, coder: 95000, researcher: 90000 }
  assert.deepEqual(onDisk(), {
    searxngUrl: "http://host:8080",
    agentContext: frozen,
  })
  assert.equal("maxContext" in onDisk(), false)
  assert.deepEqual(merged, state({ agentContext: frozen }))
})

test("with no flat key the freeze takes each type's built-in default", () => {
  const merged = stepAgentContext("coder", 5000, AGENTS)

  const frozen = {
    planner: DEFAULT_AGENT_CONTEXT.planner,
    coder: DEFAULT_AGENT_CONTEXT.coder + 5000,
    researcher: DEFAULT_AGENT_CONTEXT.researcher,
  }
  assert.deepEqual(onDisk(), { agentContext: frozen })
  assert.deepEqual(merged, state({ agentContext: frozen }))
})

test("the freeze takes the env value where that is what governs", () => {
  process.env.OPENCODE_AGENT_INTERCOM_MAX_CONTEXT = "70000"

  stepAgentContext("coder", 5000, AGENTS)

  assert.deepEqual(onDisk(), {
    agentContext: { planner: 70000, coder: 75000, researcher: 70000 },
  })
})

test("an agent the cycler does not list keeps its own entry", () => {
  writeFileSync(file, JSON.stringify({ agentContext: { "project-agent": 25000 } }))

  stepAgentContext("coder", 5000, AGENTS)

  assert.equal(onDisk().agentContext["project-agent"], 25000)
})

test("a ceiling step starts from the value the file holds for that agent", () => {
  // Mount: the panel reads 60000 into its signal.
  writeFileSync(file, JSON.stringify({ agentContext: { coder: 60000 } }))
  assert.equal(readSettings().agentContext.coder, 60000)

  // Raised outside the panel while the sidebar still shows 60000.
  writeFileSync(file, JSON.stringify({ agentContext: { coder: 100000 } }))

  const merged = stepAgentContext("coder", 5000, ["coder"])

  assert.equal(merged.agentContext.coder, 105000)
  assert.deepEqual(onDisk(), { agentContext: { coder: 105000 } })
})

test("0 is reachable and stays in the file as the disabling value", () => {
  writeFileSync(file, JSON.stringify({ agentContext: { coder: 5000 } }))

  const merged = stepAgentContext("coder", -5000, ["coder"])

  assert.deepEqual(onDisk(), { agentContext: { coder: 0 } })
  assert.equal(merged.agentContext.coder, 0)
})

test("a step below zero drops the agent's entry and leaves the others", () => {
  writeFileSync(file, JSON.stringify({ agentContext: { planner: 40000, coder: 0 } }))

  const merged = stepAgentContext("coder", -5000, ["planner", "coder"])

  // coder falls back to its built-in default; the entry beside it is untouched.
  assert.deepEqual(onDisk(), { agentContext: { planner: 40000 } })
  assert.deepEqual(merged, state({ agentContext: { planner: 40000 } }))
})

test("dropping the last entry drops the whole map rather than leaving it empty", () => {
  writeFileSync(file, JSON.stringify({ maxSubagents: 2, agentContext: { coder: 0 } }))

  stepAgentContext("coder", -5000, ["coder"])

  assert.deepEqual(onDisk(), { maxSubagents: 2 })
})

test("a malformed entry in the map is dropped by a ceiling write", () => {
  writeFileSync(
    file,
    JSON.stringify({ agentContext: { coder: 60000, planner: "lots" } }),
  )

  stepAgentContext("coder", 5000, ["coder"])

  // planner is not written back as a string; the freeze does not cover it
  // either, since the cycler list of this case is coder alone.
  assert.deepEqual(onDisk(), { agentContext: { coder: 65000 } })
})

test("an unparsable file is left alone by a ceiling step", () => {
  writeFileSync(file, '{ "maxContext": 50000, "exaApiKey": "secret",')
  const before = readFileSync(file, "utf8")

  const merged = stepAgentContext("coder", 5000, AGENTS)

  assert.equal(readFileSync(file, "utf8"), before)
  assert.deepEqual(merged, state())
})

test("a ceiling write that cannot reach the disk leaves the panel on the file's state", { skip: rootSkip }, () => {
  writeFileSync(file, JSON.stringify({ maxContext: 90000 }))
  chmodSync(file, 0o444)

  const merged = stepAgentContext("coder", 5000, AGENTS)

  assert.deepEqual(onDisk(), { maxContext: 90000 })
  assert.deepEqual(merged, state({ maxContext: 90000 }))
  chmodSync(file, 0o644)
})
