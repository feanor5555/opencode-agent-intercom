// End-to-end test for the TODO.md auto-tracking feature.
//
// Drives a real `opencode serve` instance through the full spawn → subagent
// runs → DONE-marker → wake-hook → TODO.md tick cycle, then verifies the file
// on disk. Same harness style as e2e/multi-task.sh but written in JS so we can
// inspect the TODO.md state programmatically.
//
// Prereqs:
//   - opencode serve running (port from arg, default 4567), with THIS plugin
//     loaded — see CLAUDE.md "lokaler file:-Pointer wirkt nur, wenn man IM
//     Projekt mit dem Pointer arbeitet": start `opencode serve` from
//     /home/wu/echomodus (its opencode.json has the file: pointer).
//   - A local LLM reachable (the test uses whatever omnicoder /v1 endpoint
//     opencode detected). Single-spawn turns; budget ~5-15 min wall-clock per
//     scenario depending on the model.
//
// Usage:
//   node test/e2e/todo-driver.mjs [baseUrl] [projectDir]
//   defaults: http://localhost:4567   /tmp/intercom-todo-e2e-<ts>
//
// Exit code 0 = all scenarios passed; 1 = any failure.

import { createOpencodeClient } from "@opencode-ai/sdk"
import { Agent, setGlobalDispatcher } from "undici"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

setGlobalDispatcher(new Agent({ headersTimeout: 30 * 60 * 1000, bodyTimeout: 30 * 60 * 1000 }))

const baseUrl = process.argv[2] || "http://localhost:4567"
const projectDir =
  process.argv[3] || mkdtempSync(join(tmpdir(), "intercom-todo-e2e-"))

const client = createOpencodeClient({ baseUrl })
const u = (r) => (r && typeof r === "object" && "data" in r ? r.data : r)
const textOf = (r) =>
  (u(r)?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n")

// Tasks chosen so the subagent doesn't need to call write/edit/bash to
// "do" them — the test exercises the wake-hook auto-tick path, not the
// model's tool use. Each spawn prompt instructs the coder to emit ONLY the
// marker line; the actual task text is just decoration.
const TODO_SEED = `# TODO

## Milestone 1

- [ ] T1. Verify the project context auto-prepended to the spawn prompt
    accept: subagent reports DONE: T1 on the first line

- [ ] T2. Attempt a deliberately impossible task to test the BLOCKED path
    accept: subagent reports BLOCKED: T2 with a one-line reason

## Review-Findings

- [ ] R1. (placeholder for review pass)
    accept: review run complete
`

function writeTodo() {
  writeFileSync(join(projectDir, "TODO.md"), TODO_SEED)
}

// Headless opencode hangs on every tool that defaults to "ask" because there
// is no one to approve — write/edit/bash/webfetch all sit in state=running
// until a 3-minute timeout. Pre-authorise everything in the test project so
// the coder/planner can actually do their work.
function writePermissiveConfig() {
  writeFileSync(
    join(projectDir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: ["file:/home/wu/opencode-agent-intercom"],
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
        },
      },
      null,
      2,
    ),
  )
}

function readTodo() {
  return readFileSync(join(projectDir, "TODO.md"), "utf8")
}

// Wait until every subagent spawned by this primary has finished and been
// destroyed (one-shot lifecycle: the plugin's wake-hook deletes the session
// after delivering the wake-notice, so `session.children` returning [] means
// all work is done). If no spawn happened within NO_SPAWN_TIMEOUT_S, return —
// the orch turn completed without dispatching anything (e.g. refusal).
const NO_SPAWN_TIMEOUT_S = 15
const POST_GONE_GRACE_MS = 3000

async function waitForChildrenGone(primaryID, maxMs = 20 * 60 * 1000) {
  const t0 = Date.now()
  let sawSpawn = false
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 3000))
    const children = u(await client.session.children({ path: { id: primaryID } })) || []
    const elapsed = Math.round((Date.now() - t0) / 1000)
    if (children.length > 0) sawSpawn = true
    process.stdout.write(
      `    …children=${children.length} (elapsed ${elapsed}s${sawSpawn ? ", saw spawn" : ""})\r`,
    )
    if (sawSpawn && children.length === 0) {
      // Tiny grace for the plugin's post-delete wake notice to land on the orch.
      await new Promise((r) => setTimeout(r, POST_GONE_GRACE_MS))
      process.stdout.write("\n")
      return true
    }
    if (!sawSpawn && elapsed > NO_SPAWN_TIMEOUT_S) {
      process.stdout.write("\n    (no spawn within grace window — orch turn ended without dispatching)\n")
      return true
    }
  }
  process.stdout.write("\n    WARN: maxMs reached without children clearing\n")
  return false
}

async function turn(primaryID, label, text) {
  console.log(`\n>>> [${label}]`)
  console.log(`    user: ${text.replace(/\n/g, " ").slice(0, 200)}…`)
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
  console.log(`    orch (${dt}s): ${reply.slice(0, 300).replace(/\n/g, " ")}${reply.length > 300 ? "…" : ""}`)
  await waitForChildrenGone(primaryID)
  return reply
}

// ---------- Scenarios -------------------------------------------------------

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  const tag = pass ? "✅ PASS" : "❌ FAIL"
  console.log(`\n${tag}  ${name}\n        ${detail.replace(/\n/g, "\n        ")}`)
}

async function scenarioDone(primaryID) {
  await turn(
    primaryID,
    "T1 — expect DONE marker → auto-tick",
    'Spawn ONE coder subagent with this exact prompt (replace nothing): `T1: Reply with a SINGLE line saying exactly: DONE: T1`. Use no other tools. After spawning, end your turn — you will be woken automatically when it finishes. Do NOT poll, do NOT call list().',
  )
  const todo = readTodo()
  const ticked = /- \[x\] T1\./.test(todo)
  record(
    "wake-hook auto-ticked T1 after DONE marker",
    ticked,
    ticked
      ? "TODO.md shows `- [x] T1.` as expected."
      : "TODO.md still shows `- [ ] T1.` — the wake-hook did NOT tick.\n--- TODO.md ---\n" + todo,
  )
}

async function scenarioBlocked(primaryID) {
  await turn(
    primaryID,
    "T2 — expect BLOCKED marker → auto-mark blocked",
    'For T2, spawn ONE coder with this exact prompt: `T2: Reply with a SINGLE line saying exactly: BLOCKED: T2 — deliberately impossible per test plan`. Use no tools. End your turn.',
  )
  const todo = readTodo()
  const blocked = /- \[!\] T2\..*\(blocked:.*\)/.test(todo)
  record(
    "wake-hook auto-marked T2 blocked after BLOCKED marker",
    blocked,
    blocked
      ? "TODO.md shows `- [!] T2. … (blocked: …)` as expected."
      : "TODO.md does NOT show the blocked marker for T2.\n--- TODO.md ---\n" + todo,
  )
}

async function scenarioMissingPrefixRejected(primaryID) {
  // We can't directly observe a rejection without scraping subagent message
  // trees, but we can check that NO new child session was created.
  const before = (u(await client.session.children({ path: { id: primaryID } })) || []).length
  await turn(
    primaryID,
    "spawn without T-prefix — expect refusal",
    'Try ONE spawn call deliberately WITHOUT a task-id prefix: `spawn("coder", "do something useful for the project")`. Report whatever the tool output says. End your turn after one spawn attempt — do NOT retry, do NOT call any other tool.',
  )
  const after = (u(await client.session.children({ path: { id: primaryID } })) || []).length
  const refused = after === before
  record(
    "spawn without T-prefix is refused when TODO.md exists",
    refused,
    refused
      ? `children count unchanged (${before}) → spawn was rejected before session creation.`
      : `children count grew ${before} → ${after}; refusal did not fire.`,
  )
}

// ---------- Driver ---------------------------------------------------------

console.log(`=== TODO.md auto-tracking E2E ===`)
console.log(`baseUrl:    ${baseUrl}`)
console.log(`projectDir: ${projectDir}`)
console.log(`time:       ${new Date().toISOString()}`)

if (!existsSync(projectDir)) {
  console.error(`projectDir does not exist: ${projectDir}`)
  process.exit(2)
}
writeTodo()
writePermissiveConfig()
console.log(`seeded TODO.md (3 open tasks: T1, T2, R1) + permissive opencode.json`)

const primary = u(
  await client.session.create({
    body: { title: "todo-e2e" },
    query: { directory: projectDir },
  }),
)
console.log(`primary session: ${primary.id}`)

try {
  await scenarioDone(primary.id)
  await scenarioBlocked(primary.id)
  await scenarioMissingPrefixRejected(primary.id)
} catch (err) {
  console.error("\nDRIVER ERROR:", err.message)
  process.exit(2)
}

console.log("\n=== Final TODO.md ===")
console.log(readTodo())

const failed = results.filter((r) => !r.pass)
console.log(`\n=== Summary: ${results.length - failed.length}/${results.length} passed ===`)
for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`)

// Leave projectDir on failure so the user can inspect; clean it up on success.
if (failed.length === 0 && process.argv[3] === undefined) {
  rmSync(projectDir, { recursive: true, force: true })
  console.log(`(cleaned up ${projectDir})`)
} else if (process.argv[3] === undefined) {
  console.log(`(kept ${projectDir} for inspection)`)
}

process.exit(failed.length === 0 ? 0 : 1)
