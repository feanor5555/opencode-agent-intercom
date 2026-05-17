// Quick sanity probe: create session in /tmp/wf-test-ui, send one prompt, dump reply + child sessions.
import { createOpencodeClient } from "@opencode-ai/sdk"
const baseUrl = process.argv[2] || "http://127.0.0.1:4567"
const dir = process.argv[3] || "/tmp/wf-test-ui"
const client = createOpencodeClient({ baseUrl })
const u = (r) => (r && typeof r === "object" && "data" in r ? r.data : r)

const sess = u(await client.session.create({ body: { title: "probe" }, query: { directory: dir } }))
console.log("session:", sess.id, "dir:", dir)
console.log("sending prompt …")
const t0 = Date.now()
const r = await client.session.prompt({
  path: { id: sess.id },
  body: {
    agent: "orchestrator",
    parts: [{ type: "text", text: "Say the word HELLO and stop." }],
  },
})
const dt = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`took ${dt}s`)
if (r?.error) {
  console.log("ERROR:", r.error?.data?.message?.split("\n").slice(0, 5).join("\n"))
} else {
  const parts = u(r)?.parts ?? []
  console.log("part types:", parts.map((p) => p.type).join(","))
  for (const p of parts) {
    if (p.type === "text") console.log("TEXT:", p.text.slice(0, 400))
    if (p.type === "tool") console.log("TOOL:", p.tool, p.state?.status, p.state?.output?.slice?.(0, 200) ?? "")
  }
}
const children = u(await client.session.children({ path: { id: sess.id } }))
console.log("children:", children.map((c) => c.id).join(",") || "(none)")
