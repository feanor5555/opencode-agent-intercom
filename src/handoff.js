// Slice 6a: pure orchestrator-handoff orchestration.
//
// This module is INTENTIONALLY side-effect free at import time. It imports no
// other plugin modules (no hooks.js, no client.js, no registry.js, no
// project.js, no state.js). Every operation the handoff needs is injected via
// `deps`, which makes the whole sequence testable in isolation against
// recording fakes — no opencode runtime, no I/O, no SDK calls.
//
// Sequence (do NOT reorder):
//   1. Gather in-flight subagents, planned steps, and the last user goal.
//   2. Build a summary object with a stand-up line, reparented-subagent notes
//      and the planned-step list (all sections stay defined even when empty).
//   3. Format the summary as markdown and write it under the working dir.
//   4. Create the new orchestrator session BEFORE any reparent/delete — the
//      new id is needed by reparent, and we must not delete the old primary
//      until its in-flight children have been re-pointed at the new one.
//   5. Ask the OLD primary (#1, which still holds PROJECT.md / TODO.md /
//      ARCHITECTURE.md in its context) to emit three concise per-file
//      summaries; the new orchestrator's kickoff message embeds the
//      stand-up summary + those three summaries — no re-read of disk.
//   6. Reparent all in-flight subagents of the old primary onto the new one.
//   7. Delete the old primary session.
//   8. Drop the old primary from the primary-tracking maps (forgetPrimary).
//   9. Return { newSessionID, reparented, summaryMarkdown }.
//
// See test/handoff.test.js for the recording-fake harness that exercises this.
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
// @property {(parentID: string) => InFlightSubagent[]} getInFlightSubagents
// @property {(directory: string) => string[]} getPlannedSteps
// @property {() => string} getLastUserGoal
// @property {(s: PrimarySummary) => string} formatPrimarySummary
// @property {(directory: string, md: string) => void} writePrimarySummary
// @property {(opts: { agent: string }) => Promise<string>} createSession
// @property {(sessionID: string, message: string) => Promise<void>} promptAsync
// @property {(fromID: string, toID: string) => Promise<number>} reparent
// @property {(sessionID: string) => Promise<void>} deleteSession
// @property {(sessionID: string) => void} forgetPrimary
// @property {() => Promise<string>} promptOldPrimaryForDocSummaries
//
// @param {PrimaryHandoffDeps} deps
// @returns {Promise<{ newSessionID: string, reparented: number, summaryMarkdown: string }>}
export async function performPrimaryHandoff(deps) {
  // 1. Gather.
  const inFlight = await deps.getInFlightSubagents(deps.primarySessionID)
  const steps = deps.getPlannedSteps(deps.directory)
  const goal = deps.getLastUserGoal()

  // 2. Build summary. Sections are always present (possibly empty) so the
  // markdown stays well-formed even with no in-flight subagents and no goal.
  const safeGoal = goal || ""
  const stand = inFlight.length > 0
    ? `Letztes Ziel: ${safeGoal} (${inFlight.length} Subagent(s) wurden re-parented)`
    : `Letztes Ziel: ${safeGoal}`

  const notes = [
    "Diese Subagents liefern jetzt an diese Session:",
    ...inFlight.map((s) => `${s.handle} (${s.agent}): ${s.task}`),
  ]

  const summaryObj = { stand, notes, plannedSteps: steps }

  // 3. Render + persist.
  const md = deps.formatPrimarySummary(summaryObj)
  deps.writePrimarySummary(deps.directory, md)

  // 4. Create orchestrator #2 BEFORE reparent (reparent needs the new id).
  const newID = await deps.createSession({ agent: deps.orchestratorAgentName })

  // 5. Ask the OLD primary (#1) — which still has PROJECT.md / TODO.md /
  // ARCHITECTURE.md in its context — to produce three short per-file
  // summaries in one final turn. The new orchestrator (#2) is a fresh
  // session with no prior state; the kickoff embeds the stand-up summary
  // plus those three summaries so #2 starts with full context WITHOUT
  // having to re-read the docs from disk.
  //
  // GRACEFUL DEGRADATION: if #1 is unavailable, the helper throws (e.g. the
  // session was already torn down, the provider is down, the LLM timed out).
  // We catch and fall back to a placeholder three-section block so the
  // kickoff message always stays well-formed. The handoff itself must
  // never throw — the rest of the sequence (reparent, delete, forget) still
  // has to run.
  //
  // validateDocSummaries is also defensive on the happy path: if #1 replies
  // with a malformed / partial / out-of-order block, the helper extracts
  // the recognised sections in canonical order and falls back to the
  // placeholder for any missing one. The kickoff never depends on the
  // helper's specific shape.
  let docSummaries
  try {
    const raw = await deps.promptOldPrimaryForDocSummaries()
    docSummaries = validateDocSummaries(raw)
  } catch (err) {
    docSummaries = FALLBACK_DOC_SUMMARIES
  }

  const kickoffMessage = md + "\n\n" + docSummaries

  await deps.promptAsync(newID, kickoffMessage)

  // 6. Move in-flight subagents of the old primary onto the new orchestrator.
  const reparented = await deps.reparent(deps.primarySessionID, newID)

  // 7. Now — and only now — delete the old primary session.
  await deps.deleteSession(deps.primarySessionID)

  // 8. Drop the old primary from primarySessions / primaryCtx maps.
  deps.forgetPrimary(deps.primarySessionID)

  // 9. Return the handoff result.
  return { newSessionID: newID, reparented, summaryMarkdown: md }
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
  "plain-text reply containing EXACTLY three sections, in this order, with these EXACT headings " +
  "(no extra prose, no tool calls, no code blocks):\n\n" +
  "## PROJECT.md — <one or two sentences capturing the project index, the goals, the agent " +
  "interop + OpenDesign direction, max ~400 characters>\n\n" +
  "## TODO.md — <one or two sentences capturing the current task list focus / " +
  "open work, max ~400 characters>\n\n" +
  "## ARCHITECTURE.md — <one or two sentences capturing the canonical software-architecture " +
  "facts the new orchestrator must know to make good decisions, max ~400 characters>\n\n" +
  "Use ONLY what you already have in context — do NOT read files from disk. Plain text reply, " +
  "no `read`/`bash`/`glob`/`grep` tool calls, no preamble, no postscript, no markdown other than " +
  "the three `## …` headings above. Start your reply with `## PROJECT.md —` literally."

// Section cap on each per-file summary. Mirrors the "~400 characters" the
// prompt instructs; used by `validateDocSummaries` to truncate runaway
// replies so the kickoff message stays bounded even when #1 ignores the cap.
export const DOC_SUMMARY_MAX_CHARS = 400

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

function capChars(text, max) {
  if (typeof text !== "string" || text.length <= max) return text
  return text.slice(0, max - 1).replace(/\s+$/, "") + "…"
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Pure helper: extract the text of the LAST message with role === "user"
// from an opencode-shaped message array. Used to seed the handoff summary's
// stand-up line (`Letztes Ziel: …`).
//
// `messages[i].content` may be either a plain string OR an array of content
// parts. Parts can be either strings or objects with a `text` field (and a
// `type` of e.g. "text" — other part types like "image" have no `text` and
// are skipped). We concatenate the text fragments with no separator — opencode
// itself concatenates parts when rendering a message, and the goal is one
// line of plain text for the summary, not a faithful transcript.
//
// Robust to malformed entries: anything that isn't a plain object with a
// string `role` is skipped. A user-shaped entry whose `content` yields an
// empty string (missing / non-string / non-array / array of non-text parts)
// is treated as "no text" and the scan falls through to the next-earlier
// user message — so a leading "image-only" user turn doesn't blank the goal.
//
// Output is trimmed of trailing whitespace and capped at 500 chars (with a
// trailing "…" when capped) so the summary line stays bounded even when the
// last user message was a multi-paragraph request.
const LAST_USER_GOAL_MAX = 500

export function lastUserGoal(messages) {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== "object") continue
    if (m.role !== "user") continue
    const text = extractUserText(m.content).replace(/\s+$/, "")
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
      out += part.text
    }
  }
  return out
}
