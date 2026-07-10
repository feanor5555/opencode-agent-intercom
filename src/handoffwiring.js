// Live wiring for the primary (orchestrator) context-refresh handoff — the
// bridge between the pure, client-free handoff sequence in handoff.js and the
// live client / registry / project plumbing. Kept OUT of handoff.js on purpose:
// handoff.js stays dependency-injected and unit-testable without a runtime; the
// client-coupled wiring lives here and is exercised end-to-end.

import {
  performPrimaryHandoff,
  runScheduledHandoff,
  lastUserGoal,
  requestDocSummaries,
  DOC_SUMMARY_PROMPT,
} from "./handoff.js"
import {
  claimPendingHandoff,
  releaseHandoff,
  inFlightSubagentsFor,
  reparentSubagents,
  forgetPrimary,
  beginHandoffDrain,
  bindHandoffDrainTarget,
  flushHandoffDrain,
  abortHandoffDrain,
  handoffGeneration,
} from "./registry.js"
import {
  fetchSnapshot,
  fetchMessages,
  postNotice,
  showToast,
  deleteSession,
  archiveSession,
  getSessionDirectory,
  createChildSession,
  promptSession,
} from "./client.js"
import { readPlannedSteps, formatPrimarySummary, writePrimarySummary } from "./project.js"
import { log, errMsg } from "./log.js"

// Orchestrator agent name passed to the new session in the handoff. The
// README + package.json declare "orchestrator" as the default primary agent;
// FLAGGED: a project that overrides `default_agent` in opencode.json will not
// be honored here — runtime verification required.
const ORCHESTRATOR_AGENT_NAME = "orchestrator"

// Idle-gated handoff, execution side. Called from the `session.idle` event
// for EVERY idle session (subagent idles are a cheap no-op: only primary
// transforms ever set the pending flag). The claim is synchronous, so a
// duplicate idle event — or an idle racing an executing handoff, e.g. the
// old primary going idle again after its doc-summary turn — cannot start a
// second handoff. Runs detached from the event handler (the full handoff
// includes a ~2-minute-capped doc-summary poll; blocking the event stream
// on it would starve subagent wakes).
//
// Because execution now starts on idle, the old primary has ALREADY fully
// answered the triggering user message when the handoff begins: the answer
// is produced and delivered by the OLD session (exactly one responder), and
// the doc-summary prompt hits an idle session instead of queuing behind a
// busy turn.
//
// Success clears the in-progress latch via deps.forgetPrimary (inside the
// handoff sequence); failure clears it via releaseHandoff inside
// runScheduledHandoff, so a later over-budget turn re-schedules and the next
// idle retries.
export function maybeRunPendingHandoff(client, sessionID) {
  return runScheduledHandoff({
    claim: () => claimPendingHandoff(sessionID),
    release: () => releaseHandoff(sessionID),
    getDeps: async () =>
      buildPrimaryHandoffDeps(client, sessionID, await getSessionDirectory(client, sessionID)),
    perform: async (deps) => {
      showToast(client, {
        title: "agent-intercom",
        message: "primary context limit reached — handing off to a fresh orchestrator",
      })
      const result = await performPrimaryHandoff(deps)
      showToast(client, {
        title: "agent-intercom",
        message: `handoff complete — new session ${result.newSessionID}, ${result.reparented} subagent(s) reparented`,
      })
      return result
    },
  })
}

// Assembles the dependency object for performPrimaryHandoff — the bridge
// between the pure handoff sequence (handoff.js) and the live client /
// registry / project plumbing. Extracted from the transform hook when the
// trigger moved to the idle event; the content is unchanged.
function buildPrimaryHandoffDeps(client, sessionID, sessionDir) {
  return {
    primarySessionID: sessionID,
    directory: sessionDir,
    orchestratorAgentName: ORCHESTRATOR_AGENT_NAME,
    getInFlightSubagents: inFlightSubagentsFor,
    getPlannedSteps: readPlannedSteps,
    // The last user goal is fetched from the old primary's own message
    // history via the session API (the transform hook input carries no
    // `messages` field, and by execution time we are in the event hook
    // anyway). fetchMessages is best-effort ([] on failure) → empty goal,
    // never a failed handoff. Since the handoff now runs at idle, the
    // triggering user message has been persisted and answered — it IS the
    // newest user message here.
    getLastUserGoal: async () => lastUserGoal(await fetchMessages(client, sessionID)),
    formatPrimarySummary,
    writePrimarySummary,
    // handoff.js calls `createSession({ agent })`; client.js exposes
    // `createChildSession(client, { parentID, title, directory })`.
    // We bridge the two shapes here. CRITICAL: parentID is OMITTED
    // on purpose so orchestrator2 is created as a ROOT/independent
    // session in opencode — NOT a child of orchestrator1. If we
    // passed parentID=sessionID, opencode would treat orchestrator2
    // as a child and the subsequent deleteSession(orchestrator1)
    // would CASCADE-DELETE orchestrator2 along with it, destroying
    // the very session the handoff just created. The SDK's
    // SessionCreateData declares parentID as optional (types.gen.d.ts
    // SessionCreateData.body.parentID?: string), so omitting it gives
    // us a root session — exactly what we want for a true handoff.
    // Subagent reparenting uses the PLUGIN's own registry parentID
    // field and is unrelated to opencode's session tree.
    createSession: () =>
      createChildSession(client, {
        title: `orchestrator#${handoffGeneration(sessionID) + 1} (handoff from ${sessionID})`,
        directory: sessionDir,
      }),
    // handoff.js calls `promptAsync(sessionID, message)`; client.js
    // exposes `promptSession(client, { sessionID, agent, prompt })`.
    // We bridge: the kickoff message must set `agent` so opencode
    // routes the first turn to the orchestrator role for the new
    // (otherwise empty) session.
    promptAsync: (sid, message) =>
      promptSession(client, {
        sessionID: sid,
        agent: ORCHESTRATOR_AGENT_NAME,
        prompt: message,
      }),
    // Ask the OLD primary (#1, which still holds PROJECT.md / TODO.md /
    // ARCHITECTURE.md in its context) to emit the three per-file summaries
    // plus the Session-Verlauf history block in one final turn. The old
    // primary is idle at this point, so the prompt starts immediately
    // instead of queuing behind an in-flight turn.
    promptOldPrimaryForDocSummaries: () => promptOldPrimaryForDocSummaries(client, sessionID),
    // deleteSession is used ONLY for the orphaned NEW session on the failure
    // path — a root session created without a parentID, so it has no children
    // to cascade over. The OLD primary is retired via archiveSession (step 8)
    // to avoid opencode's recursive child-delete cascade over still-live
    // reparented subagents.
    deleteSession: (sid) => deleteSession(client, sid),
    archiveSession: (sid) => archiveSession(client, sid),
    reparent: reparentSubagents,
    // Handoff delivery drain (registry.js): step 0 opens the buffer for the
    // old primary, step 2 binds the new session into it. While the drain is
    // open, postParentNotice buffers every subagent notice addressed to
    // either session instead of posting — see the router doc-comments.
    beginDrain: () => beginHandoffDrain(sessionID),
    bindDrainTarget: (newID) => bindHandoffDrainTarget(sessionID, newID),
    // Success path (step 7, after the kickoff was sent): close the drain,
    // install the old→new redirect, and deliver the buffered notices to the
    // NEW session in arrival order. Per-notice failures are logged and do
    // not stop the remaining notices (best-effort — the alternative would
    // drop everything behind the first transport hiccup).
    flushDrain: async () => {
      const flushed = flushHandoffDrain(sessionID)
      if (!flushed) return 0
      for (const notice of flushed.notices) {
        try {
          await postNotice(client, flushed.newID, notice)
        } catch (err) {
          log("handoff flushDrain: notice delivery failed", {
            target: flushed.newID,
            err: errMsg(err),
          })
        }
      }
      return flushed.notices.length
    },
    // Failure path: close the drain WITHOUT a redirect and deliver the
    // buffered notices back to the OLD primary — it survives a failed
    // handoff and remains the live orchestrator. Best-effort per notice.
    abortDrain: async () => {
      const drained = abortHandoffDrain(sessionID)
      if (!drained) return 0
      for (const notice of drained.notices) {
        try {
          await postNotice(client, sessionID, notice)
        } catch (err) {
          log("handoff abortDrain: notice delivery failed", {
            target: sessionID,
            err: errMsg(err),
          })
        }
      }
      return drained.notices.length
    },
    // registry.forgetPrimary also clears the pending/in-progress handoff
    // flags for the old id — the success-path release.
    forgetPrimary,
  }
}

// Asks the OLD primary (#1) — which still holds PROJECT.md / TODO.md /
// ARCHITECTURE.md in its context from its original kickoff — to emit three
// short per-file summaries plus a session-history summary (Session-Verlauf)
// in one final turn. The new orchestrator (#2) embeds those blocks into its
// kickoff message and starts its life with full context WITHOUT having to
// re-read the docs from disk.
//
// Flow (implemented by `requestDocSummaries` in handoff.js — injectable
// core, so the baseline/poll discipline is unit-testable without a runtime):
//   1. BASELINE: read the old primary's CURRENT final result BEFORE sending
//      the prompt. Without it the first poll returns the primary's PREVIOUS
//      answer as if it were the summaries (live-verified bug — the summary
//      prompt never reached an LLM and the kickoff fell back).
//   2. `promptSession` the OLD primary with `DOC_SUMMARY_PROMPT`. Non-blocking
//      (the SDK returns once the request is queued, 204-style). The handoff
//      fires mid-turn, so this queues BEHIND the in-flight user turn.
//   3. Poll `fetchSnapshot` until the final result has CHANGED from the
//      baseline AND looks like the summaries reply (`## PROJECT.md —`). A
//      changed-but-foreign result is the interrupted in-flight turn's reply —
//      re-baseline and keep waiting for the summary turn behind it.
//   4. Return the raw text. `performPrimaryHandoff` runs it through
//      `validateDocSummaries` so the kickoff stays well-formed even if the
//      LLM gave us a malformed / partial reply.
//
// Failure modes (all re-thrown so the handoff can fall back):
//   - The session was already deleted (opencode returns 404) → snapshot
//     returns {} → no result ever changes → timeout → we throw.
//   - The LLM is slow / the provider is down → polling times out after
//     DOC_SUMMARIES_TIMEOUT_MS (handoff.js, 120 s — sized for a measured
//     42 s in-flight turn plus the summary turn itself) → we throw.
//   - The session never produced a summaries-shaped reply in the window
//     (e.g. the prompt was rejected) → timeout → we throw.
//
// In every failure case the handoff's `try/catch` replaces the
// `docSummaries` block with `FALLBACK_DOC_SUMMARIES` so the kickoff still
// lands. The handoff itself never throws out.
async function promptOldPrimaryForDocSummaries(client, primarySessionID) {
  if (!client || !primarySessionID) {
    throw new Error("promptOldPrimaryForDocSummaries: missing client or primarySessionID")
  }
  return requestDocSummaries({
    fetchResult: async () => (await fetchSnapshot(client, primarySessionID))?.result,
    sendPrompt: () =>
      promptSession(client, {
        sessionID: primarySessionID,
        agent: ORCHESTRATOR_AGENT_NAME,
        prompt: DOC_SUMMARY_PROMPT,
      }),
  })
}
