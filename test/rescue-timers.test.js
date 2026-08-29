// Regression test for rescue timers that resolve promises awaited by a bare
// Node process. The timers must keep the event loop alive until their bounded
// fallback settles the promise; settlement clears each timer afterward.

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const teardownURL = new URL("../src/teardown.js", import.meta.url).href
const childwaitURL = new URL("../src/childwait.js", import.meta.url).href

test("rescue timers hold a bare Node process open until their promises settle, and release it then", () => {
  const script = `
    import { waitForSessionQuiescence } from ${JSON.stringify(teardownURL)}
    import { registerChildWaiter, settleChildWaiter } from ${JSON.stringify(childwaitURL)}

    const quiescence = await waitForSessionQuiescence("ses_quiescence", 20)
    if (quiescence !== "timeout") {
      throw new Error("quiescence result: " + quiescence)
    }

    const waiter = await registerChildWaiter(
      "ses_child",
      "ses_parent",
      { timeoutMs: 20 },
    )
    if (waiter.status !== "expired") {
      throw new Error("waiter result: " + waiter.status)
    }

    // The other half: a waiter that settles NORMALLY. Its rescue timer is ref'd
    // and 30 s out, so the assertion is this process EXITING — awaiting the
    // promise says nothing, since settle resolves it either way. With the
    // clearTimeout inside settle gone, the loop stays alive for those 30 s and
    // the 5 s spawnSync timeout below kills the run.
    const early = registerChildWaiter(
      "ses_early",
      "ses_parent",
      { timeoutMs: 30_000 },
    )
    settleChildWaiter("ses_early", { reason: "completed" })
    const ended = await early
    if (ended.status !== "ended") {
      throw new Error("settled waiter result: " + ended.status)
    }
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
})
