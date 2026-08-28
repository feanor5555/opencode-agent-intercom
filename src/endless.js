// The endless-mode cycle: the idle-side executor that saves the primary's open
// points to the project's todo file and replaces the primary with a fresh
// orchestrator that is told to work that file off.
//
// Dependency-injected in the same discipline as handoff.js: this module imports
// no client, no registry and no todo-file code, so the whole sequence — quiesce
// wait, save, replacement, bounds — is unit-testable against fakes with virtual
// time. The live wiring lives in handoffwiring.js.
//
// Sequence (do NOT reorder):
//   1. Claim the latch. False → another idle event already took this cycle.
//   2. The cycle ceiling: at `maxCycles` the mode switches itself off before
//      anything is written or replaced.
//   3. Wait for quiesce — no subagent running anywhere in the process —
//      bounded by `quiesceTimeoutMs`. A timeout ABANDONS the cycle; aborting a
//      working subagent to make room for a context refresh would destroy real
//      work to save context.
//   4. Save: ask the primary for its open points, parse them, write one task
//      per point and READ THE FILE BACK. Every id `addTask` returned must be
//      in that read-back — the plugin knows the write happened rather than
//      assuming it. Any failure here abandons WITHOUT replacing the session:
//      replacing a primary after failing to save its open points is precisely
//      the data loss endless mode exists to prevent.
//   5. Nothing left to do: an empty point list AND an empty todo file switch
//      the mode off instead of starting a session that would have nothing to
//      work on.
//   6. Replace: the handoff runs with the endless kickoff block and with the
//      open-points text standing in for the doc-summary turn.
//   7. Record the open-task count and apply the no-progress bound.
//
// Every abandon path does the same three things: release the latch (which
// lifts the spawn freeze), arm the cooldown so an already-over-threshold
// primary cannot retry on its very next turn, and log the stage it failed at.
// Like `runScheduledHandoff`, this function NEVER throws — its caller is an
// event handler.

import { parseOpenPoints } from "./openpoints.js"
import { log, errMsg } from "./log.js"

// Cadence of the quiesce wait. Mirrors DOC_SUMMARIES_POLL_MS: the wait is
// bounded in minutes, so a half-second poll costs nothing and keeps the
// measured "quiesced after <ms>" figure honest.
export const ENDLESS_QUIESCE_POLL_MS = 500

// How many consecutive cycles may end without the open-task count falling
// before the mode switches itself off. The bound against the failure the mode
// invites: an orchestrator that saves the same points every cycle.
export const ENDLESS_MAX_STALLED_CYCLES = 2

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The block the new orchestrator's kickoff carries in an endless cycle,
// inserted right after the handoff summary. States only what the save step
// confirmed: the ids come from the read-back, never from the parse alone.
//
// @param {Object} io
// @param {string} io.todoFileName  name of the file the tasks were written to
// @param {string[]} io.ids         the confirmed task ids, in write order
// @returns {string}
export function endlessKickoffBlock({ todoFileName, ids = [] }) {
  const file = todoFileName || "the project's todo file"
  const head =
    ids.length > 0
      ? `The previous orchestrator session reached its context ceiling. Its open points ` +
        `were saved to ${file} as ${ids.length} task(s): ${ids.join(", ")}.`
      : `The previous orchestrator session reached its context ceiling. It reported no new ` +
        `open points; ${file} still carries the work that is open.`
  return (
    "## Endless mode — work off the todo file\n\n" +
    head +
    "\n\n" +
    "Your job for this session: work that todo file off, top to bottom. The first task " +
    "is the next one to do. Spawn one subagent per task with the task id on the first " +
    "line of the spawn prompt. A task is finished when its subagent reports " +
    "`DONE: T<n>` — the plugin removes it from the file itself. Do not re-add the " +
    "tasks; do not re-plan the list; start with the first one."
  )
}

// Runs one endless cycle.
//
// @typedef {Object} EndlessCycleDeps
// @property {string} primarySessionID
// @property {() => boolean} claim              consume the latch, atomically (claimPendingEndless)
// @property {() => void} release               clear the in-progress latch, lifting the spawn freeze
// @property {() => void} setCooldown           arm the post-abandon cooldown
// @property {() => Promise<boolean>} isQuiesced
// @property {() => number} [countActive]       active subagents, sampled once for the log line
// @property {() => Promise<string>} requestOpenPoints  the primary's final open-points turn; throws on timeout
// @property {(point: { title: string, accept?: string }) => { id: string }} addTask
// @property {() => Array<{ id: string }>} listOpen  the todo file's open tasks; a greenfield directory reads as []
// @property {() => string} [todoFileName]
// @property {(io: { extraKickoffBlock: string, openPointsText: string }) => Promise<{ newSessionID: string }>} performHandoff
// @property {number} [cycleNumber]             this primary's generation (handoffGeneration)
// @property {number} [maxCycles]               ceiling; <= 0 arms no ceiling
// @property {() => boolean} [switchOff]        write endlessMode:false back to the settings file
// @property {(openTasks: number) => { stalledCycles: number }} [recordCycle]
// @property {(t: { message: string, variant: string }) => void} [toast]
// @property {number} [quiesceTimeoutMs]
// @property {number} [pollMs]
// @property {(ms: number) => Promise<void>} [sleep]
// @property {() => number} [now]
//
// @param {EndlessCycleDeps} deps
// @returns {Promise<null|{ outcome: string }>} null when the latch was not
//   claimed; otherwise an outcome record ("ceiling", "abandoned",
//   "no-open-points", "complete").
export async function runEndlessCycle({
  primarySessionID,
  claim,
  release,
  setCooldown,
  isQuiesced,
  countActive = () => 0,
  requestOpenPoints,
  addTask,
  listOpen,
  todoFileName = () => "",
  performHandoff,
  cycleNumber = 1,
  maxCycles = 0,
  switchOff = () => false,
  recordCycle = () => ({ stalledCycles: 0 }),
  toast = () => {},
  quiesceTimeoutMs = 600_000,
  pollMs = ENDLESS_QUIESCE_POLL_MS,
  sleep = defaultSleep,
  now = Date.now,
}) {
  // 1. The claim is synchronous, so a duplicate idle event — or an idle racing
  // the executing cycle, e.g. the old primary going idle again after its
  // open-points turn — cannot start a second cycle.
  if (!claim()) return null

  // Abandon: release the latch (the spawn freeze lifts with it), arm the
  // cooldown, say where and why. The primary is NOT replaced.
  const abandon = (stage, reason) => {
    log(`endless: abandoned at ${stage} — ${reason}`, { sessionID: primarySessionID })
    release()
    setCooldown()
    toast({ message: `endless mode: cycle abandoned at ${stage} — ${reason}`, variant: "error" })
    return { outcome: "abandoned", stage, reason }
  }

  // Switch the mode off through the plugin's own settings write and release.
  // Used by the three bounds that end the loop deliberately; no cooldown —
  // there is nothing left to hold back.
  const stop = (outcome, message, variant) => {
    const written = switchOff()
    release()
    log(`endless: ${message}`, { sessionID: primarySessionID, settingsWritten: written })
    toast({ message: `endless mode: ${message}`, variant })
    return { outcome, switchedOff: written }
  }

  // 2. The cycle ceiling, checked BEFORE anything is written or replaced.
  // Counted over the handoff-redirect chain, so it survives every replacement
  // in this process. A non-positive ceiling arms nothing, the way a
  // non-positive context threshold does.
  if (maxCycles > 0 && cycleNumber >= maxCycles) {
    return stop("ceiling", `cycle ceiling reached (${cycleNumber}/${maxCycles}) — switched off`, "warning")
  }

  // 3. Quiesce. The count is process-wide, so the wait is an
  // over-approximation with a second orchestrator in the same process. The
  // inactivity watchdog resolves a HUNG subagent on its own well inside this
  // window; the timeout is for one that is genuinely working.
  const waitStartedAt = now()
  const activeAtStart = countActive()
  let quiesced = false
  try {
    quiesced = await isQuiesced()
    while (!quiesced) {
      if (now() - waitStartedAt >= quiesceTimeoutMs) {
        return abandon("quiesce", `still busy after ${quiesceTimeoutMs}ms`)
      }
      await sleep(pollMs)
      quiesced = await isQuiesced()
    }
  } catch (err) {
    return abandon("quiesce", errMsg(err))
  }
  log(
    `endless: quiesced after ${now() - waitStartedAt}ms, subagents drained=${activeAtStart}`,
    { sessionID: primarySessionID },
  )

  // 4a. The open-points turn. The primary cannot write files — it holds
  // spawn / abort / list and nothing else — so the reply is plain text and the
  // plugin does the writing.
  let openPointsText
  try {
    openPointsText = await requestOpenPoints()
  } catch (err) {
    return abandon("save", `open-points turn failed: ${errMsg(err)}`)
  }
  const points = parseOpenPoints(openPointsText)
  if (points === null) {
    return abandon("save", "reply carried no `## OPEN POINTS` heading")
  }

  // 4b. The open-task count BEFORE the write — the "before" half of the
  // progress figure. A directory with no todo file at all reads as empty; any
  // other unusable todo file (several of them, or one that is not a regular
  // file) throws and abandons the cycle rather than being written over.
  let openBefore
  try {
    openBefore = listOpen().length
  } catch (err) {
    return abandon("save", `todo file unusable: ${errMsg(err)}`)
  }

  // 4c. Write one task per point.
  const ids = []
  try {
    for (const point of points) {
      const { id } = addTask(point)
      ids.push(id)
    }
  } catch (err) {
    return abandon("save", `writing the open points failed: ${errMsg(err)}`)
  }

  // 4d. The confirmation, and the part that is not assumed: read the file back
  // and require every id the write returned to be in it.
  let openTasks
  try {
    openTasks = listOpen()
  } catch (err) {
    return abandon("save", `todo file unreadable after the write: ${errMsg(err)}`)
  }
  const present = new Set(openTasks.map((t) => t.id))
  const missing = ids.filter((id) => !present.has(id))
  if (missing.length > 0) {
    return abandon("save", `${missing.join(",")} missing from the todo file after the write`)
  }
  const fileName = todoFileName()
  log(
    `endless: saved ${points.length} point(s) as ${ids.join(",") || "-"} ` +
      `confirmed=${ids.length} file=${fileName || "-"}`,
    { sessionID: primarySessionID },
  )

  // 5. Nothing left to do. A restart into an empty todo file would produce a
  // session with nothing to work on, which would idle and be woken by nothing.
  if (ids.length === 0 && openTasks.length === 0) {
    return stop("no-open-points", "no open points left — switched off", "success")
  }

  // 6. Replace the primary. The open-points turn has already happened, so the
  // doc-summary turn is not asked for a second time — the wiring hands the
  // text we already have back to the handoff instead.
  let result
  try {
    result = await performHandoff({
      extraKickoffBlock: endlessKickoffBlock({ todoFileName: fileName, ids }),
      openPointsText,
    })
  } catch (err) {
    return abandon("handoff", errMsg(err))
  }
  if (!result?.newSessionID) {
    return abandon("handoff", "the handoff produced no new session")
  }

  // 7. The progress record, and the no-progress bound on it. The count at the
  // end of the cycle is the file as the new orchestrator finds it.
  const openAfter = openTasks.length
  const { stalledCycles } = recordCycle(openAfter)
  log(
    `endless: cycle ${cycleNumber}/${maxCycles || "∞"} complete, new session ${result.newSessionID}, ` +
      `open tasks ${openBefore}→${openAfter}`,
  )
  if (stalledCycles >= ENDLESS_MAX_STALLED_CYCLES) {
    // The latch of the OLD primary is already gone (the handoff's forgetPrimary
    // released it); `stop`'s release is a harmless no-op here and the write is
    // what matters.
    const stopped = stop(
      "complete",
      `no progress over ${stalledCycles} cycles at ${openAfter} open task(s) — switched off`,
      "warning",
    )
    return { ...stopped, newSessionID: result.newSessionID, ids, openBefore, openAfter, stalledCycles }
  }
  return {
    outcome: "complete",
    newSessionID: result.newSessionID,
    ids,
    openBefore,
    openAfter,
    stalledCycles,
  }
}
