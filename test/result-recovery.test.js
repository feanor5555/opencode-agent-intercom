// A subagent's account of its own work must never be lost. Three places
// decided that, and this file pins all three:
//
//   1. client.js `finalResult` — the newest assistant message is the result
//      whenever it holds USABLE text; where it holds none it walks back and
//      returns the most recent earlier assistant text instead.
//   2. notices.js `errorNotice` — a provider blow-up or a user abort now
//      carries that recovered text up to the orchestrator alongside the
//      failure, instead of reporting the failure alone.
//   3. hooks.js `contextLimitNotice` — the demand for a `Done:` summary fires
//      at CTX_STOP_RESERVE (0.9) of the context budget, while the tool
//      lockdown in `guardToolExecute` still fires at the budget itself, so the
//      subagent is told to write while its tools still work.
//   4. watchdog.js `timeoutSubagent` — the inactivity reap reads the session
//      one last time before its teardown deletes it, puts that text through
//      the reply ceiling (so the overflow file exists) and hands it to the
//      orchestrator in the timeout notice, instead of reporting the timeout
//      alone.
//
// Run: node --test test/result-recovery.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index.js"
import { finalResult, fetchSnapshot } from "../src/client.js"
import { completionNotice, errorNotice, timeoutNotice } from "../src/notices.js"
import { resetState } from "../src/state.js"
import { trackPrimary, upsertSession, entryForSession } from "../src/registry.js"
import { resetTurnNotices } from "../src/hooks.js"
import { sweepWatchdog, _stopWatchdogForTests } from "../src/watchdog.js"
import { resetProjectContext } from "../src/project.js"
import { resetPermissionGuardCache } from "../src/config.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"

const PRIMARY = "ses_primary"
const toolCtx = { sessionID: PRIMARY, agent: "orchestrator", messageID: "m1" }

const fixtureDir = mkdtempSync(join(tmpdir(), "intercom-recovery-"))
writeFileSync(
  join(fixtureDir, "package.json"),
  JSON.stringify({ name: "fixture-proj", description: "test fixture project" }),
)
mkdirSync(join(fixtureDir, "src"))
writeFileSync(join(fixtureDir, "src", "main.js"), "// fixture")

const settingsFile = join(fixtureDir, "agent-intercom.json")
setSettingsPath(settingsFile)

beforeEach(() => {
  _stopWatchdogForTests()
  resetState()
  resetTurnNotices()
  resetProjectContext()
  resetPermissionGuardCache()
  rmSync(settingsFile, { force: true })
  resetSettings()
})

// ---- shapes ------------------------------------------------------------------

const assistant = (...parts) => ({ info: { role: "assistant" }, parts })
const user = (text) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })
const textPart = (text) => ({ type: "text", text })
const toolPart = (tool) => ({ type: "tool", tool, state: { status: "completed" } })

// ---- 1. finalResult: the walk back -------------------------------------------

test("finalResult: a last assistant message WITH text is the result, unchanged", () => {
  const messages = [
    user("do x"),
    assistant(textPart("early note")),
    assistant(toolPart("read"), textPart("Done: wrote the parser.")),
  ]
  assert.equal(finalResult(messages), "Done: wrote the parser.")
})

test("finalResult: all text parts of the winning message are joined, in order", () => {
  const messages = [assistant(textPart("Done: part one."), toolPart("read"), textPart("part two."))]
  assert.equal(finalResult(messages), "Done: part one.\npart two.")
})

test("finalResult: a last message of tool parts only falls back to the earlier text", () => {
  const messages = [
    user("do x"),
    assistant(textPart("Done: read the three call sites.")),
    assistant(toolPart("read"), toolPart("grep")),
  ]
  assert.equal(finalResult(messages), "Done: read the three call sites.")
})

test("finalResult: whitespace-only text is not usable and is walked past", () => {
  const messages = [
    assistant(textPart("Done: the migration is written.")),
    assistant(textPart("   \n\t  ")),
    assistant(textPart("")),
  ]
  assert.equal(finalResult(messages), "Done: the migration is written.")
})

test("finalResult: a synthetic text part is machinery, never the subagent's result", () => {
  const messages = [
    assistant(textPart("Done: the three tests are green.")),
    assistant({ type: "text", text: "🛑 STOP. agent-intercom: your context …", synthetic: true }),
  ]
  assert.equal(finalResult(messages), "Done: the three tests are green.")
})

test("finalResult: text that is nothing but tool-call scaffolding is walked past", () => {
  for (const scaffold of [
    '<tool_call>{"name": "read", "arguments": {"path": "/a"}}</tool_call>',
    '<function_call>{"name": "bash"}</function_call>',
    '[TOOL_CALLS]read{"path": "/a"}',
    '{"name": "read", "arguments": {"filePath": "/a"}}',
    '{"arguments": {"filePath": "/a"}, "name": "read"}',
  ]) {
    const messages = [assistant(textPart("Done: found it.")), assistant(textPart(scaffold))]
    assert.equal(finalResult(messages), "Done: found it.", scaffold)
  }
})

test("finalResult: a real summary that QUOTES a tool call keeps its text", () => {
  const quoted =
    'Done: the model emitted `<tool_call>{"name":"read"}</tool_call>` as plain text instead of ' +
    "calling the tool. That is the bug."
  assert.equal(finalResult([assistant(textPart(quoted))]), quoted)
})

test("finalResult: JSON with only a name key is a result, not scaffolding", () => {
  const json = '{"name": "parser-rewrite", "status": "done"}'
  assert.equal(finalResult([assistant(textPart(json))]), json)
})

test("finalResult: user messages are never mistaken for the subagent's result", () => {
  const messages = [user("the briefing"), assistant(toolPart("read")), user("a follow-up")]
  assert.equal(finalResult(messages), undefined)
})

test("finalResult: no usable assistant text anywhere yields undefined", () => {
  assert.equal(finalResult([]), undefined)
  assert.equal(finalResult([user("do x"), assistant(toolPart("read"))]), undefined)
})

test("fetchSnapshot carries the recovered text through as `result`", async () => {
  const client = {
    session: {
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", tokens: { input: 500, output: 10 } },
            parts: [textPart("Done: three files changed.")],
          },
          { info: { role: "assistant", tokens: { input: 900, output: 0 } }, parts: [toolPart("read")] },
        ],
      }),
    },
  }
  const snap = await fetchSnapshot(client, "ses_sub1")
  assert.equal(snap.result, "Done: three files changed.")
  assert.equal(snap.ctxTokens, 900)
})

test("the no-text wording survives: an empty result still reads as before", () => {
  const notice = completionNotice("coder#1", "coder", undefined, PRIMARY, undefined, 0, 0, undefined)
  assert.match(notice, /It produced no text result\./)
  assert.doesNotMatch(notice, /Its result:/)
})

// ---- 2. errorNotice carries the recovered text --------------------------------

const failedEntry = {
  handle: "coder#1",
  agent: "coder",
  sessionID: "ses_sub1",
  parentID: PRIMARY,
}

test("errorNotice without recovered text is byte-identical to the failure line alone", () => {
  const notice = errorNotice(failedEntry, "APIError: context length exceeded", false)
  assert.equal(
    notice,
    '🔔 agent-intercom: subagent "coder#1" (coder, session ses_sub1) failed: APIError: context ' +
      "length exceeded. Slot freed. You may re-dispatch with spawn() if the work is still needed." +
      "\nSubagent slots: 0/1 (global, across all sessions) — 1 free.",
  )
})

test("errorNotice with recovered text keeps the failure wording AND reports the text", () => {
  const notice = errorNotice(
    failedEntry,
    "APIError: context length exceeded",
    false,
    "Done: rewrote the parser; the CLI flags are still open.",
  )
  assert.match(notice, /failed: APIError: context length exceeded\. Slot freed\. /)
  assert.match(notice, /You may re-dispatch with spawn\(\) if the work is still needed\./)
  assert.match(notice, /Done: rewrote the parser; the CLI flags are still open\./)
  assert.match(notice, /do not have the same ground covered twice/)
})

test("errorNotice on a user abort also reports the text, with the abort wording", () => {
  const notice = errorNotice(failedEntry, "MessageAbortedError", true, "Done: read six files.")
  assert.match(notice, /aborted by user\. Slot freed\. /)
  assert.doesNotMatch(notice, /failed:/)
  assert.match(notice, /Done: read six files\./)
})

test("session.error posts the recovered text to the parent", async () => {
  const posted = []
  const { ctx, created } = makeCtx({
    ctxTokens: 5000,
    resultParts: [textPart("Done: mapped the call sites; the migration is not written.")],
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  posted.length = 0

  await hooks.event({
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "APIError", data: { message: "context length exceeded" } },
      },
    },
  })

  const notice = posted.map((p) => p.text).join("\n")
  assert.match(notice, /failed: APIError: context length exceeded/)
  assert.match(notice, /Done: mapped the call sites; the migration is not written\./)
})

// The error path is the one where the recovered text is longest — a session
// that died of a context-length error has usually been working for a while —
// so it carries the same reply ceiling as the idle path: cut in the notice,
// whole in the overflow file, written before the teardown deletes the session.
test("session.error carries a capped last text and files the rest", async () => {
  const posted = []
  const huge = "Done: " + "R".repeat(9000) + "TAIL_MARKER"
  const home = mkdtempSync(join(tmpdir(), "intercom-recovery-home-"))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const { ctx, created } = makeCtx({
      ctxTokens: 5000,
      resultParts: [textPart(huge)],
      onPrompt: (id, text) => posted.push({ id, text }),
    })
    const hooks = await plugin(ctx)
    await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
    const sessionID = created[created.length - 1]
    posted.length = 0

    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "APIError", data: { message: "context length exceeded" } },
        },
      },
    })

    const notice = posted.map((p) => p.text).join("\n")
    assert.match(notice, /failed: APIError: context length exceeded/)
    assert.match(notice, /\[cut at 2000 tokens — \d+ more tokens of this reply are not shown here/)
    assert.doesNotMatch(notice, /TAIL_MARKER/)
    const path = /^(\/\S+\.md)$/m.exec(notice)?.[1]
    assert.ok(path, `no overflow file path in the error notice: ${notice}`)
    assert.ok(readFileSync(path, "utf8").endsWith(huge), "the file must hold the reply whole")
    // An errored subagent is never held, so the marker must not offer `reuse`.
    assert.doesNotMatch(notice, /reuse\(/)
  } finally {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  }
})

test("session.error on a session with no assistant text reports the failure alone", async () => {
  const posted = []
  const { ctx, created } = makeCtx({
    ctxTokens: 5000,
    resultParts: [toolPart("read")],
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  posted.length = 0

  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID, error: { name: "UnknownError", data: { message: "boom" } } },
    },
  })

  const notice = posted.map((p) => p.text).join("\n")
  assert.match(notice, /failed: UnknownError: boom/)
  assert.doesNotMatch(notice, /Its last text before it stopped/)
})

// ---- 4. the watchdog timeout carries the recovered text ----------------------

const reapedEntry = {
  handle: "coder#1",
  agent: "coder",
  sessionID: "ses_sub1",
  parentID: PRIMARY,
}

test("timeoutNotice without recovered text is byte-identical to the timeout line alone", () => {
  assert.equal(
    timeoutNotice(reapedEntry, 90000, 91000),
    '🔔 agent-intercom: subagent "coder#1" (coder, session ses_sub1) timed out after 91s of ' +
      "inactivity (limit 90s) — slot freed. You may re-dispatch with spawn() if the work is " +
      "still needed.",
  )
})

test("timeoutNotice with recovered text keeps the timeout wording AND reports the text", () => {
  const notice = timeoutNotice(
    reapedEntry,
    90000,
    91000,
    "Done: rewrote the parser; the CLI flags are still open.",
  )
  assert.match(notice, /timed out after 91s of inactivity \(limit 90s\) — slot freed\./)
  assert.match(notice, /You may re-dispatch with spawn\(\) if the work is still needed\./)
  assert.match(notice, /Done: rewrote the parser; the CLI flags are still open\./)
  assert.match(notice, /do not have the same ground covered twice/)
})

// Spawns a coder, back-dates it past the inactivity window and lets the real
// sweep reap it. Returns everything the parent was told.
async function reapedNotice({ resultParts, ctxTokens = 5000 }) {
  const posted = []
  const { ctx, created } = makeCtx({
    ctxTokens,
    resultParts,
    onPrompt: (id, text) => posted.push({ id, text }),
  })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  posted.length = 0
  entryForSession(sessionID).lastActivityAt = Date.now() - 600_000
  await sweepWatchdog()
  return { notice: posted.map((p) => p.text).join("\n"), sessionID }
}

test("the inactivity watchdog posts the recovered text to the parent", async () => {
  const { notice } = await reapedNotice({
    resultParts: [textPart("Done: mapped the call sites; the migration is not written.")],
  })
  assert.match(notice, /timed out after \d+s of inactivity/)
  assert.match(notice, /Done: mapped the call sites; the migration is not written\./)
})

// The reap is where the recovered text is longest — the subagent was cut off
// mid-run after several finished steps — so it carries the same reply ceiling
// as the idle and error paths: cut in the notice, whole in the overflow file,
// written while the session still exists.
test("the inactivity watchdog carries a capped last text and files the rest", async () => {
  const huge = "Done: " + "R".repeat(9000) + "TAIL_MARKER"
  const home = mkdtempSync(join(tmpdir(), "intercom-recovery-home-"))
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const { notice } = await reapedNotice({ resultParts: [textPart(huge)] })
    assert.match(notice, /timed out after \d+s of inactivity/)
    assert.match(notice, /\[cut at 2000 tokens — \d+ more tokens of this reply are not shown here/)
    assert.doesNotMatch(notice, /TAIL_MARKER/)
    const path = /^(\/\S+\.md)$/m.exec(notice)?.[1]
    assert.ok(path, `no overflow file path in the timeout notice: ${notice}`)
    assert.ok(readFileSync(path, "utf8").endsWith(huge), "the file must hold the reply whole")
    // A timed-out subagent is never held, so the marker must not offer `reuse`.
    assert.doesNotMatch(notice, /reuse\(/)
  } finally {
    process.env.HOME = realHome
    rmSync(home, { recursive: true, force: true })
  }
})

test("a timed-out session with no assistant text reports the timeout alone", async () => {
  const { notice } = await reapedNotice({ resultParts: [toolPart("read")] })
  assert.match(notice, /timed out after \d+s of inactivity/)
  assert.doesNotMatch(notice, /the only account of the work it managed/)
})

// ---- 3. the STOP reserve below the tool lockdown ------------------------------

// A budget of 10000 tokens for `coder`: the reserve band opens at 9000 and the
// tool lockdown at 10000.
const BUDGET = 10000
const RESERVE_AT = 9000

function budgetSettings() {
  writeFileSync(settingsFile, JSON.stringify({ agentContext: { coder: BUDGET } }))
  resetSettings()
}

// The block the plugin injects into the subagent's own turn.
async function subagentTurnNotice(hooks, sessionID) {
  const messages = [
    { info: { id: "mu1", role: "user", sessionID }, parts: [textPart("task")] },
  ]
  await hooks["experimental.chat.messages.transform"]({}, { messages })
  return messages[0].parts
    .filter((part) => part.synthetic)
    .map((part) => part.text)
    .join("")
}

// Whether the tool guard admits a call from this subagent right now.
async function toolAdmitted(hooks, sessionID) {
  try {
    await hooks["tool.execute.before"]({ tool: "read", sessionID, callID: "c1" })
    return true
  } catch {
    return false
  }
}

// Spawns a coder subagent whose session reports `ctxTokens`.
async function subagentAt(ctxTokens) {
  budgetSettings()
  const { ctx, created } = makeCtx({ ctxTokens, resultParts: [textPart("working")] })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  return { hooks, sessionID: created[created.length - 1] }
}

test("below the reserve: no block, tools admitted", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT - 1)
  const notice = await subagentTurnNotice(hooks, sessionID)
  assert.doesNotMatch(notice, /WRAP UP NOW/)
  assert.doesNotMatch(notice, /STOP\./)
  assert.equal(await toolAdmitted(hooks, sessionID), true)
})

test("in the reserve band: told to write the summary WHILE the tools still work", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  const notice = await subagentTurnNotice(hooks, sessionID)
  assert.match(notice, /WRAP UP NOW/)
  assert.match(notice, /"Done:"/)
  // The whole point of the reserve: the demand arrives before the cut.
  assert.doesNotMatch(notice, /Your tool calls are now DISABLED/)
  assert.equal(
    await toolAdmitted(hooks, sessionID),
    true,
    "the reserve band must not deny tools — that is the lockdown's job",
  )
})

test("the reserve band does not count as a STOP injection or notify the parent", async () => {
  const { hooks, sessionID } = await subagentAt(RESERVE_AT + 100)
  await subagentTurnNotice(hooks, sessionID)
  const entry = upsertSession(sessionID, { agent: "coder", prompt: "x", parentID: PRIMARY })
  assert.equal(entry.contextWarnings, 1)
  assert.equal(entry.stopInjections, 0, "no denial has happened, so no denial-loop escalation")
  assert.equal(entry.notifiedParentOfLoop, false)
})

test("at the budget: the existing lockdown block and the hard tool denial, unchanged", async () => {
  const { hooks, sessionID } = await subagentAt(BUDGET)
  const notice = await subagentTurnNotice(hooks, sessionID)
  assert.match(notice, /🛑 STOP\./)
  assert.match(notice, /Your tool calls are now DISABLED/)
  assert.match(notice, /YOUR LITERAL NEXT MESSAGE MUST BEGIN WITH "Done:"/)
  assert.doesNotMatch(notice, /WRAP UP NOW/)
  assert.equal(await toolAdmitted(hooks, sessionID), false)
})

test("the reserve is a fraction of whatever budget the type has, not a fixed margin", async () => {
  // Same relative position (95 % of the budget) on a budget ten times larger.
  writeFileSync(settingsFile, JSON.stringify({ agentContext: { coder: 100000 } }))
  resetSettings()
  const { ctx, created } = makeCtx({ ctxTokens: 95000, resultParts: [textPart("working")] })
  const hooks = await plugin(ctx)
  await hooks.tool.spawn.execute({ agent: "coder", prompt: "x" }, toolCtx)
  const sessionID = created[created.length - 1]
  assert.match(await subagentTurnNotice(hooks, sessionID), /WRAP UP NOW/)
  assert.equal(await toolAdmitted(hooks, sessionID), true)
})

// ---- harness -----------------------------------------------------------------

// An opencode client whose sessions report `ctxTokens` of context and end with
// `resultParts` as their newest assistant message.
function makeCtx({ ctxTokens = 1000, resultParts = [], onPrompt } = {}) {
  let counter = 0
  const created = []
  const client = {
    session: {
      create: async () => {
        counter += 1
        const id = `ses_sub${counter}`
        created.push(id)
        return { data: { id } }
      },
      promptAsync: async (opts) => {
        onPrompt?.(opts?.path?.id, (opts?.body?.parts ?? []).map((p) => p.text).join("\n"))
        return { data: undefined }
      },
      abort: async () => ({ data: true }),
      delete: async () => ({ data: true }),
      status: async () => ({ data: {} }),
      get: async () => ({ data: { directory: fixtureDir } }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", tokens: { input: ctxTokens, output: 0 } },
            parts: resultParts,
          },
        ],
      }),
    },
    tui: { showToast: async () => ({ data: true }) },
    config: { get: async () => ({ data: { agent: {} } }) },
  }
  return { ctx: { client, directory: fixtureDir, worktree: fixtureDir, project: {} }, created }
}
