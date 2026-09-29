// Settling the subagents an opencode instance restart ended.
//
// opencode can dispose a project's instance and build a new one for the same
// directory inside the SAME process. The plugin module stays loaded, so the
// registry in state.js survives, and the factory runs again for the new
// instance. The dispose cuts off every run of the old instance, but the events
// that report those endings reach this plugin only while the old instance's
// event stream still stands: a run whose abort lands after it is gone is never
// reported at all, and its entry would stay "running" for the life of the
// process — holding a concurrency slot, never waking its primary, and keeping
// an endless cycle's quiesce open. With `maxSubagentAgeMs: 0` the orphan sweep
// never collects it and the watchdog only at its run ceiling, never where its
// type has none.
//
// Two signals mark the restart, and both are used:
//
//   - the plugin's `dispose` hook, which opencode calls while it disposes the
//     instance, side by side with the interruption of the instance's runs and
//     before it drops the plugin's event subscription. It marks the directory
//     as disposing; a `session.error` a subagent of that directory reports
//     inside that window is the dispose cutting the run off, and
//     onSessionError (src/hooks.js) leaves it to the reconcile below instead
//     of reporting it as an ordinary abort and deleting a session opencode is
//     still writing its abort into. `server.instance.disposed` is no signal
//     here: opencode publishes it after that subscription is gone;
//   - the factory running again for a directory it has already run for in this
//     process (noteInstanceLoad). That is what arms the reconcile, and it holds
//     whether or not the dispose hook ran.
//
// The reconcile waits INSTANCE_RESTART_SETTLE_MS after the last factory run for
// the directory, re-armed by every further run inside that window — opencode
// has been seen to dispose and rebuild the same instance several times within
// seconds — and cancelled by a dispose that falls inside it. Its reads and
// deletes then go to an instance that has finished building, and every write
// the old instance's dying runs made is in the database before the first
// session is read or deleted.
//
// A running entry of the directory whose run started before the last factory
// run is settled unless opencode reports its session as running in the new
// instance: the instance it ran in is gone, and no run of it survives the
// dispose. Each one is read once and its state filed exactly as on every other
// mid-work ending (secureSubagentState, src/resultfile.js), then torn down
// nested children first, and each primary is woken ONCE with one notice naming
// every subagent of its own that ended, posted after all of them are torn down
// so its slots line is true.

import {
  registry,
  aborted,
  loadedInstanceDirectories,
  instanceRestartReconciles,
  disposingInstanceDirectories,
} from "./state.js"
import {
  entryLifecycle,
  LIFECYCLE_RUNNING,
  primaryDirectoryOf,
  rootPrimaryFor,
  entryForSession,
  reservePendingDelivery,
  releasePendingDelivery,
} from "./registry.js"
import { fetchSnapshot, fetchRunningSessionIDs, showToast } from "./client.js"
import { secureSubagentState } from "./resultfile.js"
import { teardownSubagent, postParentNotice } from "./teardown.js"
import { instanceRestartNotice } from "./notices.js"
import { log, errMsg } from "./log.js"

// How long after the last factory run for a directory the reconcile waits.
export const INSTANCE_RESTART_SETTLE_MS = 2000

// The cause text every ending settled here carries: in the outcome a blocked
// nested caller is handed, and in the log.
export const INSTANCE_RESTART_DETAIL = "ended by an opencode instance restart"

function isDirectory(directory) {
  return typeof directory === "string" && directory !== ""
}

// Records one factory run for `directory`. The first run in this process is
// the ordinary load and answers false. Every later one is an instance restart:
// it clears the dispose mark and (re-)arms the reconcile, and answers true.
export function noteInstanceLoad(client, directory, now = Date.now()) {
  if (!isDirectory(directory)) return false
  disposingInstanceDirectories.delete(directory)
  if (!loadedInstanceDirectories.has(directory)) {
    loadedInstanceDirectories.add(directory)
    return false
  }
  const previous = instanceRestartReconciles.get(directory)
  if (previous) clearTimeout(previous.timer)
  const record = { client, loadedAt: now, timer: null }
  record.timer = setTimeout(() => {
    if (instanceRestartReconciles.get(directory) === record) instanceRestartReconciles.delete(directory)
    void reconcileAfterInstanceRestart(client, { directory, loadedAt: now }).catch((err) => {
      log("instance restart reconcile failed", { directory, err: errMsg(err) })
    })
  }, INSTANCE_RESTART_SETTLE_MS)
  record.timer.unref?.()
  instanceRestartReconciles.set(directory, record)
  log("instance restart: reconcile armed", { directory, settleMs: INSTANCE_RESTART_SETTLE_MS })
  return true
}

// Called from the plugin's `dispose` hook. Marks the directory as disposing
// and cancels a reconcile still waiting to run: the instance it would read is
// going away again, and the next factory run arms a fresh one.
export function noteInstanceDisposing(directory, now = Date.now()) {
  if (!isDirectory(directory)) return
  disposingInstanceDirectories.set(directory, now)
  const pending = instanceRestartReconciles.get(directory)
  if (pending) {
    clearTimeout(pending.timer)
    instanceRestartReconciles.delete(directory)
  }
  log("instance disposing", { directory })
}

// Whether the instance of `directory` is being disposed right now: the dispose
// hook ran for it and no factory run has followed yet.
export function instanceDisposing(directory) {
  return isDirectory(directory) && disposingInstanceDirectories.has(directory)
}

// The project directory an entry's run belongs to: its own, recorded at spawn,
// and for an entry the event hook registered before `spawn` reached it, the
// directory of the primary at the root of its chain. Undefined where neither is
// known.
export function entryInstanceDirectory(entry) {
  if (isDirectory(entry?.directory)) return entry.directory
  const root = rootPrimaryFor(entry?.parentID)
  const fromPrimary = root ? primaryDirectoryOf(root) : null
  return isDirectory(fromPrimary) ? fromPrimary : undefined
}

// Whether no other ending path has claimed the entry: the same guards the idle,
// error and watchdog paths test before they act.
function unclaimedRunning(entry) {
  if (!entry) return false
  if (entryLifecycle(entry) !== LIFECYCLE_RUNNING) return false
  if (aborted.has(entry.sessionID)) return false
  if (entry.timedOut || entry.errored || entry.dispatched) return false
  return true
}

function candidateEntries(directory, loadedAt) {
  const out = []
  for (const entry of registry.values()) {
    if (!unclaimedRunning(entry)) continue
    if ((entry.runStartedAt ?? 0) >= loadedAt) continue
    const own = entryInstanceDirectory(entry)
    if (own !== undefined && own !== directory) continue
    out.push(entry)
  }
  return out
}

// How many of `sessionID`'s ancestors are in `dead` — the order the teardowns
// run in, deepest first, so no delete cascades over a child still to be read.
function deadDepth(entry, dead) {
  let depth = 0
  const seen = new Set([entry.sessionID])
  let parentID = entry.parentID
  while (parentID && dead.has(parentID) && !seen.has(parentID)) {
    seen.add(parentID)
    depth += 1
    parentID = entryForSession(parentID)?.parentID
  }
  return depth
}

// The top-level ancestor inside `dead` an entry ended under, or the entry
// itself where its parent is not among the dead.
function deadRoot(entry, dead) {
  let current = entry
  const seen = new Set()
  while (current && dead.has(current.parentID) && !seen.has(current.sessionID)) {
    seen.add(current.sessionID)
    const parent = entryForSession(current.parentID)
    if (!parent) break
    current = parent
  }
  return current
}

// Settles every running subagent of `directory` whose run the instance restart
// ended. `loadedAt` is the moment of the factory run that armed it; a run
// started at or after it belongs to the new instance and is left alone.
//
// Answers `{ ended, left }`: the session ids it settled and the ones opencode
// still reports running, which it did not touch.
export async function reconcileAfterInstanceRestart(client, { directory, loadedAt = Date.now() } = {}) {
  if (!isDirectory(directory)) return { ended: [], left: [] }
  if (candidateEntries(directory, loadedAt).length === 0) return { ended: [], left: [] }

  // A session opencode reports running is running in the new instance — whoever
  // started it there — and is not this reconcile's to end. An unknown status
  // (the read failed) establishes nothing either way; the instance the entries
  // ran in is gone, so they are settled.
  const running = await fetchRunningSessionIDs(client, { directory })

  // Re-selected after the await, and latched before the next one: an idle or
  // error event may have claimed an entry while the status was being read, and
  // no other path may claim one of these from here on.
  const left = []
  const dead = []
  for (const entry of candidateEntries(directory, loadedAt)) {
    if (running?.has(entry.sessionID)) {
      left.push(entry.sessionID)
      continue
    }
    entry.errored = true
    entry.endedByInstanceRestart = true
    dead.push(entry)
  }
  if (left.length > 0) {
    log("instance restart: subagents still running in the new instance; left alone", {
      directory,
      sessionIDs: left,
    })
  }
  if (dead.length === 0) return { ended: [], left }

  const deadIDs = new Set(dead.map((e) => e.sessionID))
  log("instance restart: settling subagents the restart ended", {
    directory,
    subagents: dead.map((e) => e.handle),
    statusKnown: running !== null,
  })

  // The notice is posted after every teardown below, so the reservation spans
  // all of them: the quiesce predicate must not read this primary's subagents
  // as settled while their ending is still being delivered.
  reservePendingDelivery()
  try {
    // Every session is read before any is deleted: a parent's delete cascades
    // over its children, and a child's state has to be in its file first.
    const settled = new Map()
    for (const entry of dead) {
      const recovered = secureSubagentState(await fetchSnapshot(client, entry.sessionID), {
        handle: entry.handle,
        agent: entry.agent,
        sessionID: entry.sessionID,
        taskId: entry.taskId,
        runs: entry.runs ?? 1,
        directory: entry.directory,
        retained: false,
      })
      settled.set(entry.sessionID, {
        handle: entry.handle,
        agent: entry.agent,
        sessionID: entry.sessionID,
        parentID: entry.parentID,
        windDown: Boolean(entry.windDown),
        root: deadRoot(entry, deadIDs)?.sessionID ?? entry.sessionID,
        depth: deadDepth(entry, deadIDs),
        result: recovered.text,
        held: !recovered.secured,
        holdReason: recovered.holdReason ?? "unfiled",
      })
    }

    const order = [...settled.values()].sort((a, b) => b.depth - a.depth)
    for (const item of order) {
      await teardownSubagent(
        client,
        { sessionID: item.sessionID, handle: item.handle, parentID: item.parentID, agent: item.agent },
        {
          outcome: {
            status: "ended",
            handle: item.handle,
            agent: item.agent,
            result: item.result,
            detail: INSTANCE_RESTART_DETAIL,
          },
          notice: null,
          markAborted: true,
          hold: item.held,
          // The run is over and its instance with it: no idle event is coming
          // for this session, and waiting for one would only delay the delete.
          quiesced: true,
          label: "instance-restart",
        },
      )
    }

    // One notice per primary, naming its own subagents. A nested child is named
    // under the top-level subagent it ended with; a wind-down child is never
    // reported, as on every other ending path.
    const byParent = new Map()
    for (const item of order) {
      if (item.depth > 0 || item.windDown) continue
      const nested = order
        .filter((c) => c.depth > 0 && c.root === item.sessionID)
        .map((c) => c.handle)
      const list = byParent.get(item.parentID) ?? []
      list.push({ ...item, nested })
      byParent.set(item.parentID, list)
    }
    for (const [parentID, ended] of byParent) {
      if (!parentID) continue
      ended.sort((a, b) => String(a.handle).localeCompare(String(b.handle)))
      try {
        await postParentNotice(client, parentID, instanceRestartNotice(ended, directory), {
          kind: "instance-restart",
        })
      } catch (err) {
        log("instance restart: notice failed", { parentID, err: errMsg(err) })
      }
    }
    showToast(client, {
      title: "agent-intercom",
      message:
        dead.length === 1
          ? `${dead[0].handle} ended by an instance restart`
          : `${dead.length} subagents ended by an instance restart`,
      variant: "warning",
    })
    return { ended: [...deadIDs], left }
  } finally {
    releasePendingDelivery()
  }
}

// Test-only: runs the armed reconcile of `directory` now instead of at the end
// of its settle window, and answers its result — undefined where none is armed.
export async function _runPendingInstanceReconcileForTests(directory) {
  const pending = instanceRestartReconciles.get(directory)
  if (!pending) return undefined
  clearTimeout(pending.timer)
  instanceRestartReconciles.delete(directory)
  return reconcileAfterInstanceRestart(pending.client, { directory, loadedAt: pending.loadedAt })
}
