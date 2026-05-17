// Subagent bookkeeping: friendly handles and the sessionID <-> entry mapping.
// Operates on the module-level shared state in state.js.

import { registry, bySession, primarySessions, counters, aborted, pendingSpawns } from "./state.js"

// Marks a session as one that has used this plugin's tools.
export function trackPrimary(sessionID) {
  if (sessionID) primarySessions.add(sessionID)
}

export function isPrimary(sessionID) {
  return primarySessions.has(sessionID)
}

// Per-agent monotonic friendly handle, e.g. "researcher#1".
export function nextHandle(agent) {
  const n = (counters.get(agent) ?? 0) + 1
  counters.set(agent, n)
  return `${agent}#${n}`
}

// Looks up an entry by friendly handle or raw sessionID.
export function resolve(ref) {
  if (!ref) return undefined
  if (registry.has(ref)) return registry.get(ref)
  return entryForSession(ref)
}

// Looks up an entry by sessionID only.
export function entryForSession(sessionID) {
  return registry.get(bySession.get(sessionID))
}

// Categorizes a registry entry into one displayed state:
//   "aborted"  — user/orchestrator killed it
//   "idle"     — opencode-idle (a brief transient between session.idle firing
//                and the event hook removing the entry); usually not seen
//   "busy" / "retry" — opencode's own status, work in flight
//   "unknown"  — registered but no status seen yet
//
// There is no "finished" state: once a subagent goes idle the event hook
// removes the entry from the registry entirely (one-shot lifecycle), so a
// "done" subagent disappears rather than lingering.
export function effectiveState(entry) {
  if (aborted.has(entry.sessionID)) return "aborted"
  return entry.status ?? "unknown"
}

// Counts a primary's active subagents — excludes aborted ones (which no
// longer occupy a concurrency slot, even before opencode has confirmed the
// abort). Finished subagents are not in the registry at all, so no special
// case for them. Pending spawns (between cap-check and upsertSession) are
// included so parallel spawn() calls in the same turn cannot bypass the cap.
export function countActiveSubagents(primaryID) {
  let n = pendingSpawns.get(primaryID) ?? 0
  for (const e of registry.values()) {
    if (e.parentID !== primaryID) continue
    if (effectiveState(e) === "aborted") continue
    n += 1
  }
  return n
}

// Atomically reserve a concurrency slot for a primary (synchronous, no awaits
// between caller's cap-check and this call). Caller MUST pair every reserve()
// with exactly one releasePendingSpawn() — typically in a `finally` so an
// error in the spawn pipeline doesn't leak a phantom slot.
export function reservePendingSpawn(primaryID) {
  pendingSpawns.set(primaryID, (pendingSpawns.get(primaryID) ?? 0) + 1)
}

export function releasePendingSpawn(primaryID) {
  const n = pendingSpawns.get(primaryID) ?? 0
  if (n <= 1) pendingSpawns.delete(primaryID)
  else pendingSpawns.set(primaryID, n - 1)
}

// Idempotent registration keyed by sessionID. opencode fires `session.created`
// for plugin-spawned sessions too — and it can fire *during* the `session.create`
// await, before `spawn` even has the sessionID. So either path may run first:
// whoever is first creates the entry, the second upgrades it in place.
export function upsertSession(sessionID, { agent, prompt, parentID, taskId, directory } = {}) {
  if (!sessionID) return undefined
  const existing = entryForSession(sessionID)
  if (existing) {
    upgradeProvisionalAgent(existing, agent)
    if (prompt && !existing.prompt) existing.prompt = prompt
    if (parentID && !existing.parentID) existing.parentID = parentID
    if (taskId && !existing.taskId) existing.taskId = taskId
    if (directory && !existing.directory) existing.directory = directory
    return existing
  }
  return createEntry(sessionID, agent || "subagent", prompt || "", parentID, taskId, directory)
}

// Returns the set of taskIds currently held by active subagents of a primary.
// Used by `spawn` to reject a duplicate spawn for a task that's already in
// flight — without this, a small model that gets confused and re-spawns the
// same T-id would silently double-tick (or, worse, race) on completion.
export function activeTaskIdsFor(primaryID) {
  const ids = new Set()
  for (const e of registry.values()) {
    if (e.parentID !== primaryID) continue
    if (effectiveState(e) === "aborted") continue
    if (e.taskId) ids.add(e.taskId)
  }
  return ids
}

// The event hook registers sessions provisionally as "subagent" before `spawn`
// knows the real agent name. Once known, re-key the entry under e.g.
// "researcher#1".
function upgradeProvisionalAgent(entry, agent) {
  if (!agent || agent === "subagent" || entry.agent !== "subagent") return
  registry.delete(entry.handle)
  entry.handle = nextHandle(agent)
  entry.agent = agent
  registry.set(entry.handle, entry)
  bySession.set(entry.sessionID, entry.handle)
}

// Removes an entry from all shared maps. The event hook calls this immediately
// after delivering a subagent's completion notice (one-shot lifecycle), so the
// registry never holds a "finished" subagent.
export function removeEntry(sessionID) {
  const handle = bySession.get(sessionID)
  if (!handle) return false
  registry.delete(handle)
  bySession.delete(sessionID)
  aborted.delete(sessionID)
  return true
}

function createEntry(sessionID, agent, prompt, parentID, taskId, directory) {
  const entry = {
    handle: nextHandle(agent),
    sessionID,
    agent,
    prompt,
    parentID,
    // Stable TODO.md task id (e.g. "T5" / "R2") extracted by `spawn` from the
    // first line of the spawn-prompt. Used by the wake-hook to validate the
    // subagent's `DONE:`/`BLOCKED:` marker matches the task that was assigned —
    // a marker for a different id is treated as a hallucination and ignored.
    taskId: taskId || undefined,
    // Project directory of THIS session, captured per-call from toolCtx.directory.
    // Used by the wake-hook to locate TODO.md — the plugin-factory closure's
    // `directory` only reflects where opencode serve was started, NOT the
    // session's actual project (sessions created with ?directory=... land in a
    // different project but share the same factory ctx).
    directory: directory || undefined,
    status: "busy",
    spawnedAt: Date.now(),
    lastActivity: undefined,
    ctxTokens: undefined,
    // wall-clock timestamp of the most recent fetchSnapshot() that returned
    // ctxTokens. Read by the hot-path cache in contextLimitNotice() so we
    // don't HTTP-fetch the full message history on every subagent LLM call.
    lastTokensFetchAt: 0,
    // Number of consecutive tool calls denied for hitting the context budget.
    // Used for logs only; the notify-parent threshold is driven by
    // stopInjections (LLM turns), not raw denials.
    budgetDenials: 0,
    // Number of LLM turns on which the contextLimitNotice STOP block was
    // injected into this subagent's system prompt. Counts "chances the LLM has
    // had to see the warning". When it reaches BUDGET_NOTIFY_AFTER, the parent
    // is notified once (see notifiedParentOfLoop). Resets when a tool call
    // gets through, i.e. when the subagent is no longer over budget.
    stopInjections: 0,
    // Latch: true after notifyParentOfDenialLoop has fired for this subagent
    // so the parent isn't spammed every subsequent over-budget turn.
    notifiedParentOfLoop: false,
  }
  registry.set(entry.handle, entry)
  bySession.set(sessionID, entry.handle)
  return entry
}
