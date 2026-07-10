// opencode lifecycle hooks: system-prompt injection, session events, and the
// tool-call guard (aborted-subagent hard-deny + native-`task` enforcement).
//
// The notice builders live in notices.js, the shared subagent teardown +
// parent-notice delivery in teardown.js, the inactivity watchdog in
// watchdog.js, and the primary-handoff wiring in handoffwiring.js — this file
// keeps the three hook factories (transform / event / guard) plus their
// close helpers.

import { aborted, registry, lastPrimaryTool } from "./state.js"
import {
  entryForSession,
  upsertSession,
  isPrimary,
  effectiveState,
  removeEntryLocked,
  registryMutex,
  shouldRefreshPrimary,
  recordPrimaryContext,
  scheduleHandoffIfNeeded,
  CTX_TTL_MS,
} from "./registry.js"
import { fetchSnapshot, showToast, getSessionDirectory } from "./client.js"
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
import { postParentNotice, teardownSubagent } from "./teardown.js"
import { completionNotice, errorNotice, denialLoopNotice } from "./notices.js"
import { ensureWatchdogStarted } from "./watchdog.js"
import { maybeRunPendingHandoff } from "./handoffwiring.js"

// Re-exported so existing importers (test/plugin.test.js) keep resolving it
// from hooks.js after the watchdog code moved to its own module.
export { timeoutSubagent } from "./watchdog.js"

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
export const TODO_TOOLS = new Set(["todos_open", "todo_done", "todo_add", "todo_edit"])
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

// CTX_TTL_MS (imported from registry.js) caps how often an entry's ctxTokens is
// re-fetched from the live snapshot on each subagent LLM call — the main
// hot-path tax. Bypassed once we are close to the budget so the lockdown still
// triggers promptly.
const CTX_NEAR_BUDGET = 0.7

// Handoff re-entrancy state lives in state.js (`pendingHandoffs` +
// `handoffInProgress`), gated via registry.js (scheduleHandoffIfNeeded /
// claimPendingHandoff / releaseHandoff / forgetPrimary). The transform hook
// only SCHEDULES a handoff; execution is idle-gated — see maybeRunPendingHandoff
// in handoffwiring.js.

// How many over-budget tool-call denials before we notify the primary that
// this subagent is stuck in a denial loop. We never auto-abort — abort is
// strictly user-only (TUI ✕ or "kill the subagent" to the orchestrator). The
// notice is a one-shot heads-up so the orchestrator can surface the situation
// to the user; further denials keep escalating in tone but do not re-notify.
const BUDGET_NOTIFY_AFTER = 3

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
        // Primary (non-subagent) turn. Measurement only — record the current
        // context-token count, TTL-guarded via shouldRefreshPrimary. No
        // threshold check, no handoff trigger; that's a later slice.
        if (shouldRefreshPrimary(sessionID)) {
          const snap = await fetchSnapshot(client, sessionID)
          recordPrimaryContext(sessionID, snap?.ctxTokens)
        }
        // Idle-gated handoff, schedule side. The transform hook fires WHILE
        // the triggering turn is already running — starting the handoff here
        // would delete the old session mid-turn, so the triggering user
        // message would never be answered and the doc-summary prompt would
        // queue behind the busy turn (both live-verified). So this hook only
        // SETS the pending flag; the primary's next `session.idle` event
        // (i.e. after the triggering turn has been fully answered) executes
        // the handoff — see maybeRunPendingHandoff. scheduleHandoffIfNeeded
        // is true only when the flag was NEWLY set (already-pending and
        // in-progress both gate), so the toast fires once per scheduling.
        const { maxPrimaryContext } = getSettings()
        if (scheduleHandoffIfNeeded(sessionID, maxPrimaryContext)) {
          log("primary handoff scheduled (idle-gated)", { sessionID })
          showToast(client, {
            title: "agent-intercom",
            message:
              "primary context limit reached — orchestrator handoff scheduled for the end of this turn",
          })
        }
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
    // Stamp the fetch time even when the snapshot came back empty (no assistant
    // step yet → ctxTokens null). Guarding this behind `ctxTokens != null` left
    // lastTokensFetchAt at 0 forever, so `cacheFresh` stayed false and the
    // full-history HTTP fetch re-ran on EVERY subagent tool call until the
    // first token count appeared — the exact hot-path tax this cache exists to
    // prevent. Same CTX_TTL_MS applies to the empty case (no new constant): an
    // early-life empty snapshot is retried at the normal cadence, and the
    // near-budget bypass is unaffected (it needs a known ctxTokens anyway).
    entry.lastTokensFetchAt = now
    if (snapshot.ctxTokens != null) entry.ctxTokens = snapshot.ctxTokens
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
      await postParentNotice(client, entry.parentID, denialLoopNotice(entry))
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

// A compact, live list of ALL active subagents across every primary in this
// opencode process — the subagent cap is global, so the orchestrator needs to
// see subagents spawned by other primaries too (those still consume the shared
// slot budget). Injected into the primary's system prompt so it always knows
// what is running. Fed from the module-level registry, kept fresh by the
// `event` hook (status/idle). Aborted subagents are filtered out; finished
// subagents are not in the registry at all (event hook removes them on idle).
// Returns the empty string when nothing is active.
function formatSubagentSnapshot(primaryID) {
  const active = [...registry.values()].filter((e) => effectiveState(e) !== "aborted")
  if (active.length === 0) return ""
  const rows = active.map((e) => {
    const state = effectiveState(e)
    const ctx = e.ctxTokens == null ? "? ctx" : `${fmtTokens(e.ctxTokens)} ctx`
    const age = ageSeconds(e.spawnedAt)
    const last = e.lastActivity ? ` · last: ${e.lastActivity.slice(0, 80)}` : ""
    const owner = e.parentID === primaryID ? "" : " · [other session]"
    return `• ${e.handle} (${e.agent}) — ${state} · ${ctx} · ${age}s${last}${owner}`
  })
  return (
    "\n\n---\n📋 agent-intercom: active subagents across all orchestrator sessions in this process " +
    "(the subagent cap is global). They are one-shot — a finished subagent disappears from this " +
    "list. To stop one, use `abort` (only on user request); for more work, spawn a fresh " +
    "subagent:\n" +
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
//
// The first call also arms the inactivity watchdog (see sweepWatchdog).
export function createEventHandler(client) {
  ensureWatchdogStarted(client)
  return async function handleEvent({ event }) {
    try {
      const props = event?.properties ?? {}
      // Bump the entry's lastActivityAt on EVERY event for a tracked session,
      // before dispatch — this is the dead-man's-switch signal for the
      // watchdog. A subagent that keeps emitting events is alive; one that
      // goes silent gets timed out. We touch by every sessionID we can find
      // on the event payload (status/idle use `sessionID` at top level;
      // session.created nests it under `info.id`). Done unconditionally:
      // touching a non-tracked session is a cheap Map miss.
      const sid = props?.sessionID ?? props?.info?.id
      if (sid) {
        const e = entryForSession(sid)
        if (e) e.lastActivityAt = Date.now()
      }
      switch (event?.type) {
        case "session.created":
          onSessionCreated(props)
          break
        case "session.status":
          onSessionStatus(props)
          break
        case "session.idle":
          await onSessionIdle(props, client)
          // Idle-gated primary handoff. Ordered AFTER the subagent wake path
          // and detached from the event stream: for a tracked subagent the
          // claim below is a guaranteed no-op (only primary transforms set
          // the pending flag), and for a primary the subagent path above is
          // a no-op (no registry entry) — the two paths cannot interfere.
          // Detached because a full handoff can take minutes (doc-summary
          // poll); maybeRunPendingHandoff never rejects (runScheduledHandoff
          // swallows + releases), so `void` cannot hide an unhandled rejection.
          void maybeRunPendingHandoff(client, props?.sessionID)
          break
        case "session.error":
          await onSessionError(props, client)
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
//
// Double-fire guard vs the inactivity watchdog: if sweepWatchdog has already
// aborted this subagent because it went silent, `aborted.has(sessionID)` is
// true AND removeEntry has already run (so entryForSession returns undefined).
// Either guard alone is sufficient; both together make the intent explicit.
async function onSessionIdle({ sessionID }, client) {
  // CRITICAL SECTION per §14.7: read all delivery-target fields from the
  // registry and remove the entry from the registry under the same mutex,
  // then release the lock BEFORE any network I/O (postNotice/fetchSnapshot).
  // The wake race (§14.7): a future reparentSubagents swaps parentID on
  // in-flight entries. We must atomically (a) read parentID, (b) verify
  // the entry is still ours (not already cleared by another path), (c)
  // claim it via a `dispatched` latch so any concurrent mutation sees
  // we've taken responsibility, and (d) removeEntry — all in one
  // runExclusive. Once we hold the snapshot, postNotice to that exact
  // parentID may proceed outside the lock; the network call is
  // retry-irrelevant because the snapshot is now stable.
  const wake = await registryMutex.runExclusive(() => {
    const e = entryForSession(sessionID)
    if (!e || aborted.has(sessionID) || e.timedOut || e.errored || e.dispatched) return null
    e.status = "idle"
    if (!e.parentID) return null
    // Latch BEFORE removal so any other path that runs under the same mutex
    // (a concurrent onSessionIdle duplicate, a future reparentSubagents, a
    // sweepWatchdog iteration) either sees `dispatched` and skips or never
    // touches this entry at all. Cheap, idempotent, single-write.
    e.dispatched = true
    // Inline removeEntry (via removeEntryLocked) instead of awaiting removeEntry:
    // removeEntry itself is wrapped in runExclusive, and the FIFO mutex is
    // not re-entrant — nesting runExclusive inside runExclusive on the same
    // `_tail` would deadlock. The body is identical to removeEntry's; we just
    // skip the inner lock acquisition because we already hold the outer one.
    // Returns a real boolean synchronously, so the truthy-branch below is
    // correct (a missing entry now actually returns null instead of leaking
    // a truthy Promise object — that was the regression slice 1a introduced).
    const removed = removeEntryLocked(sessionID)
    return removed ? {
      handle: e.handle,
      parentID: e.parentID,
      agent: e.agent,
      taskId: e.taskId,
      directory: e.directory,
    } : null
  })
  if (!wake) return
  const { handle, parentID, agent, taskId, directory } = wake
  try {
    const snapshot = await fetchSnapshot(client, sessionID)
    // Auto-tick TODO.md based on the subagent's `DONE: T<n>` marker, if it's
    // present and matches the spawn-assigned task id. Done BEFORE
    // removeEntry/postNotice so the completion notice can report the outcome.
    const taskOutcome = autoMarkTask(directory, taskId, snapshot.result)
    // Routed delivery: during an executing primary handoff the notice is
    // buffered (and flushed to the NEW orchestrator after its kickoff);
    // after a completed handoff a stale parentID is redirected. Never posts
    // into the old session's teardown window.
    await postParentNotice(
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
  }
  await teardownSubagent(
    client,
    { sessionID, handle, parentID },
    { entryRemoved: true, label: "" },
  )
}

// A tracked subagent's LLM call failed (provider auth error, API error,
// output-length, abort, or generic unknown). opencode surfaces this as
// `session.error` BEFORE the eventual `session.idle`, so catching it here
// gives the orchestrator a precise, immediate signal — the 90 s inactivity
// watchdog is the fallback for subagents that go silent without an explicit
// error event.
//
// Idempotency: the same subagent may receive `session.error` AND a later
// `session.idle`, and the watchdog sweep could run in between. We latch
// `entry.errored = true` FIRST, then onSessionIdle and sweepWatchdog both
// early-return on that flag (just like they do for `timedOut`/`aborted`).
//
// Scope guard: `session.error` may fire for sessions we do not track (e.g.
// the orchestrator's own primary, or any user session). If `entryForSession`
// returns nothing, this is not a subagent we spawned — log and return without
// touching it.
//
// Best-effort: every step is wrapped in try/catch and we never throw out of
// the event handler, so a failure here cannot poison the rest of the event
// stream.
async function onSessionError(props, client) {
  const sessionID = props?.sessionID
  if (!sessionID) {
    // type-level: sessionID is optional. Nothing to attribute the failure to.
    log("session.error with no sessionID — ignored")
    return
  }
  const entry = entryForSession(sessionID)
  if (!entry) {
    // Not one of our subagents. Don't touch it.
    return
  }
  if (entry.timedOut || entry.errored || aborted.has(sessionID)) {
    // Already being handled by another path (watchdog or a prior error event).
    return
  }
  // Latch FIRST so onSessionIdle / sweepWatchdog skip this entry even if
  // they race us between here and the postNotice below.
  entry.errored = true
  const errText = extractErrorMessage(props?.error)
  // A user-initiated abort (TUI ✕ or session.abort) surfaces here as a
  // MessageAbortedError, not a real failure. Phrase the notice accordingly so
  // the orchestrator does not report a bug to the user for a deliberate stop.
  const wasAborted = errorName(props?.error) === "MessageAbortedError"
  log("subagent llm error", {
    handle: entry.handle,
    sessionID,
    error: errText,
    aborted: wasAborted,
  })
  // Wake the parent with the error notice, then free the slot — same teardown
  // as onSessionIdle / the watchdog. markAborted keeps the tool-guard hard-
  // denying in-flight tool calls throughout removeEntry + deleteSession
  // (mirrors the watchdog path); see teardownSubagent.
  await teardownSubagent(client, entry, {
    notice: errorNotice(entry, errText, wasAborted),
    toast: {
      title: "agent-intercom",
      message: wasAborted ? `${entry.handle} aborted` : `${entry.handle} failed`,
      variant: wasAborted ? "warning" : "error",
    },
    markAborted: true,
    label: "session.error",
  })
}

// Extracts a human-readable message from the `error` payload of a
// `session.error` event. The payload is one of:
//   ProviderAuthError        — { name: "ProviderAuthError", data: { providerID, message } }
//   UnknownError             — { name: "UnknownError", data: { message } }
//   MessageOutputLengthError — { name: "MessageOutputLengthError", data: { … } }
//   MessageAbortedError      — { name: "MessageAbortedError", data: { message } }
//   ApiError                 — { name: "APIError", data: { message, statusCode?, isRetryable, … } }
// All of them have a `name` field that names the kind, and most have a
// `data.message`. We compose `<name>: <data.message>` when both exist, fall
// back to just one of them when only one is present, and return "unknown
// error" if the payload is missing or empty. Defensive against every field
// being undefined — opencode has been known to ship `error: undefined`.
function extractErrorMessage(error) {
  if (!error || typeof error !== "object") return "unknown error"
  const name = typeof error.name === "string" && error.name ? error.name : null
  const dataMsg =
    error.data && typeof error.data === "object" && typeof error.data.message === "string"
      ? error.data.message
      : null
  // MessageAbortedError carries no `message` field; surface the kind so the
  // orchestrator at least sees "MessageAbortedError" rather than "unknown".
  if (name && dataMsg) return `${name}: ${dataMsg}`
  if (name) return name
  if (dataMsg) return dataMsg
  return "unknown error"
}

// The `name` field of a session.error payload, if present. Used to distinguish
// a user-initiated abort (MessageAbortedError) from a genuine failure.
function errorName(error) {
  return error && typeof error === "object" && typeof error.name === "string" ? error.name : null
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
export function createGuardToolExecute(client, permissionGuard) {
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
      // Defense in depth: re-check the per-agent `permission.<tool> = "deny"`
      // map at runtime, even though agents.js strips denied tools from the
      // LLM schema. If the schema strip is bypassed (project override, MCP
      // plugin re-adding a tool, future opencode change to how tools merge),
      // this still hard-denies. `permission.task` is intentionally NOT
      // consulted here — it is an allowlist handled by spawn's
      // checkTaskPermission, and its bare-string `"deny"` form is the signal
      // we use to HIDE opencode's blocking native `task` tool from the LLM
      // (see config.js).
      if (permissionGuard) {
        const reason = await permissionGuard.checkToolPermission(entry.agent, input.tool)
        if (reason) {
          log("denied tool call: per-agent permission deny", {
            sessionID,
            agent: entry.agent,
            tool: input.tool,
            reason,
          })
          throw new Error(`agent-intercom: ${reason}. This tool is in the agent's deny map.`)
        }
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
    // intercom tools (spawn/abort/list); everything else it must delegate.
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
    // denied. Any other tool call (spawn/abort) resets the streak.
    if (input.tool === "list" && lastPrimaryTool.get(sessionID) === "list") {
      log("denied back-to-back list from primary", { sessionID })
      throw new Error(
        "agent-intercom: don't call `list` twice in a row. End your turn — you will be woken.",
      )
    }
    lastPrimaryTool.set(sessionID, input.tool)
  }
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
