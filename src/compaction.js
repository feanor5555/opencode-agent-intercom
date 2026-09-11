// Automatic compaction: the global switch this plugin writes into opencode's
// resolved config.
//
// opencode compacts a session when it crosses its own context threshold, and
// the decision reads ONE key: `compaction.auto`. There is no per-agent form of
// it — the agent-entry schema carries no compaction key, the overflow test
// reads the global value alone, and no hook can veto a compaction once it is
// started. The agent entry is not a substitute either: opencode's compaction
// path dereferences the fetched `compaction` agent without a guard, so a
// `disable: true` on it would turn an automatic compaction into a throw rather
// than into a skip (recorded at BUILTIN_AUTO_AGENTS, src/agents.js).
//
// So the plugin takes the switch: `auto: false`, in every agent mode,
// unconditionally. Compaction is a setting of this plugin from here on — off
// for every agent that does not carry its own `agentCompaction: true`
// (compactionEnabledFor, src/settings.js) — and the side that says ON is the
// plugin's own, driven through `client.session.summarize` at the threshold the
// agent already has.
//
// The write therefore reads NO setting. That is what keeps the per-agent switch
// live: opencode latches its config at instance bootstrap, so anything the
// global value depended on would need a restart to take effect, while a value
// that never enters this write can be read fresh at every crossing.
//
// The plugin wins over a project that set `compaction.auto: true` in its own
// `opencode.json`, on the same ground the solo-mode `title`/`summary` writes
// claim: the value is a user-facing setting of this plugin, and a project file
// that contradicted it would leave the user's own switch saying something that
// is not in effect.
//
// Not touched: the user's own `/compact` command, which is a compaction the
// user asked for and not an automatic one.

import { log, errMsg } from "./log.js"
import { summarizeSession, fetchSnapshot, showToast } from "./client.js"
import {
  claimPendingCompaction,
  releaseCompaction,
  sessionAgentName,
} from "./registry.js"
import { resolveModelForAgent } from "./llmmodel.js"
import { compactionEnabledFor } from "./settings.js"

// Switches opencode's automatic compaction off in the resolved config. Every
// neighbouring key of the `compaction` object — `preserve_recent_tokens`,
// `reserved`, `prune`, `tail_turns` — is kept; a `compaction` value that is not
// a plain object (an array, a string, null) is replaced rather than merged
// into, the discipline suppressBuiltinAgentTurns uses for the same case.
// Mutates `config` in place. A config that is not an object is left alone.
export function applyCompactionPolicy(config) {
  if (!config || typeof config !== "object") return
  const existing =
    config.compaction && typeof config.compaction === "object" && !Array.isArray(config.compaction)
      ? config.compaction
      : null
  config.compaction = { ...existing, auto: false }
}

// ----------------------------------------------------------------------------
// The driver: the ON side of the per-agent switch.
//
// opencode's own automatic compaction is off in every session of this process
// (above), so an agent whose `agentCompaction` entry says on is compacted by
// the plugin itself, at the threshold that agent already has — the primary's
// `primaryContextThreshold`, a subagent's `contextBudgetFor`. Both crossings
// already exist and already have the fresh context figure; this module only
// takes the relief they resolve to.
// ----------------------------------------------------------------------------

// How many compactions ONE subagent session is given before the crossing goes
// back to the tool-call lockdown. A compaction that frees nothing must not
// become a loop: a session whose fill is one huge tool result cannot be
// summarized below its budget, and without a cap every further crossing would
// start another summarize request on it.
//
// An attempt that FAILED counts too. The failure that matters here is a route
// that is not there at all (a build without `session/{id}/summarize`, an
// opencode that answers it 404), and that one fails on every try: counting only
// successes would retry it at every crossing for the life of the run, while
// counting attempts degrades to today's behaviour after three.
export const MAX_SUBAGENT_COMPACTIONS = 3

// A `{ providerID, modelID }` pair both of whose halves are non-empty strings,
// or null. The summarize route takes the model as its body and resolves none of
// its own, so a half-filled pair is not a model.
function usableModel(model) {
  const providerID = model?.providerID
  const modelID = model?.modelID
  if (typeof providerID !== "string" || providerID === "") return null
  if (typeof modelID !== "string" || modelID === "") return null
  return { providerID, modelID }
}

// Compacts one session through opencode's own compaction agent and answers
// `{ ok, reason, model }`. Never throws: every caller's fallback is the relief
// that was already there, so a compaction that could not run degrades the
// crossing rather than breaking it.
//
// The model is resolved in three rungs, and the first one that yields a usable
// pair wins:
//
//   1. `model` — what the caller already read off this session. The subagent
//      crossing has it: it fetched a snapshot two lines earlier to get the very
//      token figure that brought it here.
//   2. the session's newest assistant message, read here. This is the model the
//      session is actually running on, which is what a further turn on it
//      should run on too.
//   3. the agent's pin in `llm-models.json` (resolveModelForAgent). The last
//      rung, because it is a statement about the ROLE and may have been changed
//      since this session started.
//
// A session with no assistant message at all is not compacted: there is nothing
// to summarize, and rung 2 would have nothing to answer with.
//
// `reason` names what happened, for the log and for the caller's toast:
// "compacted", "refused" (the request was made and did not confirm),
// "no-session", "no-messages", "no-model".
export async function compactSession(client, { sessionID, agent, model } = {}) {
  if (!sessionID) return { ok: false, reason: "no-session" }
  let pair = usableModel(model)
  if (!pair) {
    const snapshot = await fetchSnapshot(client, sessionID)
    // messageCount is 0 both for a session that is gone and for one that has
    // never spoken; neither is a session to compact.
    if (!snapshot.messageCount) {
      log("compaction skipped: nothing to compact", { sessionID, agent })
      return { ok: false, reason: "no-messages" }
    }
    pair = usableModel(snapshot.model)
  }
  if (!pair) pair = usableModel(resolveModelForAgent(agent))
  if (!pair) {
    log("compaction skipped: no model resolved", { sessionID, agent })
    return { ok: false, reason: "no-model" }
  }
  const ok = await summarizeSession(client, sessionID, pair)
  log(ok ? "compaction done" : "compaction refused", {
    sessionID,
    agent,
    providerID: pair.providerID,
    modelID: pair.modelID,
  })
  return { ok, reason: ok ? "compacted" : "refused", model: pair }
}

// Idle-gated compaction of the PRIMARY, execution side. Called from the
// `session.idle` event for every idle session, beside maybeRunPendingHandoff:
// only a primary transform ever sets the latch, so for a subagent idle this is
// one set lookup and a return.
//
// The claim is synchronous, so a duplicate idle event — or an idle arriving
// while the compaction turn itself runs — cannot start a second compaction on
// the same session. The release runs on every exit, success and failure alike:
// unlike the handoff there is no forgetPrimary behind this, because the session
// this relief acts on is the one that survives it.
//
// The agent name is the one recorded for the session (`sessionAgentName`), used
// for the model pin's last rung and the log. The SWITCH was already read at the
// crossing that scheduled this, and is deliberately not read again here: the
// decision belongs to the turn that crossed the threshold.
export async function maybeRunPendingCompaction(client, sessionID) {
  if (!claimPendingCompaction(sessionID)) return false
  const agent = sessionAgentName(sessionID) ?? undefined
  try {
    showToast(client, {
      title: "agent-intercom",
      message: "primary context limit reached — compacting this session",
    })
    const outcome = await compactSession(client, { sessionID, agent })
    showToast(client, {
      title: "agent-intercom",
      message: outcome.ok
        ? "compaction complete — the orchestrator keeps working in this session"
        : `compaction did not run (${outcome.reason}) — the session is unchanged`,
    })
    return outcome.ok
  } catch (err) {
    log("primary compaction failed", { sessionID, agent, err: errMsg(err) })
    return false
  } finally {
    releaseCompaction(sessionID)
  }
}

// Starts a compaction of a SUBAGENT's session at its context crossing, and
// answers whether one is now in flight. The caller (contextLimitNotice,
// hooks.js) takes `false` as "this crossing is the lockdown's", which is
// today's behaviour and the behaviour with the switch off.
//
// Synchronous on purpose: it is called from the transform hook, which is on the
// subagent's own LLM turn, and the crossing must not wait for a whole
// compaction turn before the model is told anything. The latch is taken here
// and the request runs detached under it.
//
// Four things say no, and each of them leaves the crossing to the lockdown:
//
//   - no entry or no session id — there is nothing to compact;
//   - compaction switched off for this agent type — the flat `compaction` key
//     or the type's own `agentCompaction` entry, read LIVE at every crossing;
//   - the cap is spent (MAX_SUBAGENT_COMPACTIONS);
//   - the subagent is blocked on an open question. Its `ask` tool call is
//     waiting inside this session for its caller's answer, and compacting the
//     session under a call that has not returned would summarize away the turn
//     the waiter is holding for. The question is bounded by its own window and
//     the budget is not going anywhere: the crossing after it can still compact.
//
// And one says yes without starting anything: a compaction of this session is
// ALREADY running, which is exactly what the caller's "wait for it" notice
// describes.
export function startSubagentCompaction(client, entry, { model } = {}) {
  if (!entry?.sessionID) return false
  if (entry.compactingSince) return true
  if (!compactionEnabledFor(entry.agent)) return false
  if ((entry.compactions ?? 0) >= MAX_SUBAGENT_COMPACTIONS) {
    log("subagent compaction cap reached", {
      handle: entry.handle,
      agent: entry.agent,
      compactions: entry.compactions,
      cap: MAX_SUBAGENT_COMPACTIONS,
    })
    return false
  }
  if (entry.pendingAsk) {
    log("subagent compaction held: a question is open", {
      handle: entry.handle,
      agent: entry.agent,
    })
    return false
  }
  entry.compactingSince = Date.now()
  entry.compactions = (entry.compactions ?? 0) + 1
  log("subagent compaction started", {
    handle: entry.handle,
    agent: entry.agent,
    ctxTokens: entry.ctxTokens,
    compactions: entry.compactions,
  })
  void runSubagentCompaction(client, entry, model)
  return true
}

// The detached half of startSubagentCompaction. Never throws — it is run with
// `void` — and always clears the latch, because that latch is what holds the
// idle handler and the watchdog off this entry.
async function runSubagentCompaction(client, entry, model) {
  try {
    const outcome = await compactSession(client, {
      sessionID: entry.sessionID,
      agent: entry.agent,
      model,
    })
    if (outcome.ok) {
      // The figure on the entry describes the fill the compaction has just
      // removed, and every reader of it — the injected notice, the tool-call
      // lockdown — would act on it as if nothing had happened. Dropping it says
      // what is true: this session's context is not measured yet. The next
      // real turn of the subagent produces the first figure that describes the
      // compacted session; until then the entry is simply unmeasured, which is
      // the state every entry is in before its first snapshot.
      entry.ctxTokens = undefined
      entry.lastTokensFetchAt = Date.now()
      // The escalation counters belong to the fill that is gone. Left standing,
      // the next crossing would open at "FINAL WARNING" and the parent would
      // never be notified again, since notifiedParentOfLoop is a one-shot.
      entry.stopInjections = 0
      entry.contextWarnings = 0
      entry.budgetDenials = 0
      entry.notifiedParentOfLoop = false
    }
  } catch (err) {
    log("subagent compaction failed", {
      handle: entry.handle,
      sessionID: entry.sessionID,
      err: errMsg(err),
    })
  } finally {
    entry.compactingSince = undefined
    // The compaction was the work in flight; the silence window starts again
    // from its end, not from the last event before it. Without this the very
    // next sweep could measure a minutes-long compaction as minutes of silence.
    entry.lastActivityAt = Date.now()
  }
}
