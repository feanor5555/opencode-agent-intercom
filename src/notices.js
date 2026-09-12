// Notice string builders. Pure composition — these functions only turn
// registry-entry / snapshot data into the text an agent sees. No client, no
// I/O, no session-lifecycle side effects.
//
// Parent-facing throughout, with one exception that lives here for the same
// reason the others do — it is composed text the plugin puts in front of a
// model: `framedAgentMessage`, the block a mid-run message from the caller is
// wrapped in before it enters the SUBAGENT's session.

import { getSettings, contextBudgetFor } from "./settings.js"
import { countActiveSubagents, RETAIN_TASK_SHARE } from "./registry.js"
import { tokens as fmtTokens, percent } from "./format.js"

// Size thresholds applied AFTER a subagent finishes, as shares of that type's
// own context budget (contextBudgetFor) — the same ceiling the plugin enforces
// while the subagent runs, so the feedback and the enforcement name one
// number. The wake notice surfaces the tokens the whole RUN consumed — system
// prompt, work package, every tool result, the model's own output — and
// escalates the tone as they approach the budget, so the next spawn in the
// same area is scoped tighter. Soft = "noticeably large", hard = "way too big,
// split next time". Pure messaging — we never auto-abort or re-spawn.
const RUN_SIZE_SOFT_SHARE = 0.6
const RUN_SIZE_HARD_SHARE = 0.9

// The marker a subagent puts at the very start of its final reply when it hit
// a problem its spawn prompt did not cover: it stopped that step, completed
// what did not depend on it, and handed the decision up. Matched on the first
// non-empty line so leading blank lines from the model do not hide it. Models
// may wrap the marker in markdown emphasis or put a list/heading marker first;
// wrapped forms require the same delimiter on both sides of the word.
const BLOCKED_MARKER_PATTERN =
  /^\s*(?:(?:#+|[-*>])\s+)*(?:(\*\*|__|\*|_|`)\s*blocked(?:\s*:\s*\1(?![*_`])|\s*\1(?![*_`])\s*:)|blocked\s*:)/i

export function isBlockedResult(result) {
  if (typeof result !== "string") return false
  const firstLine = result.split("\n").find((l) => l.trim().length > 0)
  return firstLine !== undefined && BLOCKED_MARKER_PATTERN.test(firstLine)
}

function taskOutcomeLine(outcome, blocked = false) {
  if (!outcome || outcome.kind === "no-task") return ""
  switch (outcome.kind) {
    case "done":
      return `\n📋 TODO.md: ${outcome.id} removed.`
    case "no-marker":
      // A blocked report carries no `DONE:` marker by design — the task is not
      // finished. Saying "delegate verification" there would send the
      // orchestrator past the decision the report is asking it for.
      if (blocked) {
        return (
          "\n📋 TODO.md: the task stays open — a blocked report carries no `DONE: <id>` " +
          "marker. Nothing was auto-removed."
        )
      }
      return (
        "\n⚠️ TODO.md: this subagent had a task id but its reply did NOT put " +
        "`DONE: <id>` on its FIRST or LAST non-empty line. The task was NOT auto-removed. Delegate verification and TODO.md cleanup " +
        "to a planner/coder."
      )
    case "mismatch":
      return (
        `\n⚠️ TODO.md: subagent reported \`${outcome.got}\` but was spawned for \`${outcome.expected}\`. ` +
        `Marker IGNORED (possible hallucination). Delegate verification and TODO.md cleanup to a planner/coder.`
      )
    case "unmigrated":
      // The task IS finished and the marker was accepted — what did not happen
      // is the removal, because the line stands outside the plugin's marked
      // section, where nothing this plugin writes may touch anything.
      return (
        `\n📋 TODO.md: ${outcome.id} is done, but its line stands OUTSIDE the plugin's marked ` +
        `section, so it was not removed. Nothing to do — the next wind-down moves it into the ` +
        `section. Do NOT delegate a cleanup for it.`
      )
    case "no-todo":
      return "\n⚠️ TODO.md not present — marker ignored."
    case "error":
      return `\n⚠️ TODO.md: auto-remove failed: ${outcome.message}`
    default:
      return ""
  }
}

// The tail of a completion notice whose session was kept. It carries the three
// things the orchestrator needs in order to act on the retention: that the
// subagent is still reachable, the handle it is reachable under, and how long
// the window is. The mode hint is the one term that separates a question from a
// further task (G4, `reuseAdmission`) evaluated on the context this run ended
// at — the other terms depend on the follow-up prompt, which does not exist
// yet, so the tool names them at the call and this line does not guess them.
//
// The window is the whole retention ceiling rather than a countdown: the entry
// was stamped `retainedAt` moments ago, in the same critical section that
// decided this notice.
function retainedTail(handle, agent, ctxTokens) {
  const ttlMs = getSettings().retainedSubagentTtlMs
  const minutes = Math.floor(ttlMs / 60000)
  const window = minutes >= 1 ? `${minutes} minutes` : "under a minute"
  const budget = contextBudgetFor(agent)
  const taskToo = budget <= 0 || (ctxTokens ?? 0) <= budget * RETAIN_TASK_SHARE
  const mode = taskToo
    ? `A further related piece of work is admitted too, with mode: "task".`
    : `Only a question: at this size a further piece of work (mode: "task") is refused, it needs ` +
      `more room than the session has left.`
  return (
    `Use this to report back to the user. The session is NOT gone: it still holds everything it ` +
    `read and did, and for the next ${window} you can put a follow-up question to it with ` +
    `reuse("${handle}", "<question>") — no re-briefing, it already has the context. ${mode} ` +
    `After that window it is gone and only spawn is left. Work that is new, or work this ` +
    `session's own history would push the wrong way, is a fresh spawn either way.`
  )
}

// The block every mid-run message from the caller is wrapped in before it is
// queued into the subagent's session. Never sent bare: what arrives there is a
// user message, the strongest position in the context, and an unframed
// paragraph is indistinguishable from a fresh task — a small model would drop
// what it is doing and start on it.
//
// Three things the frame has to say, and it says nothing else: who this is
// from, that it is NOT a new task, and that the final reply has to account for
// it — which is the only way the orchestrator ever learns whether its steering
// landed.
export function framedAgentMessage(text) {
  return (
    "📨 agent-intercom: message from the orchestrator that briefed you (this is NOT a new task).\n" +
    "Fold it into the task you are already on, and say in your final reply what you did with it.\n\n" +
    `${text}`
  )
}

// The notice that carries a subagent's question to its caller. Posted through
// postParentNotice like every other parent notice, so it is buffered during an
// orchestrator handoff and redirected after one.
//
// The opening is the marker the orchestration guide names — `asks you:` — and
// it is the one wake notice that is not a finished run. The two mistakes it has
// to prevent are exactly that confusion: reporting the question to the user as
// a result, and spawning something for it. So the notice says what the subagent
// is doing right now (nothing — it has stopped), what the one action is that
// changes that, and what happens if the orchestrator does not take it.
export function askNotice(entry, ask) {
  const waitMs = ask?.waitMs ?? 0
  const window =
    waitMs > 0
      ? `It waits ${Math.round(waitMs / 1000)}s for your answer; after that it goes on without ` +
        `you or comes back \`Blocked:\`, and what is lost then is your steering, not its work.`
      : `It is NOT waiting — this run answers questions asynchronously — so an answer reaches it ` +
        `at its next step if you send one.`
  return (
    `❓ agent-intercom: your subagent "${entry.handle}" (${entry.agent}, session ` +
    `${entry.sessionID}) asks you:\n\n${ask?.question ?? ""}\n\n` +
    `It has STOPPED and is waiting. Answer it in THIS turn with ` +
    `message("${entry.handle}", "<your answer>"). ${window} ` +
    `This is a question, not a finished run: do not report it to the user as a result, and spawn ` +
    `nothing for it — the subagent is still on the task.`
  )
}

// The tail line that reports the mid-run traffic of a finished run, and the one
// place a steering attempt that was never read is named.
//
// `exchange` is `{ messages, unread, unreadAt, asksOut, asksAnswered,
// asksUnanswered }`, read off the registry entry inside the critical section
// that removes it. Absent — the empty string — for a run with no traffic at
// all, which is every run that never used the channel, so an ordinary
// completion notice is byte-identical to what it has always been.
//
// A message queued but never read is the one thing this line must not leave
// implicit: the orchestrator was told it had been queued, and if it finished
// inside the tool call it was in when the message arrived, that steering simply
// did not happen. Silence there would let the orchestrator believe a correction
// landed that never did.
//
// The second is a question that took no wait: `asksOut` counts every question
// opened, `asksAnswered` and `asksUnanswered` only those that could be waited
// on, so the difference between them is exactly the questions delivered under
// `answerWaitMs: 0`. Reported as its own clause rather than folded into the
// unanswered count, which would accuse the orchestrator of ignoring a question
// this run never gave it the chance to answer.
function exchangeNotice(exchange) {
  const messages = exchange?.messages ?? 0
  const asked = exchange?.asksOut ?? 0
  const answered = exchange?.asksAnswered ?? 0
  const unanswered = exchange?.asksUnanswered ?? 0
  const unwaited = Math.max(0, asked - answered - unanswered)
  if (messages === 0 && answered === 0 && unanswered === 0 && unwaited === 0) return ""
  const parts = []
  if (messages > 0) parts.push(`${messages} message${messages === 1 ? "" : "s"} down`)
  if (answered > 0) parts.push(`${answered} question${answered === 1 ? "" : "s"} answered`)
  if (unanswered > 0) {
    parts.push(`${unanswered} unanswered`)
  }
  if (unwaited > 0) {
    parts.push(`${unwaited} question${unwaited === 1 ? "" : "s"} delivered without a wait`)
  }
  const unread = exchange?.unread ?? 0
  const when = exchange?.unreadAt ? new Date(exchange.unreadAt).toTimeString().slice(0, 5) : ""
  const lost =
    unread > 0
      ? ` — ${
          unread === 1
            ? `the message you sent${when ? ` at ${when}` : ""} was never read`
            : `${unread} of those messages were never read`
        }: it was still inside a tool call when it finished, so that steering did not reach it.`
      : "."
  return `\n📨 exchange: ${parts.join(", ")}${lost}`
}

export function completionNotice(
  handle,
  agent,
  result,
  parentID,
  taskOutcome,
  ctxTokens,
  packageTokens,
  nested,
  runs = 1,
  retained = false,
  exchange = undefined,
  heldForState = false,
) {
  // A result opening with `Blocked:` is the subagent handing a decision up:
  // it stopped at a problem its prompt did not cover, did what did not depend
  // on it, and is gone. The headline says so instead of "has finished", and
  // the tail line names the decision the orchestrator now owns — otherwise the
  // report reads like any other completion and gets passed to the user or
  // re-spawned unchanged.
  const blocked = isBlockedResult(result)
  // Which run of this session ended. A reuse re-prompts the SAME session under
  // the same handle, so without this the orchestrator cannot tell the answer to
  // its follow-up from a fresh subagent's first report — the handle, the type
  // and the shape of the notice are identical. Absent for run 1, which is every
  // run wherever retention is switched off.
  const followUp = runs > 1 ? ` — follow-up run ${runs} of that session` : ""
  // A retention granted by the idle path: the session was NOT deleted and is
  // still addressable under the same handle. Saying "destroyed" here would be
  // false and would hide the one thing the orchestrator has to know to use it.
  // A blocked report is never retained (the idle path revokes on it), so the
  // two branches cannot both apply; the guard keeps that true of this function
  // on its own rather than only of its caller.
  const held = retained && !blocked
  // The other reason a session outlives its subagent: the reply was cut and the
  // overflow file could not be written, so the session is the last copy of the
  // rest and the teardown holds it (`hold`, src/teardown.js). It is NOT a
  // retention — the entry is gone, nothing can be put to it — so it only
  // changes the word "destroyed", which would otherwise be false in the same
  // notice whose result text says the session is being kept.
  const stateHeld = heldForState && !held
  const ending = stateHeld
    ? "Its session is being HELD, not destroyed: its full result could not be filed, and that " +
      "session is the only remaining copy of the part that was cut."
    : null
  const head = blocked
    ? `🔔 agent-intercom: your subagent "${handle}" (${agent})${followUp} came back BLOCKED` +
      `${ending ? `. ${ending}` : " and was destroyed."}\n`
    : held
      ? `🔔 agent-intercom: your subagent "${handle}" (${agent})${followUp} has finished. Its session is being HELD, not destroyed.\n`
      : `🔔 agent-intercom: your subagent "${handle}" (${agent})${followUp} has finished` +
        `${ending ? `. ${ending}` : " and been destroyed."}\n`
  const tail = blocked
    ? `⚠️ This is a DECISION for you, not a failed run to retry: decide what happens about the ` +
      `problem and whether the original task continues — where it does, spawn a FRESH subagent ` +
      `carrying that decision. Do not re-send the same prompt; the one above is gone.`
    : held
      ? retainedTail(handle, agent, ctxTokens)
      : `Use this to report back to the user. If you need more work in this area, spawn a fresh ` +
        `subagent — the one above is gone.`
  return (
    head +
    (result ? `Its result:\n${result}\n` : "It produced no text result.\n") +
    tail +
    taskOutcomeLine(taskOutcome, blocked) +
    runSizeNotice(agent, ctxTokens, packageTokens, runs) +
    nestedRunsNotice(nested) +
    exchangeNotice(exchange) +
    slotsNoticeAfterFinish(parentID)
  )
}

// Tail line: what this subagent spent on subagents of its OWN, when it spawned
// any. Absent otherwise, which is every run of a role that does not delegate.
//
// It sits BELOW the run-size verdict and outside it on purpose. runSizeNotice
// measures the parent's own run against the parent's own budget, and folding a
// child's internal spend into that figure would make a well-scoped parent read
// as oversized and push the orchestrator to split a package that was the right
// size. The figure here is the one thing that number cannot show — what the
// delegation cost on top — so the orchestrator can see it and stop paying for
// it where it is not earning its keep.
//
// `{ runs, tokens }` from the parent's registry entry (chargeNestedRun). Runs
// are children whose ending came back; tokens are the sum of what those
// children burned in their own sessions, which an ending without a snapshot
// does not report — hence the two shapes.
function nestedRunsNotice(nested) {
  const runs = nested?.runs ?? 0
  if (runs <= 0) return ""
  const tokens = nested?.tokens ?? 0
  const what = runs === 1 ? "1 run" : `${runs} runs`
  const cost =
    tokens > 0 ? `~${fmtTokens(tokens)} tokens` : "token cost not reported by the child"
  return `\n⤷ nested: ${what}, ${cost} (not counted in the figure above).`
}

// Tail line: surfaces what the finished RUN consumed against the context
// budget of its own type, so the orchestrator gets feedback measured on the
// ceiling that governed the run. The work package the orchestrator itself sent
// is named beside it (`packageTokens`, the spawn gate's estimate carried on the
// registry entry) — the two figures separate an oversized prompt from a task
// that sprawled while it ran, and each has a different corrective. Absent for
// a subagent the plugin did not size at spawn time; the line then reports the
// run alone. Tone escalates in two steps; a figure at or over the hard share
// is too big and the next spawn in the area should be split tighter. A budget
// of 0 means the ceiling is disabled for that type — the figure is then
// reported with no verdict.
function runSizeNotice(agent, ctxTokens, packageTokens, runs = 1) {
  if (!ctxTokens || ctxTokens <= 0) return ""
  const used = fmtTokens(ctxTokens)
  // On run 2 and beyond the figure is the whole SESSION's context, not this
  // run's: a reuse adds to a session that was already carrying its first run.
  // The number was always the honest one; only its caption would be wrong.
  const label = runs > 1 ? `run-size (run ${runs}, cumulative over the session)` : "run-size"
  const budget = contextBudgetFor(agent)
  if (budget <= 0) {
    const pkg = packageTokens > 0 ? `, your package was ${fmtTokens(packageTokens)} of it` : ""
    return `\n📏 ${label}: ${used} tokens${pkg} (no context budget set for ${agent}).`
  }
  const pkg = packageTokens > 0 ? ` — your package was ${fmtTokens(packageTokens)} of it` : ""
  const against = `${used} of the ${fmtTokens(budget)} ${agent} budget${pkg}`
  if (ctxTokens >= budget * RUN_SIZE_HARD_SHARE) {
    return (
      `\n📏 ${label}: ${against} — at ${percent(RUN_SIZE_HARD_SHARE)} of it or beyond. The task ` +
      `was too big. SPLIT the next spawn in this area into smaller, single-concern pieces ` +
      `(1 file / 1 slice each) before continuing. Where the package figure is itself a large ` +
      `share of the budget, cut the prompt first and pass bulk material as a file path.`
    )
  }
  if (ctxTokens >= budget * RUN_SIZE_SOFT_SHARE) {
    return (
      `\n📏 ${label}: ${against} — over ${percent(RUN_SIZE_SOFT_SHARE)} of it. Scope the next ` +
      `spawn in this area tighter (fewer files, narrower goal).`
    )
  }
  return `\n📏 ${label}: ${against} — ok.`
}

// Tail line for completion notices: tells the orchestrator how many subagent
// slots are now free so it knows whether the next spawn() will succeed. Empty
// when the cap is disabled. Called after removeEntry, so the freed slot is
// already counted out. The cap is GLOBAL — the count includes subagents from
// every primary in this process.
function slotsNoticeAfterFinish(primaryID) {
  const maxSubagents = getSettings().maxSubagents
  if (maxSubagents <= 0) return ""
  const active = countActiveSubagents(primaryID)
  const free = Math.max(0, maxSubagents - active)
  return `\nSubagent slots: ${active}/${maxSubagents} (global, across all sessions) — ${free} free.`
}

// Wake-notice sent to the parent when the watchdog times out a subagent.
// Sibling of completionNotice — keeps the same emoji + phrasing vocabulary so
// the orchestrator's pattern-matching notices stay consistent.
//
// `result` is the last usable assistant text the session still held, read off
// a snapshot taken in timeoutSubagent before the teardown deleted the session
// and put through the reply token ceiling there. It is the same block
// errorNotice carries and it is here for the same reason: a subagent reaped on
// the silence clock has usually done real work — several finished steps — and
// without this the entire run reaches the orchestrator as a bare timeout, so
// the only thing it can do is have the same ground covered again. Appended only
// when there IS text; the wording above it does not depend on it.
//
// `limit` is the descriptor watchdogLimit built for this entry: which of the
// two windows fired (`kind`), its value (`ms`), the setting key that holds it
// (`setting`) and, for a call caught in flight, the tool (`tool`). All four
// reach the orchestrator: the number alone does not tell it whether to give the
// work more room or to treat the subagent as hung, and the setting key is what
// it would have to name to give it that room.
//
// `kind` is what the notice judges on, and it is a statement the plugin can
// make: a subagent with a tool call in flight takes the `tool-call` window, so
// a reap on the `silence` window is a reap of a subagent that had NOTHING of
// its own running — the probable hang. The two are named as what they are.
// What the notice still does not say is that the subagent was inactive: the
// clock measures the plugin's own silence, not the subagent's idleness, and a
// hung provider call is silence full of work that was paid for. So it reports
// the silence, names which of the two windows ended it, and hands over what the
// subagent was last seen doing as the evidence the orchestrator re-dispatches
// on.
// `openQuestion` is the question the entry had open at the moment of the reap,
// captured by timeoutSubagent before it settled the waiter. It changes what the
// reap MEANS: a subagent that stopped on a question and was then cut off was
// waiting for this very orchestrator, so the sentence names the question and
// says that re-dispatching without deciding it would run into the same wall.
export function timeoutNotice(entry, limit, silentMs, result, openQuestion) {
  const silentSec = Math.round(silentMs / 1000)
  const limitSec = Math.round(limit.ms / 1000)
  const held = `(limit ${limitSec}s, ${limit.setting})`
  const cause =
    limit.kind === "tool-call"
      ? `spent ${silentSec}s inside a single \`${limit.tool ?? "unknown"}\` tool call ${held} ` +
        `and was cut off`
      : `gave no sign of life for ${silentSec}s ${held} and was cut off`
  const lastSeen = lastSeenPhrase(entry)
  const seen = lastSeen
    ? `Last seen doing: ${lastSeen}. `
    : `Nothing is known of what it was doing — no text and no tool call of its own has reached ` +
      `this plugin. `
  const judgement =
    limit.kind === "tool-call"
      ? `It was still working when it was cut off, so this is a limit on how long one step may ` +
        `take and not proof of a hang: raise \`${limit.setting}\` if that step legitimately ` +
        `needs longer. `
      : `The clock ran out with no tool call of its own in flight, so this reads as a hung step ` +
        `rather than a long one, and not as work that needed more room. `
  const recovered = result
    ? `\nWhat it produced before it was cut off — this is the only account of the work it ` +
      `managed, read it before you re-dispatch and do not have the same ground covered twice:\n${result}\n`
    : ""
  const asked = openQuestion?.question
    ? `\n❓ It had a question open to YOU when the clock ran out, and it never got an answer: ` +
      `${openQuestion.question}\nDecide that question before you re-dispatch — a fresh subagent ` +
      `on the same prompt walks into the same wall.`
    : ""
  return (
    `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) ` +
    `${cause} — slot freed. ` +
    seen +
    judgement +
    `You may re-dispatch with spawn() if the work is still needed.` +
    asked +
    recovered
  )
}

// How much of `entry.lastActivity` a notice quotes. Enough for a tool marker
// (`[tool: bash]`) whole and for the opening sentence of a text step, short
// enough that the phrase stays a phrase.
const LAST_SEEN_CHARS = 160

// What a subagent was last seen doing, as one line fit to drop into a sentence,
// or "" where nothing is known of it.
//
// The source is `entry.lastActivity` — the newest text or tool part of the
// session, cut to 280 chars by latestActivity (client.js). Two things happen to
// it here. Whitespace is collapsed, because that string is raw model output and
// may carry newlines that would break a one-line notice into pieces the
// orchestrator reads as separate instructions. And it is cut again, harder: the
// notice is a wake message, not a transcript, and the run's actual text is
// already carried in full below it on the paths that recovered any.
export function lastSeenPhrase(entry, maxChars = LAST_SEEN_CHARS) {
  const raw = typeof entry?.lastActivity === "string" ? entry.lastActivity.trim() : ""
  if (!raw) return ""
  const flat = raw.replace(/\s+/g, " ")
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat
}

// Wake-notice sent to the parent when a subagent's LLM call failed (caught
// via `session.error`). Sibling of completionNotice / timeoutNotice — same
// emoji + phrasing vocabulary so the orchestrator's pattern-matching notices
// stay consistent. We append a `slots` line via slotsNoticeAfterFinish so the
// freed slot is visible to the orchestrator, matching the completion path.
//
// `result` is the last usable assistant text the failed session still held
// (client.js finalResult, read off a snapshot taken before teardown). A
// provider blow-up or a user abort lands on a session that has usually been
// working for a while, and without this block everything the subagent said
// about that work died with the session and the next run would start from
// zero. It is appended only when there IS text; the failure wording above it
// is unchanged either way, so a notice for a session that produced nothing
// reads exactly as it did before.
export function errorNotice(entry, message, wasAborted = false, result) {
  const head = `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) `
  const body = wasAborted
    ? `aborted by user. Slot freed. `
    : `failed: ${message}. Slot freed. `
  const recovered = result
    ? `\nIts last text before it stopped — this is the only account of the work it managed, ` +
      `read it before you re-dispatch and do not have the same ground covered twice:\n${result}\n`
    : ""
  return (
    head +
    body +
    `You may re-dispatch with spawn() if the work is still needed.` +
    recovered +
    slotsNoticeAfterFinish(entry.parentID)
  )
}

export function denialLoopNotice(entry) {
  return (
    `⚠️ agent-intercom: subagent "${entry.handle}" (${entry.agent}) is OVER its context budget ` +
    `(${fmtTokens(entry.ctxTokens)} tokens) and keeps calling tools instead of wrapping up — ` +
    `it has ignored ${entry.stopInjections} STOP injection${entry.stopInjections === 1 ? "" : "s"}. ` +
    `It is still alive, still consuming time, still producing nothing useful. ` +
    `Tell the user the subagent appears stuck and ask whether to abort it (via the TUI ✕ button, ` +
    `or by telling you to abort it by handle). Do NOT abort on your own — abort is user-only.`
  )
}

// Wake-notice sent to the parent when a HELD subagent's session was deleted
// from outside this plugin — the sidebar's `x` on a held row, or a user
// deleting that session in opencode. Sibling of timeoutNotice / errorNotice:
// same emoji + phrasing vocabulary, so the orchestrator's pattern-matching
// stays consistent across every ending it is told about.
//
// It carries the one thing the orchestrator cannot work out for itself. It was
// told, in the completion notice, that this handle stays reachable for the
// retention window; the session behind it is now gone, and without this notice
// the first it hears of that is the refusal of a `reuse` it has already spent a
// turn framing. So the notice names the handle, says the context it held is
// gone, and points at the only thing left — a fresh spawn with a full briefing.
//
// No slots line, unlike errorNotice: a retained subagent occupies no
// concurrency slot (isActiveEntry counts running entries only), so this drop
// frees nothing a spawn budget would want to hear about.
export function retentionLostNotice(entry) {
  return (
    `🔔 agent-intercom: the held subagent "${entry.handle}" (${entry.agent}, session ` +
    `${entry.sessionID}) is GONE — its opencode session was deleted from outside the plugin, ` +
    `so the context it was holding no longer exists. reuse("${entry.handle}", …) will not reach ` +
    `it. If that work is still needed, spawn() a fresh subagent and brief it from scratch — it ` +
    `has none of what the held session had read.`
  )
}
