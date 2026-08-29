// Shared subagent-teardown + parent-notice delivery. Used by the event-dispatch
// paths (onSessionIdle / onSessionError in hooks.js) and by the inactivity
// watchdog (watchdog.js) — kept here, importing neither, so the two callers do
// not form an import cycle through this shared plumbing.

import {
  routeParentNotice,
  removeEntry,
  reservePendingDelivery,
  releasePendingDelivery,
} from "./registry.js"
import { postNotice, showToast, deleteSession, forgetSessionDirectory } from "./client.js"
import { settleChildWaiter } from "./childwait.js"
import { aborted } from "./state.js"
import { log, errMsg } from "./log.js"

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

// Shared teardown for a finished / errored / timed-out subagent. Runs the
// sequence that used to be spelled out three times (onSessionIdle,
// onSessionError, timeoutSubagent): post the wake notice to the parent
// (best-effort), remove the registry entry, delete the underlying opencode
// session, and forget its directory cache.
//
// `markAborted` mirrors the errored/timeout paths: it adds the session to the
// `aborted` set FIRST and keeps that marker in place across
// removeEntry(clearAborted:false) + deleteSession, dropping it only in the
// `finally`. That keeps guardToolExecute hard-denying any in-flight tool call
// that races the teardown (instead of misclassifying the session as a primary
// once its registry entry is gone), and guarantees the set never grows
// unbounded even if deleteSession throws. The idle path never marks aborted
// (a clean one-shot completion is not an abort), so it passes markAborted:false.
//
// `entryRemoved` is the idle path's genuine divergence: it already removed its
// registry entry INSIDE the wake-race mutex, before any network I/O, so
// the helper must not remove it a second time. The errored/timeout paths remove
// it here.
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
export async function teardownSubagent(
  client,
  { sessionID, handle, parentID, agent },
  {
    notice = null,
    toast = null,
    markAborted = false,
    entryRemoved = false,
    label = "",
    outcome = null,
  } = {},
) {
  const tag = label ? `${label}: ` : ""
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
    if (!entryRemoved) {
      if (await removeEntry(sessionID, { clearAborted: false })) {
        log(`${tag}removed subagent`, { handle, sessionID })
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
