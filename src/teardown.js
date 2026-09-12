// Shared subagent-teardown + parent-notice delivery. Used by the event-dispatch
// paths (onSessionIdle / onSessionError in hooks.js) and by the inactivity
// watchdog (watchdog.js) — kept here, importing neither, so the two callers do
// not form an import cycle through this shared plumbing.

import {
  routeParentNotice,
  removeEntry,
  entryForSession,
  isActiveEntry,
  isPrimary,
  rootPrimaryFor,
  markEntryClosing,
  clearAsk,
  claimRetentionEvictionsLocked,
  registryMutex,
  reservePendingDelivery,
  releasePendingDelivery,
} from "./registry.js"
import {
  showToast,
  deleteSession,
  listSessions,
  abortSession,
  forgetSessionDirectory,
  updateSessionTitle,
  fetchSnapshot,
} from "./client.js"
import { deliverParentNotice } from "./noticejournal.js"
import { secureSubagentState } from "./resultfile.js"
import { getSettings, retentionOffered } from "./settings.js"
import { settleChildWaiter, detachedParentOf, liveChildSessionIDs } from "./childwait.js"
import { settleAsk } from "./agentmsg.js"
import {
  aborted,
  pendingSessionQuiescence,
  quiescedSessions,
  trimByAgeAndSize,
} from "./state.js"
import { log, errMsg } from "./log.js"

// Maximum time an abort/error teardown waits for opencode to emit the idle event
// that follows its own cleanup writes. The timeout keeps deletion bounded when
// opencode does not emit that event after an abort.
export const SESSION_QUIESCE_TIMEOUT_MS = 1000

// How long a session.idle already seen answers a wait armed after it.
//
// opencode publishes session.idle for an aborted session INSIDE the abort
// request: its runner interrupts the run fiber, waits out that fiber's
// finalizers — the cleanup that flushes the in-flight parts — and only then
// sets the session status to idle, all before the HTTP call returns. So every
// path that awaits its own abort call (the inactivity watchdog, the `abort`
// tool) arms its quiescence wait for an event that has already gone by, and
// without a record of it that wait has nothing left to resolve and burns its
// full SESSION_QUIESCE_TIMEOUT_MS on a session that is already still.
//
// The record therefore says "this session went idle just now", and only just
// now: a wait armed more than QUIESCE_MARK_TTL_MS after the idle ignores it,
// because a session that went quiet that long ago may have been prompted since
// — a reuse, or a user typing into a retained session — and the quiet the
// record reports is then not the quiet the wait is asking about. Ignoring one
// costs exactly the wait it would have skipped, i.e. what every wait costs
// today.
export const QUIESCE_MARK_TTL_MS = SESSION_QUIESCE_TIMEOUT_MS

// How many such records are kept. They live for a second at most, so the cap is
// only there to keep a burst of endings from growing the map without bound.
export const QUIESCE_MARK_MEMORY = 256

// Records that this session has just gone idle, and drops the records that are
// expired or over the cap. The record is re-inserted rather than overwritten so
// that the map's iteration order stays its age order, which is what
// `trimByAgeAndSize` — the eviction rule shared with the deleted-session
// memory — walks.
function noteSessionQuiesced(sessionID, now) {
  quiescedSessions.delete(sessionID)
  quiescedSessions.set(sessionID, now)
  trimByAgeAndSize(quiescedSessions, now, {
    max: QUIESCE_MARK_MEMORY,
    ttlMs: QUIESCE_MARK_TTL_MS,
  })
}

// Consumes this session's record and answers whether it is fresh enough to
// stand in for the idle event a wait would otherwise sit out. Consumed either
// way: a record too old to answer this wait is too old to answer a later one.
function takeSessionQuiescedMark(sessionID, now) {
  const at = quiescedSessions.get(sessionID)
  if (at === undefined) return false
  quiescedSessions.delete(sessionID)
  return now - at <= QUIESCE_MARK_TTL_MS
}

// Registers a wait before an abort/error teardown yields to any network I/O.
// The matching session.idle event resolves it early; the bounded fallback keeps
// a session from being retained forever when opencode emits no idle event. A
// session that went idle just before the wait was armed resolves it at once —
// see QUIESCE_MARK_TTL_MS for why that case is the normal one on every path
// that awaits its own abort call.
export function waitForSessionQuiescence(
  sessionID,
  timeoutMs = SESSION_QUIESCE_TIMEOUT_MS,
) {
  if (!sessionID) return Promise.resolve("timeout")
  const existing = pendingSessionQuiescence.get(sessionID)
  if (existing) return existing.promise
  if (takeSessionQuiescedMark(sessionID, Date.now())) {
    log("session had already gone idle when the quiescence wait was armed", { sessionID })
    return Promise.resolve("idle")
  }

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
//
// The idle is recorded whether or not anything is waiting on it: on the abort
// paths this event arrives BEFORE the wait for it is armed, and the record is
// what that wait reads instead of sitting out its timeout. Returns whether a
// pending wait was resolved, which the record does not change.
export function signalSessionIdle(sessionID) {
  if (!sessionID) return false
  noteSessionQuiesced(sessionID, Date.now())
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
export async function postParentNotice(
  client,
  parentID,
  notice,
  { allowTrackedSubagent = false, kind = "notice" } = {},
) {
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
  // A waiter's ceiling is the one exception. It resolves the nested spawn with
  // `expired` but leaves the child detached so the parent's DELETE cannot
  // cascade over a still-running session. If that child later ends, its result
  // has no blocked tool call left to enter and must be posted to the still
  // tracked subagent directly; the ending path opts into that route with
  // `allowTrackedSubagent`.
  //
  // Checked here rather than at each of the three notice paths (completion in
  // hooks.js, error/timeout in teardownSubagent below, the denial-loop notice
  // in hooks.js) because this function is the one door all three go through and
  // the rule is the same for all three. Inert for every subagent except the
  // detached-child late-result case above.
  if (entryForSession(parentID) && !allowTrackedSubagent) {
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
  // Durable delivery, not a bare post: `promptAsync` answers 204 as soon as it
  // has FORKED the work that writes the message row, so this call establishes
  // nothing about whether the notice landed. The journal entry written before
  // the post, the confirmation read after it and the replay at the next plugin
  // load are what stand behind that (src/noticejournal.js). It throws exactly
  // where postNotice threw, so every caller's failure path is unchanged.
  //
  // Every parent notice the plugin sends goes through this one door — the
  // completion wake, the error/timeout teardown notice, the denial-loop
  // warning, the retention-drop notice and a subagent's `ask` — so all five are
  // covered by being here. `kind` is what names them apart in the journal and
  // in the log.
  await deliverParentNotice(client, routed.target, notice, {
    kind,
    requestedFor: parentID,
  })
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
// A child is torn down MID-WORK — it was running when its parent ended — so it
// falls under the same securing rule as every other mid-work ending: its state
// is read one last time and written to its own result file before its session
// goes (secureSubagentState, src/resultfile.js), and where that fails the child
// is HELD instead of deleted.
//
// Holding a child is not enough on its own here, and that is what `unsecured`
// is for. opencode's DELETE cascades recursively over child sessions, so a held
// child still dies when its parent is deleted a moment later. Every child whose
// state could not be secured is therefore pushed onto the caller's `unsecured`
// array, and the caller holds ITSELF as well — teardownSubagent does exactly
// that. A caller that passes no array gets the child's hold and nothing more.
//
// `seen` bounds the mutual recursion. The delegation design bounds the depth
// structurally — the target table in agents.js admits no cycle and no chain
// longer than caller → researcher → grounder — but a parentID cycle from a
// reparent race must not spin here, and the cost of the guard is one Set.
export async function endLiveChildrenOf(client, sessionID, { label = "", seen, unsecured } = {}) {
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
    // After the abort, so the step that was streaming has stopped and its parts
    // stand still, and before the teardown that deletes the session.
    const recovered = secureSubagentState(await fetchSnapshot(client, childSessionID), {
      handle: child?.handle,
      agent: child?.agent,
      sessionID: childSessionID,
      taskId: child?.taskId,
      runs: child?.runs ?? 1,
      directory: child?.directory,
      retained: false,
    })
    if (!recovered.secured) {
      unsecured?.push(childSessionID)
      log(`${tag}child state could not be filed; holding it and its parent`, {
        childSessionID,
        parentSessionID: sessionID,
        reason: recovered.holdReason,
      })
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
        hold: !recovered.secured,
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
// `hold` is the other reason a session is not deleted, and it is not a
// retention: the subagent is finished, its entry goes out of the registry and
// its slot is freed exactly as on every ending path, but the opencode session
// itself is left standing. It is passed when the subagent's state did not reach
// a file — the write failed, or on a mid-work ending the session could not be
// read at all (capReplyForAgent / secureSubagentState, src/resultfile.js): the
// session is then the only remaining copy of what the subagent produced, and
// deleting it would destroy the state this plugin exists to hand over. This
// function raises it on its own account too, for a child of this session whose
// state could not be secured (see endLiveChildrenOf). Tearing a subagent down
// quickly is worth less than the handover, so the session waits — the notice tells the
// orchestrator it is being held and why, and the orphan sweep at the next
// plugin load is what eventually collects it. `retain` takes precedence where
// both are set: it keeps the entry as well, which is strictly more.
//
// `quiesced` says the caller has ALREADY waited this session's post-abort
// cleanup out and needs no second wait here. Passed by the error path, which
// has to wait before its own rescue read — opencode publishes `session.error`
// from inside the run fiber's interrupt handler, ahead of the finalizer that
// flushes the in-flight text, so a snapshot taken on that event loses the
// paragraph the subagent was in the middle of. That wait has already run to
// its end (idle or timeout) by the time it gets here, and re-arming would
// wait for a second idle event that is never coming.
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
    hold = false,
    quiesced = false,
    label = "",
    outcome = null,
    seen = undefined,
  } = {},
) {
  const tag = label ? `${label}: ` : ""
  // Register before the first await. An abort can emit session.idle while the
  // notice, child teardown, or abort request is still in flight — and can
  // equally have emitted it before this call, which waitForSessionQuiescence
  // answers from its record of that event rather than by waiting again.
  const quiescence = markAborted && !quiesced ? waitForSessionQuiescence(sessionID) : null
  reservePendingDelivery()
  if (markAborted) aborted.add(sessionID)
  // Capture this before settleChildWaiter drops a detached record. An active
  // waiter must keep the ordinary no-duplicate rule; only a late ending after
  // `expired` may wake a parent that is still tracked as a subagent.
  const detachedParentID = detachedParentOf(sessionID)
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
    // The same, for a question this subagent was blocked on: this helper is the
    // one door every ending path that is not the idle wake goes through, so it
    // is the catch-all that keeps a blocked `ask` from outliving its session.
    // The paths that know WHY the run ended settle it themselves first with
    // that reason (the abort handler, the watchdog), and this call is then the
    // no-op it is for every subagent that asked nothing.
    settleAsk(sessionID, {
      status: outcome?.status ?? "ended",
      detail: "the subagent's run ended while its question was open",
    })
    clearAsk(entryForSession(sessionID), outcome?.status ?? "ended")
    // A wind-down child never posts into its primary, on ANY ending path. Its
    // result already reached the primary as the permitted spawn's own tool
    // result, and that primary is being replaced by the cycle; a watchdog/abort
    // reap firing a timeout notice here would land in a session the cycle is
    // retiring. The completion path suppresses its own wake notice for the same
    // entry (hooks.js); this closes the reap/abort route the concept scoped to
    // this helper.
    const windDownEntry = Boolean(entryForSession(sessionID)?.windDown)
    if (windDownEntry && notice != null) {
      log(`${tag}wind-down child reaped; no notice posted`, { handle, parentID })
    }
    if (notice != null && parentID && !windDownEntry) {
      try {
        await postParentNotice(client, parentID, notice, {
          allowTrackedSubagent: detachedParentID === parentID,
          kind: "teardown",
        })
        if (toast) showToast(client, toast)
      } catch (err) {
        log(`${tag}postNotice failed`, { handle, parentID, err: errMsg(err) })
      }
    }
    if (retain) {
      // The session stays. Everything below this point exists to dispose of
      // it, so this is the end of the path for a retained subagent; the
      // watchdog's reap runs the rest when the retention window is up.
      //
      // This is the last word on the retention — the two-phase decision is
      // settled and every caller that keeps a session comes through here — so
      // it is where the state is published. The window is the entry's own
      // `retainedAt` plus the configured TTL, i.e. the same moment the reap
      // works to and the same one `list` and the snapshot count down to.
      const entry = entryForSession(sessionID)
      const retainedAt = entry?.retainedAt ?? Date.now()
      await publishRetentionState(client, sessionID, {
        retainedUntil: retainedAt + getSettings().retainedSubagentTtlMs,
      })
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
    //
    // A child whose own state could not be secured comes back in
    // `unsecuredChildren`, and holding that child is worth nothing unless this
    // session is held too: the delete below would cascade straight onto it.
    const unsecuredChildren = []
    try {
      await endLiveChildrenOf(client, sessionID, { label, seen, unsecured: unsecuredChildren })
    } catch (err) {
      log(`${tag}ending live children failed`, { handle, sessionID, err: errMsg(err) })
    }
    if (quiescence) {
      const reason = await quiescence
      if (reason === "timeout") {
        log(`${tag}session quiescence timed out; deleting`, { handle, sessionID })
      }
    }
    if (hold || unsecuredChildren.length > 0) {
      // The state could not be secured to a file, so the session that holds it
      // stays. Everything above has already run — the notice is out, the entry
      // is gone, the slot is free — and only the delete is skipped. The
      // directory cache entry goes with the entry, like on every other ending:
      // nothing looks a held-for-state session up again.
      log(`${tag}held opencode session: its result could not be filed`, {
        handle,
        sessionID,
        forChildren: unsecuredChildren.length > 0 ? unsecuredChildren : undefined,
      })
      forgetSessionDirectory(sessionID)
      return
    }
    // A reported write: deleteSession never throws and answers whether the
    // delete took effect, logging the status itself where it did not. Only the
    // confirmation is logged here; the teardown proceeds either way, and a
    // session left standing is collected by sweepOrphanedSubagentSessions at
    // the next plugin load.
    //
    // `parentID`/`fallbackID` are where a user WATCHING this subagent is
    // carried to before the session goes — the caller's own session first, the
    // root primary behind it (they differ for a nested subagent, whose caller
    // is itself a subagent). The chain is walked here rather than after the
    // delete, while the registry still holds it: `rootPrimaryFor` reads the
    // parent's entry, and this subagent's own entry is gone by now.
    if (
      await deleteSession(client, sessionID, {
        parentID,
        fallbackID: rootPrimaryFor(parentID),
        cause: label || "teardown",
      })
    ) {
      log(`${tag}deleted opencode session`, { handle, sessionID })
    }
    forgetSessionDirectory(sessionID)
  } finally {
    if (markAborted) aborted.delete(sessionID)
    releasePendingDelivery()
  }
}

// Tears retained subagents down until at most `keep` of them are left, oldest
// `retainedAt` first, and returns the descriptors it tore down.
//
// The two callers differ only in that number. `keep: maxRetainedSubagents`
// trims the set back after one more entry joined it — the capacity eviction on
// the idle path. `keep: 0` — the default — drops the whole set, which is what a
// primary handoff and an endless cycle do: a retained session's only value is
// the context of the primary it belongs to, and that primary is on its way out.
//
// The claim runs under the registry mutex and moves its victims to "closing"
// before it returns, so the watchdog's reap and a second drop cannot take the
// same entry; the teardowns themselves run outside the lock. Silent towards the
// parent — each of these subagents was woken when its run finished, and a
// second notice would cost an LLM turn to be told that something it may never
// ask about again is gone.
//
// The session is really torn down, not merely forgotten: the same
// teardownSubagent every ending path goes through, so the opencode session is
// deleted rather than left behind as an orphan nothing else will ever delete.
export async function dropRetainedSubagents(client, { keep = 0, label = "retention" } = {}) {
  const victims = await registryMutex.runExclusive(() => claimRetentionEvictionsLocked(keep))
  for (const victim of victims) {
    log(`${label}: dropping a retained subagent`, {
      handle: victim.handle,
      sessionID: victim.sessionID,
    })
    await teardownSubagent(client, victim, { notice: null, markAborted: false, label })
  }
  return victims
}

// The fixed prefix EVERY subagent session title carries (tools.js spawn,
// unconditionally). It is the ONLY thing that attributes an opencode session to
// this plugin from the outside: the registry lives in the plugin's own process
// and is empty in a fresh one, and nothing in the session record itself says
// who created it.
//
// Written whatever the settings say. Retention is one reader of the marker, not
// its owner: the bootstrap sweep below and the TUI's subagent row both need to
// tell this plugin's sessions from everything else on the same database, and
// neither becomes able to do so only because a session may be held.
export const SUBAGENT_SESSION_TITLE_MARKER = "[agent-intercom] "

// The retention state, published on that same session title.
//
// Whether a finished subagent is really being held is decided here — on its
// reply, on the context it ended at, on capacity, on whether retention is in
// effect in this process at all — and none of that is visible from outside the
// plugin's own memory. A reader that infers it from what a session list does or
// does not hold gets it wrong for as long as its poll takes to notice, and
// paints a session as held that is at that moment being deleted.
//
// So the state is published rather than inferred, and the title is the channel:
// the plugin already writes it (spawn puts SUBAGENT_SESSION_TITLE_MARKER in
// front of it), every reader of a session already gets it, and it needs no
// transport that does not exist. A held session's title carries the stamp
// `[retained:<epoch ms the window ends>]` directly after the marker — held, and
// for how long, in the one field. It goes on when the retention becomes final
// and comes off again when an accepted reuse ends it; every other way a
// retention ends deletes the session, which takes the title with it.
//
// The marker stays the first thing in the title, so the bootstrap sweep's
// attribution test (startsWith) is unaffected by the stamp.
export const RETENTION_STAMP_RE = /^\[retained:(\d{1,15})\]\s/

// The mid-run state of a RUNNING subagent, published on that same title and in
// the vocabulary `list` already renders on a running row (`formatListRow`,
// src/tools.js): `msgs:N` for the messages the caller has sent down this run,
// `asking` for a question this subagent has STOPPED on and is waiting for an
// answer to.
//
// Published for the same reason the retention state is: neither is visible from
// outside the plugin's own memory. A subagent blocked inside its own `ask` call
// is `busy` to opencode and silent to every reader of the session — exactly
// what a hung subagent looks like — so a panel that only reads the server
// cannot tell work waiting on the orchestrator from work that has stalled.
//
// The stamp sits between the marker and the work title, is empty where there is
// nothing to say, and carries its fields comma-separated in the order `list`
// renders them: `[mid:msgs:2,asking]`. A run whose channel was never used
// writes no stamp and therefore no title at all.
export const MID_RUN_STAMP_RE = /^\[mid:([^\]]{1,32})\]\s/

// Upper bound on the message count the stamp carries, so the field stays inside
// the length the reader accepts however long a run talks to its subagent.
export const MID_RUN_MAX_MESSAGES = 9999

// The mid-run stamp itself, with its trailing space, or the empty string where
// nothing has happened on the channel.
export function midRunStamp({ asking = false, messagesIn = 0 } = {}) {
  const count = Number.isFinite(messagesIn) ? Math.floor(messagesIn) : 0
  const fields = []
  if (count > 0) fields.push(`msgs:${Math.min(count, MID_RUN_MAX_MESSAGES)}`)
  if (asking) fields.push("asking")
  return fields.length === 0 ? "" : `[mid:${fields.join(",")}] `
}

// The mid-run state read back off a title: what the panel decodes. A title
// without the marker, without the stamp, or with a stamp no longer in this
// shape reads as a subagent with nothing on its channel — never as an error and
// never as a question nobody asked.
export function readMidRunStamp(title) {
  const quiet = { asking: false, messagesIn: 0 }
  if (typeof title !== "string") return quiet
  if (!title.startsWith(SUBAGENT_SESSION_TITLE_MARKER)) return quiet
  // Past the retention stamp where one stands there, so the reader is total
  // over everything the composer below can write.
  let rest = title.slice(SUBAGENT_SESSION_TITLE_MARKER.length)
  const retention = RETENTION_STAMP_RE.exec(rest)
  if (retention) rest = rest.slice(retention[0].length)
  const match = MID_RUN_STAMP_RE.exec(rest)
  if (!match) return quiet
  const fields = match[1].split(",")
  const messages = fields.find((f) => f.startsWith("msgs:"))
  const count = messages ? Number(messages.slice("msgs:".length)) : 0
  return {
    asking: fields.includes("asking"),
    messagesIn: Number.isFinite(count) && count > 0 ? count : 0,
  }
}

// The title a subagent's session carries: marker, the retention stamp where it
// is held, the mid-run stamp where its channel has something to say, then the
// text `spawn` was given. Each part is absent where it has nothing to say, so a
// subagent that is neither held nor talking carries the marker and its work
// title, which is the title spawn wrote.
export function stampedSubagentTitle(baseTitle, { retainedUntil = 0, asking, messagesIn } = {}) {
  const base = typeof baseTitle === "string" ? baseTitle : ""
  const retention =
    Number.isFinite(retainedUntil) && retainedUntil > 0
      ? `[retained:${Math.floor(retainedUntil)}] `
      : ""
  return SUBAGENT_SESSION_TITLE_MARKER + retention + midRunStamp({ asking, messagesIn }) + base
}

// The title a held subagent's session carries: marker, stamp, then the text
// `spawn` was given. `retainedUntil` at or below zero composes the plain form,
// which is what an accepted reuse writes back. A retention is published when
// the run is over, so it carries no mid-run stamp: writing it back is what
// takes a stamp of that run off the title.
export function retentionStampedTitle(baseTitle, retainedUntil) {
  return stampedSubagentTitle(baseTitle, { retainedUntil })
}

// The epoch ms a published retention window ends at, read back off a title.
// Undefined for every title that does not carry the stamp — a session this
// plugin never created, one it created and is not holding, and one whose title
// a future opencode rewrote.
export function readRetentionStamp(title) {
  if (typeof title !== "string") return undefined
  if (!title.startsWith(SUBAGENT_SESSION_TITLE_MARKER)) return undefined
  const match = RETENTION_STAMP_RE.exec(title.slice(SUBAGENT_SESSION_TITLE_MARKER.length))
  if (!match) return undefined
  const until = Number(match[1])
  return Number.isFinite(until) && until > 0 ? until : undefined
}

// Writes the retention state of one subagent session to its title. Called with
// the window's end for a retention that has just become final, and with nothing
// for a reuse that has just ended one.
//
// Best-effort and silent about failure beyond the log: the state is a reading
// aid, and a title that could not be written costs a reader the row it would
// have shown, never a wrong one. Published only when retention is offered
// (`retentionOffered()`); every spawned session carries the marker regardless
// of whether retention is active.
export async function publishRetentionState(client, sessionID, { retainedUntil = 0 } = {}) {
  if (!retentionOffered()) return false
  if (!client || !sessionID) return false
  const entry = entryForSession(sessionID)
  const title = retentionStampedTitle(entry?.title ?? "", retainedUntil)
  return updateSessionTitle(client, sessionID, title)
}

// Writes the mid-run state of one RUNNING subagent to its title: a question it
// has stopped on, and how many messages its caller has sent it this run.
//
// The state is read off the entry rather than passed in, so every caller
// publishes what the registry holds at the moment it calls and no call site can
// publish a question that is no longer open. Called at the transitions — a
// question opening, that question ending, a message queued — and nowhere else.
//
// Refused for an entry that is not a running subagent — `isActiveEntry`, the
// plugin's single definition of that, so an aborted entry is refused as well as
// a retained or closing one. A finished subagent's title belongs to
// `publishRetentionState`, which writes the retention state and takes any
// mid-run stamp of the run just ended off with it. Best-effort and silent about
// failure beyond the log, exactly like the retention publish: a title that
// could not be written costs a reader the marker it would have shown.
export async function publishMidRunState(client, sessionID) {
  if (!client || !sessionID) return false
  const entry = entryForSession(sessionID)
  if (!isActiveEntry(entry)) return false
  const title = stampedSubagentTitle(entry.title ?? "", {
    asking: Boolean(entry.pendingAsk),
    messagesIn: Array.isArray(entry.messagesIn) ? entry.messagesIn.length : 0,
  })
  return updateSessionTitle(client, sessionID, title)
}

// A subagent session outlives the process that made it whenever that process
// stops without tearing it down: a plugin reload inside a retention window, and
// equally an opencode instance that died mid-run with subagents still going.
// opencode has no session TTL and no garbage collection, and the plugin gets no
// shutdown hook, so either way that session is left behind with nothing left in
// the world that would ever delete it.
//
// This is the counter-move, run once at plugin load: list the project's
// sessions and delete the ones that can only be this plugin's own leftovers.
export const ORPHAN_SWEEP_TTL_FACTOR = 2

// The independent floor under the sweep's age bound. The watchdog-derived
// bound below is normally the stronger protection, but this floor keeps a very
// short configured inactivity window from making the sweep too eager.
export const ORPHAN_SWEEP_MIN_AGE_MS = 600000

// Leave a wide margin after the inactivity watchdog would reap a subagent. The
// sweep can see sessions from another opencode process, so its age bound must
// be later than that process's own watchdog deadline — and that deadline is
// the WIDER of the two windows watchdogLimit measures against
// (`maxSubagentAgeMs` for a silent subagent, `maxSubagentToolCallMs` for one
// inside a tool call), because a subagent sitting in a long tool call writes
// nothing to its session and so looks exactly this idle from the outside.
export const ORPHAN_SWEEP_WATCHDOG_FACTOR = 8

// A session is deleted only when EVERY one of these holds. Each is a positive
// statement about the session, not the absence of a reason to keep it — a
// session that cannot be attributed with certainty is left standing, whatever
// it costs in leaked rows.
//
//  1. its title carries SUBAGENT_SESSION_TITLE_MARKER — this plugin created it
//     as a subagent session, and nothing else writes that prefix;
//  2. it has a parentID — it is a child. A primary is never a candidate, and
//     the one primary this plugin does create as a child (the handoff's
//     successor orchestrator, handoffwiring.js) carries no marker either, so it
//     is excluded twice over;
//  3. no listed session names it as a parent — it has no children of its own,
//     so the recursive DELETE cascade cannot reach a session this sweep never
//     judged;
//  4. this process knows nothing about it: not a tracked primary, not a
//     registry entry. At bootstrap the registry is empty and every candidate
//     passes, but the sweep must stay safe wherever it is called from;
//  5. it has been idle for longer than ORPHAN_SWEEP_TTL_FACTOR × the retention
//     window, and in no case less than ORPHAN_SWEEP_MIN_AGE_MS or
//     ORPHAN_SWEEP_WATCHDOG_FACTOR × the WIDER of the two watchdog windows,
//     `maxSubagentAgeMs` and `maxSubagentToolCallMs`. A running subagent is
//     reaped by the inactivity watchdog before that latter bound — by the
//     silence window when nothing of its own is in flight, by the tool-call
//     window when it is inside a call that publishes nothing — and a retained
//     one at its TTL, so nothing alive is ever this old; a second opencode
//     instance's subagent on the same database is either far younger than this
//     or already an orphan itself. Taking the silence window alone would leave
//     a foreign subagent that is legally inside a tool call inside the sweep's
//     kill range as soon as the tool-call window is raised past
//     ORPHAN_SWEEP_WATCHDOG_FACTOR × the silence window.
//
// The sweep is unavailable when EITHER watchdog window is switched off. Without
// the window that governs the case, there is no finite age at which an
// untracked foreign session can be known to be dead, so deleting one would turn
// an explicit user setting into a live-session kill: `maxSubagentAgeMs = 0`
// switches the inactivity watchdog off altogether, and
// `maxSubagentToolCallMs = 0` means the other instance never reaps a subagent
// that is working, however long the call runs. Positive settings on both still
// leave the sweep useful, including for the shipped default. Every spawned
// session carries the marker (tools.js), so the sweep can attribute them there
// as well; the cost at load is one session.list call.
export async function sweepOrphanedSubagentSessions(client, { directory, now = Date.now() } = {}) {
  const settings = getSettings()
  if (settings.maxSubagentAgeMs <= 0) return []
  // A settings object carrying no tool-call window is read as "no window wider
  // than the silence one", the same way childWaiterTimeoutMs reads it: absent
  // is not the statement an explicit 0 makes.
  const toolCallMs = Number.isFinite(settings.maxSubagentToolCallMs)
    ? settings.maxSubagentToolCallMs
    : settings.maxSubagentAgeMs
  if (toolCallMs <= 0) return []
  const minAgeMs = Math.max(
    ORPHAN_SWEEP_TTL_FACTOR * settings.retainedSubagentTtlMs,
    ORPHAN_SWEEP_MIN_AGE_MS,
    ORPHAN_SWEEP_WATCHDOG_FACTOR * Math.max(settings.maxSubagentAgeMs, toolCallMs),
  )
  const sessions = await listSessions(client, { directory })
  const parents = new Set()
  for (const s of sessions) if (typeof s?.parentID === "string" && s.parentID) parents.add(s.parentID)

  const deleted = []
  for (const s of sessions) {
    const sessionID = s?.id
    if (typeof sessionID !== "string" || sessionID === "") continue
    if (typeof s.title !== "string" || !s.title.startsWith(SUBAGENT_SESSION_TITLE_MARKER)) continue
    if (typeof s.parentID !== "string" || s.parentID === "") continue
    if (parents.has(sessionID)) continue
    if (isPrimary(sessionID) || entryForSession(sessionID)) continue
    const idleSince = s.time?.updated
    if (typeof idleSince !== "number" || !Number.isFinite(idleSince)) continue
    if (now - idleSince <= minAgeMs) continue
    log("bootstrap sweep: deleting a leaked subagent session", {
      sessionID,
      title: s.title,
      idleMs: now - idleSince,
    })
    // The gate reads a truthful boolean: a delete the server refused leaves the
    // session standing, so it is neither counted as deleted nor dropped from
    // the directory cache. It stays a leftover and the next sweep finds it
    // again — this run reports only what it really removed.
    //
    // A leaked session is one no registry entry names, so the parent this
    // sweep escapes a watching user to is the one the session itself carries.
    if (await deleteSession(client, sessionID, { parentID: s.parentID, cause: "sweep" })) {
      forgetSessionDirectory(sessionID)
      deleted.push(sessionID)
    }
  }
  if (deleted.length > 0) log("bootstrap sweep: deleted leaked subagent sessions", deleted.length)
  return deleted
}
