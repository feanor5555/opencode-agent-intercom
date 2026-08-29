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
  looksLikeDocSummariesReply,
  looksLikeOpenPointsReply,
  DOC_SUMMARY_PROMPT,
  OPEN_POINTS_PROMPT,
} from "./handoff.js"
import { runEndlessCycle } from "./endless.js"
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
  sessionAgentName,
  hasEndlessPending,
  cancelPendingEndless,
  claimPendingEndless,
  releaseEndless,
  setEndlessCooldown,
  isQuiesced,
  recordEndlessCycle,
  countActiveSubagents,
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
  selectTuiSession,
} from "./client.js"
import { addTask, listOpen, findTodoFile, TodoFileMissingError } from "./todofile.js"
import { getSettings, writeEndlessMode } from "./settings.js"
import { defaultAgentName, DEFAULT_AGENT } from "./agents.js"
import { knownAgentKinds } from "./config.js"
import { readPlannedSteps, formatPrimarySummary, writePrimarySummary } from "./project.js"
import { log, errMsg } from "./log.js"

// The agent a replacement primary runs as: the name opencode resolved for the
// old primary's current session, recorded by the `chat.message` hook. This is
// the session's actual role, not merely the process default; a user can select
// a different primary agent for an individual session. Before that hook has
// run, the captured `default_agent` remains the fallback identification rung.
//
// The name must be one opencode can actually route a session to. A project or
// session name that nothing resolves would fail the kickoff and with it the
// whole handoff, so every non-plugin role is confirmed against the resolved
// agent list first — the same cached read the spawn refusal uses. `DEFAULT_AGENT`
// needs no confirmation: installAgents writes that role into every config.
//
// Unconfirmable means fall back, not fail: knownAgentKinds yields an empty map
// on a server without the route or a transport error, and replacing the primary
// with this plugin's own role is what the handoff did before it consulted the
// name at all. `directory` keeps the default fallback tied to the same project
// when one process serves more than one configured instance.
export async function handoffAgentName(client, sessionID, directory) {
  const name = sessionAgentName(sessionID) ?? defaultAgentName(directory)
  if (name === DEFAULT_AGENT) return name
  const kinds = await knownAgentKinds(client)
  if (kinds.has(name)) return name
  log("handoff: session agent is not a resolved agent, using the plugin role", {
    agent: name,
    using: DEFAULT_AGENT,
  })
  return DEFAULT_AGENT
}

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
// registry / project plumbing. Async for one reason: the agent the replacement
// primary runs as may have to be confirmed against the resolved agent list.
async function buildPrimaryHandoffDeps(client, sessionID, sessionDir, resolvedAgentName) {
  // Resolve once for the whole handoff, so the name the deps carry and every
  // prompt it routes cannot diverge. Endless mode supplies the name it already
  // resolved for its open-points turn; the plain path resolves it here.
  const agentName =
    resolvedAgentName ?? (await handoffAgentName(client, sessionID, sessionDir))
  return {
    primarySessionID: sessionID,
    directory: sessionDir,
    orchestratorAgentName: agentName,
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
    // `hideable`: the kickoff is traffic between the plugin and the fresh
    // orchestrator, so it follows the `hideChatter` setting.
    promptAsync: (sid, message) =>
      promptSession(client, {
        sessionID: sid,
        agent: agentName,
        prompt: message,
        hideable: true,
      }),
    // Point the TUI at the new session right after the kickoff (handoff step
    // 6b). Best-effort inside client.js — it never throws into the handoff.
    // Wired for the plain handoff too: it has the same gap, and a user left on
    // the archived session sees an orchestrator that has stopped answering.
    selectTuiSession: (sid) => selectTuiSession(client, sid),
    // Ask the OLD primary (#1, which still holds PROJECT.md / TODO.md /
    // ARCHITECTURE.md in its context) to emit the three per-file summaries
    // plus the Session-Verlauf history block in one final turn. The old
    // primary is idle at this point, so the prompt starts immediately
    // instead of queuing behind an in-flight turn.
    promptOldPrimaryForDocSummaries: () =>
      promptOldPrimaryFor(client, sessionID, agentName, {
        prompt: DOC_SUMMARY_PROMPT,
        looksLikeReply: looksLikeDocSummariesReply,
      }),
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

// Asks the primary that is about to be replaced for ONE more shaped turn, and
// waits for it. Both final turns the plugin takes out of a dying primary go
// through here, differing only in the prompt and the shape check:
//
//   - DOC_SUMMARY_PROMPT / looksLikeDocSummariesReply — the plain handoff.
//     #1 still holds PROJECT.md / TODO.md / ARCHITECTURE.md in its context
//     from its original kickoff and emits three short per-file summaries plus
//     a session-history summary (Session-Verlauf). The new orchestrator (#2)
//     embeds those blocks into its kickoff message and starts its life with
//     full context WITHOUT having to re-read the docs from disk.
//   - OPEN_POINTS_PROMPT / looksLikeOpenPointsReply — the endless cycle.
//     Everything still open, in the todo file's own two-line shape, so the
//     plugin can write the points itself.
//
// Flow (implemented by `requestDocSummaries` in handoff.js — injectable
// core, so the baseline/poll discipline is unit-testable without a runtime):
//   1. BASELINE: read the old primary's CURRENT final result BEFORE sending
//      the prompt. Without it the first poll returns the primary's PREVIOUS
//      answer as if it were the reply (live-verified bug — the summary prompt
//      never reached an LLM and the kickoff fell back).
//   2. `promptSession` the OLD primary with `prompt`. Non-blocking (the SDK
//      returns once the request is queued, 204-style). The plain handoff fires
//      mid-turn, so this queues BEHIND the in-flight user turn.
//   3. Poll `fetchSnapshot` until the final result has CHANGED from the
//      baseline AND passes `looksLikeReply`. A changed-but-foreign result is
//      the interrupted in-flight turn's reply — re-baseline and keep waiting
//      for the turn queued behind it.
//   4. Return the raw text.
//
// Failure modes (all re-thrown so the caller can fall back):
//   - The session was already deleted (opencode returns 404) → snapshot
//     returns {} → no result ever changes → timeout → we throw.
//   - The LLM is slow / the provider is down → polling times out after
//     DOC_SUMMARIES_TIMEOUT_MS (handoff.js, 120 s — sized for a measured
//     42 s in-flight turn plus the summary turn itself) → we throw.
//   - The session never produced a shaped reply in the window (e.g. the
//     prompt was rejected) → timeout → we throw.
//
// What the two callers do with a throw differs, and that is the whole
// asymmetry between them: the handoff's own `try/catch` replaces the
// `docSummaries` block with `FALLBACK_DOC_SUMMARIES` and the kickoff still
// lands, while the endless cycle ABANDONS — replacing a primary after failing
// to save its open points is the data loss the mode exists to prevent.
async function promptOldPrimaryFor(client, primarySessionID, agentName, { prompt, looksLikeReply }) {
  if (!client || !primarySessionID) {
    throw new Error("promptOldPrimaryFor: missing client or primarySessionID")
  }
  return requestDocSummaries({
    fetchResult: async () => (await fetchSnapshot(client, primarySessionID))?.result,
    sendPrompt: async () =>
      promptSession(client, {
        sessionID: primarySessionID,
        agent: agentName,
        prompt,
        hideable: true,
      }),
    looksLikeReply,
  })
}

// Idle-gated endless cycle, execution side. Called from the `session.idle`
// event for EVERY idle session, beside maybeRunPendingHandoff: a session with
// no endless latch leaves here after one synchronous set lookup, before any
// session-API call is made. The real, atomic claim happens inside
// runEndlessCycle — the cheap pre-check only keeps the idle path free of an
// HTTP round trip for every subagent that finishes.
//
// Runs detached from the event handler like the plain handoff, and for a
// stronger reason: a cycle waits for quiesce (up to endlessQuiesceTimeoutMs),
// then takes a final turn out of the old primary, then runs the whole handoff.
// runEndlessCycle never throws, so `void`-calling it cannot hide a rejection.
//
// Success releases the in-progress latch through the handoff's forgetPrimary;
// every abandon path releases it inside runEndlessCycle and arms the cooldown.
export async function maybeRunPendingEndless(client, sessionID) {
  if (!hasEndlessPending(sessionID)) return null
  const { endlessMode, endlessQuiesceTimeoutMs, endlessMaxCycles } = getSettings()
  // Stop #5, the switch: the latch is usually set during the very turn that
  // crosses the ceiling and this idle follows it immediately, so the transform
  // hook's off-branch — which needs ANOTHER turn from the primary — is not a
  // reachable stop for a user who sees the toast and turns the row off. Read
  // here, before the claim, so a cycle already executing is untouched.
  if (!endlessMode) {
    cancelPendingEndless(sessionID)
    log("endless: latch dropped — the mode was switched off before the cycle started", { sessionID })
    return null
  }
  // The session's OWN directory, not the factory closure's: sessions created
  // with ?directory=… land in a different project but share the same factory
  // ctx, and the todo file this cycle writes must be that project's.
  const directory = await getSessionDirectory(client, sessionID)
  // Resolve the session's actual agent once and reuse it for both the
  // open-points prompt and the replacement kickoff.
  const agentName = await handoffAgentName(client, sessionID, directory)
  return runEndlessCycle({
    primarySessionID: sessionID,
    claim: () => claimPendingEndless(sessionID),
    release: () => releaseEndless(sessionID),
    setCooldown: () => setEndlessCooldown(sessionID),
    isQuiesced: () => isQuiesced(sessionID),
    countActive: () => countActiveSubagents(),
    requestOpenPoints: () =>
      promptOldPrimaryFor(client, sessionID, agentName, {
        prompt: OPEN_POINTS_PROMPT,
        looksLikeReply: looksLikeOpenPointsReply,
      }),
    addTask: (point) => addTask(directory, point),
    // A directory with NO todo file at all is the greenfield state addTask
    // creates over, so it reads as an empty list here. "several todo files"
    // and "not a regular file" are NOT greenfield — they propagate and the
    // cycle abandons rather than writing into a directory a human has to
    // sort out first.
    listOpen: () => {
      try {
        return listOpen(directory)
      } catch (err) {
        if (err instanceof TodoFileMissingError && err.kind === "missing") return []
        throw err
      }
    },
    todoFileName: () => {
      try {
        return findTodoFile(directory).name
      } catch {
        return ""
      }
    },
    // The plain handoff with two dependencies replaced: the endless kickoff
    // block, and the doc-summary turn standing down. Asking a session at its
    // context ceiling for a second long turn is what the open-points turn
    // already was; the text we have is handed back instead, so
    // validateDocSummaries' fallback block lands in the kickoff and the new
    // orchestrator reads the documents itself — it has the context to.
    performHandoff: async ({ extraKickoffBlock, openPointsText }) =>
      performPrimaryHandoff({
        ...(await buildPrimaryHandoffDeps(client, sessionID, directory, agentName)),
        extraKickoffBlock,
        promptOldPrimaryForDocSummaries: async () => openPointsText,
      }),
    cycleNumber: handoffGeneration(sessionID),
    maxCycles: endlessMaxCycles,
    switchOff: () => writeEndlessMode(false),
    recordCycle: recordEndlessCycle,
    toast: ({ message, variant }) => showToast(client, { title: "agent-intercom", message, variant }),
    quiesceTimeoutMs: endlessQuiesceTimeoutMs,
  })
}

