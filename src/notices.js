// Parent-facing notice string builders. Pure composition — these functions
// only turn registry-entry / snapshot data into the wake-notice text that the
// orchestrator sees. No client, no I/O, no session-lifecycle side effects.

import { getSettings } from "./settings.js"
import { countActiveSubagents } from "./registry.js"
import { tokens as fmtTokens } from "./format.js"

// Spawn-size thresholds applied AFTER a subagent finishes. The orchestrator's
// ORCHESTRATION_GUIDE asks for ≤ ~15 k tokens per spawn; in practice this is
// hard to feel as a number on the orchestrator side without feedback. The
// wake notice surfaces the actual ctxTokens consumed and escalates the tone
// once the spawn was clearly too big, so the next spawn in the same area is
// scoped tighter. Soft = "noticeably large", hard = "way too big, split next
// time". Pure messaging — we never auto-abort or re-spawn.
const LARGE_CTX_TOKENS_SOFT = 30_000
const LARGE_CTX_TOKENS_HARD = 50_000

function taskOutcomeLine(outcome) {
  if (!outcome || outcome.kind === "no-task") return ""
  switch (outcome.kind) {
    case "done":
      return `\n📋 TODO.md: ${outcome.id} removed.`
    case "no-marker":
      return (
        "\n⚠️ TODO.md: this subagent had a task id but its reply did NOT start with " +
        "`DONE: <id>`. The task was NOT auto-removed. Delegate verification and TODO.md cleanup " +
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

export function completionNotice(handle, agent, result, parentID, taskOutcome, ctxTokens) {
  return (
    `🔔 agent-intercom: your subagent "${handle}" (${agent}) has finished and been destroyed.\n` +
    (result ? `Its result:\n${result}\n` : "It produced no text result.\n") +
    `Use this to report back to the user. If you need more work in this area, spawn a fresh ` +
    `subagent — the one above is gone.` +
    taskOutcomeLine(taskOutcome) +
    spawnSizeNotice(ctxTokens) +
    slotsNoticeAfterFinish(parentID)
  )
}

// Tail line: surfaces the actual ctx consumption of the finished subagent so
// the orchestrator gets numerical feedback on whether the spawn was right-sized.
// Tone escalates in two steps; numbers ≥ HARD are spawn-too-big and the next
// one in the area should be split tighter.
function spawnSizeNotice(ctxTokens) {
  if (!ctxTokens || ctxTokens <= 0) return ""
  const used = fmtTokens(ctxTokens)
  if (ctxTokens >= LARGE_CTX_TOKENS_HARD) {
    return (
      `\n📏 spawn-size: this subagent used ${used} tokens — far over the ~15 k target. The ` +
      `task was too big. SPLIT the next spawn in this area into smaller, single-concern pieces ` +
      `(1 file / 1 slice each) before continuing.`
    )
  }
  if (ctxTokens >= LARGE_CTX_TOKENS_SOFT) {
    return (
      `\n📏 spawn-size: this subagent used ${used} tokens — above the ~15 k target. Scope the ` +
      `next spawn in this area tighter (fewer files, narrower goal).`
    )
  }
  return `\n📏 spawn-size: ${used} tokens (target ≤ ~15 k — ok).`
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
