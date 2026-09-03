// Shared subagent-teardown + parent-notice delivery. Used by the event-dispatch
// paths (onSessionIdle / onSessionError in hooks.js) and by the inactivity
// watchdog (watchdog.js) — kept here, importing neither, so the two callers do
// not form an import cycle through this shared plumbing.

import {
  routeParentNotice,
  removeEntry,
  entryForSession,
  isPrimary,
  markEntryClosing,
  claimRetentionEvictionsLocked,
  registryMutex,
  reservePendingDelivery,
  releasePendingDelivery,
} from "./registry.js"
import {
  postNotice,
  showToast,
  deleteSession,
  listSessions,
  abortSession,
  forgetSessionDirectory,
  updateSessionTitle,
} from "./client.js"
import { getSettings, retentionOffered } from "./settings.js"
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
// structurally — the target table in agents.js admits no cycle and no chain
// longer than caller → researcher → grounder — but a parentID cycle from a
// reparent race must not spin here, and the cost of the guard is one Set.
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

// The title a held subagent's session carries: marker, stamp, then the text
// `spawn` was given. `retainedUntil` at or below zero composes the plain form,
// which is what an accepted reuse writes back.
export function retentionStampedTitle(baseTitle, retainedUntil) {
  const base = typeof baseTitle === "string" ? baseTitle : ""
  const stamp =
    Number.isFinite(retainedUntil) && retainedUntil > 0
      ? `[retained:${Math.floor(retainedUntil)}] `
      : ""
  return SUBAGENT_SESSION_TITLE_MARKER + stamp + base
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

// Leave a wide margin after the inactivity watchdog would reap a silent
// subagent. The sweep can see sessions from another opencode process, so its
// age bound must be later than that process's own watchdog deadline.
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
//     ORPHAN_SWEEP_WATCHDOG_FACTOR × maxSubagentAgeMs. A running subagent is
//     reaped by the inactivity watchdog before that latter bound, and a
//     retained one at its TTL, so nothing alive is ever this old; a second
//     opencode instance's subagent on the same database is either far younger
//     than this or already an orphan itself.
//
// The sweep is unavailable when the inactivity watchdog is disabled. Without
// that watchdog there is no finite age at which an untracked foreign session
// can be known to be dead, so deleting one would turn an explicit user setting
// into a live-session kill. A positive watchdog setting still leaves the sweep
// useful, including for the shipped default. Every spawned session carries the
// marker (tools.js), so the sweep can attribute them there as well; the cost at
// load is one session.list call.
export async function sweepOrphanedSubagentSessions(client, { directory, now = Date.now() } = {}) {
  const settings = getSettings()
  if (settings.maxSubagentAgeMs <= 0) return []
  const minAgeMs = Math.max(
    ORPHAN_SWEEP_TTL_FACTOR * settings.retainedSubagentTtlMs,
    ORPHAN_SWEEP_MIN_AGE_MS,
    ORPHAN_SWEEP_WATCHDOG_FACTOR * settings.maxSubagentAgeMs,
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
    if (await deleteSession(client, sessionID)) {
      forgetSessionDirectory(sessionID)
      deleted.push(sessionID)
    }
  }
  if (deleted.length > 0) log("bootstrap sweep: deleted leaked subagent sessions", deleted.length)
  return deleted
}
