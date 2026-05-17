// The three tools the primary agent gets: spawn, abort, list.

import { tool } from "@opencode-ai/plugin"
import { registry, aborted } from "./state.js"
import {
  createChildSession,
  promptSession,
  abortSession,
  showToast,
  getSessionDirectory,
} from "./client.js"
import {
  resolve,
  upsertSession,
  trackPrimary,
  countActiveSubagents,
  effectiveState,
  reservePendingSpawn,
  releasePendingSpawn,
  activeTaskIdsFor,
} from "./registry.js"
import { projectContext } from "./project.js"
import { getSettings } from "./settings.js"
import { createWebsearchTool, isWebsearchEnabled } from "./websearch.js"
import { createOutlineTool, isOutlineEnabled } from "./outline.js"
import {
  listOpen,
  markDone,
  markBlocked,
  todoFilePath,
  TodoFileMissingError,
} from "./todofile.js"
import { existsSync } from "node:fs"
import { log, errMsg } from "./log.js"
import { tokens as fmtTokens, ageSeconds } from "./format.js"

// Matches the task-id prefix the orchestrator MUST put on the first line of
// a spawn prompt once TODO.md exists. Captures the id (T5 / R2). Tolerant
// about whitespace and trailing colon style.
const SPAWN_TASK_PREFIX_RE = /^\s*(T\d+|R\d+)\s*[:.\-]\s*/m

function extractTaskId(prompt) {
  const m = SPAWN_TASK_PREFIX_RE.exec(prompt ?? "")
  return m ? m[1] : undefined
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
    trackPrimary(toolCtx.sessionID)
    const directory = await dirFor(toolCtx)

    const denied = await permissionGuard.checkTaskPermission(toolCtx.agent, args.agent)
    if (denied) {
      log("spawn denied", denied)
      return { output: `Denied: ${denied}` }
    }

    // Pull a stable task id (T5 / R2) off the first line of the prompt, if
    // present. Once TODO.md exists the orchestrator MUST tag every spawn this
    // way so the wake-hook can auto-tick — but in greenfield phases (no
    // TODO.md yet) the prefix is optional.
    const taskId = extractTaskId(args.prompt)
    const todoExists = existsSync(todoFilePath(directory))
    if (todoExists && !taskId) {
      log("spawn refused: missing task id prefix", { prompt: args.prompt.slice(0, 80) })
      return {
        output:
          "Spawn refused: TODO.md exists, so every spawn prompt MUST start with a task id like " +
          "`T5: <text>` or `R2: <text>` (taken from TODO.md). Without it the wake-hook cannot " +
          "tick the task done. Add the prefix and try again.",
      }
    }
    if (taskId) {
      const active = activeTaskIdsFor(toolCtx.sessionID)
      if (active.has(taskId)) {
        log("spawn refused: duplicate task id", { taskId })
        return {
          output:
            `Spawn refused: task ${taskId} already has a subagent running. Wait for it to finish ` +
            `(you are woken automatically) before re-spawning the same task, or abort the existing ` +
            `one (only if the user says so) and then re-spawn.`,
        }
      }
    }

    const maxSubagents = getSettings().maxSubagents
    // Atomic cap-check-and-reserve: any await between count and reserve would
    // let parallel spawn() calls in the same turn all observe "active < cap"
    // and bypass the limit. countActiveSubagents includes pendingSpawns, so
    // the synchronous reserve() that follows makes the slot visible to any
    // later spawn() in the same micro-batch.
    if (maxSubagents > 0) {
      const active = countActiveSubagents(toolCtx.sessionID)
      if (active >= maxSubagents) {
        log("spawn refused: subagent limit", { active, limit: maxSubagents })
        return {
          output:
            `Subagent limit reached (${active}/${maxSubagents} running). Wait for one to finish ` +
            `— you are woken automatically — or abort one with abort(handle) before spawning again.`,
        }
      }
    }
    reservePendingSpawn(toolCtx.sessionID)

    let entry
    try {
      const sessionID = await createChildSession(client, {
        parentID: toolCtx.sessionID,
        title: args.description || `${args.agent}: ${args.prompt.slice(0, 60)}`,
        directory,
      })
      if (!sessionID) return { output: "Failed to create subagent session." }

      // Prepend a light project snapshot so the subagent does not start blind.
      const ctxBlock = projectContext(directory)
      const fullPrompt = ctxBlock ? `${ctxBlock}\n\n${args.prompt}` : args.prompt
      await promptSession(client, { sessionID, agent: args.agent, prompt: fullPrompt })

      entry = upsertSession(sessionID, {
        agent: args.agent,
        prompt: args.prompt,
        parentID: toolCtx.sessionID,
        taskId,
        directory,
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
      return {
        output:
          `Spawned subagent "${entry.handle}" (session ${sessionID}). It runs in the background — ` +
          `you are woken automatically with its result when it finishes. ` +
          `abort("${entry.handle}") to stop it (only if the user asks). It will reply once, then be destroyed.` +
          slotsNoticeAfterSpawn(toolCtx.sessionID),
        metadata: { handle: entry.handle, sessionID, agent: args.agent },
      }
    } finally {
      // The slot is now owned by the registry entry (if we got that far) or by
      // nothing (on failure). Either way the pending reservation is done.
      releasePendingSpawn(toolCtx.sessionID)
    }
  }

  // Tail-line for spawn output: tells the orchestrator how many slots remain
  // so it knows whether the next spawn() will succeed. Empty when the cap is
  // disabled (maxSubagents=0 means "no cap").
  function slotsNoticeAfterSpawn(primaryID) {
    const maxSubagents = getSettings().maxSubagents
    if (maxSubagents <= 0) return ""
    // countActiveSubagents reads from the registry (the freshly upserted entry
    // is already there) plus pendingSpawns (this handler's own reservation is
    // still held until the finally block). Subtract it so the number we report
    // matches what the orchestrator sees after this call returns.
    const active = countActiveSubagents(primaryID) - 1
    const free = Math.max(0, maxSubagents - active)
    if (free === 0) {
      return (
        ` Subagent slots: ${active}/${maxSubagents} — CAP REACHED, no further spawn() will succeed ` +
        `until a subagent finishes (you will be woken).`
      )
    }
    return ` Subagent slots: ${active}/${maxSubagents} — ${free} free.`
  }

  async function abortHandler(args, toolCtx) {
    trackPrimary(toolCtx.sessionID)
    const entry = resolve(args.subagent)
    if (!entry) return unknown(args.subagent)

    aborted.add(entry.sessionID)
    entry.status = "aborted"

    const confirmed = await signalAbort(client, entry.sessionID)
    log("aborted", { handle: entry.handle, confirmed })
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
    const active = [...registry.values()].filter((e) => {
      if (e.parentID !== toolCtx.sessionID) return false
      return effectiveState(e) !== "aborted"
    })
    if (active.length === 0) return { output: "No active subagents." }
    return { output: active.map(formatListRow).join("\n") }
  }

  async function listOpenHandler(_args, toolCtx) {
    const directory = await dirFor(toolCtx)
    let tasks
    try {
      tasks = listOpen(directory)
    } catch (err) {
      if (err instanceof TodoFileMissingError) {
        if (err.kind === "wrong-case") {
          return {
            output:
              `TODO.md not found at ${todoFilePath(directory)} — but a case-variant ` +
              `"${err.actualName}" exists in the same directory. Convention is uppercase TODO.md. ` +
              `Report this verbatim to the user and ask which of these to do: ` +
              `(a) rename "${err.actualName}" to TODO.md, ` +
              `(b) create a fresh empty TODO.md and leave "${err.actualName}" alone, or ` +
              `(c) migrate existing tasks from "${err.actualName}" into a new TODO.md. ` +
              `Do NOT spawn a subagent to "check" or "investigate" — there is nothing to investigate. ` +
              `Do NOT look in AGENTS.md or any other file for tasks; tasks live ONLY in TODO.md.`,
          }
        }
        return {
          output:
            `TODO.md not found at ${todoFilePath(directory)}. Tasks/TODOs live ONLY in TODO.md — ` +
            `never AGENTS.md or any other file. Tell the user that no TODO.md exists yet and ask ` +
            `whether to create one (spawn planner once the user agrees). Do NOT spawn a subagent ` +
            `to "investigate" or to search other files for tasks — there is nothing to find.`,
        }
      }
      throw err
    }
    if (tasks.length === 0) return { output: "TODO.md has no open tasks." }
    const rows = tasks.map((t) => {
      const tag = t.status === "blocked" ? "BLOCKED" : "OPEN"
      const accept = t.accept ? `\n    accept: ${t.accept}` : ""
      const reason = t.blockedReason ? ` (blocked: ${t.blockedReason})` : ""
      return `${tag} ${t.id}. ${t.text}${reason}${accept}`
    })
    return { output: rows.join("\n") }
  }

  async function markDoneHandler(args, toolCtx) {
    const id = String(args.id || "").trim()
    if (!/^[TR]\d+$/.test(id)) {
      return { output: `mark_done failed: id must look like T5 or R2, got "${args.id}".` }
    }
    const res = markDone(await dirFor(toolCtx), id)
    if (res.alreadyDone) return { output: `${id} was already [x]; no change.` }
    return { output: `${id} marked done.` }
  }

  async function markBlockedHandler(args, toolCtx) {
    const id = String(args.id || "").trim()
    if (!/^[TR]\d+$/.test(id)) {
      return { output: `mark_blocked failed: id must look like T5 or R2, got "${args.id}".` }
    }
    const reason = String(args.reason || "").trim() || "no reason given"
    const res = markBlocked(await dirFor(toolCtx), id, reason)
    if (!res.changed && res.alreadyBlocked) return { output: `${id} was already [!]; reason updated.` }
    return { output: `${id} marked blocked (${reason}).` }
  }

  return {
    spawn: tool({
      description:
        'Start a subagent non-blocking. Returns a handle (e.g. "researcher#1") that identifies ' +
        "the subagent for `abort` and `list`. The primary stays responsive while the subagent runs, " +
        "and is woken automatically with the subagent's result when it finishes. A subagent is " +
        "ONE-SHOT — once it replies it is destroyed. For more work, spawn a fresh subagent.",
      args: {
        agent: z.string().describe("Name of the subagent to spawn (e.g. coder, planner, researcher)"),
        prompt: z.string().describe("The task/instruction for the subagent"),
        description: z.string().optional().describe("Short title for the subagent session"),
      },
      execute: guard("spawn", spawnHandler),
    }),

    abort: tool({
      description:
        "Abort a running subagent. Sends opencode's cooperative abort signal and hard-denies any " +
        "further tool calls from that subagent. ONLY use when the USER explicitly tells you to " +
        "stop one; never on your own.",
      args: {
        subagent: z.string().describe('Handle (e.g. "researcher#1") or raw sessionID'),
      },
      execute: guard("abort", abortHandler),
    }),

    list: tool({
      description:
        "List currently active subagents with their handle, agent, status and age. State labels: " +
        "`busy`/`retry` = working. Finished subagents are not listed — they have been destroyed " +
        "(one-shot lifecycle); their result was already delivered to you via the wake notice.",
      args: {},
      execute: guard("list", listHandler),
    }),

    list_open: tool({
      description:
        "List open + blocked tasks from TODO.md in the project root, with their stable id (T5, R2, …) " +
        "and any `accept:` criterion. Errors if TODO.md doesn't exist (greenfield — run planner first). " +
        "Available to every agent so subagents can see fresh state without re-spawn.",
      args: {},
      execute: guard("list_open", listOpenHandler),
    }),

    mark_done: tool({
      description:
        "Mark a TODO.md task as done — flips `- [ ] T5` to `- [x] T5`. Idempotent. Orchestrator-only " +
        "(the wake-hook auto-calls this when a subagent's reply starts with `DONE: T<n>` matching " +
        "its spawn id; use this tool manually only when the marker was missing or wrong).",
      args: {
        id: z.string().describe("Task id, e.g. T5 or R2"),
      },
      execute: guard("mark_done", markDoneHandler),
    }),

    mark_blocked: tool({
      description:
        "Mark a TODO.md task as blocked — flips its line to `- [!] T5 … (blocked: <reason>)`. " +
        "Idempotent. Orchestrator-only (the wake-hook auto-calls this when a subagent's reply " +
        "starts with `BLOCKED: T<n> — <reason>`; use this manually for corrections).",
      args: {
        id: z.string().describe("Task id, e.g. T5 or R2"),
        reason: z.string().describe("One-line reason why the task is blocked"),
      },
      execute: guard("mark_blocked", markBlockedHandler),
    }),

    ...(isWebsearchEnabled() ? { web_search: createWebsearchTool() } : {}),
    ...(isOutlineEnabled() ? { outline: createOutlineTool({ directory: factoryDirectory }) } : {}),
  }
}
