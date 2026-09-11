// The mid-run channel between a running subagent and the caller that briefed
// it, as the two tools that carry it: `message` down and `ask` up.
//
// Split out of tools.js because the pair is one feature with one invariant —
// the caller answering a question and the subagent blocking on it are two
// halves of the same critical section — and because the refusal texts that make
// the channel usable by a small model are the bulk of both handlers.
//
// `createMidRunTools` mirrors `createTools`: it is handed the collaborators the
// tool factory owns and returns the handlers, which tools.js registers under
// `guard(...)` with the rest of the map. Everything else either module needs is
// imported directly, so nothing about the channel is routed through tools.js.

import { registryMutex, aborted } from "./state.js"
import {
  resolve,
  trackPrimary,
  entryForSession,
  entryLifecycle,
  noteMessageIn,
  openAsk,
  clearAsk,
  oldestToolCall,
  LIFECYCLE_RUNNING,
} from "./registry.js"
import { promptSession } from "./client.js"
import { registerAskWaiter, settleAsk } from "./agentmsg.js"
import { postParentNotice } from "./teardown.js"
import {
  getSettings,
  contextBudgetFor,
  retentionActive,
  soloModeActive,
} from "./settings.js"
import { tokens as fmtTokens, estimateTokens, estimateReplyTokens } from "./format.js"
import { askNotice, framedAgentMessage } from "./notices.js"
import { log, errMsg } from "./log.js"

// `client` is the opencode client every send goes through; `unknown` the
// refusal an unresolvable or foreign handle gets, owned by tools.js so that all
// four handle-taking tools answer it with the same words.
export function createMidRunTools({ client, unknown }) {
  // When the subagent will actually read what was just queued for it, as a
  // clause to hang on the tool result. opencode drains a queued user message at
  // the next STEP boundary of the loop that is already running, so a subagent
  // inside a tool call reads it when that call returns and one between steps
  // reads it at once. `oldestToolCall` is what the plugin knows about that: the
  // call it has had in flight the longest, which is the one the subagent is
  // sitting in.
  function deliveryMomentPhrase(entry) {
    const call = oldestToolCall(entry)
    if (call?.tool) {
      return (
        `it reads it at its next step — it is inside \`${call.tool}\` right now, so the moment ` +
        `that call returns`
      )
    }
    return "it reads it at its next step, which is the next model call it makes"
  }

  // Say something to a subagent that is still running. Two things happen under
  // this one tool and the plugin decides which, because it knows whether a
  // question is open and a small model should not have to:
  //
  //   an ANSWER — the subagent is blocked inside its own `ask` call, so the
  //     text is handed to it as that call's return value and nothing is written
  //     to its session at all.
  //   a STEERING message — it goes into the session as a queued user message
  //     with `noReply`, which starts no turn; opencode's own runner picks it up
  //     at the subagent's next step.
  //
  // The running check and the answer hand-over are taken under
  // `registryMutex.runExclusive`, on the same fields the wake's critical
  // section tests (aborted / timedOut / errored / dispatched / lifecycle). That
  // is the one race here: the idle event may have fired and claimed this entry
  // while this handler is deciding, and a message queued into a session the
  // teardown is about to delete would be reported as delivered and never read.
  async function messageHandler(args, toolCtx) {
    trackPrimary(toolCtx.sessionID)
    // The mode gate first, for the reason spawnHandler states: in solo mode
    // this tool is not registered, so on a correct instance this is
    // unreachable — and it is here so that a route the tool map does not decide
    // cannot re-open a channel to a second agent that does not exist.
    if (soloModeActive()) {
      log("message refused: solo mode", { sessionID: toolCtx?.sessionID })
      return {
        output:
          "Message refused: solo mode runs one agent — you. There is no running subagent to " +
          "say anything to; do the work yourself with your own tools.",
      }
    }
    const settings = getSettings()
    // Read LIVE, not latched: unlike retention this setting gates no
    // conditional registration, so switching it off has to take effect in the
    // same opencode instance.
    if (!settings.midRunMessaging) {
      return {
        output:
          "Message refused: the mid-run channel is switched off " +
          '(`"midRunMessaging": false` in ~/.config/opencode/agent-intercom.json, or ' +
          "OPENCODE_AGENT_INTERCOM_MID_RUN_MESSAGING). A running subagent cannot be reached " +
          "while it is off; wait for its reply.",
      }
    }
    const text = String(args.text ?? "").trim()
    if (!text) {
      return {
        output:
          "Message refused: `text` is empty. Say what you want the subagent to know, in one or " +
          "two concrete sentences.",
      }
    }
    const estimate = estimateReplyTokens(text)
    const ceiling = settings.maxMessageTokens
    if (ceiling > 0 && estimate > ceiling) {
      return {
        output:
          `Message refused: ${fmtTokens(estimate)} tokens is over the ${fmtTokens(ceiling)}-token ` +
          `ceiling for one mid-run message (maxMessageTokens). This channel carries a correction ` +
          `or a fact, not a briefing — cut it to the instruction itself, or let this subagent ` +
          `finish and spawn a fresh one with the full package.`,
      }
    }
    const entry = resolve(args.subagent)
    // Ownership, in the abort handler's rule verbatim: a foreign handle reads
    // as unknown, so which other orchestrator owns it is not leaked.
    if (!entry || entry.parentID !== toolCtx.sessionID) return unknown(args.subagent)

    // The target's own context ceiling. The text lands in ITS context, so a
    // subagent already at its budget must not be pushed over it by a steering
    // note: past the budget every tool call of its own is denied and all it can
    // still do is write its final reply.
    //
    // Measured with `estimateTokens`, not with the `estimateReplyTokens` the
    // ceiling above uses. The two estimators keep different contracts on
    // purpose (src/format.js): the reply estimator overestimates prose by some
    // 14 % because it decides where a reply is CUT, while every budget figure
    // in the plugin — `contextBudgetFor`, the package gate, the wake notice's
    // totals — is arithmetic in `estimateTokens`. Comparing one against the
    // other would refuse a message earlier than the same text costs everywhere
    // else this budget is spoken about.
    const budget = contextBudgetFor(entry.agent)
    const budgetCost = estimateTokens(text)
    if (budget > 0 && (entry.ctxTokens ?? 0) + budgetCost >= budget) {
      return {
        output:
          `Message refused: "${entry.handle}" is at ${fmtTokens(entry.ctxTokens)} tokens of its ` +
          `${fmtTokens(budget)} ${entry.agent} budget, and ${fmtTokens(budgetCost)} more would ` +
          `put it over. It is about to finish or be stopped by its own ceiling; wait for its ` +
          `reply and carry the correction into the next spawn.`,
      }
    }

    const decision = await registryMutex.runExclusive(() => {
      const e = entryForSession(entry.sessionID)
      if (!e || aborted.has(e.sessionID) || e.timedOut || e.errored || e.dispatched) {
        return { kind: "gone" }
      }
      if (entryLifecycle(e) !== LIFECYCLE_RUNNING) return { kind: "gone" }
      // A question is open, so this text is its ANSWER: the subagent is holding
      // its `ask` call open and the answer is that call's return value. Both
      // sides of the state — the waiter and the entry's own flag — are closed
      // here, under the one lock, so no other path can see a question that is
      // open on one side and settled on the other.
      if (e.pendingAsk) {
        const question = e.pendingAsk.question
        const settled = settleAsk(e.sessionID, { status: "answered", answer: text })
        // `settled` false means the wait had already run out between the timer
        // firing and the subagent's own handler clearing the flag: the question
        // is over and this text answered nothing, so it is not counted as an
        // answer either.
        clearAsk(e, settled ? "answered" : "unanswered")
        return { kind: settled ? "answer" : "answer-late", question }
      }
      // Recorded before the send, in the same section that found the entry
      // running, so the `seen` bookkeeping cannot miss a message the subagent
      // reads before this handler gets its turn back. Taken out again below if
      // the send throws.
      return { kind: "queue", record: noteMessageIn(e, text) }
    })

    if (decision.kind === "gone") {
      const retention = retentionActive()
        ? `It may still be held for a follow-up — check list() for a RETAINED row and use ` +
          `reuse("${entry.handle}", "<question>").`
        : `Spawn a fresh subagent carrying what you wanted to say.`
      return {
        output:
          `Message refused: "${entry.handle}" is no longer running — it has finished, been ` +
          `stopped or been cut off, and nothing more reaches it. ${retention}`,
      }
    }

    if (decision.kind === "answer" || decision.kind === "answer-late") {
      log("answered a subagent's question", {
        handle: entry.handle,
        sessionID: entry.sessionID,
        late: decision.kind === "answer-late",
      })
      if (decision.kind === "answer-late") {
        return {
          output:
            `"${entry.handle}" had a question open but its wait had already run out, so it went ` +
            `on without your answer. Your text was NOT delivered. Send it again — it now goes ` +
            `down as an ordinary message and it reads it at its next step.`,
        }
      }
      return {
        output:
          `Answer delivered to "${entry.handle}" — it was blocked on its question and is running ` +
          `again from this moment, with your text as the result of its own \`ask\` call. Its ` +
          `question was: ${decision.question}`,
      }
    }

    try {
      await promptSession(client, {
        sessionID: entry.sessionID,
        agent: entry.agent,
        prompt: framedAgentMessage(text),
        // Starts NO turn: the message is persisted into the session and the
        // loop that is already running drains it at its next step. Without this
        // a send into a subagent that has just gone quiet would start a second
        // run on a session this plugin has already accounted as finished.
        noReply: true,
      })
    } catch (err) {
      // Nothing was queued, so the bookkeeping must not claim it was — the
      // completion notice reports unread messages, and a phantom record would
      // accuse the subagent of ignoring a message it was never sent.
      const messages = entryForSession(entry.sessionID)?.messagesIn
      const at = Array.isArray(messages) ? messages.indexOf(decision.record) : -1
      if (at >= 0) messages.splice(at, 1)
      log("message send failed", { handle: entry.handle, err: errMsg(err) })
      return {
        output:
          `Message NOT delivered to "${entry.handle}": ${errMsg(err)}. Nothing reached it. You ` +
          `can call message() again; the subagent is running and has not been told anything.`,
      }
    }
    log("message queued", { handle: entry.handle, sessionID: entry.sessionID, tokens: estimate })
    return {
      output:
        `Queued for "${entry.handle}" (${entry.agent}) — ${deliveryMomentPhrase(entry)}. It was ` +
        `not restarted and it cost you no spawn. Do not repeat it; end your turn — you are woken ` +
        `with its reply as usual, and that reply says what it did with your message.`,
      metadata: { handle: entry.handle, sessionID: entry.sessionID, queued: true },
    }
  }

  // A subagent puts ONE question to the caller that briefed it and blocks on
  // the answer. The tool call IS the wait: no polling, no token spend, and the
  // answer arrives as this call's own result.
  //
  // Refused for a nested subagent, and that refusal is what keeps the whole
  // channel deadlock-free: a caller that is itself a subagent is blocked inside
  // its own `spawn` tool call, so it can run no tool round and could never
  // answer. Nested delegation stays one-shot in both directions.
  async function askHandler(args, toolCtx) {
    const sessionID = toolCtx?.sessionID
    const entry = sessionID ? entryForSession(sessionID) : undefined
    if (!entry) {
      return {
        output:
          "ask is for a running subagent: it puts a question to the orchestrator that briefed it. " +
          "This session was not spawned by one, so there is nobody this question would reach.",
      }
    }
    const settings = getSettings()
    if (!settings.midRunMessaging) {
      return {
        output:
          "ask refused: the mid-run channel is switched off (midRunMessaging), so your question " +
          "would reach nobody. Decide with what you have, or finish now with a `Blocked:` reply " +
          "naming the question.",
      }
    }
    if (entryForSession(entry.parentID)) {
      return {
        output:
          "ask refused: your caller is itself a subagent and is blocked waiting for you; it " +
          "cannot answer. Decide with what you have, or finish with a `Blocked:` reply naming " +
          "the question.",
      }
    }
    const question = String(args.question ?? "").trim()
    if (!question) {
      return { output: "ask refused: `question` is empty. Ask one self-contained question." }
    }
    const estimate = estimateReplyTokens(question)
    const ceiling = settings.maxMessageTokens
    if (ceiling > 0 && estimate > ceiling) {
      return {
        output:
          `ask refused: ${fmtTokens(estimate)} tokens is over the ${fmtTokens(ceiling)}-token ` +
          `ceiling for one mid-run message (maxMessageTokens). This is a QUESTION, not a report: ` +
          `ask the one thing you need decided in a sentence or two, and put your findings in ` +
          `your final reply.`,
      }
    }
    if (entry.pendingAsk) {
      return {
        output:
          `ask refused: one question at a time. You are already waiting on: ` +
          `${entry.pendingAsk.question}`,
      }
    }

    const waiter = registerAskWaiter(sessionID, entry.parentID, { question })
    if (!openAsk(entry, waiter)) {
      settleAsk(sessionID, { status: "ended", detail: "a second question raced the first" })
      return {
        output: "ask refused: one question at a time — another question of yours is already open.",
      }
    }
    try {
      await postParentNotice(client, entry.parentID, askNotice(entry, waiter))
    } catch (err) {
      settleAsk(sessionID, { status: "ended", detail: "the question never reached the caller" })
      // The same outcome the waiter was settled with, and a member of
      // ASK_OUTCOMES: the question ended without an answer, so clearAsk counts
      // it unanswered.
      clearAsk(entry, "ended")
      log("ask notice failed", { handle: entry.handle, err: errMsg(err) })
      return {
        output:
          `ask failed: your question did not reach the orchestrator (${errMsg(err)}). Decide with ` +
          `what you have, or finish with a \`Blocked:\` reply naming the question.`,
      }
    }
    log("ask posted", {
      handle: entry.handle,
      sessionID,
      parentID: entry.parentID,
      id: waiter.id,
      waitMs: waiter.waitMs,
    })

    const outcome = await waiter.promise
    // The entry may be gone by now — the reap, the abort and the teardown all
    // settle the waiter on their way out — so the flag is cleared off whatever
    // entry is still there rather than off the one captured above.
    clearAsk(entryForSession(sessionID), outcome.status)
    const waitedSec = Math.round((outcome.waitedMs ?? 0) / 1000)
    if (outcome.status === "answered") {
      return {
        output:
          `The orchestrator answers: ${outcome.answer}\n\n` +
          `That is the decision — carry on with your task on it, and say in your final reply ` +
          `what you did with it. Do not ask the same thing again.`,
      }
    }
    if (outcome.status === "not-waiting") {
      return {
        output:
          "Your question was delivered, but this run does not wait for answers (answerWaitMs is " +
          "0). Go on with the best reading you can defend; an answer, if one comes, arrives as " +
          "an ordinary message at your next step.",
      }
    }
    if (outcome.status === "unanswered") {
      return {
        output:
          `No answer came within ${waitedSec}s. Go on with the best reading you can defend, or ` +
          `finish now with a \`Blocked:\` reply naming the question. Do not ask again.`,
      }
    }
    return {
      output:
        `Your question was ended without an answer (${outcome.status}) after ${waitedSec}s — your ` +
        `run is being stopped. Write your final reply now: start it with \`Blocked:\` and name ` +
        `the question and what you did complete.`,
    }
  }

  return { messageHandler, askHandler }
}
