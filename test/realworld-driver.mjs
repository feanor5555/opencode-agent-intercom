// Manual real-world smoke test — NOT part of `npm test`.
// Requires a running `opencode serve` with this plugin loaded.
//   node test/realworld-driver.mjs [baseUrl]
import { createOpencodeClient } from "@opencode-ai/sdk"

const baseUrl = process.argv[2] || "http://localhost:4630"
const client = createOpencodeClient({ baseUrl })
const u = (r) => (r && typeof r === "object" && "data" in r ? r.data : r)
const textOf = (r) => (u(r)?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")

const primary = u(await client.session.create({ body: { title: "intercom realworld" } }))
console.log("primary session:", primary.id)

console.log("\n>>> ask orchestrator to call spawn ...")
const r1 = await client.session.prompt({
  path: { id: primary.id },
  body: {
    agent: "orchestrator",
    parts: [{
      type: "text",
      text: 'Call the `spawn` tool once: agent="researcher", prompt="Count slowly from 1 to 30, one number per line, pausing between each.". Then stop and report the handle it returned.',
    }],
  },
})
if (r1?.error) { console.log("PROMPT ERROR:", r1.error?.data?.message?.split("\n")[0]); process.exit(1) }
console.log("reply:", textOf(r1).slice(0, 400))

const children = u(await client.session.children({ path: { id: primary.id } }))
console.log("child sessions:", children.map((c) => c.id))
if (!children.length) { console.log("NO CHILD SPAWNED"); process.exit(1) }
const childID = children[0].id

console.log("\n>>> ask orchestrator to abort the subagent ...")
const r2 = await client.session.prompt({
  path: { id: primary.id },
  body: {
    agent: "orchestrator",
    parts: [{
      type: "text",
      text: `Call abort once: subagent="${childID}". Report the output.`,
    }],
  },
})
if (r2?.error) { console.log("PROMPT ERROR:", r2.error?.data?.message?.split("\n")[0]); process.exit(1) }
console.log("reply:", textOf(r2).slice(0, 700))
console.log("\n>>> done")
