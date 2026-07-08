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
//   5. Prompt the new orchestrator with the summary + a directive to read
//      PROJECT.md / TODO.md / ARCHITECTURE.md (the new orchestrator is a
//      fresh session and reconstructs its world model from canonical docs).
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
//
// @param {PrimaryHandoffDeps} deps
// @returns {Promise<{ newSessionID: string, reparented: number, summaryMarkdown: string }>}
export async function performPrimaryHandoff(deps) {
  // 1. Gather.
  const inFlight = deps.getInFlightSubagents(deps.primarySessionID)
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

  // 5. Kickoff message: the summary markdown verbatim, plus a directive to
  // rebuild full context from the canonical docs (this is a fresh
  // orchestrator — it has no prior state).
  const kickoffMessage =
    md +
    "\n\n" +
    "Lies jetzt PROJECT.md, TODO.md und ARCHITECTURE.md im Arbeitsverzeichnis, " +
    "um den vollständigen Kontext zu rekonstruieren, bevor du fortfährst."

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
