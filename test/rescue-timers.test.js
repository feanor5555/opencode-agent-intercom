// Regression test for rescue timers that resolve promises awaited by a bare
// Node process. The timers must keep the event loop alive until their bounded
// fallback settles the promise; settlement clears each timer afterward.

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const teardownURL = new URL("../src/teardown.js", import.meta.url).href
const childwaitURL = new URL("../src/childwait.js", import.meta.url).href

test("rescue timers keep a bare Node process alive until their promises settle", () => {
  const script = `
    import { waitForSessionQuiescence } from ${JSON.stringify(teardownURL)}
    import { registerChildWaiter } from ${JSON.stringify(childwaitURL)}

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
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
})
