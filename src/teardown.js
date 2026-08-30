// Shared subagent-teardown + parent-notice delivery. Used by the event-dispatch
// paths (onSessionIdle / onSessionError in hooks.js) and by the inactivity
// watchdog (watchdog.js) — kept here, importing neither, so the two callers do
// not form an import cycle through this shared plumbing.

import {
  routeParentNotice,
  removeEntry,
  entryForSession,
  markEntryClosing,
  reservePendingDelivery,
  releasePendingDelivery,
} from "./registry.js"
import {
  postNotice,
  showToast,
  deleteSession,
  abortSession,
  forgetSessionDirectory,
} from "./client.js"
import { settleChildWaiter, liveChildSessionIDs } from "./childwait.js"
import { aborted, pendingSessionQuiescence } from "./state.js"
import { log, errMsg } from "./log.js"

// Maximum time an abort/error teardown waits for opencode to emit the idle event
// that follows its own cleanup writes. The timeout keeps deletion bounded when
// opencode does not emit that event after an abort.
export const SESSION_QUIESCE_TIMEOUT_MS = 1000

// Registers a wait before an abort/error teardown yields to any network I/O.
// The matching session.idle event resolves it early; the bounded fallback keeps
// a session from being retained forever when opencode emits no idle event.
export function waitForSessionQuiescence(
  sessionID,
  timeoutMs = SESSION_QUIESCE_TIMEOUT_MS,
) {
  if (!sessionID) return Promise.resolve("timeout")
  const existing = pendingSessionQuiescence.get(sessionID)
  if (existing) return existing.promise

  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  const record = {
    promise,
    timer: null,
    settled: false,
    settle(reason) {
      if (record.settled) return false
      record.settled = true
      if (record.timer) {
        clearTimeout(record.timer)
        record.timer = null
      }
      resolve(reason)
      return true
    },
  }
  pendingSessionQuiescence.set(sessionID, record)

  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : SESSION_QUIESCE_TIMEOUT_MS
  const timer = setTimeout(() => {
    if (pendingSessionQuiescence.get(sessionID) !== record) return
    pendingSessionQuiescence.delete(sessionID)
    if (record.settle("timeout")) {
      log("session quiescence wait timed out", { sessionID, timeoutMs: waitMs })
    }
  }, waitMs)
  record.timer = timer
  return promise
}

// Resolves the pending wait for exactly this session. The event handler calls
// this before its normal idle bookkeeping, because an aborted entry is already
// absent from the registry by the time the event arrives.
export function signalSessionIdle(sessionID) {
  if (!sessionID) return false
  const record = pendingSessionQuiescence.get(sessionID)
  if (!record) return false
  pendingSessionQuiescence.delete(sessionID)
  return record.settle("idle")
}

// Routes a parent notice through the handoff delivery router before posting.
// EVERY parent-notice path (subagent completion, error, timeout, denial-loop)
// must go through here instead of calling postNotice directly: during an
// executing orchestrator handoff the notice is buffered by the drain (and
// flushed to the NEW session right after its kickoff), and after a completed
// handoff the old→new redirect re-targets stragglers whose wake snapshot
// still carries the deleted old primary. The routing decision is synchronous
// (routeParentNotice in registry.js), so it cannot tear against the handoff's
// own drain transitions.
export async function postParentNotice(client, parentID, notice) {
  // A wake notice is for a PRIMARY. A parent that is itself a subagent got its
  // child through the blocking nested spawn, where the child's ending IS the
  // return value of the parent's own `spawn` tool call — so the same ending
  // posted into its session would reach it twice, once as the tool result it
  // asked for and once as a message it never asked for. The second copy is not
  // merely redundant: while the parent is blocked it cannot act on it, its
  // tokens count against the parent's own context budget, and after the parent
  // is unblocked the only thing left in its one-shot life is the reply it is
  // already writing.
  //
  // Checked here rather than at each of the three notice paths (completion in
  // hooks.js, error/timeout in teardownSubagent below, the denial-loop notice
  // in hooks.js) because this function is the one door all three go through and
  // the rule is the same for all three. Inert for every subagent today: a
  // parentID only becomes a subagent's id through a nested spawn.
  if (entryForSession(parentID)) {
    log("parent notice dropped: the parent is a subagent and takes its child's ending as a tool result", {
      parentID,
    })
    return
  }
  const routed = routeParentNotice(parentID, notice)
  if (routed.buffered) {
    log("parent notice buffered during primary handoff", { parentID })
    return
  }
  if (routed.target !== parentID) {
    log("parent notice re-routed to handoff successor", { parentID, target: routed.target })
  }
  await postNotice(client, routed.target, notice)
}

// Ends every live child of `sessionID` before that session is deleted, and
// returns the child session ids it ended.
//
// The precondition on `deleteSession` (see its doc-comment in client.js) is
// that the session has no live children: opencode's DELETE cascades
// recursively over child sessions, and a child still streaming its final reply
// has its rows wiped mid-write — `FOREIGN KEY constraint failed`, a
// `session.error` in place of `session.idle`, and the deterministic auto-tick
// skipped. That precondition used to hold for free, because a subagent had no
// children. A nested spawn falsifies it, so it is now ENFORCED here rather
// than assumed: every path that deletes a session ends its children first.
//
// Per child: a cooperative abort (so a streaming child stops before its rows
// go), then the ordinary teardown — which settles the child's waiter, removes
// its entry and deletes its session, and, through this same function, ends its
// own children first. No parent notice: the session that would be woken is the
// one being torn down.
//
// `seen` bounds the mutual recursion. The delegation design bounds the depth
// structurally at one level, but a parentID cycle from a reparent race must
// not spin here, and the cost of the guard is one Set.
export async function endLiveChildrenOf(client, sessionID, { label = "", seen } = {}) {
  const children = liveChildSessionIDs(sessionID)
  if (children.length === 0) return []
  const tag = label ? `${label}: ` : ""
  const visited = seen ?? new Set([sessionID])
  const ended = []
  for (const childSessionID of children) {
    if (visited.has(childSessionID)) continue
    visited.add(childSessionID)
    const child = entryForSession(childSessionID)
    log(`${tag}ending live child before its parent's delete`, {
      parentSessionID: sessionID,
      childSessionID,
      handle: child?.handle,
    })
    try {
      await abortSession(client, childSessionID)
    } catch (err) {
      log(`${tag}child abort failed`, { childSessionID, err: errMsg(err) })
    }
    await teardownSubagent(
      client,
      {
        sessionID: childSessionID,
        handle: child?.handle,
        parentID: sessionID,
        agent: child?.agent,
      },
      {
        outcome: {
          status: "ended",
          detail: "its parent was torn down",
        },
        markAborted: true,
        label: label || "child-first",
        seen: visited,
      },
    )
    ended.push(childSessionID)
  }
  return ended
}

// Shared teardown for a finished / errored / timed-out subagent. Runs the
// sequence used by onSessionIdle, onSessionError, and timeoutSubagent: post the
// wake notice to the parent (best-effort), remove the registry entry, delete the
// underlying opencode session, and forget its directory cache. Abort/error
// paths wait for the session's own cleanup to quiesce before the delete.
//
// `markAborted` mirrors the errored/timeout paths: it adds the session to the
// `aborted` set FIRST and keeps that marker in place across
// removeEntry(clearAborted:false), the quiescence wait, and deleteSession,
// dropping it only in the `finally`. That keeps guardToolExecute hard-denying
// any in-flight tool call that races the teardown (instead of misclassifying
// the session as a primary once its registry entry is gone), and guarantees the
// set never grows unbounded even if deleteSession throws. The idle path never
// marks aborted (a clean one-shot completion is not an abort), so it passes
// markAborted:false.
//
// `entryRemoved` is the idle path's genuine divergence: it already removed its
// registry entry INSIDE the wake-race mutex, before any network I/O, so
// the helper must not remove it a second time. The errored/timeout paths remove
// it here.
//
// `retain` is what makes a finished subagent a retained one: the notice half
// of this function still runs, and everything that disposes of the session
// then does not. No `removeEntry` — the entry stays, on `lifecycle` "retained"
// — no child teardown, no quiescence wait, no `deleteSession`, and no
// `forgetSessionDirectory`: the directory cache is part of what a later reuse
// needs. Only the idle path passes it, and only after the retention decision
// has been taken on the delivered result; every other ending path deletes.
//
// `label` prefixes the debug logs so each caller stays greppable. `notice`/
// `toast` are optional; the idle path posts its own completion notice inline
// (it needs the fetched snapshot + task outcome), the errored/timeout paths let
// the helper post theirs.
//
// The whole body runs inside a delivery reservation. `markAborted` drops the
// entry out of countActiveSubagents before the notice is posted, and the idle
// path has already removed it entirely, so without the reservation the quiesce
// predicate would report zero while this subagent's result or error is still
// being delivered. The idle path reserves earlier still (inside its wake
// mutex) and releases after this call — the counter nests, both halves are
// balanced.
//
// `outcome` settles the child-waiter, if this subagent is one somebody is
// blocked on. This helper is the choke point every ending path runs through
// (idle, error, watchdog timeout), so settling here is what guarantees the
// property the blocking shape depends on: no path can end a child without
// freeing the session waiting for it. The idle path settles earlier — it is
// the only one that has a RESULT to hand over — and its second settle here is
// the no-op that keeps the guarantee unconditional. A caller that names no
// outcome settles as "ended".
//
// Being that choke point is also why the child-first step sits here: every
// ending path deletes through this function, so ending this session's own live
// children just before the delete is what keeps opencode's recursive DELETE
// cascade off a session that is still streaming. `seen` is passed only by that
// recursion (see endLiveChildrenOf).
export async function teardownSubagent(
  client,
  { sessionID, handle, parentID, agent },
  {
    notice = null,
    toast = null,
    markAborted = false,
    entryRemoved = false,
    retain = false,
    label = "",
    outcome = null,
    seen = undefined,
  } = {},
) {
  const tag = label ? `${label}: ` : ""
  // Register before the first await. An abort can emit session.idle while the
  // notice, child teardown, or abort request is still in flight.
  const quiescence = markAborted ? waitForSessionQuiescence(sessionID) : null
  reservePendingDelivery()
  if (markAborted) aborted.add(sessionID)
  try {
    // FIRST, before any network I/O: the waiting session is blocked inside a
    // tool call, and posting a notice or deleting a session is no reason to
    // keep it blocked a second longer.
    settleChildWaiter(sessionID, {
      status: "ended",
      handle,
      agent,
      ...(outcome ?? {}),
    })
    if (notice != null && parentID) {
      try {
        await postParentNotice(client, parentID, notice)
        if (toast) showToast(client, toast)
      } catch (err) {
        log(`${tag}postNotice failed`, { handle, parentID, err: errMsg(err) })
      }
    }
    if (retain) {
      // The session stays. Everything below this point exists to dispose of
      // it, so this is the end of the path for a retained subagent; the
      // watchdog's reap runs the rest when the retention window is up.
      log(`${tag}retained opencode session`, { handle, sessionID })
      return
    }
    // A retained entry on its way out moves to "closing" before the first
    // network call below, so no reap and no eviction can claim it twice.
    markEntryClosing(sessionID)
    if (!entryRemoved) {
      if (await removeEntry(sessionID, { clearAborted: false })) {
        log(`${tag}removed subagent`, { handle, sessionID })
      }
    }
    // Child-first: the delete below cascades recursively over child sessions,
    // so anything this session is still waiting on has to be ended before it
    // fires. A no-op for a leaf subagent, which is every subagent today.
    try {
      await endLiveChildrenOf(client, sessionID, { label, seen })
    } catch (err) {
      log(`${tag}ending live children failed`, { handle, sessionID, err: errMsg(err) })
    }
    if (quiescence) {
      const reason = await quiescence
      if (reason === "timeout") {
        log(`${tag}session quiescence timed out; deleting`, { handle, sessionID })
      }
    }
    try {
      const ok = await deleteSession(client, sessionID)
      if (ok) log(`${tag}deleted opencode session`, { handle, sessionID })
    } catch (err) {
      log(`${tag}deleteSession failed`, { handle, sessionID, err: errMsg(err) })
    }
    forgetSessionDirectory(sessionID)
  } finally {
    if (markAborted) aborted.delete(sessionID)
    releasePendingDelivery()
  }
}
