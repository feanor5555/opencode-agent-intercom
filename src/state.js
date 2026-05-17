// Shared mutable state for opencode-agent-intercom.
//
// This MUST live at module scope. opencode instantiates the plugin factory
// once per session within a single process — the orchestrator session and each
// subagent session each get their own factory invocation, so closure-local
// state is NOT shared between them. The module is imported exactly once per
// process, so module-level state IS shared across every instance: `spawn` runs
// in the orchestrator's instance while the subagent's `chat.system.transform`
// hook runs in a different one, and they must see the same registry.

// handle -> { handle, sessionID, agent, prompt, parentID, status, spawnedAt,
//             lastActivity, ctxTokens, lastTokensFetchAt }
//
// One-shot subagent lifecycle: each entry lives from `spawn` until the
// subagent goes idle (= completed its single reply). At that point the event
// hook delivers the result to the primary, removes the entry from this map,
// and deletes the underlying opencode session. There is no follow-up channel
// to a finished subagent; if more work is needed, the orchestrator spawns a
// fresh one.
export const registry = new Map()

// sessionID -> handle (reverse lookup)
export const bySession = new Map()

// sessionIDs that have used this plugin's tools — treated as "primary"
export const primarySessions = new Set()

// sessionIDs that have been aborted — used to hard-deny lingering tool calls
export const aborted = new Set()

// agent name -> monotonic counter, for friendly handles
export const counters = new Map()

// primaryID -> count of spawn() calls currently between the cap check and the
// final upsertSession (i.e. holding a reserved slot but not yet visible in the
// registry). Without this counter, N parallel spawn tool-calls in the same
// orchestrator turn all read "0 active" before any of them reaches upsert ->
// the cap is silently bypassed. countActiveSubagents adds this counter so the
// reservation is atomic across the synchronous check-and-increment.
export const pendingSpawns = new Map()

// primaryID -> name of the last tool the primary successfully invoked. Used by
// the guard to deny back-to-back `list` calls (small LLMs poll status instead
// of ending the turn after a spawn; one snapshot per turn is plenty).
export const lastPrimaryTool = new Map()

// Test-only: clears all shared state so unit tests run in isolation.
// Not part of the plugin contract — opencode never calls this.
export function resetState() {
  registry.clear()
  bySession.clear()
  primarySessions.clear()
  aborted.clear()
  counters.clear()
  pendingSpawns.clear()
  lastPrimaryTool.clear()
}
