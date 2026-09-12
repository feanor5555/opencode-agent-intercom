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
  looksLikeWindDownReply,
  interpretWindDownReply,
  WIND_DOWN_PROMPT,
  DOC_SUMMARY_PROMPT,
  DOC_SUMMARIES_POLL_MS,
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
  pauseEndless,
  isEndlessPaused,
  isQuiesced,
  recordEndlessCycle,
  countActiveSubagentsFor,
  createWindDownToken,
  armEndlessWindDown,
  endlessWindDownPermit,
  disarmEndlessWindDown,
  upsertSession,
} from "./registry.js"
import {
  fetchSnapshot,
  fetchMessages,
  getSessionTitle,
  showToast,
  deleteSession,
  archiveSession,
  getSessionDirectory,
  createChildSession,
  promptSession,
  selectTuiSession,
  abortSession,
} from "./client.js"
import { dropRetainedSubagents, teardownSubagent, SUBAGENT_SESSION_TITLE_MARKER } from "./teardown.js"
import { deliverParentNotice } from "./noticejournal.js"
import { secureSubagentState } from "./resultfile.js"
import {
  prepareTodoFile,
  readTodoFileNamed,
  writeTodoFile,
  parseTasks,
  splitSections,
} from "./todofile.js"
import { registerChildWaiter, settleChildWaiter } from "./childwait.js"
import { windDownSubagentPrompt } from "./prompts.js"
import { createHash } from "node:crypto"
import { getSettings, soloModeActive } from "./settings.js"
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
//
// Exported so the wiring itself can be pinned against the doubles handoff.js is
// tested with: handoff.js's failure paths are written for a `promptAsync` that
// REJECTS on a refused kickoff and a `createSession` that answers undefined on
// a refused create, and only a test that builds these real deps over a fake
// client can show the production bridge behaves that way.
export async function buildPrimaryHandoffDeps(client, sessionID, sessionDir, resolvedAgentName) {
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
    // handoff.js calls `createSession({ agent })` and wants the id or
    // `undefined`; client.js exposes `createChildSession(client, { parentID,
    // title, directory })`, answering `{ sessionID }` or `{ error }`. We bridge
    // the two shapes here — a refused create has no `sessionID`, which is the
    // `undefined` handoff.js's own guard is written for. A successor carries
    // the predecessor's own title unchanged; when the predecessor has no title,
    // `createChildSession` omits the field and opencode supplies its default.
    // CRITICAL: parentID is OMITTED on purpose so the successor is created as a
    // ROOT/independent session in opencode — NOT a child of the predecessor. If
    // we passed parentID=sessionID, opencode would treat the successor as a
    // child and deleting the predecessor would CASCADE-DELETE the successor
    // along with it. The SDK's SessionCreateData declares parentID as optional,
    // so omitting it gives us a root session — exactly what we want for a true
    // handoff. Subagent reparenting uses the PLUGIN's own registry parentID
    // field and is unrelated to opencode's session tree.
    createSession: async () => {
      const title = await getSessionTitle(client, sessionID)
      return (
        await createChildSession(client, {
          ...(title === undefined ? {} : { title }),
          directory: sessionDir,
        })
      ).sessionID
    },
    // handoff.js calls `promptAsync(sessionID, message)`; client.js
    // exposes `promptSession(client, { sessionID, agent, prompt })`.
    // We bridge: the kickoff message must set `agent` so opencode
    // routes the first turn to the orchestrator role for the new
    // (otherwise empty) session.
    // `hideable`: the kickoff is traffic between the plugin and the fresh
    // orchestrator, so it follows the `showAgentcom` setting.
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
    // The orphan is the session the user would be looking at only if the view
    // had already been switched to it, which happens after the kickoff; the
    // OLD primary is where they belong back either way, and it is still there
    // — a failed handoff does not retire it.
    deleteSession: (sid) => deleteSession(client, sid, { parentID: sessionID, cause: "handoff-orphan" }),
    archiveSession: (sid) => archiveSession(client, sid),
    // Step 4b, the escape hatch for a step 3 that gave up.
    // `promptOldPrimaryForDocSummaries` gives up after
    // DOC_SUMMARIES_TIMEOUT_MS, but the prompt it sent was accepted by the
    // server and the old primary keeps generating: without this the handoff
    // walks on and starts the kickoff turn on the successor while the
    // predecessor is still producing tokens. `archiveSession` (step 8) only
    // stamps a timestamp and stops nothing, so the abort has to be its own
    // call. handoff.js issues it only AFTER the reparent, when the old session
    // has an empty subtree and the handoff can no longer fall back onto it —
    // see step 4b there. Reported like every other client call here — it
    // answers a boolean and never throws.
    abortSession: (sid) => abortSession(client, sid),
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
          // Durable delivery, like every other parent notice: these ARE the
          // subagent notices postParentNotice buffered, only re-addressed to
          // the successor, and a flush lost to an accepted-but-never-persisted
          // post loses the same ending. The routing decision was already taken
          // when they were buffered, so they go straight to the delivery rather
          // than back through the router (src/noticejournal.js).
          await deliverParentNotice(client, flushed.newID, notice, {
            kind: "handoff-flush",
            requestedFor: sessionID,
          })
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
          await deliverParentNotice(client, sessionID, notice, {
            kind: "handoff-drain-abort",
            requestedFor: sessionID,
          })
        } catch (err) {
          log("handoff abortDrain: notice delivery failed", {
            target: sessionID,
            err: errMsg(err),
          })
        }
      }
      return drained.notices.length
    },
    // Handoff step 0b: the retained subagents of the primary being replaced go
    // before anything else happens. Their sessions are deleted, not merely
    // forgotten — nothing outside this plugin ever deletes a subagent session.
    // Runs on every handoff at the shipped default of `maxRetainedSubagents:
    // 2`; a no-op only under the rollback `maxRetainedSubagents: 0`, which
    // retains nothing.
    dropRetainedSubagents: () => dropRetainedSubagents(client, { label: "handoff" }),
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
//   - WIND_DOWN_PROMPT / looksLikeWindDownReply — the endless cycle.
//     Asks #1 to spawn a `planner` through the one-time permit; that child
//     rewrites the todo file itself. The turn does not return until the child
//     has settled, so its ceiling is the whole wind-down window, and its reply
//     is the `## WIND-DOWN DONE — <n> open` line the plugin then verifies.
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
async function promptOldPrimaryFor(
  client,
  primarySessionID,
  agentName,
  { prompt, looksLikeReply, timeoutMs },
) {
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
    // The wind-down turn does not return until the child it spawns has finished
    // rewriting the file, so its ceiling is the whole wind-down window, not the
    // doc-summary default. Left undefined for the plain doc-summary turn.
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

// The role the wind-down subagent runs as. `planner` already holds read /
// write / edit / glob / grep and the todo tools and nothing that could delegate
// or reach the web or a shell, which is exactly the job.
const WIND_DOWN_AGENT = "planner"

// The failure-path fallback of §5: the plugin starts the wind-down subagent
// itself, with the same role, prompt shape and waiter the orchestrator's
// permitted spawn would have produced — differing only in WHO calls it. Reached
// once, after the permit has been disarmed, when the primary placed no shaped
// reply and never consumed the permit. `payload` is whatever final text the
// primary last produced; the child prompt caps it and wraps it in the hand-over
// heading. Returns `{ childSessionID, settlement }`; throws when no child could
// be started, which the cycle turns into an abandon.
async function startWindDownSubagent(client, primarySessionID, directory, payload) {
  const title = `${WIND_DOWN_AGENT}: endless wind-down`
  const { sessionID, error } = await createChildSession(client, {
    parentID: primarySessionID,
    title: SUBAGENT_SESSION_TITLE_MARKER + title,
    directory,
  })
  if (!sessionID) {
    throw new Error(error ? errMsg(error) : "createChildSession returned no session id")
  }
  // The waiter goes up before the prompt and before the entry is upserted, so
  // no window exists in which the child could end with nothing recording it.
  const window = getSettings().endlessWindDownTimeoutMs
  const settlement = registerChildWaiter(sessionID, primarySessionID, {
    timeoutMs: window > 0 ? Math.max(0, window - DOC_SUMMARIES_POLL_MS) : 0,
  })
  // The entry carries `windDown` so the completion path and the teardown both
  // suppress the wake notice, exactly as they do for the permitted spawn.
  upsertSession(sessionID, {
    agent: WIND_DOWN_AGENT,
    parentID: primarySessionID,
    directory,
    title,
    windDown: true,
  })
  try {
    await promptSession(client, {
      sessionID,
      agent: WIND_DOWN_AGENT,
      prompt: windDownSubagentPrompt(payload),
    })
  } catch (err) {
    settleChildWaiter(sessionID, { status: "error", agent: WIND_DOWN_AGENT, detail: errMsg(err) })
    try {
      await deleteSession(client, sessionID, {
        parentID: primarySessionID,
        cause: "wind-down-cleanup",
      })
    } catch {}
    throw err
  }
  return { childSessionID: sessionID, settlement }
}

// The settlement gate of §5: await the child's own ending, and where the waiter
// ceiling fired without the child ending (status "expired"), end the child —
// abort, then teardown, which removes the entry — and report the cycle as
// unsettled. Never lets the cycle confirm against a running writer, and never
// abandons leaving one alive.
async function settleWindDownChild(client, primarySessionID, child) {
  const outcome = await child.settlement
  if (outcome && outcome.status === "expired") {
    try {
      await abortSession(client, child.childSessionID)
    } catch (err) {
      log("endless: aborting an unsettled wind-down child failed", { err: errMsg(err) })
    }
    // The same mid-work securing rule every other reap follows: this child is
    // being ended in the middle of writing the handover, and its session is
    // about to go. What it managed is written to its result file first, and
    // where that could not be done the session is held rather than deleted —
    // an unsettled wind-down is exactly the case where the cycle needs to be
    // able to read what the writer got through.
    let recovered = { secured: true, path: null, holdReason: null }
    try {
      recovered = secureSubagentState(await fetchSnapshot(client, child.childSessionID), {
        handle: child.childSessionID,
        agent: WIND_DOWN_AGENT,
        sessionID: child.childSessionID,
        runs: 1,
        retained: false,
      })
    } catch (err) {
      log("endless: securing an unsettled wind-down child's state failed", { err: errMsg(err) })
    }
    try {
      await teardownSubagent(
        client,
        {
          sessionID: child.childSessionID,
          handle: child.childSessionID,
          parentID: primarySessionID,
          agent: WIND_DOWN_AGENT,
        },
        { markAborted: true, hold: !recovered.secured, label: "endless-wind-down" },
      )
    } catch (err) {
      log("endless: tearing down an unsettled wind-down child failed", { err: errMsg(err) })
    }
    return { ok: false, reason: "the wind-down child did not settle in the window" }
  }
  return { ok: true, outcome: outcome ?? {} }
}

// Drops an endless latch that has been set but not yet claimed, and says why.
// The spawn freeze lifts with it, so this is the only thing standing between a
// primary whose cycle will never start and a `spawn` that refuses for the life
// of the process.
//
// A cycle already claimed is untouched: cancelPendingEndless refuses one, and
// an executing cycle owns its own abandon discipline (releaseEndless + the
// cooldown, inside runEndlessCycle). No cooldown is armed here — nothing was
// attempted, so the next over-threshold turn may arm again at once.
export function dropEndlessLatch(sessionID, reason) {
  if (!hasEndlessPending(sessionID)) return false
  if (!cancelPendingEndless(sessionID)) return false
  log(`endless: latch dropped — ${reason}`, { sessionID })
  return true
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
// runEndlessCycle itself never throws, but the two session reads THIS function
// makes before the claim can: a rejection there is outside the cycle's abandon
// discipline, so it is caught here and drops the latch. The `void` call site
// (hooks.js) keeps a catch of its own as the backstop.
//
// Success releases the in-progress latch through the handoff's forgetPrimary;
// every abandon path releases it inside runEndlessCycle and arms the cooldown.
export async function maybeRunPendingEndless(client, sessionID) {
  if (!hasEndlessPending(sessionID)) return null
  const { endlessMode, endlessQuiesceTimeoutMs, endlessMaxCycles, endlessWindDownTimeoutMs } =
    getSettings()
  // Stop #5, the switch: the latch is usually set during the very turn that
  // crosses the ceiling and this idle follows it immediately, so the transform
  // hook's off-branch — which needs ANOTHER turn from the primary — is not a
  // reachable stop for a user who sees the toast and turns the row off. Read
  // here, before the claim, so a cycle already executing is untouched.
  if (!endlessMode) {
    dropEndlessLatch(sessionID, "the mode was switched off before the cycle started")
    return null
  }
  // Solo mode, at the executing end. The marking end already refuses to arm
  // there — endlessModeInEffect is false for the whole process (src/settings.js)
  // — so this is only reachable through a latch that predates the answer, and
  // it is here for the same reason the switch and the pause are checked at both
  // ends: the cycle takes a wind-down turn that has the primary spawn a
  // `planner`, and starts that child itself where the turn does not. Neither
  // may happen on a backend that serves one agent at a time.
  if (soloModeActive()) {
    dropEndlessLatch(sessionID, "solo mode runs no endless cycle")
    return null
  }
  // The same gate for the mode's own stop. scheduleEndlessIfNeeded already
  // refuses to arm a paused primary, so a latch can only be one that was set
  // before the pause — the turn that crossed the ceiling, with the stop landing
  // on the idle that followed. Dropping it here keeps the pause authoritative
  // at both ends, the mark and the execute.
  if (isEndlessPaused(sessionID)) {
    dropEndlessLatch(sessionID, "the mode is paused for this session")
    return null
  }
  // The two reads that stand BEFORE the claim, and the only awaits in this
  // function that are not inside runEndlessCycle's own discipline.
  // getSessionDirectory swallows its failures, but handoffAgentName awaits
  // knownAgentKinds (config.js), which has no guard of its own — and a
  // rejection escaping here would leave the latch set with nothing left to
  // clear it, i.e. `spawn` refused for the life of the process.
  let directory
  let agentName
  try {
    // The session's OWN directory, not the factory closure's: sessions created
    // with ?directory=… land in a different project but share the same factory
    // ctx, and the todo file this cycle writes must be that project's.
    directory = await getSessionDirectory(client, sessionID)
    // Resolve the session's actual agent once and reuse it for both the
    // open-points prompt and the replacement kickoff.
    agentName = await handoffAgentName(client, sessionID, directory)
  } catch (err) {
    dropEndlessLatch(sessionID, `the session could not be resolved: ${errMsg(err)}`)
    return null
  }
  return runEndlessCycle({
    primarySessionID: sessionID,
    claim: () => claimPendingEndless(sessionID),
    release: () => releaseEndless(sessionID),
    setCooldown: () => setEndlessCooldown(sessionID),
    isQuiesced: () => isQuiesced(sessionID),
    // Cycle step 2b: a retained subagent must not outlive the primary this
    // cycle replaces. Runs before the quiesce wait, so nothing is held alive
    // across a wait that may last `endlessQuiesceTimeoutMs`. The handoff this
    // cycle then performs drops them too — by that point there is nothing left
    // to drop, and both entry points stay correct on their own.
    dropRetained: () => dropRetainedSubagents(client, { label: "endless" }),
    // The figure the "quiesced after" log line reports: what this primary's
    // own wait was on when it began, scoped exactly as isQuiesced is.
    countActive: () => countActiveSubagentsFor(sessionID),
    // Resolve the todo file, lay the machine section down where it is missing
    // and WRITE it, then snapshot content + hash + parse + the drift count.
    // "several todo files" / "not a regular file" propagate as a throw the
    // cycle abandons on, rather than writing into a directory a human still has
    // to sort out; a directory with no todo file at all is created over.
    prepare: () => {
      const { name, content } = prepareTodoFile(directory)
      const tasks = parseTasks(content)
      const split = splitSections(content)
      const driftCount = split.valid
        ? tasks.filter((t) => t.lineIdx < split.beginIdx || t.lineIdx > split.endIdx).length
        : tasks.length
      const hash = createHash("sha256").update(content).digest("hex")
      return { fileName: name, content, hash, tasks, driftCount }
    },
    // Mint a per-cycle token and arm the single-use permit for the `planner`
    // spawn the freeze will admit. Returns the token the wind-down prompt
    // carries, or an empty object when the arm failed.
    armWindDown: () => {
      const token = createWindDownToken()
      const permit = armEndlessWindDown(sessionID, { token, agent: WIND_DOWN_AGENT })
      return permit ? { token } : {}
    },
    disarmWindDown: () => disarmEndlessWindDown(sessionID),
    // The wind-down turn: ask the primary to spawn the `planner` through the
    // permit. The call does not return until the child has rewritten the file,
    // so its ceiling is the whole wind-down window.
    windDownTurn: ({ token, fileName, driftCount }) =>
      promptOldPrimaryFor(client, sessionID, agentName, {
        prompt: WIND_DOWN_PROMPT(token, fileName, driftCount),
        looksLikeReply: looksLikeWindDownReply,
        timeoutMs: endlessWindDownTimeoutMs,
      }),
    windDownPermit: () => endlessWindDownPermit(sessionID),
    // The fallback: the plugin starts the wind-down subagent itself, with the
    // primary's last text as the hand-over. Reached only after the permit has
    // been disarmed.
    startWindDownSubagent: async () => {
      let payload = ""
      try {
        payload = (await fetchSnapshot(client, sessionID))?.result ?? ""
      } catch {}
      return startWindDownSubagent(client, sessionID, directory, payload)
    },
    settleWindDown: (child) => settleWindDownChild(client, sessionID, child),
    // V1 re-resolve after the wind-down: the resolved name and current content,
    // throwing "multiple" / "not-a-file" / "missing" so a file that split or
    // vanished under the cycle surfaces rather than reading as empty.
    reread: () => readTodoFileNamed(directory),
    interpretReply: (text) => interpretWindDownReply(text),
    restoreSnapshot: (content) => writeTodoFile(directory, content),
    parseTasks,
    splitSections,
    // The plain handoff with two dependencies replaced: the endless kickoff
    // block, and the doc-summary turn standing down. The wind-down reply is
    // handed back in place of a fresh doc-summary turn, so validateDocSummaries'
    // fallback block lands in the kickoff and the new orchestrator reads the
    // documents itself — it has the context to.
    performHandoff: async ({ extraKickoffBlock, docSummariesText }) =>
      performPrimaryHandoff({
        ...(await buildPrimaryHandoffDeps(client, sessionID, directory, agentName)),
        extraKickoffBlock,
        promptOldPrimaryForDocSummaries: async () => docSummariesText,
      }),
    cycleNumber: handoffGeneration(sessionID),
    maxCycles: endlessMaxCycles,
    // A stop pauses the mode for one primary session and never writes the
    // settings file: `endlessMode` is the user's switch, and the sidebar is the
    // only half that persists a change to it.
    pause: (pausedSessionID, reason) => pauseEndless(pausedSessionID, reason),
    recordCycle: recordEndlessCycle,
    toast: ({ message, variant }) => showToast(client, { title: "agent-intercom", message, variant }),
    quiesceTimeoutMs: endlessQuiesceTimeoutMs,
  })
}

