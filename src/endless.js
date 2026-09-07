// The endless-mode cycle: the idle-side executor that hands the primary's open
// work to a single wind-down subagent, which rewrites the project's todo file,
// then replaces the primary with a fresh orchestrator told to work that file
// off.
//
// Dependency-injected in the same discipline as handoff.js: this module imports
// no client, no registry and no todo-file I/O, so the whole sequence — quiesce
// wait, prepare, arm, wind-down turn, settle, confirm, replacement, bounds — is
// unit-testable against fakes with virtual time. The live wiring lives in
// handoffwiring.js. The two pure parse helpers `splitSections`/`parseTasks` are
// injected too, so the verification (verifyWindDown) can be exercised without
// touching the disk.
//
// Sequence (do NOT reorder):
//   1. Claim the latch. False → another idle event already took this cycle.
//   2. The cycle ceiling: at `maxCycles` the mode pauses itself for this
//      primary before anything is written or replaced.
//   2b. Drop every retained subagent. A retained session must not outlive the
//      primary this cycle replaces. The ceiling above is deliberately ahead of
//      this: it replaces nothing and lifts the freeze again.
//   3. Wait for quiesce — no subagent running anywhere in the process —
//      bounded by `quiesceTimeoutMs`. A timeout ABANDONS the cycle.
//   4. Prepare: resolve the todo file (creating a canonical one where the
//      directory has none), insert the machine section where it is absent and
//      WRITE it, then snapshot content + hash + parse + drift. Any failure
//      here abandons before a turn is spent.
//   5. Arm the single-use wind-down permit for this primary.
//   6. The wind-down turn: ask the primary to spawn the wind-down `planner`
//      through the permit. The shaped reply ends the TURN. If no shaped reply
//      arrives and the permit is unconsumed, the plugin spawns the subagent
//      itself (the fallback).
//   7. Settle: the shaped reply says the turn is over; the child's own ending
//      says the write finished. Await the child's settlement and require its
//      registry entry gone. Where it never settles, end the child and abandon.
//   8. Confirm: V1–V7 over the file as a whole. A failure of V1, V3, V4, V5 or
//      V6 restores the snapshot and abandons WITHOUT replacing the session.
//   9. Nothing left to do: the subagent's explicit "nothing open" and a
//      zero-task parse pause the mode instead of starting an empty session.
//   10. Replace: the handoff runs with the endless kickoff block carrying the
//      todo file's own text, and the wind-down reply standing in for the
//      doc-summary turn.
//   11. Record the open-task ids the cycle found and left, and apply the
//      no-progress bound to them.
//
// None of the deliberate stops writes the settings file. `endlessMode` is the
// user's own switch (on by default); a self-stop persisting `false` would
// disable that default for good. A stop pauses ONE primary session instead.
//
// Every abandon path releases the latch (lifting the spawn freeze), arms the
// cooldown, logs the stage, and NEVER replaces the primary. The permit is
// disarmed in a `finally` on every exit, so no permit outlives its cycle. Like
// runScheduledHandoff, this function NEVER throws — its caller is an event
// handler.

import fs from "node:fs"
import path from "node:path"

import { ensureResultsDir } from "./resultfile.js"
import { log, errMsg } from "./log.js"

// Cadence of the quiesce and settle waits. Mirrors DOC_SUMMARIES_POLL_MS.
export const ENDLESS_QUIESCE_POLL_MS = 500

// How many consecutive cycles may end without a single inherited task id
// leaving the todo file before the mode pauses itself.
export const ENDLESS_MAX_STALLED_CYCLES = 2

// Bound on the todo-file text the kickoff carries inline. The successor cannot
// open the file itself, so it is handed the file's own text verbatim; past this
// bound the text is cut at a block boundary and the successor is told to have a
// subagent read the rest.
export const KICKOFF_TODO_MAX_CHARS = 16000

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Comparison form of a task title: lower-cased with every run of whitespace
// collapsed to one space. Used by V6 (an id must not be re-bound to a different
// title) and by the no-progress record's own title normalisation where a caller
// still wants it.
export function normaliseTitle(title) {
  return typeof title === "string" ? title.trim().toLowerCase().replace(/\s+/g, " ") : ""
}

// Cuts the todo file's text for the kickoff at a block boundary (a blank line,
// falling back to a line boundary) so no task's indented run is split mid-way.
// Returns `{ text, truncated }`.
export function cutTodoText(content, max = KICKOFF_TODO_MAX_CHARS) {
  const text = String(content ?? "")
  if (text.length <= max) return { text, truncated: false }
  const blank = text.lastIndexOf("\n\n", max)
  if (blank > 0) return { text: text.slice(0, blank), truncated: true }
  let nl = text.lastIndexOf("\n", max)
  if (nl <= 0) nl = max
  return { text: text.slice(0, nl), truncated: true }
}

// The block the new orchestrator's kickoff carries in an endless cycle. It
// carries the todo file's OWN text verbatim (bounded, cut at a block boundary),
// because the successor holds spawn / abort / list / reuse and nothing else and
// cannot open the file itself. Where the text was truncated, or none could be
// read, the first instruction is a `planner` spawn to read the file in full.
//
// @param {Object} io
// @param {string} io.todoFileName  name of the todo file
// @param {string} io.todoFileText  the file's own text (already cut for the cap)
// @param {boolean} io.truncated    the text was cut, so the successor must read the rest
export function endlessKickoffBlock({ todoFileName, todoFileText = "", truncated = false } = {}) {
  const file = todoFileName || "the project's todo file"
  const text = String(todoFileText ?? "").trim()
  const head =
    `The previous orchestrator session reached its context ceiling. A wind-down subagent has ` +
    `updated ${file} with everything that is still open; the fresh session continues from it.`
  let body
  if (!text) {
    body =
      `The plugin could not read ${file} for this kickoff. Have a subagent read it in full ` +
      `before you plan the session — you cannot read it yourself.`
  } else if (truncated) {
    body =
      `The start of ${file} (it was too long to carry whole — have a subagent read the rest ` +
      `before you plan past what is shown):\n\n${text}`
  } else {
    body = `${file} as it stands now:\n\n${text}`
  }
  return (
    "## Endless mode — work off the todo file\n\n" +
    head +
    "\n\n" +
    body +
    "\n\n" +
    "Your job for this session: work that todo file off, top to bottom. The first task is the " +
    "next one to do. Spawn one subagent per task with the task id on the first line of the spawn " +
    "prompt. A task is finished when its subagent reports `DONE: T<n>` — the plugin removes it " +
    "from the file itself. Do not re-plan the list; start with the first task."
  )
}

// V4 treats one final newline as layout rather than content. Add it for the
// comparison only; a second final newline remains visible and is not tolerated.
function normaliseFinalNewlineForComparison(content) {
  const text = String(content ?? "")
  return text.endsWith("\n") ? text : `${text}\n`
}

// Accepted todo files always have one, and only one, final newline. This is
// deliberately separate from the comparison normalisation so V4 still sees
// extra final blank lines as a change.
function normaliseAcceptedContent(content) {
  const text = String(content ?? "")
  return `${text.replace(/\n+$/, "")}\n`
}

// The lines of `content` that lie outside the inclusive marked range, computed
// from an already-taken `split`. A helper kept beside V4 so the two read the
// same rule.
function outsideOf(content, split) {
  const lines = normaliseFinalNewlineForComparison(content).split("\n")
  if (!split.valid) return lines
  return [...lines.slice(0, split.beginIdx), ...lines.slice(split.endIdx + 1)]
}

// The set of lines V4 expects OUTSIDE the machine section after the wind-down:
// the snapshot's own outside lines, minus the required lines of every task block
// the parser found standing outside the markers in the snapshot. An immediately
// following blank line is a tolerated separator: the child may keep it or remove
// it while moving the block.
function expectedOutside(snapshot, splitSections, parseTasks) {
  const comparisonContent = normaliseFinalNewlineForComparison(snapshot.content)
  const split = splitSections(comparisonContent)
  const lines = comparisonContent.split("\n")
  const marked = new Set()
  if (split.valid) {
    for (let i = split.beginIdx; i <= split.endIdx; i++) marked.add(i)
  }
  const migrated = new Set()
  const optionalTrailingBlanks = new Set()
  for (const t of parseTasks(snapshot.content)) {
    // A task inside the markers is not an outside block.
    if (split.valid && t.lineIdx > split.beginIdx && t.lineIdx < split.endIdx) continue
    for (let i = t.lineIdx; i <= t.blockEndIdx; i++) migrated.add(i)
    const after = t.blockEndIdx + 1
    if (after < lines.length && lines[after].trim() === "") optionalTrailingBlanks.add(after)
  }
  const out = []
  const optionalBlankPositions = []
  for (let i = 0; i < lines.length; i++) {
    if (marked.has(i) || migrated.has(i)) continue
    if (optionalTrailingBlanks.has(i)) optionalBlankPositions.push(out.length)
    out.push(lines[i])
  }
  return {
    lines: out,
    optionalBlankPositions,
    migratedBlockIndices: [...migrated].sort((a, b) => a - b),
    optionalTrailingBlankIndices: [...optionalTrailingBlanks].sort((a, b) => a - b),
  }
}

// Compares the outside sequence while allowing each separator blank identified
// by expectedOutside to be retained or removed, independently.
function sequenceEqual(a, b, optionalBlankPositions) {
  const optional = new Set(optionalBlankPositions)
  let ai = 0
  let bi = 0
  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) {
      ai += 1
      bi += 1
      continue
    }
    if (optional.has(ai) && a[ai].trim() === "") {
      ai += 1
      continue
    }
    return false
  }
  while (ai < a.length && optional.has(ai) && a[ai].trim() === "") ai += 1
  return ai === a.length && bi === b.length
}

function jsonLine(line) {
  return line === undefined ? "<missing>" : JSON.stringify(line)
}

function firstDifference(expected, actual) {
  const length = Math.max(expected.length, actual.length)
  for (let i = 0; i < length; i++) {
    if (expected[i] !== actual[i]) {
      return { index: i, expected: jsonLine(expected[i]), actual: jsonLine(actual[i]) }
    }
  }
  return null
}

let rejectedWindDownSequence = 0

// Keeps the rejected bytes after the caller restores the pre-spawn snapshot.
// The result directory is private and best-effort, so a filing failure cannot
// turn a recoverable rejection into a thrown event-handler error.
export function writeRejectedWindDown(content, sessionID) {
  const safeSession = String(sessionID ?? "session").replace(/[^A-Za-z0-9._-]/g, "-") || "session"
  const file = path.join(
    ensureResultsDir(),
    `endless-wind-down-rejected-${safeSession}-${Date.now()}-${process.pid}-${rejectedWindDownSequence++}.md`,
  )
  try {
    fs.writeFileSync(file, String(content ?? ""), { encoding: "utf8", mode: 0o600 })
    return { path: file, error: null }
  } catch (err) {
    const error = errMsg(err)
    log("endless: rejected wind-down content could not be filed", { file, error })
    return { path: null, error }
  }
}

// The confirmation, as a pure function over the snapshot and the file the
// subagent left behind. V1 (the file still resolves to one regular file of the
// same name) is checked by the caller, which owns the re-resolve; V2 (the
// child's outcome) is combined by the caller. Everything here is computed from
// the file's content and the reply's stated signals — never asserted by the
// subagent.
//
// Returns { empty, v3, v4, v4Details, v5, v6, tasks, openIds, parseCount,
// replyCount, countMismatch }.
//
// @param {Object} snapshot  { content, tasks } — the pre-spawn file
// @param {Object} fresh      { content, replyNoChange, replyNothingOpen, replyCount }
// @param {Object} deps       { splitSections, parseTasks }
export function verifyWindDown(snapshot, fresh, { splitSections, parseTasks }) {
  const newContent = String(fresh.content ?? "")
  const newSplit = splitSections(newContent)
  const newTasks = parseTasks(newContent)
  const openIds = newTasks.map((t) => t.id)

  const empty = newTasks.length === 0 && fresh.replyNothingOpen === true

  const idsUnique = new Set(openIds).size === openIds.length
  const titlesNonEmpty = newTasks.every((t) => typeof t.text === "string" && t.text.trim() !== "")
  const v5 = newTasks.length >= 1 && idsUnique && titlesNonEmpty

  const v3 = newContent !== snapshot.content || fresh.replyNoChange === true

  const expected = expectedOutside(snapshot, splitSections, parseTasks)
  const actual = outsideOf(newContent, newSplit)
  const sequenceValid = sequenceEqual(expected.lines, actual, expected.optionalBlankPositions)
  const v4Details = {
    markerValid: newSplit.valid,
    sequenceValid,
    beginCount: newSplit.beginCount,
    endCount: newSplit.endCount,
    beginIdx: newSplit.beginIdx,
    endIdx: newSplit.endIdx,
    firstDifference: (() => {
      const difference = firstDifference(expected.lines, actual)
      if (!difference) return null
      return {
        index: difference.index,
        expectedLine: difference.expected,
        actualLine: difference.actual,
      }
    })(),
    expectedLength: expected.lines.length,
    actualLength: actual.length,
    migratedBlockIndices: expected.migratedBlockIndices,
    optionalTrailingBlankIndices: expected.optionalTrailingBlankIndices,
  }
  const v4 = v4Details.markerValid && v4Details.sequenceValid

  const snapTitleById = new Map((snapshot.tasks || []).map((t) => [t.id, normaliseTitle(t.text)]))
  const v6 = newTasks.every(
    (t) => !snapTitleById.has(t.id) || snapTitleById.get(t.id) === normaliseTitle(t.text),
  )

  const parseCount = newTasks.length
  const replyCount = fresh.replyCount ?? null
  const countMismatch = replyCount != null && replyCount !== parseCount

  return {
    empty,
    v3,
    v4,
    v4Details,
    v5,
    v6,
    tasks: newTasks,
    openIds,
    parseCount,
    replyCount,
    countMismatch,
  }
}

// Runs one endless cycle.
//
// @typedef {Object} EndlessCycleDeps
// @property {string} primarySessionID
// @property {() => boolean} claim
// @property {() => void} release
// @property {() => void} setCooldown
// @property {() => Promise<boolean>} isQuiesced
// @property {() => Promise<unknown>} [dropRetained]
// @property {() => number} [countActive]
// @property {() => { fileName: string, content: string, hash: string, tasks: Array, driftCount: number }} prepare
//   resolve + section-insert + write + snapshot; throws to abandon at prepare
// @property {() => { token: string }} armWindDown
// @property {() => void} [disarmWindDown]
// @property {(io: { token: string, fileName: string, driftCount: number }) => Promise<string>} windDownTurn
//   the primary's shaped reply; throws on timeout / no shaped reply
// @property {() => ({ consumed?: boolean, childSessionID?: string, settlement?: Promise<any> }|undefined)} windDownPermit
// @property {() => Promise<{ childSessionID: string, settlement: Promise<any> }>} startWindDownSubagent  the fallback
// @property {(child: { childSessionID: string, settlement: Promise<any> }) => Promise<{ ok: boolean, outcome?: any, reason?: string }>} settleWindDown
// @property {() => { name: string, content: string }} reread  V1 re-resolve; throws multiple/not-a-file
// @property {(text: string) => { count: number|null, noChange: boolean, nothingOpen: boolean }} interpretReply
// @property {(content: string) => void} restoreSnapshot  writes the resolved todo file;
//   used for snapshot restoration and for accepted-content newline normalisation
// @property {(content: string) => Array} parseTasks
// @property {(content: string) => Object} splitSections
// @property {(io: { extraKickoffBlock: string, docSummariesText: string }) => Promise<{ newSessionID: string }>} performHandoff
// @property {number} [cycleNumber]
// @property {number} [maxCycles]
// @property {(sessionID: string, reason: string) => boolean} [pause]
// @property {(openIdsFound: string[], openIdsLeft: string[]) => { stalledCycles: number, completed: number|null }} [recordCycle]
// @property {(t: { message: string, variant: string }) => void} [toast]
// @property {number} [quiesceTimeoutMs]
// @property {number} [pollMs]
// @property {(ms: number) => Promise<void>} [sleep]
// @property {() => number} [now]
//
// @param {EndlessCycleDeps} deps
// @returns {Promise<null|Object>} null when the latch was not claimed.
export async function runEndlessCycle({
  primarySessionID,
  claim,
  release,
  setCooldown,
  isQuiesced,
  dropRetained = null,
  countActive = () => 0,
  prepare,
  armWindDown,
  disarmWindDown = () => {},
  windDownTurn,
  windDownPermit = () => undefined,
  startWindDownSubagent,
  settleWindDown,
  reread,
  interpretReply = () => ({ count: null, noChange: false, nothingOpen: false }),
  restoreSnapshot = () => {},
  parseTasks,
  splitSections,
  performHandoff,
  cycleNumber = 1,
  maxCycles = 0,
  pause = () => false,
  recordCycle = () => ({ stalledCycles: 0, completed: null }),
  toast = () => {},
  quiesceTimeoutMs = 600_000,
  pollMs = ENDLESS_QUIESCE_POLL_MS,
  sleep = defaultSleep,
  now = Date.now,
}) {
  if (!claim()) return null

  const abandon = (stage, reason) => {
    log(`endless: abandoned at ${stage} — ${reason}`, { sessionID: primarySessionID })
    release()
    setCooldown()
    toast({ message: `endless mode: cycle abandoned at ${stage} — ${reason}`, variant: "error" })
    return { outcome: "abandoned", stage, reason }
  }

  const stop = (outcome, message, variant, pauseTarget = primarySessionID) => {
    release()
    const paused = pause(pauseTarget, message)
    log(`endless: ${message}`, { sessionID: primarySessionID, pausedSessionID: pauseTarget })
    toast({ message: `endless mode: ${message}`, variant })
    return { outcome, paused, pausedSessionID: pauseTarget }
  }

  try {
    // 2. The cycle ceiling, before anything is written or replaced.
    const cyclesCompleted = cycleNumber - 1
    if (maxCycles > 0 && cyclesCompleted >= maxCycles) {
      return stop(
        "ceiling",
        `cycle ceiling reached (${cyclesCompleted}/${maxCycles}) — paused for this session`,
        "warning",
      )
    }

    // 2b. Drop the retained subagents of the primary this cycle will replace.
    if (dropRetained) {
      try {
        await dropRetained()
      } catch (err) {
        log(`endless: dropping retained subagents failed, continuing — ${errMsg(err)}`, {
          sessionID: primarySessionID,
        })
      }
    }

    // 3. Quiesce.
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
    log(`endless: quiesced after ${now() - waitStartedAt}ms, activeAtStart=${activeAtStart}`, {
      sessionID: primarySessionID,
    })

    // 4. Prepare: resolve, insert the section, write, snapshot. A throw here —
    // several todo files, a non-regular file, an ensureTodoFile or section
    // write failure — abandons before a turn is spent.
    let snapshot
    try {
      snapshot = prepare()
    } catch (err) {
      return abandon("prepare", `the todo file could not be prepared: ${errMsg(err)}`)
    }
    const fileName = snapshot.fileName || ""
    const openIdsFound = (snapshot.tasks || []).map((t) => t.id)

    // 5. Arm the single-use permit.
    const { token } = armWindDown() || {}
    if (!token) return abandon("prepare", "the wind-down permit could not be armed")

    // 6. The wind-down turn. The shaped reply ends the turn; the child's
    // settlement (step 7) says the write finished.
    let replyText = ""
    try {
      replyText = await windDownTurn({ token, fileName, driftCount: snapshot.driftCount || 0 })
    } catch (err) {
      // No shaped reply in the window. The fallback covers a model that could
      // not place the tool call at its ceiling.
      log(`endless: wind-down turn produced no shaped reply — ${errMsg(err)}`, {
        sessionID: primarySessionID,
      })
    }

    // Whichever route ran, the cycle waits on the child the permit records — or,
    // where the permit was never consumed, on the fallback the plugin starts
    // itself after disarming so a late permitted spawn cannot add a second
    // writer against the same file.
    let child
    const permit = windDownPermit()
    if (permit && permit.consumed && permit.settlement) {
      child = { childSessionID: permit.childSessionID, settlement: permit.settlement }
    } else {
      // Disarm FIRST, synchronously, then start the fallback.
      disarmWindDown()
      log("endless: wind-down spawned by the plugin — the orchestrator made no permitted spawn", {
        sessionID: primarySessionID,
      })
      try {
        child = await startWindDownSubagent()
      } catch (err) {
        return abandon("wind-down", `the fallback wind-down spawn failed: ${errMsg(err)}`)
      }
      if (!child || !child.settlement) {
        return abandon("wind-down", "the fallback produced no wind-down child")
      }
    }

    // 7. Settle. Await the child's own ending, bounded; where it never settles
    // the child is ended and the cycle abandons — never confirm against a
    // running writer.
    let settle
    try {
      settle = await settleWindDown(child)
    } catch (err) {
      return abandon("wind-down", `the wind-down child could not be settled: ${errMsg(err)}`)
    }
    if (!settle || !settle.ok) {
      return abandon("wind-down", settle?.reason || "the wind-down child did not settle in the window")
    }
    const childOutcome = settle.outcome || {}
    const childCompleted = childOutcome.status === "completed"

    // 8. Confirm. V1 is the re-resolve here; the rest is verifyWindDown.
    let fresh
    try {
      fresh = reread()
    } catch (err) {
      // multiple / not-a-file: there is no single resolved file to restore to.
      toast({
        message: `endless mode: the todo file no longer resolves (${snapshot.fileName || "?"}) — ${errMsg(err)}`,
        variant: "error",
      })
      return abandon("confirm", `the todo file no longer resolves: ${errMsg(err)}`)
    }
    if (fresh.name !== snapshot.fileName) {
      toast({
        message: `endless mode: the todo file was renamed from ${snapshot.fileName} to ${fresh.name}`,
        variant: "error",
      })
      return abandon("confirm", `the todo file was renamed from ${snapshot.fileName} to ${fresh.name}`)
    }

    const reply = interpretReply(replyText)
    const verdict = verifyWindDown(
      snapshot,
      {
        content: fresh.content,
        replyNoChange: reply.noChange,
        replyNothingOpen: reply.nothingOpen,
        replyCount: reply.count,
      },
      { splitSections, parseTasks },
    )

    // 9. Nothing left to do: the subagent's explicit "nothing open" and a
    // zero-task parse pause the mode rather than start an empty session.
    if (verdict.empty) {
      return stop("no-open-points", "no open points left — paused for this session", "success")
    }

    // The rewrite the plugin will not stand behind (V3, V4, V5 or V6): restore
    // the snapshot, then abandon without replacing the session.
    const coreOk = verdict.v3 && verdict.v4 && verdict.v5 && verdict.v6
    if (!coreOk) {
      const failed = !verdict.v3 ? "V3" : !verdict.v4 ? "V4" : !verdict.v5 ? "V5" : "V6"
      const rejected = writeRejectedWindDown(fresh.content, primarySessionID)
      const rejectionLog = {
        sessionID: primarySessionID,
        failed,
        rejectedContentPath: rejected.path,
        ...(rejected.error ? { rejectedContentError: rejected.error } : {}),
        v4: verdict.v4Details,
      }
      try {
        restoreSnapshot(snapshot.content)
        log("endless: wind-down rewrite rejected — the todo file was restored", rejectionLog)
      } catch (err) {
        log("endless: wind-down rewrite rejected — the todo file could not be restored", {
          ...rejectionLog,
          restoreError: errMsg(err),
        })
        toast({
          message: `endless mode: the todo file could not be restored after ${failed} at ${snapshot.fileName}: ${errMsg(err)}`,
          variant: "error",
        })
      }
      return abandon("confirm", `wind-down rewrite rejected (${failed})`)
    }
    // V2: a child that ended abnormally is accepted only because V3–V6 all hold.
    if (!childCompleted) {
      log("endless: wind-down child did not complete, but the file verifies — accepting", {
        sessionID: primarySessionID,
        status: childOutcome.status,
      })
    }
    // V7: an observation, not a gate — the parse wins.
    if (verdict.countMismatch) {
      log("endless: wind-down reply count disagrees with the parse — the parse wins", {
        sessionID: primarySessionID,
        replyCount: verdict.replyCount,
        parseCount: verdict.parseCount,
      })
    }

    // Keep the accepted bytes stable for the next cycle. The writer is the same
    // dependency used for snapshot restoration; only a missing or extra final
    // newline reaches this branch because V4 rejected every other difference.
    const normalisedContent = normaliseAcceptedContent(fresh.content)
    if (normalisedContent !== fresh.content) {
      try {
        restoreSnapshot(normalisedContent)
        fresh = { ...fresh, content: normalisedContent }
      } catch (err) {
        const normaliseError = errMsg(err)
        let restoreError = null
        try {
          restoreSnapshot(snapshot.content)
        } catch (restoreErr) {
          restoreError = errMsg(restoreErr)
        }
        log("endless: accepted wind-down rewrite could not be normalised — the todo file was restored", {
          sessionID: primarySessionID,
          normaliseError,
          ...(restoreError ? { restoreError } : {}),
        })
        toast({
          message: `endless mode: the accepted todo rewrite could not be normalised at ${snapshot.fileName}: ${normaliseError}`,
          variant: "error",
        })
        return abandon("confirm", `accepted wind-down rewrite could not be normalised: ${normaliseError}`)
      }
    }

    const openIdsLeft = verdict.openIds
    log(
      `endless: wind-down confirmed ${openIdsLeft.length} open task(s) [${openIdsLeft.join(",") || "-"}] ` +
        `file=${fileName || "-"}`,
      { sessionID: primarySessionID },
    )

    // 10. Replace the primary. The kickoff carries the confirmed file's own
    // text; the wind-down reply stands in for the doc-summary turn.
    const { text: todoFileText, truncated } = cutTodoText(fresh.content)
    let result
    try {
      result = await performHandoff({
        extraKickoffBlock: endlessKickoffBlock({ todoFileName: fileName, todoFileText, truncated }),
        docSummariesText: replyText,
      })
    } catch (err) {
      return abandon("handoff", errMsg(err))
    }
    if (!result?.newSessionID) {
      return abandon("handoff", "the handoff produced no new session")
    }

    // 11. Record and apply the no-progress bound, keyed on open task ids.
    const { stalledCycles, completed } = recordCycle(openIdsFound, openIdsLeft)
    log(
      `endless: cycle ${cycleNumber}/${maxCycles || "∞"} complete, new session ${result.newSessionID}, ` +
        `open tasks ${openIdsFound.length}→${openIdsLeft.length} completed=${completed ?? "-"}`,
    )
    if (stalledCycles >= ENDLESS_MAX_STALLED_CYCLES) {
      const stopped = stop(
        "complete",
        `no task completed over ${stalledCycles} cycles at ${openIdsFound.length} open task(s) — ` +
          `paused for the new session`,
        "warning",
        result.newSessionID,
      )
      return {
        ...stopped,
        newSessionID: result.newSessionID,
        openIds: openIdsLeft,
        openBefore: openIdsFound.length,
        openAfter: openIdsLeft.length,
        stalledCycles,
      }
    }
    return {
      outcome: "complete",
      newSessionID: result.newSessionID,
      openIds: openIdsLeft,
      openBefore: openIdsFound.length,
      openAfter: openIdsLeft.length,
      stalledCycles,
    }
  } finally {
    // No permit may outlive its cycle, on any exit.
    disarmWindDown()
  }
}
