// The three tools the primary agent gets: spawn, abort, list.

import { tool } from "@opencode-ai/plugin"
import { registry, aborted } from "./state.js"
import {
  createChildSession,
  promptSession,
  abortSession,
  showToast,
  getSessionDirectory,
  deleteSession,
  forgetSessionDirectory,
} from "./client.js"
import {
  resolve,
  upsertSession,
  removeEntry,
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
  removeTask,
  addTask,
  editTask,
  todoFilePath,
  TodoFileMissingError,
} from "./todofile.js"
import { log, errMsg } from "./log.js"
import { tokens as fmtTokens, ageSeconds } from "./format.js"

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

    // Pull an optional task id (T5 / R2) off the first line of the prompt.
    // Present → wake-hook auto-ticks TODO.md when the subagent's reply ends
    // with the matching `DONE:`/`BLOCKED:` marker. Absent → non-task spawn
    // (status check, ad-hoc question) and auto-tick is skipped. The orchestrator
    // decides per spawn; the plugin never forces a prefix.
    const taskId = extractTaskId(args.prompt)
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
    //
    // The cap is GLOBAL across all orchestrator primaries in this process —
    // see countActiveSubagents in registry.js. We pass toolCtx.sessionID for
    // signature compatibility, but the value is ignored.
    if (maxSubagents > 0) {
      const active = countActiveSubagents(toolCtx.sessionID)
      if (active >= maxSubagents) {
        log("spawn refused: subagent limit", { active, limit: maxSubagents })
        return {
          output:
            `Subagent limit reached (${active}/${maxSubagents} running globally across all ` +
            `orchestrator sessions). Wait for one to finish — you are woken automatically — or ` +
            `abort one with abort(handle) before spawning again.`,
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

  async function abortHandler(args, toolCtx) {
    trackPrimary(toolCtx.sessionID)
    const entry = resolve(args.subagent)
    if (!entry) return unknown(args.subagent)

    aborted.add(entry.sessionID)
    entry.status = "aborted"

    const confirmed = await signalAbort(client, entry.sessionID)
    log("aborted", { handle: entry.handle, confirmed })

    // Mirror the onSessionIdle cleanup path: the event hook skips aborted
    // sessions (`if (!entry || aborted.has(sessionID)) return`), so without
    // this branch the registry/bySession entry and the opencode session would
    // leak for the lifetime of the opencode process. removeEntry itself drops
    // the sessionID from the `aborted` Set; by the time it runs the opencode
    // session is already being aborted, so further tool calls are blocked
    // regardless of the Set. All three operations are best-effort.
    removeEntry(entry.sessionID)
    const ok = await deleteSession(client, entry.sessionID)
    if (ok) log("deleted opencode session (aborted)", { handle: entry.handle, sessionID: entry.sessionID })
    forgetSessionDirectory(entry.sessionID)

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

  return {
    spawn: tool({
      description:
        'Start a subagent non-blocking. Returns a handle ("researcher#1") for `abort`. You stay ' +
        "responsive; you are woken automatically with the subagent's reply when it finishes. " +
        "One-shot: a subagent replies once and is destroyed. For more work, spawn a fresh one. " +
        "Optional first-line prefix `T<n>:` (taken from TODO.md) opts in to wake-hook auto-tick — " +
        "omit for ad-hoc questions and status checks.",
      args: {
        agent: z.string().describe("Subagent name (coder, planner, researcher, …)"),
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
        "(one-shot); their result already arrived in the wake notice.",
      args: {},
      execute: guard("list", listHandler),
    }),

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
        "reply starts with `DONE: T<n>` matching its spawn id. Call yourself when (a) you just " +
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
    ...(isOutlineEnabled() ? { outline: createOutlineTool({ directory: factoryDirectory }) } : {}),
  }
}
