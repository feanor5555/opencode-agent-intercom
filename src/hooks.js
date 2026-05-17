// opencode lifecycle hooks: system-prompt injection, session events, and the
// tool-call guard (aborted-subagent hard-deny + native-`task` enforcement).

import { aborted, registry, lastPrimaryTool } from "./state.js"
import {
  entryForSession,
  upsertSession,
  isPrimary,
  effectiveState,
  removeEntry,
  countActiveSubagents,
} from "./registry.js"
import { fetchSnapshot, postNotice, showToast, deleteSession, forgetSessionDirectory, getSessionDirectory } from "./client.js"
import { getSettings } from "./settings.js"
import { removeTask, todoFilePath } from "./todofile.js"
import { projectMdBlock } from "./project.js"
import { existsSync } from "node:fs"
import { log, errMsg } from "./log.js"
import {
  ABORT_NOTICE,
  ORCHESTRATION_GUIDE,
  SUBAGENT_GUIDE_CORE,
  SUBAGENT_OUTLINE_GUIDE,
} from "./prompts.js"
import { loadCustomPrompt, applyCustomPrompt } from "./promptsfile.js"
import { tokens as fmtTokens, ageSeconds } from "./format.js"

// The only tools a primary session may execute — everything else must be
// delegated to a subagent. Pure orchestration: spawn / abort / list. Even
// glob, grep, and TODO.md reads are delegated (to the planner), so the
// orchestrator stays at the coordination layer.
const PRIMARY_TOOLS = new Set([
  "spawn",
  "abort",
  "list",
])

// TODO.md is the domain of the six agents that produce concrete deliverables:
// planner (plans), coder (code), debugger (diagnoses), reviewer (reviews),
// documenter (docs), designer (images). Each one can read AND write TODO.md
// — list, add new tasks, edit existing ones, remove completed ones.
// The other two subagents (researcher, gitter) get no TODO tools at all: they
// hand off whatever they find to the others, who manage the list.
const TODO_TOOLS = new Set(["todos_open", "todo_done", "todo_add", "todo_edit"])
const TODO_AGENTS = new Set([
  "planner", "coder", "debugger", "reviewer", "documenter", "designer",
])

// Subagents whose tool gating disables `outline` — they neither read source
// code nor have the outline tool to call. Skip the outline-discipline block
// for them so the system prompt doesn't push a tool they can't use.
const OUTLINE_DISABLED_AGENTS = new Set(["designer", "gitter"])

// Subagents that get AGENTS.md content preserved in their system prompt.
// Others strip the ~17 KB block — they can still `read` AGENTS.md on demand
// if a task happens to need it. Orchestrator is treated as "primary" further
// down and always keeps AGENTS.md.
//   - coder / debugger / reviewer keep it: build/test commands, code style,
//     PR rules are central to their work.
//   - planner / documenter strip it: planner writes design docs and is told
//     in its role prompt to reference AGENTS.md via Sources when relevant;
//     documenter writes user-facing docs that rarely need dev conventions.
//   - researcher / designer / gitter strip it: web research, image
//     generation, git operations don't need project code conventions.
const AGENTS_MD_SUBAGENTS = new Set([
  "coder",
  "debugger",
  "reviewer",
])

// How long an entry's ctxTokens stays valid before the transform hook re-fetches
// the live snapshot. Caps the HTTP-fetch frequency on each subagent LLM call to
// at most once per CTX_TTL_MS, the main hot-path tax. Bypassed once we are
// close to the budget so the lockdown still triggers promptly.
const CTX_TTL_MS = 3000
const CTX_NEAR_BUDGET = 0.7

// How many over-budget tool-call denials before we notify the primary that
// this subagent is stuck in a denial loop. We never auto-abort — abort is
// strictly user-only (TUI ✕ or "kill the subagent" to the orchestrator). The
// notice is a one-shot heads-up so the orchestrator can surface the situation
// to the user; further denials keep escalating in tone but do not re-notify.
const BUDGET_NOTIFY_AFTER = 3

// Spawn-size thresholds applied AFTER a subagent finishes. The orchestrator's
// ORCHESTRATION_GUIDE asks for ≤ ~15 k tokens per spawn; in practice this is
// hard to feel as a number on the orchestrator side without feedback. The
// wake notice surfaces the actual ctxTokens consumed and escalates the tone
// once the spawn was clearly too big, so the next spawn in the same area is
// scoped tighter. Soft = "noticeably large", hard = "way too big, split next
// time". Pure messaging — we never auto-abort or re-spawn.
const LARGE_CTX_TOKENS_SOFT = 30_000
const LARGE_CTX_TOKENS_HARD = 50_000

// Builds the final system prompt for the current LLM call. We REPLACE opencode's
// `output.system` array wholesale with one combined string we control, rather
// than appending — opencode otherwise injects ~150 chars of model-identity
// boilerplate plus the full AGENTS.md (~17 KB) into every call regardless of
// whether the agent needs it. The new layout:
//
//   <role prompt — preserved from opencode>
//   <AGENTS.md project state — only for agents that benefit from it>
//   <plugin guide — SUBAGENT_GUIDE_CORE [+ OUTLINE], or ORCHESTRATION_GUIDE>
//   <limits + snapshot — orchestrator only>
//
// We keep opencode's `<env>` block (cwd / date / platform) intact since it's
// small and useful; we drop the "You are powered by the model named …" line
// (zero signal) and conditionally drop the AGENTS.md inject.
//
// Returns the hook bound to a client (needed for the context-budget check,
// which reads the subagent's live message history).
export function createTransformSystem(client) {
  return async function transformSystem(input, output) {
    try {
      const sessionID = input?.sessionID
      if (!sessionID) return

      const entry = entryForSession(sessionID)
      const isSubagent = Boolean(entry)
      const agentName = isSubagent ? entry.agent : detectAgentFromSystem(output) ?? "orchestrator"

      // Decide whether this agent gets AGENTS.md
      const keepAgentsMd = isSubagent
        ? AGENTS_MD_SUBAGENTS.has(agentName)
        : true // primaries (orchestrator) always keep AGENTS.md

      // Parse opencode's combined system into the three slices we care about.
      const slices = parseOpencodeSystem(output.system)

      // Resolve the session's directory so we can inject the project-spec block.
      // Subagents already have it on their registry entry (captured at spawn);
      // primaries are looked up via the session API (cached per session).
      const sessionDir = isSubagent
        ? entry.directory
        : await getSessionDirectory(client, sessionID)

      // Build the runtime parts once — both the auto-assembled path and the
      // custom-template path need them.
      const abortNotice = aborted.has(sessionID) ? ABORT_NOTICE : ""
      const projectMd = projectMdBlock(sessionDir) || ""
      let limits = ""
      let snapshot = ""
      let ctxBudget = ""
      if (isSubagent) {
        ctxBudget = await contextLimitNotice(client, entry)
      } else {
        limits = formatLimitsNotice()
        snapshot = formatSubagentSnapshot(sessionID) || ""
      }

      // User-editable per-agent template: `<sessionDir>/.opencode/agent-intercom/<agent>.md`.
      // When present, it REPLACES the auto-assembled prompt wholesale, with
      // `{{placeholder}}` tokens for the runtime parts the user chose to keep.
      // Caches by mtime so the per-turn cost is one stat() call.
      const customTemplate = sessionDir ? loadCustomPrompt(sessionDir, agentName) : null
      if (customTemplate) {
        const result = applyCustomPrompt(customTemplate, {
          env: slices.env || "",
          agents_md: keepAgentsMd ? slices.agentsMd || "" : "",
          project_md: projectMd,
          limits,
          snapshot,
          context_budget: ctxBudget,
          abort_notice: abortNotice,
        })
        output.system.length = 0
        output.system.push(result)
        return
      }

      // No custom file → auto-assemble as before.
      const guideParts = []
      if (abortNotice) guideParts.push(abortNotice)
      if (isSubagent) {
        if (!aborted.has(sessionID)) {
          guideParts.push(SUBAGENT_GUIDE_CORE)
          if (!OUTLINE_DISABLED_AGENTS.has(entry.agent)) {
            guideParts.push(SUBAGENT_OUTLINE_GUIDE)
          }
          if (projectMd) guideParts.push(projectMd)
        }
        if (ctxBudget) guideParts.push(ctxBudget)
      } else {
        guideParts.push(ORCHESTRATION_GUIDE)
        if (projectMd) guideParts.push(projectMd)
        guideParts.push(limits)
        if (snapshot) guideParts.push(snapshot)
      }

      const combined =
        slices.role +
        slices.env +
        (keepAgentsMd ? slices.agentsMd : "") +
        guideParts.join("")
      output.system.length = 0
      output.system.push(combined)
    } catch (err) {
      log("transform error", errMsg(err))
      // never break the session
    }
  }
}

// Splits opencode's auto-injected system into three labelled slices so we can
// rebuild it on our terms. Defensive: when a marker is missing, the rest goes
// into the role slice and the others come back empty — the worst case is that
// our rewrite degrades to a noop, never a corrupted prompt.
//
// Slices:
//   role     — the agent prompt that came from agents.js, ending right before
//              opencode's "You are powered by the model …" boilerplate.
//   env      — opencode's `<env>` block (cwd / platform / date / git-repo).
//              Small and useful — we always preserve it. The "powered by the
//              model" line above it is dropped (zero signal).
//   agentsMd — everything from "Instructions from: …AGENTS.md" onward, i.e.
//              the AGENTS.md content opencode auto-includes. The caller
//              decides whether to keep it for the current agent.
function parseOpencodeSystem(systemArr) {
  const joined = Array.isArray(systemArr) ? systemArr.join("\n\n") : String(systemArr ?? "")
  const empty = { role: joined, env: "", agentsMd: "" }

  const modelLineIdx = joined.indexOf("You are powered by the model named")
  if (modelLineIdx < 0) return empty
  const role = joined.slice(0, modelLineIdx)

  // Find the <env> block; skip the model-identity line before it.
  const envOpen = joined.indexOf("<env>", modelLineIdx)
  const envClose = envOpen >= 0 ? joined.indexOf("</env>", envOpen) : -1
  let env = ""
  let cursor = modelLineIdx
  if (envOpen >= 0 && envClose >= 0) {
    env = "\n\n" + joined.slice(envOpen, envClose + "</env>".length) + "\n"
    cursor = envClose + "</env>".length
  }

  // Everything from the first "Instructions from:" marker through the end is
  // AGENTS.md (or any other root instruction file opencode found).
  const instrIdx = joined.indexOf("Instructions from:", cursor)
  const agentsMd = instrIdx >= 0 ? "\n\n" + joined.slice(instrIdx) : ""

  return { role, env, agentsMd }
}

// Pulls the agent name out of an "# Role: <Name>" header in the role prompt.
// Used for primary sessions where we don't have a registry entry yet — the
// agents.js role prompts all start with `# Role: Orchestrator` or
// `# Role: Coder (Subagent)` etc. Returns the lowercased agent name, or null
// if the header isn't found (caller falls back to "orchestrator").
function detectAgentFromSystem(output) {
  if (!Array.isArray(output?.system) || output.system.length === 0) return null
  const head = output.system[0].slice(0, 200)
  const m = /^#\s*Role:\s*([A-Za-z]+)/m.exec(head)
  if (!m) return null
  return m[1].toLowerCase()
}

// Reads the subagent's live context size and, if it has reached the budget,
// returns a "wrap up and report back" notice to inject. Also keeps the entry's
// ctxTokens/lastActivity fresh as a side effect. Empty string when the budget
// is disabled, not reached, or the subagent is already aborted.
//
// Hot path: this runs before EVERY subagent LLM call. The snapshot HTTP fetch
// dominates cost as the subagent's message history grows, so the result is
// cached on the entry for CTX_TTL_MS. Once we get within CTX_NEAR_BUDGET of
// the limit the cache is bypassed so the lockdown triggers as soon as the
// budget is actually breached.
async function contextLimitNotice(client, entry) {
  const maxContext = getSettings().maxContext
  if (maxContext <= 0 || aborted.has(entry.sessionID)) return ""

  const now = Date.now()
  const cacheFresh = now - entry.lastTokensFetchAt < CTX_TTL_MS
  const nearBudget =
    entry.ctxTokens != null && entry.ctxTokens > maxContext * CTX_NEAR_BUDGET
  if (!cacheFresh || nearBudget) {
    const snapshot = await fetchSnapshot(client, entry.sessionID)
    if (snapshot.ctxTokens != null) {
      entry.ctxTokens = snapshot.ctxTokens
      entry.lastTokensFetchAt = now
    }
    if (snapshot.lastActivity) entry.lastActivity = snapshot.lastActivity
  }

  if (entry.ctxTokens == null || entry.ctxTokens < maxContext) return ""

  // Count THIS injection: each over-budget LLM turn is one "you have seen the
  // stop sign" chance. Counting LLM turns (not raw tool-call denials) is the
  // right unit — parallel tool calls within a single turn share one chance,
  // and the LLM only sees an updated injection on its NEXT turn. The level
  // drives both the tone of this message and the notify-parent decision.
  entry.stopInjections = (entry.stopInjections ?? 0) + 1
  const level = entry.stopInjections

  log("subagent over context budget", {
    handle: entry.handle,
    ctxTokens: entry.ctxTokens,
    limit: maxContext,
    stopInjections: level,
  })

  // Side effect: when this turn crosses the notify threshold, post a one-shot
  // heads-up to the parent so the orchestrator can surface it to the user.
  // We never auto-abort — abort is strictly user-only (TUI ✕ or "kill the
  // subagent" to the orchestrator). The subagent stays alive; further turns
  // keep escalating the tone but do not re-notify.
  if (level >= BUDGET_NOTIFY_AFTER && !entry.notifiedParentOfLoop) {
    entry.notifiedParentOfLoop = true
    void notifyParentOfDenialLoop(client, entry)
  }

  const head =
    level >= BUDGET_NOTIFY_AFTER
      ? "🛑🛑🛑 STOP — FINAL WARNING."
      : level === 2
        ? "🛑🛑 STOP — SECOND WARNING."
        : "🛑 STOP."
  const tail =
    level >= BUDGET_NOTIFY_AFTER
      ? "THE ORCHESTRATOR AND USER HAVE NOW BEEN NOTIFIED that you are stuck — the user is " +
        "being asked whether to abort you. Every further tool call is wasted output that nobody " +
        'will read. Your ONLY remaining move: write a plain-text message starting with "Done:" ' +
        'or "Blocked:" — now.'
      : level === 2
        ? "One more over-budget turn and the orchestrator + user will be notified that you are " +
          'stuck. Write a plain-text message starting with "Done:" now.'
        : `If you keep calling tools, after ${BUDGET_NOTIFY_AFTER} ignored warnings the ` +
          "orchestrator + user will be notified that you are stuck. Write a plain-text message " +
          'starting with "Done:" now.'

  return (
    `\n\n---\n${head} agent-intercom: your context has reached ${fmtTokens(entry.ctxTokens)} ` +
    `tokens (budget ${fmtTokens(maxContext)}). Your tool calls are now DISABLED — every tool ` +
    `call will be rejected with an error. This is warning ${level}/${BUDGET_NOTIFY_AFTER}.\n\n` +
    'YOUR LITERAL NEXT MESSAGE MUST BEGIN WITH "Done:" (or "Blocked:") followed by 1–2 short ' +
    "sentences naming what you accomplished and what remains. No tool call, no JSON, no code " +
    'block — plain text starting with "Done:" or "Blocked:". Do NOT try `read`, `edit`, `bash`, ' +
    "`web_search`, `webfetch` or any other tool; do NOT try \"just one more lookup\". " +
    tail +
    "\n---\n"
  )
}

// One-line block telling the orchestrator the CURRENT runtime limits so the
// "right-sized chunks" sizing rule in ORCHESTRATION_GUIDE has a concrete
// number to anchor on. The guide refers to `maxContext` abstractly; the user
// can change it at runtime via the settings file, so the actual value must be
// injected fresh per turn. "0" means the budget is disabled.
function formatLimitsNotice() {
  const s = getSettings()
  const ctx = s.maxContext > 0 ? `${fmtTokens(s.maxContext)} tokens` : "disabled"
  const sub = s.maxSubagents > 0 ? `${s.maxSubagents}` : "unlimited"
  return (
    "\n\n---\n📐 agent-intercom: current limits — " +
    `maxContext = ${ctx}, maxSubagents = ${sub}. ` +
    "Use these as the actual numbers when applying the right-sized-chunks rule.\n---\n"
  )
}

// A compact, live list of THIS primary's currently active subagents — injected
// into the primary's system prompt so it always knows what is running. Fed from
// the module-level registry, kept fresh by the `event` hook (status/idle).
// Aborted subagents are filtered out; finished subagents are not in the
// registry at all (event hook removes them on idle). Returns the empty string
// when nothing is active.
function formatSubagentSnapshot(primaryID) {
  const mine = [...registry.values()].filter((e) => {
    if (e.parentID !== primaryID) return false
    return effectiveState(e) !== "aborted"
  })
  if (mine.length === 0) return ""
  const rows = mine.map((e) => {
    const state = effectiveState(e)
    const ctx = e.ctxTokens == null ? "? ctx" : `${fmtTokens(e.ctxTokens)} ctx`
    const age = ageSeconds(e.spawnedAt)
    const last = e.lastActivity ? ` · last: ${e.lastActivity.slice(0, 80)}` : ""
    return `• ${e.handle} (${e.agent}) — ${state} · ${ctx} · ${age}s${last}`
  })
  return (
    "\n\n---\n📋 agent-intercom: active subagents you have spawned. They are one-shot — a finished " +
    "subagent disappears from this list. To stop one, use `abort` (only on user request); for " +
    "more work, spawn a fresh subagent:\n" +
    rows.join("\n") +
    "\n---\n"
  )
}


// Set of unknown event types we have already logged once. opencode is on a
// moving release train so new event types appear from time to time — log them
// once per process so we notice during upgrades without spamming the log.
const unknownEventsSeen = new Set()

// Auto-registers subagents spawned via the native `task` tool, keeps status
// fresh from session lifecycle events, and — the key bit — wakes the primary
// when a subagent finishes. opencode never re-activates an idle primary on its
// own, so a finished subagent would go unreported until the user asks; here we
// `promptAsync` the parent session so it proactively reports back.
//
// Returns the event handler bound to a client. The wake-hook locates TODO.md
// for auto-tick from `entry.directory` (captured per-session at spawn time) —
// NOT from the factory closure, which only reflects where opencode serve was
// started and is wrong for sessions created with ?directory=other-project.
export function createEventHandler(client) {
  return async function handleEvent({ event }) {
    try {
      const props = event?.properties ?? {}
      switch (event?.type) {
        case "session.created":
          onSessionCreated(props)
          break
        case "session.status":
          onSessionStatus(props)
          break
        case "session.idle":
          await onSessionIdle(props, client)
          break
        default:
          if (event?.type && !unknownEventsSeen.has(event.type)) {
            unknownEventsSeen.add(event.type)
            log("unknown event type (logging once per process)", event.type)
          }
      }
    } catch (err) {
      log("event error", errMsg(err))
    }
  }
}

function onSessionCreated({ info }) {
  if (!info?.id || !info.parentID || !isPrimary(info.parentID)) return
  const existed = Boolean(entryForSession(info.id))
  const entry = upsertSession(info.id, { prompt: info.title ?? "", parentID: info.parentID })
  if (!existed) log("auto-registered subagent", { handle: entry.handle, sessionID: info.id })
}

function onSessionStatus({ sessionID, status }) {
  const entry = entryForSession(sessionID)
  if (entry && status?.type && !aborted.has(sessionID)) entry.status = status.type
}

// A tracked subagent went idle -> its one-shot life is over. Wake the primary
// with the result, then remove the entry from our registry AND delete the
// underlying opencode session, so the next time the orchestrator wants
// something it spawns a fresh one. Aborted subagents skip the wake (the user
// already asked for it to stop). Re-entry by a duplicate idle event is a no-op
// because the entry is already gone.
async function onSessionIdle({ sessionID }, client) {
  const entry = entryForSession(sessionID)
  if (!entry || aborted.has(sessionID)) return
  entry.status = "idle"
  if (!entry.parentID) return
  const handle = entry.handle
  const parentID = entry.parentID
  const agent = entry.agent
  const taskId = entry.taskId
  const directory = entry.directory
  try {
    const snapshot = await fetchSnapshot(client, sessionID)
    // Auto-tick TODO.md based on the subagent's `DONE: T<n>` marker, if it's
    // present and matches the spawn-assigned task id. Done BEFORE
    // removeEntry/postNotice so the completion notice can report the outcome.
    const taskOutcome = autoMarkTask(directory, taskId, snapshot.result)
    // Drop the entry BEFORE rendering the slot notice so the freed slot is
    // already reflected in countActiveSubagents — otherwise the orchestrator
    // would see "0 free" even though this very subagent just released its slot.
    if (removeEntry(sessionID)) {
      log("removed finished subagent", { handle, sessionID })
    }
    await postNotice(
      client,
      parentID,
      completionNotice(handle, agent, snapshot.result, parentID, taskOutcome, snapshot.ctxTokens),
    )
    showToast(client, {
      title: "agent-intercom",
      message: `${handle} finished`,
      variant: "success",
    })
    log("notified primary of completion", { handle, parentID, taskOutcome })
  } catch (err) {
    log("notify parent failed", errMsg(err))
    // Fall through to cleanup of the underlying opencode session — keeping it
    // around would only leak: a one-shot subagent gets exactly one wake
    // attempt. If it failed, the user can re-prompt via the primary.
    if (removeEntry(sessionID)) {
      log("removed finished subagent (after notify failure)", { handle, sessionID })
    }
  }
  const ok = await deleteSession(client, sessionID)
  if (ok) log("deleted opencode session", { handle, sessionID })
  forgetSessionDirectory(sessionID)
}

// Marker the subagent is taught to put on the FIRST non-empty line of its
// final reply. `DONE: T<n>` — the wake-hook removes the matching task from
// TODO.md. No blocked state; if the work cannot finish, the subagent just
// reports plainly and TODO.md stays unchanged.
const MARKER_RE = /^\s*DONE:\s*(T\d+)\s*$/i

// Parses the marker out of the subagent's final reply and removes the task
// from TODO.md if it matches the spawn-assigned task id. Returns one of:
//   { kind: "no-task" }   — subagent wasn't spawned with a task id
//   { kind: "no-marker" } — task id given but reply has no DONE line
//   { kind: "mismatch" }  — marker present but for a different id (ignored)
//   { kind: "no-todo" }   — TODO.md doesn't exist (greenfield)
//   { kind: "done", id }  — successfully removed
//   { kind: "error", message } — TODO.md operation threw (id not found etc.)
function autoMarkTask(directory, taskId, finalReply) {
  if (!taskId) return { kind: "no-task" }
  const firstLine = firstNonEmptyLine(finalReply)
  const m = firstLine ? MARKER_RE.exec(firstLine) : null
  if (!m) return { kind: "no-marker" }
  const markerId = m[1]
  if (markerId !== taskId) return { kind: "mismatch", expected: taskId, got: markerId }
  if (!directory || !existsSync(todoFilePath(directory))) return { kind: "no-todo" }
  try {
    removeTask(directory, taskId)
    return { kind: "done", id: taskId }
  } catch (err) {
    return { kind: "error", message: errMsg(err) }
  }
}

function firstNonEmptyLine(text) {
  if (!text) return ""
  for (const line of text.split("\n")) {
    if (line.trim()) return line
  }
  return ""
}

function taskOutcomeLine(outcome) {
  if (!outcome || outcome.kind === "no-task") return ""
  switch (outcome.kind) {
    case "done":
      return `\n📋 TODO.md: ${outcome.id} removed.`
    case "no-marker":
      return (
        "\n⚠️ TODO.md: this subagent had a task id but its reply did NOT start with " +
        "`DONE: <id>`. The task was NOT auto-removed. Verify the work and call " +
        "`todo_done(id)` yourself if appropriate."
      )
    case "mismatch":
      return (
        `\n⚠️ TODO.md: subagent reported \`${outcome.got}\` but was spawned for \`${outcome.expected}\`. ` +
        `Marker IGNORED (possible hallucination). Verify and remove manually if needed.`
      )
    case "no-todo":
      return "\n⚠️ TODO.md not present — marker ignored."
    case "error":
      return `\n⚠️ TODO.md: auto-remove failed: ${outcome.message}`
    default:
      return ""
  }
}

function completionNotice(handle, agent, result, parentID, taskOutcome, ctxTokens) {
  return (
    `🔔 agent-intercom: your subagent "${handle}" (${agent}) has finished and been destroyed.\n` +
    (result ? `Its result:\n${result}\n` : "It produced no text result.\n") +
    `Use this to report back to the user. If you need more work in this area, spawn a fresh ` +
    `subagent — the one above is gone.` +
    taskOutcomeLine(taskOutcome) +
    spawnSizeNotice(ctxTokens) +
    slotsNoticeAfterFinish(parentID)
  )
}

// Tail line: surfaces the actual ctx consumption of the finished subagent so
// the orchestrator gets numerical feedback on whether the spawn was right-sized.
// Tone escalates in two steps; numbers ≥ HARD are spawn-too-big and the next
// one in the area should be split tighter.
function spawnSizeNotice(ctxTokens) {
  if (!ctxTokens || ctxTokens <= 0) return ""
  const used = fmtTokens(ctxTokens)
  if (ctxTokens >= LARGE_CTX_TOKENS_HARD) {
    return (
      `\n📏 spawn-size: this subagent used ${used} tokens — far over the ~15 k target. The ` +
      `task was too big. SPLIT the next spawn in this area into smaller, single-concern pieces ` +
      `(1 file / 1 slice each) before continuing.`
    )
  }
  if (ctxTokens >= LARGE_CTX_TOKENS_SOFT) {
    return (
      `\n📏 spawn-size: this subagent used ${used} tokens — above the ~15 k target. Scope the ` +
      `next spawn in this area tighter (fewer files, narrower goal).`
    )
  }
  return `\n📏 spawn-size: ${used} tokens (target ≤ ~15 k — ok).`
}

// Tail line for completion notices: tells the orchestrator how many subagent
// slots are now free so it knows whether the next spawn() will succeed. Empty
// when the cap is disabled. Called after removeEntry, so the freed slot is
// already counted out.
function slotsNoticeAfterFinish(primaryID) {
  const maxSubagents = getSettings().maxSubagents
  if (maxSubagents <= 0) return ""
  const active = countActiveSubagents(primaryID)
  const free = Math.max(0, maxSubagents - active)
  return `\nSubagent slots: ${active}/${maxSubagents} — ${free} free.`
}

// Guards tool execution before it runs:
//  - hard-denies any tool call from a subagent we have flagged as aborted
//    (opencode's abort is cooperative, so this is the safety net),
//  - hard-denies every tool call from a subagent that has hit its context
//    budget, locking it down to a text-only handover, and
//  - restricts primary sessions to the intercom tools only: a primary
//    orchestrates and delegates, it does not do work itself.
//
// Bound to a client so it can read live state, though the budget path no
// longer aborts: notification of the parent happens in contextLimitNotice
// when the LLM-turn-based threshold is crossed; the guard only denies.
export function createGuardToolExecute(client) {
  return async function guardToolExecute(input) {
    const sessionID = input?.sessionID
    if (!sessionID) return

    if (aborted.has(sessionID)) {
      log("denied tool call from aborted session", { sessionID, tool: input.tool })
      throw new Error(
        "agent-intercom: this subagent has been aborted by the orchestrator — no further tool calls permitted.",
      )
    }

    const entry = entryForSession(sessionID)

    // A tracked subagent may run any tool — unless it has reached its context
    // budget, in which case every tool is denied so it can only emit its final
    // text and return control. entry.ctxTokens is kept fresh by the transform
    // hook, which runs before each LLM call.
    if (entry) {
      if (TODO_TOOLS.has(input.tool) && !TODO_AGENTS.has(entry.agent)) {
        log("denied todo tool from non-todo subagent", {
          sessionID,
          agent: entry.agent,
          tool: input.tool,
        })
        throw new Error(
          `agent-intercom: \`${input.tool}\` is restricted to planner / coder / debugger / ` +
            "reviewer / documenter / designer. The researcher and gitter agents do not touch " +
            "TODO.md. End your reply with `DONE: T<n>` on the FIRST line of your final message " +
            "if your spawn was task-tracked and you finished the work.",
        )
      }
      const maxContext = getSettings().maxContext
      if (maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext) {
        entry.budgetDenials = (entry.budgetDenials ?? 0) + 1
        const level = entry.stopInjections ?? 0
        log("denied tool call: subagent over context budget", {
          handle: entry.handle,
          tool: input.tool,
          ctxTokens: entry.ctxTokens,
          denials: entry.budgetDenials,
          stopInjections: level,
        })
        // Tone escalates with stopInjections (LLM turns the warning has been
        // visible) — NOT raw denials, so parallel tool calls within one turn
        // share one intensity level. We never auto-abort; the worst-case at
        // level >= BUDGET_NOTIFY_AFTER is that the parent has been notified
        // (by contextLimitNotice on the same turn) so the user can step in.
        const escalation =
          level >= BUDGET_NOTIFY_AFTER
            ? "🛑🛑🛑 FINAL. The orchestrator and user have been notified that you are stuck. " +
              "No tool call will succeed. Your only path forward: write a plain-text message " +
              'starting with "Done:" or "Blocked:".'
            : level === 2
              ? `🛑🛑 SECOND WARNING (turn ${level}/${BUDGET_NOTIFY_AFTER}). You have ignored ` +
                "the previous STOP injection. One more over-budget turn and the orchestrator + " +
                'user will be notified. Write a plain-text message starting with "Done:" now.'
              : "🛑 STOP. Your context budget is exhausted; tool calls are disabled. Write a " +
                'plain-text message starting with "Done:" (1–2 sentences) and return.'
        throw new Error("agent-intercom: " + escalation)
      }
      // Tool call accepted — clear stale counters from a previous near-budget
      // burst that recovered (e.g. after a compact).
      if (entry.budgetDenials) entry.budgetDenials = 0
      if (entry.stopInjections) entry.stopInjections = 0
      if (entry.notifiedParentOfLoop) entry.notifiedParentOfLoop = false
      return
    }

    // Not a tracked subagent -> a primary session. It may only run the
    // intercom tools (+ glob/grep); everything else it must delegate.
    if (!PRIMARY_TOOLS.has(input.tool)) {
      log("denied non-orchestration tool from primary", { sessionID, tool: input.tool })
      const hint =
        input.tool === "task"
          ? "Use `spawn(agent, prompt)` instead — it starts the subagent non-blocking."
          : "Spawn a subagent and describe the *goal* you want — do not mention the tool. How the " +
            "subagent reaches the goal is its own concern, not yours."
      throw new Error(
        `agent-intercom: this is an orchestrator session — it delegates work, it does not run ` +
          `\`${input.tool}\` itself. ${hint} Available orchestration tools: spawn, abort, list.`,
      )
    }

    // Anti-polling: small LLMs habitually re-call `list` instead of ending the
    // turn after a spawn — the snapshot in the system prompt already shows the
    // same info each turn, and finished subagents wake the primary on their
    // own. One `list` per "stretch" is enough; the second back-to-back call is
    // denied. Any other tool call (spawn/abort/glob/grep) resets the streak.
    if (input.tool === "list" && lastPrimaryTool.get(sessionID) === "list") {
      log("denied back-to-back list from primary", { sessionID })
      throw new Error(
        "agent-intercom: don't call `list` twice in a row. End your turn — you will be woken.",
      )
    }
    lastPrimaryTool.set(sessionID, input.tool)
  }
}

// Tells the primary that a subagent is stuck in a denial loop — over budget,
// ignoring STOP injections, still trying tool calls. Fires once when the
// stopInjections counter crosses BUDGET_NOTIFY_AFTER. We do NOT abort: that
// is strictly user-only (TUI ✕ or "kill the subagent" to the orchestrator).
// The subagent stays alive so the user can still inspect its session.
async function notifyParentOfDenialLoop(client, entry) {
  log("denial loop: notifying parent", {
    handle: entry.handle,
    ctxTokens: entry.ctxTokens,
    stopInjections: entry.stopInjections,
    denials: entry.budgetDenials,
  })
  if (entry.parentID) {
    try {
      await postNotice(client, entry.parentID, denialLoopNotice(entry))
    } catch (err) {
      log("denial loop: notify parent failed", errMsg(err))
    }
  }
  showToast(client, {
    title: "agent-intercom",
    message: `${entry.handle} stuck — user action needed`,
    variant: "warning",
  })
}

function denialLoopNotice(entry) {
  return (
    `⚠️ agent-intercom: subagent "${entry.handle}" (${entry.agent}) is OVER its context budget ` +
    `(${fmtTokens(entry.ctxTokens)} tokens) and keeps calling tools instead of wrapping up — ` +
    `it has ignored ${entry.stopInjections} STOP injection${entry.stopInjections === 1 ? "" : "s"}. ` +
    `It is still alive, still consuming time, still producing nothing useful. ` +
    `Tell the user the subagent appears stuck and ask whether to abort it (via the TUI ✕ button, ` +
    `or by telling you to abort it by handle). Do NOT abort on your own — abort is user-only.`
  )
}

// Rewrites any pending tool-part in the message history to a completed denial.
//
// Why: when `guardToolExecute` throws (back-to-back list, aborted subagent,
// over-budget, primary calling a non-orchestration tool), opencode has already
// persisted the assistant step with the tool-part in state=pending — but the
// tool never executes, so no tool-result is appended. The next provider call
// then sends `messages[-1] = assistant{parts:[…, tool(pending)]}` as a
// trailing-assistant with a non-empty tool-call but no result. llama.cpp
// thinking-on templates (Qwen3 hybrid/3.5/3.6, DeepSeek-R1, …) reject this
// with HTTP 400 "Assistant response prefill is incompatible with
// enable_thinking". opencode explicitly leaves this class for plugin-side
// fixes (see opencode `provider/transform.ts:249-256`).
//
// We rewrite in place: set state.status="completed" and inject a clear denial
// output so the model sees a normal tool-result-like message ("this call was
// not executed — pick a different action"). Mutation is safe because opencode
// hands us its `output.messages` array for transformation.
const PENDING_DENIAL_OUTPUT =
  "[agent-intercom: this tool call was NOT executed — it was denied by the " +
  "tool-execute guard (e.g. back-to-back `list`, aborted subagent, " +
  "over-budget subagent, or a primary calling a non-orchestration tool). " +
  "Do not retry the same call; continue with a different action.]"

export function rewritePendingTools(messages) {
  if (!Array.isArray(messages)) return 0
  let rewritten = 0
  for (const m of messages) {
    if (m?.info?.role !== "assistant") continue
    const parts = m.parts
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      if (p?.type !== "tool") continue
      const state = p.state
      if (!state || state.status !== "pending") continue
      state.status = "completed"
      if (!state.output) state.output = PENDING_DENIAL_OUTPUT
      if (!state.metadata) state.metadata = { truncated: false }
      if (state.title == null) state.title = ""
      const now = Date.now()
      if (!state.time) state.time = { start: now, end: now }
      else if (state.time.end == null) state.time.end = state.time.start ?? now
      rewritten++
    }
  }
  if (rewritten > 0) log("rewrote pending tool-parts", { count: rewritten })
  return rewritten
}
