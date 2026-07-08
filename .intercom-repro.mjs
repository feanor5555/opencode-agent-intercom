// Force denial-heavy flow to exercise the rewritePendingTools fix.
// Asks the orchestrator to call list() twice in a row right after spawn —
// guardToolExecute denies the second call, producing a pending tool part.
// Without the fix that pending part lands as messages[-1] in the next provider
// call and llama with enable_thinking rejects it. With the fix, it should be
// rewritten to completed-with-denial and the request succeeds.
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Agent, setGlobalDispatcher } from "undici"

setGlobalDispatcher(new Agent({ headersTimeout: 90 * 60 * 1000, bodyTimeout: 90 * 60 * 1000 }))

const baseUrl = process.argv[2] || "http://localhost:4567"
const client = createOpencodeClient({ baseUrl })
const u = (r) => (r && typeof r === "object" && "data" in r ? r.data : r)
const textOf = (r) => (u(r)?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")

const primary = u(await client.session.create({
  body: { title: "force-denial-repro" },
  query: { directory: "/home/wu/echomodus" },
}))
console.log("primary session:", primary.id)

const prompt = [
  "TEST TASK — follow exactly:",
  "1. Call spawn(agent=\"researcher\", prompt=\"name one Java 21 feature\", description=\"t1\").",
  "2. Immediately call list() to see active subagents.",
  "3. Immediately call list() AGAIN (yes, twice in a row — this is the test).",
  "4. Then end your turn and wait for the researcher to wake you.",
  "5. After it wakes you, reply with exactly \"DONE\".",
].join("\n")

console.log(">>> sending denial-heavy prompt")
const t0 = Date.now()
const r = await client.session.prompt({
  path: { id: primary.id },
  body: {
    agent: "orchestrator",
    parts: [{ type: "text", text: prompt }],
  },
})
const dt = ((Date.now() - t0) / 1000).toFixed(0)
if (r?.error) {
  console.log(`PROMPT ERROR after ${dt}s:`, r.error?.data?.message?.split("\n")[0])
  process.exit(1)
}
console.log(`orchestrator reply after ${dt}s:`)
console.log(textOf(r).slice(0, 1500))
console.log("\n>>> done; primary:", primary.id)
