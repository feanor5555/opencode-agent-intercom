// Parent-facing notice string builders. Pure composition — these functions
// only turn registry-entry / snapshot data into the wake-notice text that the
// orchestrator sees. No client, no I/O, no session-lifecycle side effects.

import { getSettings, contextBudgetFor } from "./settings.js"
import { countActiveSubagents } from "./registry.js"
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
    case "no-todo":
      return "\n⚠️ TODO.md not present — marker ignored."
    case "error":
      return `\n⚠️ TODO.md: auto-remove failed: ${outcome.message}`
    default:
      return ""
  }
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
) {
  // A result opening with `Blocked:` is the subagent handing a decision up:
  // it stopped at a problem its prompt did not cover, did what did not depend
  // on it, and is gone. The headline says so instead of "has finished", and
  // the tail line names the decision the orchestrator now owns — otherwise the
  // report reads like any other completion and gets passed to the user or
  // re-spawned unchanged.
  const blocked = isBlockedResult(result)
  const head = blocked
    ? `🔔 agent-intercom: your subagent "${handle}" (${agent}) came back BLOCKED and was destroyed.\n`
    : `🔔 agent-intercom: your subagent "${handle}" (${agent}) has finished and been destroyed.\n`
  const tail = blocked
    ? `⚠️ This is a DECISION for you, not a failed run to retry: decide what happens about the ` +
      `problem and whether the original task continues — where it does, spawn a FRESH subagent ` +
      `carrying that decision. Do not re-send the same prompt; the one above is gone.`
    : `Use this to report back to the user. If you need more work in this area, spawn a fresh ` +
      `subagent — the one above is gone.`
  return (
    head +
    (result ? `Its result:\n${result}\n` : "It produced no text result.\n") +
    tail +
    taskOutcomeLine(taskOutcome, blocked) +
    runSizeNotice(agent, ctxTokens, packageTokens) +
    nestedRunsNotice(nested) +
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
function runSizeNotice(agent, ctxTokens, packageTokens) {
  if (!ctxTokens || ctxTokens <= 0) return ""
  const used = fmtTokens(ctxTokens)
  const budget = contextBudgetFor(agent)
  if (budget <= 0) {
    const pkg = packageTokens > 0 ? `, your package was ${fmtTokens(packageTokens)} of it` : ""
    return `\n📏 run-size: ${used} tokens${pkg} (no context budget set for ${agent}).`
  }
  const pkg = packageTokens > 0 ? ` — your package was ${fmtTokens(packageTokens)} of it` : ""
  const against = `${used} of the ${fmtTokens(budget)} ${agent} budget${pkg}`
  if (ctxTokens >= budget * RUN_SIZE_HARD_SHARE) {
    return (
      `\n📏 run-size: ${against} — at ${percent(RUN_SIZE_HARD_SHARE)} of it or beyond. The task ` +
      `was too big. SPLIT the next spawn in this area into smaller, single-concern pieces ` +
      `(1 file / 1 slice each) before continuing. Where the package figure is itself a large ` +
      `share of the budget, cut the prompt first and pass bulk material as a file path.`
    )
  }
  if (ctxTokens >= budget * RUN_SIZE_SOFT_SHARE) {
    return (
      `\n📏 run-size: ${against} — over ${percent(RUN_SIZE_SOFT_SHARE)} of it. Scope the next ` +
      `spawn in this area tighter (fewer files, narrower goal).`
    )
  }
  return `\n📏 run-size: ${against} — ok.`
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
export function timeoutNotice(entry, maxAgeMs, silentMs) {
  const silentSec = Math.round(silentMs / 1000)
  const maxSec = Math.round(maxAgeMs / 1000)
  return (
    `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) ` +
    `timed out after ${silentSec}s of inactivity (limit ${maxSec}s) — slot freed. ` +
    `You may re-dispatch with spawn() if the work is still needed.`
  )
}

// Wake-notice sent to the parent when a subagent's LLM call failed (caught
// via `session.error`). Sibling of completionNotice / timeoutNotice — same
// emoji + phrasing vocabulary so the orchestrator's pattern-matching notices
// stay consistent. We append a `slots` line via slotsNoticeAfterFinish so the
// freed slot is visible to the orchestrator, matching the completion path.
export function errorNotice(entry, message, wasAborted = false) {
  const head = `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) `
  const body = wasAborted
    ? `aborted by user. Slot freed. `
    : `failed: ${message}. Slot freed. `
  return (
    head +
    body +
    `You may re-dispatch with spawn() if the work is still needed.` +
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
