// Slice 6a: pure orchestrator-handoff orchestration.
//
// This module is INTENTIONALLY side-effect free at import time. It imports no
// other plugin modules (no hooks.js, no client.js, no registry.js, no
// project.js, no state.js). Every operation the handoff needs is injected via
// `deps`, which makes the whole sequence testable in isolation against
// recording fakes — no opencode runtime, no I/O, no SDK calls.
//
// Two exceptions, both pure leaves with no plugin runtime dependencies:
//   - `src/log.js` (debug-logging only, appends to
//     `~/.cache/opencode-agent-intercom/debug.log`), imported so the outer
//     try/catch in `performPrimaryHandoff` can surface uncaught throws with
//     the full stack instead of letting them bubble silently.
//   - `src/pluginmsg.js` (constants + pure predicates), imported so
//     `lastUserGoal` can skip plugin-generated messages (wake notices,
//     kickoffs, DOC_SUMMARY prompts) when scanning for the real user goal.
import { log, errMsg } from "./log.js"
import { isPluginGeneratedMessage, looksLikePluginMessage } from "./pluginmsg.js"
//
// Sequence (do NOT reorder):
//   0. Open the delivery drain for the old primary (deps.beginDrain). From
//      this moment every subagent notice addressed to the old primary is
//      BUFFERED by the router in hooks.js/registry.js instead of posted —
//      the old session is on its way out, and a notice delivered to it
//      would die with the delete (live-verified loss).
//   1. Gather planned steps and the last user goal. (The in-flight subagent
//      list is deliberately NOT gathered here — it is read AFTER the
//      reparent in step 4, so the kickoff only announces subagents whose
//      re-pointing has actually happened.)
//   2. Create the new orchestrator session and bind it to the drain
//      (deps.bindDrainTarget): until the flush, notices addressed to the
//      NEW session are buffered too, so a reparented subagent finishing
//      early cannot beat the kickoff message.
//   3. Ask the OLD primary (#1, which still holds PROJECT.md / TODO.md /
//      ARCHITECTURE.md in its context) to emit three concise per-file
//      summaries PLUS a session-history summary (what was done, which
//      decisions fell and why, current work, next step) in one final
//      turn; the new orchestrator's kickoff message embeds the stand-up
//      summary + the history block + those three summaries — no re-read
//      of disk. A subagent finishing during this (potentially long) wait
//      is buffered by the drain and cannot disturb the old primary's
//      summary turn.
//   4. Reparent all in-flight subagents of the old primary onto the new one
//      — BEFORE the kickoff is composed, so announcement and delivery
//      path cannot diverge.
//   5. Read the in-flight list from the POST-reparent registry, build the
//      summary (stand-up line, reparented-subagent notes, planned steps —
//      all sections stay defined even when empty), format it as markdown
//      and write it under the working dir. A subagent that finished during
//      steps 0-4 is gone from the registry (its notice sits in the drain)
//      and is correctly NOT announced as re-parented.
//   6. Send the kickoff to the new orchestrator.
//   7. Flush the drain (deps.flushDrain): buffered notices are delivered to
//      the NEW session, AFTER the kickoff, in arrival order; the old→new
//      redirect now routes any late straggler to the new session as well.
//   8. Archive the old primary session (NOT delete). A delete cascades
//      recursively over child sessions in opencode; a subagent still
//      reparented under the old primary's DB parent would have its rows
//      wiped mid-write (FK-constraint failure → session.error → skipped
//      auto-tick). Archiving retires the session without the cascade.
//   9. Drop the old primary from the primary-tracking maps (forgetPrimary).
//  10. Return { newSessionID, reparented, summaryMarkdown }.
//
// Failure discipline: any throw in steps 1-6 triggers a best-effort revert —
// un-reparent (new→old), delete the orphaned new session, abort the drain
// (deps.abortDrain delivers the buffer back to the still-existing OLD
// session) — and re-throws so runScheduledHandoff can release the latch.
// From step 7 on the kickoff is delivered and the new session is live:
// flush and delete failures are logged and the sequence proceeds (reverting
// a live handoff would be worse than a zombie old session).
//
// See test/handoff.test.js + test/handoff-reparent.test.js for the harnesses.
//
// @typedef {Object} InFlightSubagent
// @property {string} handle
// @property {string} agent
// @property {string} task
//
// @typedef {Object} PrimarySummary
// @property {string} stand
// @property {string[]} notes
// @property {string[]} plannedSteps
//
// @typedef {Object} PrimaryHandoffDeps
// @property {string} primarySessionID
// @property {string} directory
// @property {string} orchestratorAgentName
// @property {() => void} beginDrain                 open the delivery drain for the old primary
// @property {(newID: string) => void} bindDrainTarget  key the drain under the new session too
// @property {() => Promise<number>} flushDrain      deliver the buffer to the NEW session (post-kickoff)
// @property {() => Promise<number>} abortDrain      deliver the buffer back to the OLD session (failure)
// @property {(parentID: string) => InFlightSubagent[]} getInFlightSubagents  called with the NEW id, post-reparent
// @property {(directory: string) => string[]} getPlannedSteps
// @property {() => string | Promise<string>} getLastUserGoal
// @property {(s: PrimarySummary) => string} formatPrimarySummary
// @property {(directory: string, md: string) => void} writePrimarySummary
// @property {(opts: { agent: string }) => Promise<string>} createSession
// @property {(sessionID: string, message: string) => Promise<void>} promptAsync
// @property {(fromID: string, toID: string) => Promise<number>} reparent
// @property {(sessionID: string) => Promise<void>} deleteSession  used ONLY for the orphaned NEW session on the failure path (a root session with no children)
// @property {(sessionID: string) => Promise<void>} archiveSession  retires the OLD primary in step 8 without opencode's recursive child-delete cascade
// @property {(sessionID: string) => void} forgetPrimary
// @property {() => Promise<string>} promptOldPrimaryForDocSummaries
//
// @param {PrimaryHandoffDeps} deps
// @returns {Promise<{ newSessionID: string, reparented: number, summaryMarkdown: string }>}
export async function performPrimaryHandoff(deps) {
  // Outer try/catch: any uncaught throw inside the sequence is logged with
  // the full stack via the plugin's `log` helper and re-thrown so the caller
  // (hooks.js → performPrimaryHandoff(...).catch) can react. We do NOT
  // swallow — that would leave the user with a hung primary and no
  // orchestrator #2. Caller behaviour on the rejected promise: log the
  // message, drop `handoffInProgress` so a later turn can retry. The error
  // was previously invisible at this layer (it bubbled up unwrapped); now it
  // lands in the debug log as a tagged "primary handoff failed" line with
  // the stack trace, which is the operational signal for debugging a
  // failed handoff.
  try {
    return await performPrimaryHandoffInner(deps)
  } catch (err) {
    log("primary handoff failed", err?.stack ?? errMsg(err))
    throw err
  }
}

// Inner helper: the actual sequence (see the module header for the numbered
// steps and the failure discipline). Split out from the public entry point
// so the outer try/catch above can log + re-throw without duplicating the
// revert/cleanup discipline.
async function performPrimaryHandoffInner(deps) {
  // 0. Open the drain FIRST: from here on, a subagent finishing at any point
  // of this sequence gets its notice buffered instead of delivered to the
  // dying old session (or to the not-yet-kicked-off new one).
  deps.beginDrain()

  let newID = null
  let reparentDone = false
  let reparented = 0
  let md
  try {
    // 1. Gather planned steps + last user goal. getLastUserGoal may be async
    // in production (it fetches the old primary's message history via the
    // session API — the system.transform hook input carries NO `messages`
    // field). Best-effort: a failed lookup yields an empty goal, never a
    // failed handoff.
    const steps = deps.getPlannedSteps(deps.directory)
    let goal = ""
    try {
      goal = (await deps.getLastUserGoal()) || ""
    } catch (err) {
      log("primary handoff: getLastUserGoal failed, continuing with empty goal", errMsg(err))
    }

    // 2. Create orchestrator #2 and bind it into the drain, so a reparented
    // subagent finishing between reparent and kickoff is buffered too (its
    // result must not reach #2 before the kickoff message).
    newID = await deps.createSession({ agent: deps.orchestratorAgentName })
    deps.bindDrainTarget(newID)

    // 3. Ask the OLD primary (#1) — which still has PROJECT.md / TODO.md /
    // ARCHITECTURE.md in its context — to produce three short per-file
    // summaries PLUS a session-history summary in one final turn. The new
    // orchestrator (#2) is a fresh session with no prior state; the kickoff
    // embeds the stand-up summary plus the history block plus those three
    // summaries so #2 starts with full context WITHOUT having to re-read
    // the docs from disk. The drain keeps #1's summary turn undisturbed: a
    // subagent finishing during this wait is buffered, not delivered.
    //
    // GRACEFUL DEGRADATION: if #1 is unavailable, the helper throws (e.g.
    // the session was already torn down, the provider is down, the LLM
    // timed out). We catch and fall back to a placeholder three-section
    // block so the kickoff message always stays well-formed; the history
    // block is simply OMITTED in that case (it is optional context, not
    // part of the kickoff's parseable shape). The handoff itself must never
    // throw on this path — the rest of the sequence still has to run.
    //
    // validateDocSummaries is also defensive on the happy path: if #1
    // replies with a malformed / partial / out-of-order block, the helper
    // extracts the recognised sections in canonical order and falls back to
    // the placeholder for any missing one. extractHistorySummary is equally
    // defensive: a missing / empty `## Session-Verlauf` section yields ""
    // and the kickoff simply omits the block. The kickoff never depends on
    // the helper's specific shape.
    let docSummaries
    let historySummary = ""
    try {
      const raw = await deps.promptOldPrimaryForDocSummaries()
      docSummaries = validateDocSummaries(raw)
      historySummary = extractHistorySummary(raw)
    } catch (err) {
      log("primary handoff: doc summaries failed, using fallback", errMsg(err))
      docSummaries = FALLBACK_DOC_SUMMARIES
    }

    // 4. Reparent BEFORE the kickoff is composed: the kickoff must only
    // announce subagents whose delivery re-pointing has actually happened.
    reparented = await deps.reparent(deps.primarySessionID, newID)
    reparentDone = true

    // 5. Build the summary from the POST-reparent registry state — the
    // in-flight list is read AFTER reparent, keyed by the NEW id, so
    // announcement and delivery path cannot diverge. A subagent that
    // finished during steps 0-4 is no longer in the registry (its notice
    // sits in the drain and will be flushed to #2 right after the kickoff)
    // and is correctly NOT listed here. Sections are always present
    // (possibly empty) so the markdown stays well-formed.
    const inFlight = await deps.getInFlightSubagents(newID)
    // Empty goal = the old session's history held no REAL user message (it
    // consisted only of plugin notices / kickoffs, or the lookup failed).
    // Render an explicit placeholder instead of a bare "Letztes Ziel: ":
    // small orchestrator models treat an empty line as an invitation to
    // invent a goal; the placeholder states the situation and points at the
    // sections that DO carry real signal. The handoff itself never fails on
    // this — the placeholder is presentation only, lastUserGoal keeps its
    // "" contract.
    const safeGoal =
      goal || "(kein echtes Nutzer-Ziel in der Session-History gefunden — siehe Geplante Schritte / TODO.md)"
    const stand = inFlight.length > 0
      ? `Letztes Ziel: ${safeGoal} (${inFlight.length} Subagent(s) wurden re-parented)`
      : `Letztes Ziel: ${safeGoal}`
    const notes = [
      "Diese Subagents liefern jetzt an diese Session:",
      ...inFlight.map((s) => `${s.handle} (${s.agent}): ${s.task}`),
    ]
    md = deps.formatPrimarySummary({ stand, notes, plannedSteps: steps })
    deps.writePrimarySummary(deps.directory, md)

    // 6. Send the kickoff to the new orchestrator.
    const kickoffMessage =
      md + (historySummary ? "\n\n" + historySummary : "") + "\n\n" + docSummaries
    await deps.promptAsync(newID, kickoffMessage)
  } catch (err) {
    // Pre-kickoff failure: the new session never became the live primary.
    // Best-effort revert, then re-throw (runScheduledHandoff releases the
    // latch; a later over-budget turn re-schedules).
    //   - un-reparent so still-running subagents wake the OLD primary again
    //     (it survives a failed handoff),
    //   - delete the orphaned new session,
    //   - abort the drain: buffered notices go back to the OLD primary, so
    //     a failed handoff neither loses results nor leaks the buffer.
    if (reparentDone && newID) {
      try {
        await deps.reparent(newID, deps.primarySessionID)
      } catch (revertErr) {
        log("primary handoff: reparent revert failed", errMsg(revertErr))
      }
    }
    if (newID) {
      try {
        await deps.deleteSession(newID)
      } catch (cleanupErr) {
        log("primary handoff: orphan new-session delete failed", errMsg(cleanupErr))
      }
    }
    try {
      await deps.abortDrain()
    } catch (drainErr) {
      log("primary handoff: abortDrain failed", errMsg(drainErr))
    }
    throw err
  }

  // ---- Point of no return: the kickoff is delivered, #2 is live. ----------
  // Failures below are logged and the sequence proceeds — reverting a live
  // handoff (deleting #2 after its kickoff) would be strictly worse than a
  // zombie old session or an undelivered buffered notice.

  // 7. Flush the drain: buffered notices are delivered to #2, AFTER the
  // kickoff, in arrival order. This also installs the old→new redirect for
  // late stragglers (deps impl per-notice failures are logged there).
  try {
    await deps.flushDrain()
  } catch (err) {
    log("primary handoff: flushDrain failed", errMsg(err))
  }

  // 8. Now — and only now — retire the old primary session. ARCHIVE, do NOT
  // delete: opencode's session delete cascades recursively over child
  // sessions, and a subagent still reparented under the old primary's DB
  // parent would have its message/part rows wiped mid-write (FK-constraint
  // failure → session.error instead of session.idle → the deterministic
  // auto-tick is skipped and the TODO.md task stays wrongly open). Archiving
  // retires the session without the cascade; the children stay untouched.
  try {
    await deps.archiveSession(deps.primarySessionID)
  } catch (err) {
    log("primary handoff: old-primary archive failed, proceeding", errMsg(err))
  }

  // 9. Drop the old primary from primarySessions / primaryCtx maps.
  deps.forgetPrimary(deps.primarySessionID)

  // 10. Return the handoff result.
  return { newSessionID: newID, reparented, summaryMarkdown: md }
}

// Idle-gated execution coordinator. The transform hook SCHEDULES a handoff
// (registry.markHandoffPending) while the triggering turn is still running;
// this function EXECUTES it when the primary's `session.idle` event arrives —
// i.e. after the triggering user message has been fully answered by the old
// session. Injectable like everything else in this module: the state-backed
// gates (claim/release) and the deps builder come in via args, so the
// claim-once / release-on-failure discipline is unit-testable without hooks.js
// or an opencode runtime.
//
// Contract:
//   - `claim()` is called FIRST and synchronously. False → return null without
//     touching anything (no pending handoff, or one is already executing —
//     duplicate idle events land here).
//   - `getDeps()` may be async (hooks.js resolves the session directory via
//     the session API). It runs INSIDE the try so a failure releases the
//     in-progress latch instead of leaking it.
//   - On success the in-progress latch is cleared by the handoff sequence
//     itself (deps.forgetPrimary → registry.forgetPrimary). On ANY failure
//     `release()` clears it so a later over-budget turn can re-schedule.
//   - Never throws: failures are logged and swallowed (the caller is an event
//     handler; the retry path is a fresh schedule on a later turn).
//
// @param {Object} io
// @param {() => boolean} io.claim
// @param {() => void} io.release
// @param {() => PrimaryHandoffDeps | Promise<PrimaryHandoffDeps>} io.getDeps
// @param {(deps: PrimaryHandoffDeps) => Promise<Object>} [io.perform]
// @returns {Promise<Object|null>} the handoff result, or null (not claimed / failed)
export async function runScheduledHandoff({
  claim,
  release,
  getDeps,
  perform = performPrimaryHandoff,
}) {
  if (!claim()) return null
  try {
    const deps = await getDeps()
    return await perform(deps)
  } catch (err) {
    // performPrimaryHandoff already logged its own failure with the stack;
    // this also covers getDeps throws. Release so a later turn can retry.
    log("scheduled primary handoff failed", errMsg(err))
    release()
    return null
  }
}

// The prompt we send to the OLD primary (#1) to ask for per-file summaries.
// Asks for exactly three sections with the literal headings the new
// orchestrator will match on, with a per-section cap so the response stays
// bounded (#1 is the long-lived session whose context just hit the budget —
// we don't want it to spend thousands of tokens here). The new orchestrator
// gets a stable shape (`## PROJECT.md — …` / `## TODO.md — …` /
// `## ARCHITECTURE.md — …`) and can rely on the headings being present.
//
// Drawn from #1's own context (the docs are already in its message history
// from the kickoff slice that set up the session) — we explicitly forbid
// re-reading from disk, since the new orchestrator will not have that
// context anyway and the summaries must reflect what #1 already saw.
export const DOC_SUMMARY_PROMPT =
  "You are about to be replaced by a fresh orchestrator session. Before that, emit ONE final " +
  "plain-text reply containing EXACTLY four sections, in this order, with these EXACT headings " +
  "(no extra prose, no tool calls, no code blocks):\n\n" +
  "## PROJECT.md — <one or two sentences capturing the project index, the goals and the " +
  "overall direction, max ~400 characters>\n\n" +
  "## TODO.md — <one or two sentences capturing the current task list focus / " +
  "open work, max ~400 characters>\n\n" +
  "## ARCHITECTURE.md — <one or two sentences capturing the canonical software-architecture " +
  "facts the new orchestrator must know to make good decisions, max ~400 characters>\n\n" +
  "## Session-Verlauf — <a summary of this session's course: what was accomplished, which " +
  "decisions were made and why, what is being worked on right now, and what the next step is; " +
  "aim for 800-1000 characters>\n\n" +
  "Use ONLY what you already have in context — do NOT read files from disk. Plain text reply, " +
  "no `read`/`bash`/`glob`/`grep` tool calls, no preamble, no postscript, no markdown other than " +
  "the four `## …` headings above. Start your reply with `## PROJECT.md —` literally."

// Section cap on each per-file summary. Mirrors the "~400 characters" the
// prompt instructs; used by `validateDocSummaries` to truncate runaway
// replies so the kickoff message stays bounded even when #1 ignores the cap.
export const DOC_SUMMARY_MAX_CHARS = 400

// How long `requestDocSummaries` waits for the old primary's summary reply
// before giving up (the handoff then falls back to FALLBACK_DOC_SUMMARIES).
// The handoff fires from the system.transform hook of an INCOMING turn, so
// the summary prompt is queued BEHIND that in-flight turn — a live test
// measured 42 s for the in-flight turn alone (glm-5.2 thinking) before the
// summary turn even started. 15 s (the old value) could never cover that;
// 120 s covers the measured in-flight turn plus a comparable summary turn.
export const DOC_SUMMARIES_TIMEOUT_MS = 120_000
export const DOC_SUMMARIES_POLL_MS = 500

// Recognises the old primary's doc-summaries reply: the prompt demands the
// reply start with `## PROJECT.md —` (and validateDocSummaries keys on the
// same heading). /m so a model that prepends prose still matches on the
// heading's own line. Exported for the tests.
export function looksLikeDocSummariesReply(text) {
  return typeof text === "string" && /^##\s+PROJECT\.md\s+—/m.test(text)
}

// Injectable core of the "ask the old primary for doc summaries" flow.
// Pure orchestration — all I/O comes in via the args, so the tests can
// drive it with fakes and virtual time (same discipline as the rest of
// this module).
//
//   1. BASELINE FIRST: snapshot the old primary's CURRENT final result
//      BEFORE the prompt is sent. Without this baseline the first poll
//      reads the primary's PREVIOUS final answer and returns it as if it
//      were the summary reply (live-verified bug: the kickoff landed 86 ms
//      after the trigger, the DOC_SUMMARY prompt never reached an LLM, and
//      the kickoff fell back to "(nicht verfügbar)" ×3).
//   2. Send the prompt (non-blocking).
//   3. Poll until the final result has CHANGED from the baseline AND looks
//      like the summaries reply. The "looks like" check matters because the
//      handoff fires mid-turn: the in-flight user turn's reply usually lands
//      FIRST and is a changed-but-foreign result. We re-baseline on such a
//      result and keep waiting for the summary turn behind it.
//   4. Timeout → throw; the caller (performPrimaryHandoff step 5) catches
//      and falls back, so the handoff itself NEVER fails on this path.
//
// @param {Object} io
// @param {() => Promise<string|undefined>} io.fetchResult  latest final result
// @param {() => Promise<void>} io.sendPrompt               fire the summary prompt
// @param {(ms: number) => Promise<void>} [io.sleep]
// @param {() => number} [io.now]
// @param {number} [io.timeoutMs]
// @param {number} [io.pollMs]
// @returns {Promise<string>} the raw summaries reply
export async function requestDocSummaries({
  fetchResult,
  sendPrompt,
  sleep = defaultSleep,
  now = Date.now,
  timeoutMs = DOC_SUMMARIES_TIMEOUT_MS,
  pollMs = DOC_SUMMARIES_POLL_MS,
}) {
  // 1. Baseline BEFORE the prompt. Best-effort: a failed baseline read must
  // not kill the whole feature — we then rely on the shape check alone.
  let baseline
  try {
    baseline = await fetchResult()
  } catch (err) {
    log("requestDocSummaries: baseline fetch failed, relying on shape check", errMsg(err))
  }

  // 2. Fire the prompt — non-blocking (queued behind any in-flight turn).
  await sendPrompt()

  // 3. Poll for a CHANGED result that carries the summaries shape.
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const result = await fetchResult()
    if (result && result !== baseline) {
      if (looksLikeDocSummariesReply(result)) return result
      // A foreign reply (the in-flight turn the handoff interrupted) landed
      // first — treat it as the new baseline and keep waiting for the
      // summary turn queued behind it.
      baseline = result
    }
    await sleep(pollMs)
  }
  // 4. Timed out without a summaries reply — let the handoff fall back.
  throw new Error("requestDocSummaries: timed out waiting for the old primary's summaries reply")
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Fallback text injected when the old primary is unavailable. Three
// well-formed sections, each marked as "(nicht verfügbar)", plus a one-line
// note explaining the degradation. Keeps the kickoff message well-formed
// so the new orchestrator's parser still sees the three `## …` headings.
export const FALLBACK_DOC_SUMMARIES =
  "## PROJECT.md — (nicht verfügbar)\n\n" +
  "## TODO.md — (nicht verfügbar)\n\n" +
  "## ARCHITECTURE.md — (nicht verfügbar)\n\n" +
  "_Hinweis: der bisherige Orchestrator konnte keine Doc-Summaries liefern. Der neue " +
  "Orchestrator sollte PROJECT.md / TODO.md / ARCHITECTURE.md bei Bedarf selbst lesen._"

// Pure helper: normalize the old primary's reply into a three-section block
// matching the shape the new orchestrator expects. Defensive on three axes:
//
//   1. Empty / missing input → returns the fallback block.
//   2. Sections present but in the wrong order / with extra prose between
//      them → re-emits the three sections in the canonical order, taking the
//      text from `start of the section` to the next `## ` (or EOF) verbatim.
//   3. Any individual section longer than DOC_SUMMARY_MAX_CHARS → truncated
//      to the cap with a trailing ellipsis, so the kickoff never carries a
//      runaway reply.
//
// This is exported so test/handoff-doc-summaries.test.js can drive it
// directly without needing an LLM.
export function validateDocSummaries(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return FALLBACK_DOC_SUMMARIES
  }
  const order = ["PROJECT.md", "TODO.md", "ARCHITECTURE.md"]
  const sections = Object.fromEntries(order.map((name) => [name, null]))
  for (const name of order) {
    // `^` (with /m) matches start of any line; `$` (with /m) matches end of
    // any line. JS regex has no \Z anchor — `$` without /m means end of
    // string, which is exactly what we want as the "end of input" terminator
    // for the last section. Note: when the last section is followed by
    // trailing whitespace, `$` would match before the trailing newline, so
    // we also accept `(?![\s\S])` (end of any character) as the final anchor.
    const re = new RegExp(
      `^##\\s+${escapeRe(name)}\\s+—\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`,
      "m",
    )
    const m = re.exec(rawText)
    if (m) sections[name] = m[1].trim()
  }
  if (order.some((name) => sections[name] == null)) {
    // Missing one or more sections — fall back so the kickoff stays well-formed.
    return FALLBACK_DOC_SUMMARIES
  }
  const parts = order.map((name, i) => {
    const body = capChars(sections[name], DOC_SUMMARY_MAX_CHARS)
    return `## ${name} — ${body}`
  })
  return parts.join("\n\n")
}

// Heading of the session-history block the old primary is asked to emit
// alongside the three per-file summaries (same final turn, same reply).
export const HISTORY_SUMMARY_HEADING = "Session-Verlauf"

// Hard cap on the history block's body. The prompt asks for 800-1000
// characters; the cap only truncates runaway replies — anything at or under
// it passes through verbatim (mirrors DOC_SUMMARY_MAX_CHARS discipline).
export const HISTORY_SUMMARY_MAX_CHARS = 1000

// Pure helper: extract the `## Session-Verlauf — …` section from the old
// primary's reply. Unlike validateDocSummaries there is NO fallback block —
// the history summary is optional context, not part of the kickoff's
// parseable shape. Missing / empty / non-string input → "" and the kickoff
// simply omits the block. Runaway bodies are truncated to
// HISTORY_SUMMARY_MAX_CHARS with a trailing ellipsis.
//
// Exported so test/handoff-doc-summaries.test.js can drive it directly.
export function extractHistorySummary(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) return ""
  const re = new RegExp(
    `^##\\s+${escapeRe(HISTORY_SUMMARY_HEADING)}\\s+—\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`,
    "m",
  )
  const m = re.exec(rawText)
  if (!m) return ""
  const body = m[1].trim()
  if (body.length === 0) return ""
  return `## ${HISTORY_SUMMARY_HEADING} — ${capChars(body, HISTORY_SUMMARY_MAX_CHARS)}`
}

function capChars(text, max) {
  if (typeof text !== "string" || text.length <= max) return text
  return text.slice(0, max - 1).replace(/\s+$/, "") + "…"
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Pure helper: extract the text of the LAST message with role === "user"
// from a message array. Used to seed the handoff summary's stand-up line
// (`Letztes Ziel: …`).
//
// TWO accepted message shapes (per entry, mixed arrays are fine):
//   - chat-completion shape: `{ role, content }` where `content` is a plain
//     string OR an array of parts (strings or `{ type, text }` objects).
//   - opencode session.messages shape: `{ info: { role }, parts: [...] }` —
//     what `client.session.messages` returns. In production this is the ONLY
//     source: the system.transform hook input carries no `messages` field,
//     so hooks.js fetches the old primary's history via the session API.
//
// Parts with an explicit non-"text" `type` (tool / file / image / reasoning)
// are skipped; text fragments are concatenated with no separator — opencode
// itself concatenates parts when rendering a message, and the goal is one
// line of plain text for the summary, not a faithful transcript.
//
// Robust to malformed entries: anything that isn't a plain object with a
// string `role` is skipped. A user-shaped entry whose `content` yields an
// empty string (missing / non-string / non-array / array of non-text parts)
// is treated as "no text" and the scan falls through to the next-earlier
// user message — so a leading "image-only" user turn doesn't blank the goal.
//
// PLUGIN-GENERATED messages are skipped the same way (fall through to the
// next-earlier user message): every notice the plugin posts (subagent
// completion / error / timeout / denial-loop, buffered drain flushes), the
// handoff kickoff and the DOC_SUMMARY prompt all arrive as user-role
// messages via promptAsync — live-verified, kickoff #1 in live-test 3
// carried a wake notice as `Letztes Ziel:`. Detection is the part-metadata
// marker set centrally in client.js (isPluginGeneratedMessage), plus a
// text-prefix backstop (looksLikePluginMessage) for messages posted by a
// pre-marker plugin version or a version-skewed companion TUI. This also
// keeps a SECOND handoff from adopting the FIRST handoff's kickoff as the
// goal (three back-to-back handoffs are a live-observed reality).
// If the history holds ONLY plugin messages, the scan returns "" — the
// caller renders an explicit placeholder and the handoff proceeds.
//
// Output is trimmed of trailing whitespace and capped at LAST_USER_GOAL_MAX
// chars so the summary line stays bounded even when the last user message
// was a multi-paragraph request. The cap is a CEILING, not a target: text at
// or under it passes through verbatim, and the trailing "…" appears only
// when the text was actually truncated. Exported for the tests.
export const LAST_USER_GOAL_MAX = 1500

export function lastUserGoal(messages) {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== "object") continue
    const role = typeof m.role === "string" ? m.role : m.info?.role
    if (role !== "user") continue
    if (isPluginGeneratedMessage(m)) continue
    const text = extractUserText(m.content ?? m.parts).replace(/\s+$/, "")
    // Backstop for unmarked plugin messages (pre-marker history, older TUI
    // builds): skip by their verbatim leading strings.
    if (looksLikePluginMessage(text)) continue
    if (text.length > 0) {
      if (text.length > LAST_USER_GOAL_MAX) {
        return text.slice(0, LAST_USER_GOAL_MAX - 1).replace(/\s+$/, "") + "…"
      }
      return text
    }
    // User-shaped entry with no text contribution — fall through to the
    // next-earlier user message.
  }
  return ""
}

function extractUserText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const part of content) {
    if (typeof part === "string") {
      out += part
    } else if (part && typeof part === "object" && typeof part.text === "string") {
      // Skip parts with an explicit non-text type (tool / file / reasoning
      // parts may carry a `text` field but are not user prose).
      if (part.type !== undefined && part.type !== "text") continue
      out += part.text
    }
  }
  return out
}
