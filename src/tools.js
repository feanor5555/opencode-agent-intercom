// The three tools the primary agent gets: spawn, abort, list.

import { tool } from "@opencode-ai/plugin"
import { registry, aborted, registryMutex } from "./state.js"
import {
  createChildSession,
  promptSession,
  abortSession,
  showToast,
  getSessionDirectory,
  deleteSession,
  forgetSessionDirectory,
  fetchSnapshot,
  snapshotOutcome,
} from "./client.js"
import {
  resolve,
  upsertSession,
  removeEntry,
  entryForSession,
  trackPrimary,
  countActiveSubagents,
  effectiveState,
  isActiveEntry,
  reservePendingSpawn,
  releasePendingSpawn,
  activeTaskIdsFor,
  reservePendingTaskId,
  releasePendingTaskId,
  isTaskIdPending,
  isEndlessFrozen,
  rootPrimaryFor,
  spawnCapDecision,
  nestedQuotaDecision,
  chargeNestedSpawn,
  chargeNestedRun,
  entryLifecycle,
  reuseAdmission,
  reviveRetainedEntryLocked,
  restoreRetainedEntryLocked,
  LIFECYCLE_RETAINED,
  LIFECYCLE_RUNNING,
  REUSE_QUESTION,
  REUSE_TASK,
  RETAIN_TASK_SHARE,
} from "./registry.js"
import { registerChildWaiter, settleChildWaiter } from "./childwait.js"
import { endLiveChildrenOf, waitForSessionQuiescence } from "./teardown.js"
import { projectContext } from "./project.js"
import { AGENTS, NESTED_SPAWN_TARGET, SPAWNABLE_ROLES } from "./agents.js"
import { knownAgentKinds } from "./config.js"
import {
  getSettings,
  contextBudgetFor,
  reuseCeilingFor,
  PACKAGE_WARN_SHARE,
  PACKAGE_REFUSE_SHARE,
} from "./settings.js"
import { createWebsearchTool, isWebsearchEnabled } from "./websearch.js"
import { createForumSearchTool, isForumSearchEnabled } from "./forumsearch.js"
import { createOutlineTool, isOutlineEnabled } from "./outline.js"
import {
  listOpen,
  removeTask,
  addTask,
  editTask,
  todoFilePath,
  TodoFileMissingError,
} from "./todofile.js"
import { log, errMsg } from "./log.js"
import { tokens as fmtTokens, ageSeconds, estimateTokens, percent } from "./format.js"

// Matches an optional task-id prefix on the first line of a spawn prompt
// (T5). When present, the wake-hook will auto-tick TODO.md on the matching
// `DONE:` marker in the subagent's reply. Absence is fine — non-task spawns
// (status checks, ad-hoc questions) just opt out of auto-tick.
const SPAWN_TASK_PREFIX_RE = /^\s*(T\d+)\s*[:.\-]\s*/m

function extractTaskId(prompt) {
  const m = SPAWN_TASK_PREFIX_RE.exec(prompt ?? "")
  return m ? m[1] : undefined
}

// Detects multi-task spawn prompts. Small models like to bundle "T29: do A.
// T30: do B. T31: do C." into a single coder spawn — that breaks the size
// rule (multiple files / multiple concerns) and gives the wake-hook only one
// TODO.md slot to flip. Pattern: any `T\d+:` (with colon) that appears on a
// line on its own or after a list bullet / number. Counts unique IDs so a
// pure cross-reference ("uses plans/T3.md") doesn't trip it. Returns the set
// of distinct IDs found at line-leading positions.
const SPAWN_TASK_ID_LINE_RE = /(?:^|\n)\s*(?:[-*+]\s+|\d+[.)]\s+)?(T\d+):/g

function extractAllTaskIds(prompt) {
  if (!prompt) return new Set()
  const ids = new Set()
  let m
  SPAWN_TASK_ID_LINE_RE.lastIndex = 0
  while ((m = SPAWN_TASK_ID_LINE_RE.exec(prompt)) !== null) ids.add(m[1])
  return ids
}

// Sizes a work package against the context budget of the type it is going to.
// The package is everything the spawn sends — the project snapshot the plugin
// prepends plus the orchestrator's own text — so the figure is what the
// subagent actually receives, not what the orchestrator typed. The size is an
// ESTIMATE (estimateTokens, chars/4), which is why the bars sit at fifths of
// the budget rather than close to it.
//
// Returns `refusal` (a message to hand back instead of spawning) or `notice`
// (a line to append to a successful spawn), at most one of them non-empty. A
// budget of 0 means the ceiling is disabled for that type; the gate is then
// skipped entirely and both come back empty.
function packageSizeVerdict(agent, fullPrompt) {
  const budget = contextBudgetFor(agent)
  if (budget <= 0) return { estimate: estimateTokens(fullPrompt), budget, refusal: "", notice: "" }
  const estimate = estimateTokens(fullPrompt)
  const warnAt = budget * PACKAGE_WARN_SHARE
  const refuseAt = budget * PACKAGE_REFUSE_SHARE
  if (estimate > refuseAt) {
    return {
      estimate,
      budget,
      notice: "",
      refusal:
        `Spawn refused: the work package is ~${fmtTokens(estimate)} tokens (estimated, project ` +
        `snapshot included) — over the ${percent(PACKAGE_REFUSE_SHARE)} bar of ` +
        `${fmtTokens(refuseAt)} for a ${agent}, whose context budget is ${fmtTokens(budget)}. ` +
        `No subagent was started. SPLIT this work into smaller packages — one concern each — and ` +
        `spawn them one per task; pass bulk material as a file path for the subagent to read ` +
        `instead of pasting it inline. Keep each package at or under ` +
        `${percent(PACKAGE_WARN_SHARE)} of the budget (${fmtTokens(warnAt)} for a ${agent}) so ` +
        `the subagent has room to work.`,
    }
  }
  if (estimate > warnAt) {
    return {
      estimate,
      budget,
      refusal: "",
      notice:
        ` Package size: ~${fmtTokens(estimate)} of the ${fmtTokens(budget)} ${agent} budget ` +
        `(estimated) — over the ${percent(PACKAGE_WARN_SHARE)} target of ${fmtTokens(warnAt)}, ` +
        `${fmtTokens(Math.max(0, budget - estimate))} left for the subagent's own work. Scope the ` +
        `next package in this area tighter, or pass bulk material as a file path.`,
    }
  }
  return { estimate, budget, refusal: "", notice: "" }
}

// NESTED_SPAWN_TARGET (agents.js) is the one agent type a NESTED spawn — one
// whose caller is itself a subagent — may name. `researcher` is the carve-out
// of the delegation rule: web access is concentrated in it, so it is the one
// thing another role cannot do for itself.
//
// It is also what bounds the nesting depth at exactly one level, structurally,
// with no counter and no walk of the session tree: the researcher role is
// itself denied `spawn` (agents.js), so a nested child can never have children
// of its own. Every teardown therefore has to consider one generation of
// children, never a tree.

// The refusal a nested spawn gets, or "" when it passes. Covers the three
// checks that decide before anything is reserved or created; the per-run quota
// is checked separately, next to the charge that consumes it, so the two stay
// in one synchronous block.
async function nestedSpawnRefusal(permissionGuard, callerEntry, args, callerSessionID) {
  // May this ROLE delegate at all? The per-role `permission.spawn` map is the
  // whole lever — a role that carries `spawn: "deny"` gets exactly the refusal
  // it got when no subagent could spawn at all, so a non-delegating role sees
  // no change whatever. checkSpawnPermission resolves it fail-closed
  // (config.js): an unreadable config or an unknown role denies.
  const denied = await permissionGuard.checkSpawnPermission(callerEntry.agent)
  if (denied) {
    log("spawn refused: caller is a subagent", {
      sessionID: callerSessionID,
      agent: callerEntry.agent,
      reason: denied,
    })
    return (
      "You are a subagent — you cannot spawn other agents. If this task needs another " +
      "agent, name it and what it should do in your final reply; the orchestrator decides " +
      "and spawns it."
    )
  }
  // Which target? One only, and the refusal names it, in the same shape as the
  // agent-type gate below: a returned refusal that says what IS available, not
  // a throw, because a throw is what small models retry into a loop.
  if (args.agent !== NESTED_SPAWN_TARGET) {
    log("spawn refused: nested target is not the researcher", {
      sessionID: callerSessionID,
      agent: args.agent,
    })
    return (
      `Spawn refused: a subagent may spawn a "${NESTED_SPAWN_TARGET}" and nothing else — you ` +
      `asked for a "${args.agent}". Delegation from a subagent exists for the one thing you ` +
      `cannot do yourself: web search and fetching. For anything else, name the agent and what ` +
      `it should do in your final reply; the orchestrator decides and spawns it.`
    )
  }
  // No task id. The `T<n>` prefix drives the TODO.md auto-tick, and a nested
  // run is preparation for the caller's task, not a task of its own: left in,
  // the child's `DONE: T<n>` would tick a task the orchestrator is still
  // tracking against the caller, and the caller would report done on work it
  // has not finished.
  const taskId = extractTaskId(args.prompt)
  if (taskId) {
    log("spawn refused: nested spawn carries a task id", {
      sessionID: callerSessionID,
      taskId,
    })
    return (
      `Spawn refused: a nested spawn carries no task id, and this prompt starts with ` +
      `"${taskId}". The ${NESTED_SPAWN_TARGET} prepares material for YOUR task — the TODO.md ` +
      `entry for ${taskId} stays yours to finish and to mark. Re-spawn with the prefix removed.`
    )
  }
  return ""
}

// The tool result of a nested `spawn`: what the blocked caller gets back the
// moment its child ends. EVERY ending renders, not just the good one — the
// caller asked a question inside a tool call and has to be told either the
// answer or why there is none, or it sits on an empty result it cannot read.
function nestedSpawnOutput(outcome, handle, agent) {
  const who = `${handle} (${agent})`
  if (outcome.status === "completed") {
    const cost = outcome.ctxTokens
      ? ` It used ~${fmtTokens(outcome.ctxTokens)} tokens of its own context getting there.`
      : ""
    return (
      `${who} finished and is gone. Its reply:\n\n${outcome.result || "(it replied with nothing)"}` +
      `\n\nThat is everything it will ever say.${cost} Work from it — it cannot be asked again.`
    )
  }
  const cause =
    {
      error: "failed",
      aborted: "was aborted",
      timeout: "was timed out for inactivity",
      expired: "has not reported back in time and may still be running",
      ended: "was ended before it could reply",
      abandoned: "was dropped when the plugin's state was reset",
    }[outcome.status] ?? "ended without a result"
  const why = outcome.detail ? ` — ${outcome.detail}` : ""
  return (
    `${who} ${cause}${why}. You have no result from it. Carry on with what you can do ` +
    `yourself and state plainly in your final reply what is still missing, so the orchestrator ` +
    `can get it — open that reply with "Blocked:" where the missing material stops the task.`
  )
}

const z = tool.schema

// Wraps a tool handler so any thrown error becomes a friendly output string
// instead of crashing the tool call.
function guard(name, handler) {
  return async (args, toolCtx) => {
    try {
      return await handler(args, toolCtx)
    } catch (err) {
      log(`${name} error`, errMsg(err))
      return { output: `${name} failed: ${errMsg(err)}` }
    }
  }
}

const unknown = (ref) => ({ output: `Unknown subagent "${ref}".` })

// Best-effort cooperative abort — never throws, reports whether it confirmed.
async function signalAbort(client, sessionID) {
  try {
    return await abortSession(client, sessionID)
  } catch (err) {
    log("session.abort failed", errMsg(err))
    return false
  }
}

function formatListRow(entry) {
  return (
    `${entry.handle}  [${effectiveState(entry)}]  ${ageSeconds(entry.spawnedAt)}s  ` +
    `ctx:${fmtTokens(entry.ctxTokens)}  session:${entry.sessionID}`
  )
}

// Whole minutes left on a retained entry's window, floored at 0. Coarse on
// purpose: the figure is read by a model deciding whether a follow-up is still
// worth asking, and a second-precision countdown would be a number that moves
// on every render for no decision it changes.
function retainedMinutesLeft(entry, ttlMs, now = Date.now()) {
  const left = (entry.retainedAt ?? 0) + ttlMs - now
  return Math.max(0, Math.floor(left / 60000))
}

// One row of the retained section of `list`. A retained subagent is finished
// and holds no concurrency slot, so it carries what the orchestrator needs to
// decide whether to put a follow-up to it rather than what it needs to watch a
// run: the handle it would address, the agent type it is, the context already
// in the session (which is what the reuse gate is decided on) and how much of
// the retention window is left.
function formatRetainedRow(entry, ttlMs) {
  return (
    `${entry.handle}  [retained]  ${entry.agent}  ctx:${fmtTokens(entry.ctxTokens)}  ` +
    `${retainedMinutesLeft(entry, ttlMs)}m left  session:${entry.sessionID}`
  )
}

export function createTools({ client, directory: factoryDirectory, permissionGuard }) {
  // Authoritative per-call directory resolver. Both `toolCtx.directory` and
  // the factory closure's `directory` reflect where `opencode serve` was
  // started, NOT the session's actual project directory. The session object
  // (GET /session/<id>) carries the truth — see `getSessionDirectory` in
  // client.js (cached). Fall back to toolCtx → factory for the unit-test
  // path where the mock client doesn't implement session.get.
  async function dirFor(toolCtx) {
    const fromSession = await getSessionDirectory(client, toolCtx?.sessionID)
    return fromSession || toolCtx?.directory || factoryDirectory
  }

  async function spawnHandler(args, toolCtx) {
    // Who is calling? A session that has a registry entry is a subagent — the
    // classification the whole plugin uses — and its spawn is a NESTED one:
    // gated by the three checks below instead of by "subagents do not spawn",
    // and, once admitted, BLOCKING. The child's ending becomes this call's tool
    // result, so the caller never ends its turn while its child runs and stays
    // the one-shot leaf every downstream assumption is written against.
    //
    // Checked BEFORE trackPrimary, which additionally refuses any session that
    // has a registry entry, so a subagent caller can never be misregistered as
    // a primary.
    const callerEntry = entryForSession(toolCtx.sessionID)
    const nested = Boolean(callerEntry)
    if (nested) {
      const refusal = await nestedSpawnRefusal(
        permissionGuard,
        callerEntry,
        args,
        toolCtx.sessionID,
      )
      if (refusal) return { output: refusal }
    }
    // The endless-mode spawn freeze. From the moment the latch is set until
    // the cycle ends, no new subagent starts: between the latch and quiesce the
    // orchestrator is still answering its turn, and one that spawns as fast as
    // its subagents finish would never let the cycle reach quiesce. A subagent
    // started now would in any case be reparented onto a session that has no
    // memory of asking for it.
    //
    // A THROW, not a returned refusal — the shape §3.3 of the endless-mode
    // concept names, and the shape the primary-tool guard in hooks.js already
    // uses. NOTE: `guard` (above) catches it and hands the model
    // `spawn failed: <this text>`, so what the model sees is the text either
    // way; the throw is what makes the refusal a failed tool call rather than
    // a successful one with a refusal in it.
    //
    // Asked of the caller's ROOT primary, not of the caller: the latch sets
    // hold primary session ids only, so a nested caller asking about its own
    // id would always be told "not frozen" and would keep spawning through the
    // freeze. For a primary caller rootPrimaryFor is the identity.
    if (isEndlessFrozen(rootPrimaryFor(toolCtx.sessionID))) {
      log("spawn refused: endless cycle in progress", { sessionID: toolCtx.sessionID })
      throw new Error(
        "Endless mode is saving this session's open points and replacing it with a fresh " +
          "orchestrator. No new subagent will start. End your turn now — the work you would " +
          "delegate belongs in your open points, which you are about to be asked for.",
      )
    }
    trackPrimary(toolCtx.sessionID)
    const directory = await dirFor(toolCtx)

    // Agent-type gate: a CLOSED positive list — this plugin's own subagent
    // roles (SPAWNABLE_ROLES, agents.js) and nothing else.
    //
    // Anything outside it is refused however well opencode itself resolves the
    // name. An agent a project defines to wrap a model carries none of this
    // plugin's role prompt and none of its permission map, so spawned it would
    // be an unbounded agent with a full tool set; and, not being in the limits
    // block, it would run against a DEFAULT_MAX_CONTEXT budget the orchestrator
    // was never shown, so the sizing rule it is given would be applied to a
    // number that is not the one in force. A typo lands here too.
    //
    // The refusal names every type that IS available, so the orchestrator can
    // correct itself in place, and it states the reason that is true of the
    // name: an agent this opencode instance does resolve is refused for what it
    // is, not as a name the project does not have.
    //
    // The plugin's own roles are classified first, from AGENTS, and not from
    // the server's answer: a name this plugin installs is its own whether or
    // not the server list can be read, and the fail-soft empty list of
    // config.js must not turn it into a name nobody has.
    if (!SPAWNABLE_ROLES.includes(args.agent)) {
      const kind = Object.hasOwn(AGENTS, args.agent)
        ? "own"
        : (await knownAgentKinds(client)).get(args.agent)
      const cause =
        {
          own: `"${args.agent}" is this plugin's primary role — the one you are running as — not a subagent to delegate to`,
          primary: `"${args.agent}" is a primary agent, not a type that can run as a subagent`,
          hidden: `"${args.agent}" is a hidden agent, not a type that can run as a subagent`,
          other: `"${args.agent}" is an agent this opencode instance defines, but not one of the roles this plugin installs — only those can be spawned`,
        }[kind] ?? `"${args.agent}" is not an agent type this project has`
      log("spawn refused: agent type not spawnable", { agent: args.agent, kind: kind ?? "unknown" })
      return {
        output:
          `Spawn refused: ${cause}, so no subagent was started. Available types: ` +
          `${[...SPAWNABLE_ROLES].sort().join(", ")}. Re-spawn with one of them — pick by the ` +
          `deliverable you want back.`,
      }
    }

    const denied = await permissionGuard.checkTaskPermission(toolCtx.agent, args.agent)
    if (denied) {
      log("spawn denied", denied)
      return { output: `Denied: ${denied}` }
    }

    // Multi-task bundle guard: a single spawn carrying several `T<n>:` markers
    // is the orchestrator trying to dump its whole batch into one coder. The
    // size rule is per spawn — one concern, one task — so reject up front with
    // a clear hint to split. Allowed: zero or one ID.
    const allTaskIds = extractAllTaskIds(args.prompt)
    if (allTaskIds.size > 1) {
      const list = [...allTaskIds].sort().join(", ")
      log("spawn refused: multi-task prompt", { ids: list })
      return {
        output:
          `Spawn refused: this prompt bundles ${allTaskIds.size} tasks (${list}). One spawn = ` +
          `one task. Issue ${allTaskIds.size} separate spawns instead — they can run back-to-back ` +
          `(parallel up to maxSubagents). The wake-hook ticks one TODO.md slot per spawn, so a ` +
          `bundled prompt loses status tracking for all but one of them.`,
      }
    }

    // Work-package size gate. Runs before any reservation and before the child
    // session exists, so a refusal costs nothing and leaves no state behind.
    // `fullPrompt` is built here and reused for promptSession below — the gate
    // measures exactly the text the subagent gets.
    const ctxBlock = projectContext(directory)
    const fullPrompt = ctxBlock ? `${ctxBlock}\n\n${args.prompt}` : args.prompt
    const size = packageSizeVerdict(args.agent, fullPrompt)
    if (size.refusal) {
      log("spawn refused: package too large", {
        agent: args.agent,
        estimate: size.estimate,
        budget: size.budget,
      })
      return { output: size.refusal }
    }

    // Pull an optional task id (T5) off the first line of the prompt.
    // Present → wake-hook auto-ticks TODO.md when the subagent's reply has
    // the matching `DONE:` marker on its first or last non-empty line. Absent → non-task spawn
    // (status check, ad-hoc question) and auto-tick is skipped. The orchestrator
    // decides per spawn; the plugin never forces a prefix.
    // Atomic duplicate-task check-and-reserve. The id is only written onto the
    // registry entry by upsertSession AFTER the createChildSession /
    // promptSession awaits below, so a bare check against activeTaskIdsFor would
    // leave a TOCTOU window: two spawn() calls in the same turn carrying the
    // same task-id both pass the check, both start, and the wake-hook double-
    // ticks TODO.md on the matching DONE: marker. Reserving the id in
    // pendingTaskIds in THIS synchronous block (before the first await) makes it
    // visible to any later spawn() in the same micro-batch — mirrors the
    // pendingSpawns cap reservation. Prefix-free spawns pass taskId=undefined
    // and never reserve, so they cannot block one another.
    const taskId = extractTaskId(args.prompt)
    if (taskId) {
      const active = activeTaskIdsFor(toolCtx.sessionID)
      if (active.has(taskId) || isTaskIdPending(taskId)) {
        log("spawn refused: duplicate task id", { taskId })
        return {
          output:
            `Spawn refused: task ${taskId} already has a subagent running. Wait for it to finish ` +
            `(you are woken automatically) before re-spawning the same task, or abort the existing ` +
            `one (only if the user says so) and then re-spawn.`,
        }
      }
      reservePendingTaskId(taskId)
    }

    // From here on the task-id reservation is held; a single finally releases it
    // (and the spawn slot, once reserved) on every exit — cap-reject, failure,
    // or success.
    let entry
    let reservedSpawn = false
    try {
      // The per-run nested quota, checked before the cap because the cap does
      // not gate a nested spawn at all (spawnCapDecision) — this is what bounds
      // a delegating run instead. Check and charge sit in the same synchronous
      // block, with no await between them, so two spawn calls in one turn
      // cannot both pass on the same figure. Charged on admission: a spawn that
      // then fails to start has still been made, and the failure mode the quota
      // exists against is a model that keeps trying.
      if (nested) {
        const quota = nestedQuotaDecision(toolCtx.sessionID, getSettings().maxNestedSpawns)
        if (quota.refused) {
          log("spawn refused: nested quota", {
            sessionID: toolCtx.sessionID,
            used: quota.used,
            limit: quota.limit,
          })
          return {
            output: quota.disabled
              ? `Spawn refused: nested spawns are switched off for this installation ` +
                `(maxNestedSpawns = 0). Do what you can yourself and name in your final reply ` +
                `what you still need; the orchestrator decides and spawns it. Open that reply ` +
                `with "Blocked:" where the missing material stops the task.`
              : `Spawn refused: you have already started ${quota.used} of the ${quota.limit} ` +
                `${NESTED_SPAWN_TARGET} spawns one subagent run gets, and the quota does not ` +
                `reset. Do the rest of the work yourself and name in your final reply what is ` +
                `still missing; the orchestrator decides and spawns it. Open that reply with ` +
                `"Blocked:" where the missing material stops the task.`,
          }
        }
        chargeNestedSpawn(toolCtx.sessionID)
      }
      const maxSubagents = getSettings().maxSubagents
      // Atomic cap-check-and-reserve: any await between count and reserve would
      // let parallel spawn() calls in the same turn all observe "active < cap"
      // and bypass the limit. spawnCapDecision counts synchronously and
      // includes pendingSpawns, so the synchronous reserve() that follows makes
      // the slot visible to any later spawn() in the same micro-batch.
      //
      // The cap is GLOBAL across all orchestrator primaries in this process,
      // and it gates a spawn made by a PRIMARY only: a nested spawn is admitted
      // unconditionally and still counted, because the caller already holds the
      // slot it would be told to wait for (see spawnCapDecision in registry.js).
      const cap = spawnCapDecision(toolCtx.sessionID, maxSubagents)
      if (cap.refused) {
        log("spawn refused: subagent limit", { active: cap.active, limit: maxSubagents })
        return {
          output:
            `Subagent limit reached (${cap.active}/${maxSubagents} running globally across all ` +
            `orchestrator sessions). Wait for one to finish — you are woken automatically — or ` +
            `abort one with abort(handle) before spawning again.`,
        }
      }
      reservePendingSpawn(toolCtx.sessionID)
      reservedSpawn = true

      const sessionID = await createChildSession(client, {
        parentID: toolCtx.sessionID,
        title: args.description || `${args.agent}: ${args.prompt.slice(0, 60)}`,
        directory,
      })
      if (!sessionID) return { output: "Failed to create subagent session." }

      // The waiter goes up here — after the child's id exists, BEFORE the child
      // is prompted — and at no later point. A child cannot end before it has
      // been prompted, so this window is closed; register after promptSession
      // and the child's own idle path may already have run, found no waiter,
      // posted its result to the caller as a wake notice and torn the session
      // down, after which this handler would block on something that is gone.
      //
      // From this moment the caller counts as having a live child: its idle is
      // held, its silence does not count against the watchdog, and its session
      // is not deleted out from under the child. Every path that ends the child
      // settles the waiter, and the waiter carries its own rescue ceiling.
      let childResult
      if (nested) childResult = registerChildWaiter(sessionID, toolCtx.sessionID)

      // The child session now exists at the opencode level. If anything below
      // throws (typically promptSession), guard() would catch it and report an
      // error — but the orphaned session (plus any provisional registry entry
      // the session.created event auto-registered in the meantime) would leak
      // for the process lifetime. Best-effort teardown here, then re-throw so
      // guard() still surfaces the ORIGINAL failure. Cleanup errors are logged,
      // never allowed to mask the original error. The outer finally still
      // releases the pendingSpawn / pendingTaskId reservations on this path.
      try {
        // `fullPrompt` carries the light project snapshot prepended above, so
        // the subagent does not start blind.
        await promptSession(client, { sessionID, agent: args.agent, prompt: fullPrompt })
      } catch (err) {
        // Drop the waiter with the same failure, first and unconditionally. It
        // is not a blocked caller that is being freed here — this handler IS
        // the caller and it is about to throw — but a waiter left in the map
        // would make the caller look like a session with a live child for the
        // rest of its run: its idle held, its silence excused, its teardown
        // waiting on a child that was never prompted.
        settleChildWaiter(sessionID, {
          status: "error",
          agent: args.agent,
          detail: `the child session was never prompted: ${errMsg(err)}`,
        })
        try {
          await removeEntry(sessionID)
          await deleteSession(client, sessionID)
          forgetSessionDirectory(sessionID)
        } catch (cleanupErr) {
          log("spawn cleanup after prompt failure failed", errMsg(cleanupErr))
        }
        throw err
      }

      entry = upsertSession(sessionID, {
        agent: args.agent,
        prompt: args.prompt,
        parentID: toolCtx.sessionID,
        taskId,
        directory,
        // The gate's own figure, kept for the completion notice: it reports
        // what this package cost beside what the whole run cost.
        packageTokens: size.estimate,
      })
      // Tag this tool-call with the same metadata shape that opencode's built-in
      // `task` tool emits. The TUI keys off `parentSessionId` + `sessionId` to
      // render the spawned session as a navigable child (Ctrl+X arrow nav,
      // back-to-parent, child-session view) — without it, the spawn appears as
      // a plain text tool result and the UI cannot link it to the new session.
      if (typeof toolCtx.metadata === "function") {
        try {
          toolCtx.metadata({
            title: args.description || `${args.agent}: ${args.prompt.slice(0, 60)}`,
            metadata: {
              parentSessionId: toolCtx.sessionID,
              sessionId: sessionID,
            },
          })
        } catch (err) {
          log("toolCtx.metadata failed", errMsg(err))
        }
      }
      log("spawned", { handle: entry.handle, sessionID, agent: args.agent, taskId, directory })
      showToast(client, { title: "agent-intercom", message: `spawned ${entry.handle}` })

      // The nested spawn blocks here: this tool call does not return until the
      // child has ended, and the child's ending is what it returns. That is the
      // whole mechanism — the caller never goes idle with a live child, so the
      // one-shot lifecycle invariant stays literally true for it and every
      // ending path keeps working on the machinery it already had.
      if (nested) {
        // Hand the reservation back BEFORE blocking. From here the slot is
        // owned by the child's registry entry; holding this handler's
        // reservation for the child's whole run would count the child twice —
        // in the global cap figure the orchestrator is shown, and in the
        // quiesce predicate an endless cycle waits on, which would then never
        // reach zero. The `finally` below sees reservedSpawn=false and does not
        // release a second time.
        if (reservedSpawn) {
          releasePendingSpawn(toolCtx.sessionID)
          reservedSpawn = false
        }
        log("nested spawn: caller blocks until its child ends", {
          caller: toolCtx.sessionID,
          callerAgent: callerEntry.agent,
          handle: entry.handle,
          sessionID,
        })
        const outcome = await childResult
        // Book the ended run against this caller's entry, at the moment the
        // waiter resolves and before anything is rendered. What the child
        // burned inside its own session is invisible in the caller's ctxTokens
        // — those hold only the text below — so without this the caller's own
        // completion notice would report the delegation as free.
        const nestedTotals = chargeNestedRun(toolCtx.sessionID, outcome.ctxTokens)
        log("nested spawn: child ended", {
          handle: entry.handle,
          sessionID,
          status: outcome.status,
          waitedMs: outcome.waitedMs,
          nestedRuns: nestedTotals.runs,
          nestedTokens: nestedTotals.tokens,
        })
        return {
          output: nestedSpawnOutput(outcome, entry.handle, args.agent),
          metadata: {
            handle: entry.handle,
            sessionID,
            agent: args.agent,
            nested: true,
            status: outcome.status,
          },
        }
      }
      return {
        output:
          `Spawned subagent "${entry.handle}" (session ${sessionID}). It runs in the background — ` +
          `you are woken automatically with its result when it finishes. ` +
          `abort("${entry.handle}") to stop it (only if the user asks). It will reply once, then be destroyed.` +
          slotsNoticeAfterSpawn(toolCtx.sessionID) +
          size.notice,
        metadata: { handle: entry.handle, sessionID, agent: args.agent },
      }
    } finally {
      // The slot is now owned by the registry entry (if we got that far) or by
      // nothing (on failure). Either way the reservations are done. Release the
      // spawn slot only if we actually reserved it (a cap-reject returns before
      // reservePendingSpawn — releasing then would decrement a CONCURRENT
      // spawn's reservation, since the counter is global). The task-id release
      // is idempotent and a no-op for prefix-free spawns.
      if (reservedSpawn) releasePendingSpawn(toolCtx.sessionID)
      releasePendingTaskId(taskId)
    }
  }

  // Tail-line for spawn output: tells the orchestrator how many global slots
  // remain so it knows whether the next spawn() will succeed. Empty when the
  // cap is disabled (maxSubagents=0 means "no cap").
  function slotsNoticeAfterSpawn(primaryID) {
    const maxSubagents = getSettings().maxSubagents
    if (maxSubagents <= 0) return ""
    // countActiveSubagents reads from the registry (the freshly upserted entry
    // is already there) plus pendingSpawns (this handler's own reservation is
    // still held until the finally block). Subtract it so the number we report
    // matches what the orchestrator sees after this call returns. The cap is
    // global, so the count is the same regardless of which primary asked.
    const active = countActiveSubagents(primaryID) - 1
    const free = Math.max(0, maxSubagents - active)
    if (free === 0) {
      return (
        ` Subagent slots: ${active}/${maxSubagents} (global, across all sessions) — CAP REACHED, ` +
        `no further spawn() will succeed until a subagent finishes (you will be woken).`
      )
    }
    return ` Subagent slots: ${active}/${maxSubagents} (global, across all sessions) — ${free} free.`
  }

  // Builds the refusal for a reuse the gate turned down. Each term names the
  // figure it was decided on and the number it was decided against, so the
  // orchestrator learns the rule rather than retrying blind, and every one of
  // them names `spawn` as the way forward so it can never be stuck.
  function reuseGateRefusal(entry, admission, ctxTokens, pkgTokens, mode) {
    const who = `"${entry.handle}" (${entry.agent})`
    const spawnInstead =
      `spawn a fresh subagent instead and carry what it needs to know in the prompt.`
    switch (admission.term) {
      case "G1":
        return (
          `Reuse refused (G1: no context figure): the session of ${who} answered, but reports no ` +
          `context size, and the reuse ceiling is never evaluated on a guessed number. ` +
          `${who} stays held — try again, or ${spawnInstead}`
        )
      case "G2":
        return (
          `Reuse refused (G2: reuse ceiling): ${who} holds ${fmtTokens(ctxTokens)} tokens of ` +
          `context, over the ${fmtTokens(admission.limit)} reuse ceiling for a ${entry.agent}. ` +
          `A session this large is not handed more work however small the follow-up — ` +
          `${spawnInstead}`
        )
      case "G3":
        return (
          `Reuse refused (G3: context budget): ${who} holds ${fmtTokens(ctxTokens)} tokens and ` +
          `your follow-up adds ~${fmtTokens(pkgTokens)}, which does not fit under the ` +
          `${fmtTokens(admission.limit)} ${entry.agent} budget. Re-prompted there it would be ` +
          `STOP-injected on its first turn and every tool call it made would be denied. ` +
          `Cut the follow-up down, or ${spawnInstead}`
        )
      case "G4":
        return (
          `Reuse refused (G4: room for a further task): ${who} holds ${fmtTokens(ctxTokens)} ` +
          `tokens, over the ${fmtTokens(admission.limit)} — ${percent(RETAIN_TASK_SHARE)} of the ` +
          `${entry.agent} budget — a further task must still be under, because a task needs room ` +
          `for what it produces. Ask a QUESTION about the work it already did ` +
          `(mode "${REUSE_QUESTION}"), or ${spawnInstead}`
        )
      default:
        return `Reuse refused. ${spawnInstead}`
    }
  }

  // Put a follow-up to a retained subagent. The orchestrator decides this and
  // the plugin never does it on its own: a spawn prompt is written for a fresh
  // context ("read X, then do Y") and prepending it to a session that has
  // already read X yields a run whose briefing contradicts its own history.
  //
  // The shape is a spawn's, deliberately: the session goes back to running, it
  // takes a concurrency slot through the same cap decision and reservation, it
  // is woken to the same parent by the same idle path, and it faces the same
  // retention decision when it finishes. What differs is that no session is
  // created, the handle is the one the orchestrator already knows, and the
  // gate below decides whether the session may be prompted at all.
  async function reuseHandler(args, toolCtx) {
    const settings = getSettings()
    if (!(settings.maxRetainedSubagents > 0)) {
      return {
        output:
          `Reuse refused: holding a finished subagent alive is switched off for this ` +
          `installation (maxRetainedSubagents = 0), so no subagent is ever kept for a follow-up ` +
          `and no handle can be reused. Spawn a fresh subagent instead and carry the question in ` +
          `its prompt.`,
      }
    }
    // A subagent has no retained subagents of its own — retention is refused
    // for nested spawns outright — and the follow-up question this tool exists
    // for is the orchestrator's.
    if (entryForSession(toolCtx.sessionID)) {
      return {
        output:
          `Reuse refused: reuse is the orchestrator's tool and you are a subagent. Do what you ` +
          `can yourself and name in your final reply what you still need; the orchestrator ` +
          `decides. Open that reply with "Blocked:" where the missing material stops the task.`,
      }
    }
    // The endless-mode freeze, on the same grounds as the spawn freeze and in
    // the same shape (a throw, so the refusal is a failed tool call): the cycle
    // drops every retained subagent as it replaces this primary, so a run
    // started now would be torn down mid-flight.
    if (isEndlessFrozen(rootPrimaryFor(toolCtx.sessionID))) {
      log("reuse refused: endless cycle in progress", { sessionID: toolCtx.sessionID })
      throw new Error(
        "Endless mode is saving this session's open points and replacing it with a fresh " +
          "orchestrator. Every retained subagent is being dropped with it, so no follow-up will " +
          "run. End your turn now — what you would ask belongs in your open points.",
      )
    }
    trackPrimary(toolCtx.sessionID)
    const entry = resolve(args.subagent)
    // Same ownership rule and same uniform wording as abort: a handle
    // belonging to another primary is reported exactly as a nonexistent one,
    // so foreign ownership does not leak.
    if (!entry || entry.parentID !== toolCtx.sessionID) return unknown(args.subagent)
    const lifecycle = entryLifecycle(entry)
    if (lifecycle !== LIFECYCLE_RETAINED) {
      // A closing entry is on its way out and its handle addresses nothing a
      // moment later, so it reads as unknown. A running one is a live subagent
      // and the orchestrator is about to be woken by it anyway.
      if (lifecycle !== LIFECYCLE_RUNNING) return unknown(args.subagent)
      return {
        output:
          `Reuse refused: "${entry.handle}" (${entry.agent}) is still running — a reuse is a ` +
          `follow-up to a FINISHED subagent. You are woken automatically with its result; put ` +
          `your question to it then.`,
      }
    }
    const prompt = String(args.prompt ?? "")
    if (!prompt.trim()) {
      return { output: `reuse failed: prompt is required — say what you want to ask or hand over.` }
    }
    const mode = args.mode === REUSE_TASK ? REUSE_TASK : REUSE_QUESTION

    // The follow-up is measured on its own, with no project snapshot prepended:
    // the session already carries one from its spawn, and sending it a second
    // time would spend the very context the gate below is protecting. The size
    // verdict supplies the wording and the notice; G3 is what actually decides,
    // because at a high context it is the far stricter of the two.
    const size = packageSizeVerdict(entry.agent, prompt)
    if (size.refusal) {
      log("reuse refused: follow-up too large", {
        handle: entry.handle,
        estimate: size.estimate,
        budget: size.budget,
      })
      return {
        output:
          `Reuse refused: the follow-up is ~${fmtTokens(size.estimate)} tokens (estimated) — over ` +
          `the ${percent(PACKAGE_REFUSE_SHARE)} bar of ` +
          `${fmtTokens(size.budget * PACKAGE_REFUSE_SHARE)} for a ${entry.agent}, whose context ` +
          `budget is ${fmtTokens(size.budget)}. Nothing was sent to "${entry.handle}". Cut the ` +
          `follow-up down and pass bulk material as a file path for it to read, or spawn a fresh ` +
          `subagent for work this size.`,
      }
    }

    // The gate runs on a FRESHLY fetched figure, never on the entry's stored
    // one: a retained session is a real opencode session the user can open in
    // the TUI and type into, and the stored value is only what was true when
    // the run ended. Three outcomes, each meaning something different.
    const snapshot = await fetchSnapshot(client, entry.sessionID)
    const outcome = snapshotOutcome(snapshot)
    if (outcome === "gone") {
      // The fetch succeeded and the session has no messages: it was deleted
      // underneath the plugin. Drop the entry so the handle stops being offered
      // in `list` and in the snapshot block.
      log("reuse refused: session gone", { handle: entry.handle, sessionID: entry.sessionID })
      await removeEntry(entry.sessionID)
      forgetSessionDirectory(entry.sessionID)
      return {
        output:
          `Reuse refused: the session behind "${entry.handle}" no longer exists — it was deleted ` +
          `outside this plugin. The handle is gone with it and will not appear in list() again. ` +
          `Spawn a fresh subagent and carry what it needs to know in the prompt.`,
      }
    }
    if (outcome === "unavailable") {
      // The fetch itself failed. Nothing was established about the session, so
      // it stays retained and the stale figure is NOT substituted: a ceiling
      // evaluated on a guess is not a ceiling.
      log("reuse refused: snapshot unavailable", {
        handle: entry.handle,
        sessionID: entry.sessionID,
      })
      return {
        output:
          `Reuse refused: could not read the current context size of "${entry.handle}" ` +
          `(the session did not answer). The reuse ceiling is never evaluated on a stale figure, ` +
          `so nothing was sent. "${entry.handle}" is still held — call reuse again, or spawn a ` +
          `fresh subagent.`,
      }
    }

    const admission = reuseAdmission(snapshot.ctxTokens, {
      pkgTokens: size.estimate,
      mode,
      ceiling: reuseCeilingFor(entry.agent),
      budget: contextBudgetFor(entry.agent),
    })
    if (!admission.admit) {
      log("reuse refused: gate", {
        handle: entry.handle,
        term: admission.term,
        reason: admission.reason,
        ctxTokens: snapshot.ctxTokens,
        pkgTokens: size.estimate,
        limit: admission.limit,
        mode,
      })
      return {
        output: reuseGateRefusal(entry, admission, snapshot.ctxTokens, size.estimate, mode),
      }
    }

    const sessionID = entry.sessionID
    const handle = entry.handle
    const agent = entry.agent
    let reservedSpawn = false
    try {
      // The slot is taken exactly as a spawn's is, through the same decision
      // and the same reservation — a reused run is an LLM run in flight, and
      // the cap means how many of those there are. Counted and reserved in one
      // synchronous block, with no await between, so two calls in the same turn
      // cannot both pass on the same figure.
      const maxSubagents = settings.maxSubagents
      const cap = spawnCapDecision(toolCtx.sessionID, maxSubagents)
      if (cap.refused) {
        log("reuse refused: subagent limit", { active: cap.active, limit: maxSubagents })
        return {
          output:
            `Reuse refused: subagent limit reached (${cap.active}/${maxSubagents} running ` +
            `globally across all orchestrator sessions) — a reused run takes a slot exactly as a ` +
            `spawn does. Wait for one to finish (you are woken automatically) and call reuse ` +
            `again; "${handle}" stays held until its window runs out.`,
        }
      }
      reservePendingSpawn(toolCtx.sessionID)
      reservedSpawn = true

      // Back to running under the registry mutex, so a watchdog reap or a
      // capacity eviction cannot take this entry between the gate and the
      // prompt. A revive that finds the entry gone is exactly that race.
      const revived = await registryMutex.runExclusive(() =>
        reviveRetainedEntryLocked(sessionID, {
          ctxTokens: snapshot.ctxTokens,
          packageTokens: size.estimate,
        }),
      )
      if (!revived) {
        log("reuse refused: entry no longer retained", { handle, sessionID })
        return {
          output:
            `Reuse refused: "${handle}" was dropped while this call was being decided — its ` +
            `retention window ran out or it was evicted. Spawn a fresh subagent instead.`,
        }
      }
      try {
        await promptSession(client, { sessionID, agent, prompt })
      } catch (err) {
        // The follow-up never reached the session, so no run started. Put the
        // entry back to retained on its ORIGINAL window rather than leaving a
        // running entry the inactivity watchdog would report as a hang.
        await registryMutex.runExclusive(() =>
          restoreRetainedEntryLocked(sessionID, revived.previous),
        )
        throw err
      }
      const run = revived.entry.runs
      log("reused", { handle, sessionID, agent, run, mode, ctxTokens: snapshot.ctxTokens })
      showToast(client, { title: "agent-intercom", message: `reused ${handle} (run ${run})` })
      return {
        output:
          `Follow-up sent to "${handle}" (${agent}, session ${sessionID}) — run ${run} of that ` +
          `session, which already holds ${fmtTokens(snapshot.ctxTokens)} tokens of the work you ` +
          `are asking about. It runs in the background; you are woken automatically with its ` +
          `reply when it finishes, exactly as a spawn is. ` +
          `abort("${handle}") stops it (only if the user asks).` +
          slotsNoticeAfterSpawn(toolCtx.sessionID) +
          size.notice,
        metadata: { handle, sessionID, agent, reuse: true, run },
      }
    } finally {
      if (reservedSpawn) releasePendingSpawn(toolCtx.sessionID)
    }
  }

  async function abortHandler(args, toolCtx) {
    trackPrimary(toolCtx.sessionID)
    const entry = resolve(args.subagent)
    // Ownership check: handles are per-role numbered (coder#1, …) and the
    // registry is shared across every primary in the process, so resolve()
    // can hand back a subagent belonging to a *different* orchestrator. Only
    // the parent that spawned it may abort it. Report a foreign subagent with
    // the same "unknown" message as a nonexistent one (the module treats
    // unknown handles uniformly — do not leak that some other session owns
    // it) and return rather than throw, so the model keeps working.
    if (!entry || entry.parentID !== toolCtx.sessionID) return unknown(args.subagent)

    // Register before the cooperative abort yields. If opencode emits the
    // session.idle event quickly, it must still open the delete gate below.
    const quiescence = waitForSessionQuiescence(entry.sessionID)
    aborted.add(entry.sessionID)
    entry.status = "aborted"
    // This handler ends a subagent WITHOUT going through teardownSubagent, so
    // it settles the child-waiter itself; otherwise a session blocked on this
    // subagent would stay blocked until the waiter's own ceiling fired. No-op
    // for a subagent nobody is waiting on, which is every subagent today.
    settleChildWaiter(entry.sessionID, {
      status: "aborted",
      handle: entry.handle,
      agent: entry.agent,
      detail: "aborted by its parent",
    })

    const confirmed = await signalAbort(client, entry.sessionID)
    log("aborted", { handle: entry.handle, confirmed })

    // Mirror the onSessionIdle cleanup path: the event hook skips aborted
    // sessions (`if (!entry || aborted.has(sessionID)) return`), so without
    // this branch the registry/bySession entry and the opencode session would
    // leak for the lifetime of the opencode process. Keep the abort marker in
    // place across removeEntry + the quiescence wait + deleteSession
    // (clearAborted: false) so a tool call still in flight is hard-denied as
    // aborted throughout teardown, not misclassified as a primary once the
    // registry entry is gone. The finally drops the marker so the Set never
    // grows unbounded. All operations are best-effort.
    try {
      if (await removeEntry(entry.sessionID, { clearAborted: false })) {
        log("removed aborted subagent", { handle: entry.handle, sessionID: entry.sessionID })
      }
      // Child-first, the same ordering teardownSubagent keeps: this handler
      // ends a subagent WITHOUT going through that helper, so the precondition
      // on deleteSession — no live children, or the DELETE cascades over a
      // session still streaming — has to be met here too. A no-op for a leaf
      // subagent, which is every subagent today.
      //
      // Placed AFTER the settle above and after removeEntry, and BEFORE the
      // delete: the session blocked on the subagent being aborted is freed
      // first and does not wait out the children's teardown, while the aborted
      // subagent's own children are gone before its rows are.
      try {
        await endLiveChildrenOf(client, entry.sessionID, { label: "abort" })
      } catch (err) {
        log("abort: ending live children failed", {
          handle: entry.handle,
          sessionID: entry.sessionID,
          err: errMsg(err),
        })
      }
      const quiescenceReason = await quiescence
      if (quiescenceReason === "timeout") {
        log("abort: session quiescence timed out; deleting", {
          handle: entry.handle,
          sessionID: entry.sessionID,
        })
      }
      const ok = await deleteSession(client, entry.sessionID)
      if (ok) log("deleted opencode session (aborted)", { handle: entry.handle, sessionID: entry.sessionID })
      forgetSessionDirectory(entry.sessionID)
    } finally {
      aborted.delete(entry.sessionID)
    }

    return {
      output:
        `Abort signalled for "${entry.handle}"${confirmed ? "" : " (abort call did not confirm)"}. ` +
        "Further tool calls from it will be denied. You can dispatch a fresh subagent now.",
    }
  }

  function listHandler(_args, toolCtx) {
    trackPrimary(toolCtx.sessionID)
    // CRITICAL: filter by the caller's sessionID — without this, one primary's
    // `list()` returns subagents from every other primary in the process. The
    // system-prompt snapshot does this correctly; without the same filter here,
    // a second primary started in the same opencode serve process would "see"
    // (and try to abort) the previous primary's children.
    const mine = [...registry.values()].filter((e) => e.parentID === toolCtx.sessionID)
    const active = mine.filter((e) => isActiveEntry(e))
    const head = active.length === 0 ? "No active subagents." : active.map(formatListRow).join("\n")
    // The retained section. Since the count split a retained entry is not
    // active anywhere — no slot, no quiesce, no task id, no snapshot row — and
    // `list` would therefore not show it either, which would leave the
    // orchestrator unable to ask a follow-up of something it cannot see. It is
    // shown as its own clearly separated block rather than as another row, so
    // "running" and "finished but still there" cannot be read as the same
    // state. Empty — and byte-identical to what `list` has always returned —
    // wherever retention is switched off, because nothing is ever retained.
    const settings = getSettings()
    if (!(settings.maxRetainedSubagents > 0)) return { output: head }
    const retained = mine.filter((e) => entryLifecycle(e) === LIFECYCLE_RETAINED)
    if (retained.length === 0) return { output: head }
    const rows = retained
      .map((e) => formatRetainedRow(e, settings.retainedSubagentTtlMs))
      .join("\n")
    return {
      output:
        `${head}\n\nRETAINED — finished, NOT running, holding no slot. Their sessions are still ` +
        `alive and still hold the work they did, so you can put a follow-up question to one with ` +
        `reuse("<handle>", "<question>") until its window runs out. After that it is gone and ` +
        `only spawn is left.\n${rows}`,
    }
  }

  async function listOpenHandler(_args, toolCtx) {
    const directory = await dirFor(toolCtx)
    let tasks
    try {
      tasks = listOpen(directory)
    } catch (err) {
      if (err instanceof TodoFileMissingError) {
        if (err.kind === "multiple") {
          return {
            output:
              `Several todo files exist in ${err.directory}: ${err.names.join(", ")}. ` +
              `Exactly one is allowed — with more than one it is undefined which file tasks are ` +
              `read from and written to. Report this verbatim to the user and ask which single ` +
              `file to keep; the tasks from the others are merged into it and those files deleted. ` +
              `Do NOT spawn a subagent to "check" or "investigate" — there is nothing to investigate. ` +
              `Do NOT look in AGENTS.md or any other file for tasks; tasks live ONLY in the todo file.`,
          }
        }
        if (err.kind === "not-a-file") {
          return {
            output:
              `"${err.names[0]}" in ${err.directory} carries a todo-file name but is not a regular ` +
              `file (symlink, directory or device). Nothing was read and nothing will be written to ` +
              `it. Report this verbatim to the user and ask them to replace it with a regular ` +
              `TODO.md. Do NOT spawn a subagent to "check" or "investigate" — there is nothing to ` +
              `investigate.`,
          }
        }
        return {
          output:
            `No todo file at ${todoFilePath(directory)} (todo.md / todos.md in any casing count ` +
            `too). Tasks/TODOs live ONLY in the todo file — never AGENTS.md or any other file. Tell ` +
            `the user that no todo file exists yet and ask whether to create one (spawn planner ` +
            `once the user agrees). Do NOT spawn a subagent to "investigate" or to search other ` +
            `files for tasks — there is nothing to find.`,
        }
      }
      throw err
    }
    if (tasks.length === 0) return { output: "TODO.md has no open tasks." }
    const rows = tasks.map((t) => {
      const accept = t.accept ? `\n    accept: ${t.accept}` : ""
      return `${t.id}: ${t.text}${accept}`
    })
    return { output: rows.join("\n") }
  }

  async function todoDoneHandler(args, toolCtx) {
    const id = String(args.id || "").trim()
    if (!/^T\d+$/.test(id)) {
      return { output: `todo_done failed: id must look like T5, got "${args.id}".` }
    }
    removeTask(await dirFor(toolCtx), id)
    return { output: `${id} removed from TODO.md.` }
  }

  async function todoAddHandler(args, toolCtx) {
    const title = String(args.title || "").trim()
    if (!title) return { output: "todo_add failed: title is required." }
    const accept = args.accept != null ? String(args.accept) : ""
    const res = addTask(await dirFor(toolCtx), { title, accept })
    return { output: `Added ${res.id}: ${title}` }
  }

  async function todoEditHandler(args, toolCtx) {
    const id = String(args.id || "").trim()
    if (!/^T\d+$/.test(id)) {
      return { output: `todo_edit failed: id must look like T5, got "${args.id}".` }
    }
    if (args.title === undefined && args.accept === undefined) {
      return { output: "todo_edit failed: pass at least one of title / accept." }
    }
    const res = editTask(await dirFor(toolCtx), id, {
      title: args.title,
      accept: args.accept,
    })
    if (!res.changed) return { output: `${id} unchanged (provided values match current).` }
    return { output: `${id} updated.` }
  }

  // Retention off is the default, and with it nothing is ever held: no entry
  // reaches "retained", `list` has no retained section to show, and `reuse`
  // has nothing it could ever address. Read once here so the tool surface is
  // decided in one place.
  const retentionOn = getSettings().maxRetainedSubagents > 0

  return {
    spawn: tool({
      description:
        'Start a subagent non-blocking. Returns a handle ("researcher#1") for `abort`. You stay ' +
        "responsive; you are woken automatically with the subagent's reply when it finishes. " +
        "One-shot: a subagent replies once and is destroyed. For more work, spawn a fresh one. " +
        "A reply starting with `Blocked:` is a decision handed up to you, not a failure to retry: " +
        "decide about the problem and whether the task continues, then spawn a fresh subagent " +
        "carrying that decision instead of re-sending the same prompt. " +
        "Optional first-line prefix `T<n>:` (taken from TODO.md) opts in to wake-hook auto-tick — " +
        "omit for ad-hoc questions and status checks.",
      args: {
        agent: z
          .string()
          .describe(`Subagent role — one of: ${SPAWNABLE_ROLES.join(", ")}`),
        prompt: z.string().describe("Task for the subagent — name the outcome, not the steps"),
        description: z.string().optional().describe("Short title for the subagent session"),
      },
      execute: guard("spawn", spawnHandler),
    }),

    abort: tool({
      description:
        "Stop a running subagent. Use ONLY when the user tells you to. Never on your own.",
      args: {
        subagent: z.string().describe('Handle ("researcher#1") or raw sessionID'),
      },
      execute: guard("abort", abortHandler),
    }),

    list: tool({
      description:
        "List your currently running subagents (handle, agent, status, age). Finished ones are gone " +
        "(one-shot); their result already arrived in the wake notice." +
        (retentionOn
          ? " Subagents that are being held for a follow-up are listed separately as RETAINED, " +
            "with the context they hold and the time left on them — those can be asked a " +
            "follow-up with reuse()."
          : ""),
      args: {},
      execute: guard("list", listHandler),
    }),

    // Only where retention is switched on. At `maxRetainedSubagents = 0` —
    // the default — nothing is ever retained, so the tool would have nothing
    // to address in any call it could ever receive; it is left out entirely
    // rather than offered as a tool that always refuses, the same way the
    // optional search tools are. Read once, at plugin load.
    ...(retentionOn
      ? {
          reuse: tool({
            description:
              'Put a follow-up to a subagent that has already finished and is being held (it is ' +
              'listed as RETAINED by list()). Its session still holds the work it did, so a ' +
              'question like "which of the two did you mean?" can be answered without re-briefing ' +
              'anything — that is what this tool is for. The run behaves exactly like a spawn: it ' +
              'runs in the background and you are woken with its reply. Refused when the ' +
              "session's context is already too large to be handed more; the refusal says which " +
              'rule refused and spawn is always the way forward.',
            args: {
              subagent: z.string().describe('Handle of a RETAINED subagent ("researcher#1")'),
              prompt: z
                .string()
                .describe("Your follow-up — a question about the work it already did"),
              mode: z
                .enum([REUSE_QUESTION, REUSE_TASK])
                .optional()
                .describe(
                  `"${REUSE_QUESTION}" (default) for a follow-up question; "${REUSE_TASK}" for a ` +
                    `further related piece of work, which is admitted only at a much lower context`,
                ),
            },
            execute: guard("reuse", reuseHandler),
          }),
        }
      : {}),

    todos_open: tool({
      description:
        "Return the open tasks from TODO.md (id, title, accept-criterion) in feasibility order. " +
        "Call this whenever you need to know what tasks exist — never spawn a subagent for that.",
      args: {},
      execute: guard("todos_open", listOpenHandler),
    }),

    todo_done: tool({
      description:
        "Remove a task from TODO.md. The wake-hook also calls this automatically when a subagent's " +
        "reply has `DONE: T<n>` on its FIRST or LAST non-empty line, matching its spawn id. Call yourself when (a) you just " +
        "finished a task that was in TODO.md, (b) the wake notice said `marker IGNORED` / " +
        "`auto-tick failed`, or (c) the user asks for it.",
      args: {
        id: z.string().describe("Task id from TODO.md, e.g. T5 — must already exist in the file"),
      },
      execute: guard("todo_done", todoDoneHandler),
    }),

    todo_add: tool({
      description:
        "Append a new task to TODO.md and return its id. Use this whenever new work surfaces — " +
        "from the user, from your own findings, or from TODOs/tasks you discover in other files " +
        "(those should be moved here and removed from the source file). Place new tasks in " +
        "feasibility order; TODO.md is read top-to-bottom.",
      args: {
        title: z.string().describe("Short one-line task title"),
        accept: z.string().optional().describe("One-line acceptance criterion"),
      },
      execute: guard("todo_add", todoAddHandler),
    }),

    todo_edit: tool({
      description:
        "Edit an existing task's title or accept-criterion in place. The id stays the same. Pass " +
        '`accept: ""` to drop the accept line.',
      args: {
        id: z.string().describe("Task id from TODO.md, e.g. T5 — must already exist in the file"),
        title: z.string().optional().describe("New one-line title (omit to keep)"),
        accept: z.string().optional().describe('New one-line accept-criterion ("" to drop the line)'),
      },
      execute: guard("todo_edit", todoEditHandler),
    }),

    ...(isWebsearchEnabled() ? { web_search: createWebsearchTool() } : {}),
    ...(isForumSearchEnabled() ? { forum_search: createForumSearchTool() } : {}),
    ...(isOutlineEnabled() ? { outline: createOutlineTool({ dirFor }) } : {}),
  }
}
