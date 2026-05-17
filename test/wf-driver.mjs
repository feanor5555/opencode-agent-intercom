// Drives a structured-workflow test through opencode serve.
// Hybrid: feeds user answers when prompted, otherwise lets the orchestrator
// drive itself via subagent wakes.
// Usage:
//   node test/wf-driver.mjs <baseUrl> <projectDir> <case>
//   case = "ui" | "cli" | "brown"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { Agent, setGlobalDispatcher } from "undici"
// Node's fetch defaults headersTimeout=300s — too short for long-running
// orchestrator turns. Bump to 90 min.
setGlobalDispatcher(new Agent({ headersTimeout: 90 * 60 * 1000, bodyTimeout: 90 * 60 * 1000 }))

const baseUrl = process.argv[2]
const projectDir = process.argv[3]
const useCase = process.argv[4]
if (!baseUrl || !projectDir || !useCase) {
  console.error("usage: node wf-driver.mjs <baseUrl> <projectDir> <case>")
  process.exit(2)
}

const client = createOpencodeClient({ baseUrl })
const u = (r) => (r && typeof r === "object" && "data" in r ? r.data : r)
const textOf = (r) => (u(r)?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")
const STALL_S = 120 // seconds primary must be idle (with no busy children) before we consider it stalled

async function waitUntilStalled(primaryID, maxMs) {
  const t0 = Date.now()
  let stalledSince = null
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 4000))
    const status = u(await client.session.status({ query: { directory: projectDir } })) || {}
    const children = u(await client.session.children({ path: { id: primaryID } })) || []
    const childIDs = new Set(children.map((c) => c.id))
    const primaryBusy = status[primaryID]?.type === "busy"
    const childBusy = children.some((c) => status[c.id]?.type === "busy")
    const elapsed = Math.round((Date.now() - t0) / 1000)
    if (!primaryBusy && !childBusy) {
      stalledSince ??= Date.now()
      const stalledFor = Math.round((Date.now() - stalledSince) / 1000)
      process.stdout.write(`  …idle ${stalledFor}s (elapsed ${elapsed}s, children=${children.length})\r`)
      if (Date.now() - stalledSince >= STALL_S * 1000) {
        process.stdout.write("\n")
        return true
      }
    } else {
      stalledSince = null
      process.stdout.write(`  …busy primary=${primaryBusy} children=${childBusy} (elapsed ${elapsed}s)\r`)
    }
  }
  process.stdout.write("\n  WARN: maxMs reached without stall\n")
  return false
}

async function turn(primaryID, label, text, waitMs = 1500000) { // 25 min default
  console.log(`\n>>> [${label}]`)
  console.log(`    user: ${text.replace(/\n/g, " ")}`)
  const t0 = Date.now()
  const r = await client.session.prompt({
    path: { id: primaryID },
    body: { agent: "orchestrator", parts: [{ type: "text", text }] },
  })
  const dt = ((Date.now() - t0) / 1000).toFixed(0)
  if (r?.error) {
    console.log(`    ERROR after ${dt}s: ${r.error?.data?.message?.split("\n")[0]}`)
    return null
  }
  const reply = textOf(r)
  console.log(`    orch (after ${dt}s): ${reply.slice(0, 500).replace(/\n/g, " ")}${reply.length>500?"…":""}`)
  await waitUntilStalled(primaryID, waitMs)
  return reply
}

function lsTree(dir, depth = 2, prefix = "") {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") && name !== ".git") continue
    if (name === "node_modules") continue
    const full = join(dir, name)
    const st = statSync(full)
    console.log(`  ${prefix}${name}${st.isDirectory() ? "/" : ` (${st.size}B)`}`)
    if (st.isDirectory() && depth > 0 && name !== ".git") lsTree(full, depth - 1, prefix + "  ")
  }
}

function dump(path, maxLines = 60) {
  if (!existsSync(path)) { console.log(`  (missing) ${path}`); return }
  const lines = readFileSync(path, "utf8").split("\n")
  console.log(`--- ${path} (${lines.length} lines) ---`)
  console.log(lines.slice(0, maxLines).join("\n"))
  if (lines.length > maxLines) console.log(`… (+${lines.length-maxLines} more)`)
}

const scripts = {
  // For each case: a list of [label, text] user turns. After each, we wait
  // until the orchestrator+children stall. The orchestrator is expected to
  // drive through multiple phases per turn via subagent wakes.
  ui: [
    ["kickoff",
      "I want to build a TINY project: a single static HTML page that says 'Hello Workflow' centered on the page, styled with one small CSS file. Please use the structured workflow. Drive through ALL phases yourself: clarify, design (skip mockups if you find a UI this trivial doesn't need them), architecture (plain HTML+CSS, NO framework), milestones (1 milestone is enough), tasks, implementation, commit. Use the planner/coder/gitter/reviewer as appropriate. Use git=yes. App name: hello-workflow."],
    ["request review",
      "Now please trigger a reviewer for the milestone-1 review."],
  ],
  uifinish: [
    // Continues an already-built UI project: git init+commit, then review.
    ["finish git + review",
      "The implementation files for milestone 1 are already on disk (index.html, styles.css). AGENTS.md/ARCHITECTURE.md/MILESTONES.md/TODO.md/TODO.md are also there. Two things left: (1) initialize a git repo and commit the milestone-1 work via the `gitter` subagent. (2) Then run a milestone-1 review via the `reviewer` subagent (writes to reviews/review-<iso>.md). Drive both phases yourself."],
  ],
  cli: [
    ["kickoff",
      "Tiny new project: a Python CLI script that adds two numbers given as command-line arguments. Use the structured workflow. Drive through all phases yourself. Settings: app name = addtool, git = NO (skip the gitter phase), UI = NO (skip the design phase). Keep it to ONE milestone with 1-2 tasks. The whole thing is maybe 15 lines of Python."],
  ],
  brown: [
    ["kickoff",
      "This is an existing brownfield project: you can see main.py (a recursive Fibonacci script) and README.md. There is no AGENTS.md yet. Please use the structured workflow, starting with the inventory phase (Phase 0). Do the inventory in small bites — ONE aspect per subagent spawn (e.g. language/frameworks, structure, build/test setup, existing docs). Each phase-0 subagent must write its finding directly into a new AGENTS.md. Stop after inventory is complete (do NOT proceed to phase 1+). Report when AGENTS.md fully reflects the project."],
  ],
}

const script = scripts[useCase]
if (!script) { console.error("unknown case", useCase); process.exit(2) }

console.log(`\n=== Driving "${useCase}" in ${projectDir} via ${baseUrl} ===`)
console.log(`time: ${new Date().toISOString()}`)
const primary = u(await client.session.create({
  body: { title: `wf-test-${useCase}` },
  query: { directory: projectDir },
}))
console.log(`primary session: ${primary.id}`)

for (const [label, text] of script) {
  await turn(primary.id, label, text)
}

console.log("\n=== Project tree ===")
lsTree(projectDir, 3)
console.log("\n=== AGENTS.md ===")
dump(join(projectDir, "AGENTS.md"))
console.log("\n=== ARCHITECTURE.md ===")
dump(join(projectDir, "ARCHITECTURE.md"))
console.log("\n=== MILESTONES.md ===")
dump(join(projectDir, "MILESTONES.md"))
console.log("\n=== TODO.md ===")
dump(join(projectDir, "TODO.md"))
const designs = join(projectDir, "designs")
console.log("\n=== designs/ ===")
if (existsSync(designs)) lsTree(designs, 1)
else console.log("  (none)")
const reviews = join(projectDir, "reviews")
console.log("\n=== reviews/ ===")
if (existsSync(reviews)) {
  lsTree(reviews, 1)
  for (const f of readdirSync(reviews)) dump(join(reviews, f), 40)
} else console.log("  (none)")
console.log("\n=== git log ===")
import("node:child_process").then(({ execSync }) => {
  try { console.log(execSync(`git -C ${projectDir} log --oneline -10 2>&1`).toString()) }
  catch (e) { console.log("  (no git)") }
})

console.log("\n=== DONE", new Date().toISOString(), "===")
