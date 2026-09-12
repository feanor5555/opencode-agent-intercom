// The panel's abort has to leave a line in the debug log.
//
// Every server-side abort path logs — the `abort` tool, the watchdog reap, the
// teardown helper — and the sidebar's own abort did not: a toast was its whole
// trace, and it is gone the moment the user looks away. A live incident then
// could not settle who ended a subagent, or from which of the three gestures
// the panel offers.
//
// The line is written where the abort is really ISSUED (`abortSubagent`), not
// where it is asked for (`requestAbort`): the first request only arms the
// confirmation, and a line there would report an abort that never happened.
//
// tui.tsx carries JSX and cannot be imported by `node --test`, so the panel
// half is pinned against its source, the same way the route tests do it. The
// trigger vocabulary is a real module (tui/src/abort-arming.ts) and is imported.
//
// Run: node --test test/tui-abort-log.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { ABORT_TRIGGERS } from "../tui/src/abort-arming.ts"

const source = readFileSync(
  fileURLToPath(new URL("../tui/src/tui.tsx", import.meta.url)),
  "utf8",
)

function bodyOf(marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `marker not in tui.tsx: ${marker}`)
  assert.equal(source.indexOf(marker, start + 1), -1, `marker occurs twice: ${marker}`)
  const end = source.indexOf("\n  };", start)
  assert.notEqual(end, -1, `no end found for: ${marker}`)
  return source.slice(start, end)
}

// ---- the vocabulary ----------------------------------------------------------

test("the three entry points the panel offers each have a name", () => {
  assert.deepEqual([...ABORT_TRIGGERS], ["row", "key", "command"])
})

// ---- the line ----------------------------------------------------------------

test("the abort writes one debug line naming session, agent and trigger", () => {
  const body = bodyOf("const abortSubagent = async (")
  assert.match(body, /debugLog\("tui abort issued", \{/)
  for (const field of [
    /sessionID: id,/,
    /handle: entry\?\.handle \?\? null,/,
    /agent: entry\?\.agent \?\? null,/,
    /status: entry\?\.status \?\? null,/,
    /trigger,/,
  ]) {
    assert.match(body, field)
  }
  assert.ok(
    body.indexOf('debugLog("tui abort issued"') < body.indexOf("api.client.session.abort("),
    "the line is written whether or not the request succeeds",
  )
  assert.match(source, /import \{ debugLog \} from "\.\/debug-log\.ts";/)
})

test("a refused abort says so on the same channel", () => {
  const body = bodyOf("const abortSubagent = async (")
  assert.match(body, /debugLog\("tui abort request failed", \{ sessionID: id, trigger \}\);/)
})

test("ending a retention from the panel is logged too", () => {
  // The cross on a held row deletes instead of aborting. It is the same gesture
  // and the same question afterwards — who ended this subagent.
  const body = bodyOf("const dropRetained = async (")
  assert.match(body, /debugLog\("tui retention drop issued", \{/)
  assert.match(body, /trigger,/)
  assert.ok(
    body.indexOf('debugLog("tui retention drop issued"') <
      body.indexOf("api.client.session.delete("),
    "written before the request goes out",
  )
})

// ---- the trigger reaches it from all three entry points ----------------------

test("the request carries the trigger through to the issue", () => {
  assert.match(source, /const requestAbort = \(id: string, trigger: AbortTrigger\): void => \{/)
  assert.match(bodyOf("const requestAbort = ("), /void abortSubagent\(id, trigger\);/)
  assert.match(bodyOf("const abortSubagent = async ("), /await dropRetained\(id, trigger\);/)
})

test("each entry point names itself, and each name is one of the three", () => {
  const callers = [
    // The command palette entry goes straight at requestAbort.
    [bodyOf("const abortSelected = (): void => {"), /requestAbort\(id, "(\w+)"\)/],
    // The panel's own key handler and the row's cross reach it through onAbort.
    [bodyOf("const handleKeyDown = (event: KeyEvent): void => {"), /props\.onAbort\(id, "(\w+)"\)/],
    [
      bodyOf("const abortThis = (): void => {"),
      /props\.onAbort\(rowProps\.entry\.sessionID, "(\w+)"\)/,
    ],
  ]
  const used = callers.map(([body, pattern]) => {
    const match = pattern.exec(body)
    assert.ok(match, `no trigger passed: ${pattern}`)
    assert.ok(
      ABORT_TRIGGERS.includes(match[1]),
      `${match[1]} is not one of ${ABORT_TRIGGERS.join(", ")}`,
    )
    return match[1]
  })
  assert.deepEqual(
    [...used].sort(),
    [...ABORT_TRIGGERS].sort(),
    "the three gestures stay tellable apart in the log",
  )
})

test("the prop the panel is handed asks for the trigger", () => {
  assert.match(source, /onAbort: \(id: string, trigger: AbortTrigger\) => void;/)
  // Nothing may reach the abort without naming its gesture.
  const bare = source.match(/onAbort\((?![^)]*,)[^)]*\)/g) ?? []
  assert.deepEqual(bare, [], `an abort with no trigger: ${bare.join(", ")}`)
})
