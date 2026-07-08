// opencode lifecycle hooks: system-prompt injection, session events, and the
// tool-call guard (aborted-subagent hard-deny + native-`task` enforcement).

import { aborted, registry, lastPrimaryTool } from "./state.js"
import {
  entryForSession,
  upsertSession,
  isPrimary,
  effectiveState,
  removeEntry,
  removeEntryLocked,
  countActiveSubagents,
  registryMutex,
  shouldRefreshPrimary,
  recordPrimaryContext,
  shouldTriggerPrimaryHandoff,
  inFlightSubagentsFor,
  reparentSubagents,
  forgetPrimary,
} from "./registry.js"
import { fetchSnapshot, postNotice, showToast, deleteSession, forgetSessionDirectory, getSessionDirectory, abortSession, createChildSession, promptSession } from "./client.js"
import { getSettings } from "./settings.js"
import { removeTask, todoFilePath } from "./todofile.js"
import { projectMdBlock, readPlannedSteps, formatPrimarySummary, writePrimarySummary } from "./project.js"
import { performPrimaryHandoff, lastUserGoal } from "./handoff.js"
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

// Re-entrancy guard for the orchestrator handoff. The transform hook fires on
// every primary turn; without this, multiple turns in a row would each kick
// off a fresh handoff before the first one finished (each handoff does
// deleteSession on the old primary, so re-entry would race on the same id).
// Cleared by the .catch handler (retry on failure) AND inside forgetPrimary
// once orchestrator1 has been replaced by orchestrator2.
const handoffInProgress = new Set()

// Orchestrator agent name passed to the new session in the handoff. The
// README + package.json declare "orchestrator" as the default primary agent;
// FLAGGED: a project that overrides `default_agent` in opencode.json will not
// be honored here — runtime verification required.
const ORCHESTRATOR_AGENT_NAME = "orchestrator"

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
        // Primary (non-subagent) turn. Measurement only — record the current
        // context-token count, TTL-guarded via shouldRefreshPrimary. No
        // threshold check, no handoff trigger; that's a later slice.
        if (shouldRefreshPrimary(sessionID)) {
          const snap = await fetchSnapshot(client, sessionID)
          recordPrimaryContext(sessionID, snap?.ctxTokens)
        }
        // Slice 6b-ii-b: trigger an orchestrator→orchestrator handoff when
        // the recorded context exceeds maxPrimaryContext. Fire-and-forget: the
        // transform hook MUST return normally (opencode awaits it before
        // injecting the system prompt), so the handoff runs in a detached
        // promise. The `handoffInProgress` set guards against re-entry while
        // a handoff is in flight — it is cleared both by the .catch handler
        // (so a failed handoff can retry on a later turn) and by the
        // forgetPrimary wrapper (which fires once orchestrator1 has been
        // successfully replaced by orchestrator2).
        const { maxPrimaryContext } = getSettings()
        if (
          shouldTriggerPrimaryHandoff(sessionID, maxPrimaryContext) &&
          !handoffInProgress.has(sessionID)
        ) {
          handoffInProgress.add(sessionID)
          showToast(client, {
            title: "agent-intercom",
            message: "primary context limit reached — handing off to a fresh orchestrator",
          })
          const handoffDeps = {
            primarySessionID: sessionID,
            directory: sessionDir,
            orchestratorAgentName: ORCHESTRATOR_AGENT_NAME,
            getInFlightSubagents: inFlightSubagentsFor,
            getPlannedSteps: readPlannedSteps,
            getLastUserGoal: () => lastUserGoal(input.messages),
            formatPrimarySummary,
            writePrimarySummary,
            // handoff.js calls `createSession({ agent })`; client.js exposes
            // `createChildSession(client, { parentID, title, directory })`.
            // We bridge the two shapes here. CRITICAL: parentID is OMITTED
            // on purpose so orchestrator2 is created as a ROOT/independent
            // session in opencode — NOT a child of orchestrator1. If we
            // passed parentID=sessionID, opencode would treat orchestrator2
            // as a child and the subsequent deleteSession(orchestrator1)
            // would CASCADE-DELETE orchestrator2 along with it, destroying
            // the very session the handoff just created. The SDK's
            // SessionCreateData declares parentID as optional (types.gen.d.ts
            // SessionCreateData.body.parentID?: string), so omitting it gives
            // us a root session — exactly what we want for a true handoff.
            // Subagent reparenting (below) uses the PLUGIN's own registry
            // parentID field and is unrelated to opencode's session tree.
            createSession: ({ agent }) =>
              createChildSession(client, {
                title: `orchestrator#2 (handoff from ${sessionID})`,
                directory: sessionDir,
              }),
            // handoff.js calls `promptAsync(sessionID, message)`; client.js
            // exposes `promptSession(client, { sessionID, agent, prompt })`.
            // We bridge: the kickoff message must set `agent` so opencode
            // routes the first turn to the orchestrator role for the new
            // (otherwise empty) session.
            promptAsync: (sid, message) =>
              promptSession(client, {
                sessionID: sid,
                agent: ORCHESTRATOR_AGENT_NAME,
                prompt: message,
              }),
            deleteSession: (sid) => deleteSession(client, sid),
            reparent: reparentSubagents,
            forgetPrimary: (sid) => {
              forgetPrimary(sid)
              handoffInProgress.delete(sid)
            },
          }
          void performPrimaryHandoff(handoffDeps)
            .then(({ newSessionID, reparented }) => {
              showToast(client, {
                title: "agent-intercom",
                message: `handoff complete — new session ${newSessionID}, ${reparented} subagent(s) reparented`,
              })
            })
            .catch((err) => {
              log("primary handoff failed", errMsg(err))
              handoffInProgress.delete(sessionID) // allow retry on a later turn
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

// A compact, live list of ALL active subagents across every primary in this
// opencode process — the subagent cap is global, so the orchestrator needs to
// see subagents spawned by other primaries too (those still consume the shared
// slot budget). Injected into the primary's system prompt so it always knows
// what is running. Fed from the module-level registry, kept fresh by the
// `event` hook (status/idle). Aborted subagents are filtered out; finished
// subagents are not in the registry at all (event hook removes them on idle).
// Returns the empty string when nothing is active.
function formatSubagentSnapshot(primaryID) {
  const mine = [...registry.values()].filter((e) => effectiveState(e) !== "aborted")
  if (mine.length === 0) return ""
  const rows = mine.map((e) => {
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
  }
  const ok = await deleteSession(client, sessionID)
  if (ok) log("deleted opencode session", { handle, sessionID })
  forgetSessionDirectory(sessionID)
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
  log("subagent llm error", {
    handle: entry.handle,
    sessionID,
    error: errText,
  })
  // Mark aborted so the tool-guard denies any in-flight tool calls that
  // race the cleanup (mirrors the watchdog path).
  aborted.add(sessionID)
  // Wake the parent with the error notice. Best-effort — a failed notice
  // must not stop us from freeing the slot.
  try {
    await postNotice(client, entry.parentID, errorNotice(entry, errText))
    showToast(client, {
      title: "agent-intercom",
      message: `${entry.handle} failed`,
      variant: "error",
    })
  } catch (err) {
    log("session.error: postNotice failed", { handle: entry.handle, err: errMsg(err) })
  }
  // Free the slot. Same cleanup as onSessionIdle / the watchdog, so the
  // global cap drops by one and the opencode session goes away.
  if (await removeEntry(sessionID)) {
    log("removed errored subagent", { handle: entry.handle, sessionID })
  }
  try {
    const ok = await deleteSession(client, sessionID)
    if (ok) log("deleted opencode session (errored)", { handle: entry.handle, sessionID })
  } catch (err) {
    log("session.error: deleteSession failed", { handle: entry.handle, sessionID, err: errMsg(err) })
  }
  forgetSessionDirectory(sessionID)
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
        "`DONE: <id>`. The task was NOT auto-removed. Delegate verification and TODO.md cleanup " +
        "to a planner/coder."
      )
    case "mismatch":
      return (
        `\n⚠️ TODO.md: subagent reported \`${outcome.got}\` but was spawned for \`${outcome.expected}\`. ` +
        `Marker IGNORED (possible hallucination). Delegate verification and TODO.md cleanup to a planner/coder.`
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
// already counted out. The cap is GLOBAL — the count includes subagents from
// every primary in this process.
function slotsNoticeAfterFinish(primaryID) {
  const maxSubagents = getSettings().maxSubagents
  if (maxSubagents <= 0) return ""
  const active = countActiveSubagents(primaryID)
  const free = Math.max(0, maxSubagents - active)
  return `\nSubagent slots: ${active}/${maxSubagents} (global, across all sessions) — ${free} free.`
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

// ---- Inactivity watchdog (dead-man's switch) ---------------------------------
//
// What this guards against: an LLM call inside a subagent that hangs forever
// (server timeout, network partition, model that never streams a token). No
// `session.idle` event ever fires, so the normal wake-on-finish path never
// runs, and the registry entry + global slot stay occupied for the life of
// the opencode process. The orchestrator also never gets woken, so it sits
// idle waiting for a result that will never arrive.
//
// The fix is a periodic sweep over the registry: any entry whose `lastActivityAt`
// is older than `maxSubagentAgeMs` is treated as hung, aborted cooperatively,
// and its slot is freed. The orchestrator is woken with a timeout notice so it
// can re-dispatch.
//
// Important: the threshold is INACTIVITY (time since the last event), not
// total lifetime. A long-running subagent that keeps emitting events is
// healthy — its `lastActivityAt` gets bumped on every event by `handleEvent`
// above, so it never trips. Only a subagent that produces ZERO events for
// `maxSubagentAgeMs` (default 90 s) gets killed.

// How often the sweep runs. 5 s is a good balance: cheap (just a Map scan
// over a handful of entries) and timely enough that the worst-case extra
// hang over the configured threshold is 5 s. The sweep is asynchronous, but
// the work per tick is small (a Map scan + maybe one abort call) so it
// doesn't need to be unref'd.
const WATCHDOG_INTERVAL_MS = 5000

// Module-level: the interval handle + the flag that ensures we only arm the
// timer once per process. createEventHandler may be invoked more than once
// across plugin reloads within the same opencode process — restarting the
// timer on every call would leak intervals.
let watchdogInterval = null
let watchdogClient = null

export function ensureWatchdogStarted(client) {
  if (watchdogInterval) {
    // Already running; keep the freshest client so future sweeps use it.
    watchdogClient = client
    return
  }
  watchdogClient = client
  const handle = setInterval(() => {
    void sweepWatchdog()
  }, WATCHDOG_INTERVAL_MS)
  // Don't pin the opencode event loop on this interval: the watchdog only
  // matters while subagents (and therefore the plugin) are alive. If
  // opencode tears the plugin factory down for a clean shutdown, the interval
  // goes with it. (setInterval is the kind of handle that would otherwise
  // keep node alive indefinitely — see node's "active handles" semantics.)
  if (typeof handle.unref === "function") handle.unref()
  watchdogInterval = handle
  log("watchdog started", { intervalMs: WATCHDOG_INTERVAL_MS })
}

// Sweeps the registry once and times out any subagent whose last event is
// older than the configured inactivity window. Best-effort: a single failed
// abort on one entry doesn't stop the others from being checked.
export async function sweepWatchdog() {
  const maxAge = getSettings().maxSubagentAgeMs
  if (maxAge <= 0) return // watchdog disabled
  const now = Date.now()
  // Snapshot the entries first — we mutate the registry (removeEntry) below,
  // so iterating the live Map would skip or revisit entries.
  const entries = [...registry.values()]
  for (const entry of entries) {
    if (entry.timedOut) continue
    if (entry.errored) continue
    if (aborted.has(entry.sessionID)) continue
    // session.idle fires just before the entry is removed; if a stray idle
    // sneaks through the gap, `entry.status === "idle"` covers it.
    if (entry.status === "idle") continue
    const last = entry.lastActivityAt ?? entry.spawnedAt
    if (now - last <= maxAge) continue

    // Latch FIRST so any racing event handler / onSessionIdle skips this entry.
    entry.timedOut = true
    await timeoutSubagent(entry, maxAge, now - last)
  }
}

// Performs the actual timeout for one entry: abort the opencode session,
// post a wake notice to the parent, and free the slot by running the same
// cleanup path as onSessionIdle (removeEntry + deleteSession +
// forgetSessionDirectory). Best-effort; failures are logged, never thrown.
export async function timeoutSubagent(entry, maxAgeMs, silentMs) {
  const sessionID = entry.sessionID
  const handle = entry.handle
  const agent = entry.agent
  const parentID = entry.parentID
  log("subagent timed out (inactivity)", {
    handle,
    sessionID,
    agent,
    silentMs,
    maxAgeMs,
  })

  // 1. Cooperative abort (best-effort, mirrors signalAbort in tools.js).
  try {
    await abortSession(watchdogClient, sessionID)
  } catch (err) {
    log("watchdog: abort failed", { handle, sessionID, err: errMsg(err) })
  }
  // Mark aborted so the guardToolExecute hook denies any in-flight tool
  // calls that race the abort signal. removeEntry will drop this set entry
  // below; ordering matters only for the tool-guard window.
  aborted.add(sessionID)

  // 2. Wake the parent with a timeout notice (mirrors postNotice in onSessionIdle).
  if (parentID && watchdogClient) {
    try {
      await postNotice(
        watchdogClient,
        parentID,
        timeoutNotice(entry, maxAgeMs, silentMs),
      )
    } catch (err) {
      log("watchdog: postNotice failed", { handle, parentID, err: errMsg(err) })
    }
  }

  // 3. Free the slot: same cleanup as onSessionIdle, so the global cap drops
  //    by one. Best-effort — a missing entry means another path already
  //    cleaned it up, which is fine.
  if (await removeEntry(sessionID)) {
    log("watchdog: removed timed-out subagent", { handle, sessionID })
  }
  try {
    const ok = await deleteSession(watchdogClient, sessionID)
    if (ok) log("watchdog: deleted opencode session", { handle, sessionID })
  } catch (err) {
    log("watchdog: deleteSession failed", { handle, sessionID, err: errMsg(err) })
  }
  forgetSessionDirectory(sessionID)
}

// Wake-notice sent to the parent when the watchdog times out a subagent.
// Sibling of completionNotice — keeps the same emoji + phrasing vocabulary so
// the orchestrator's pattern-matching notices stay consistent.
export function timeoutNotice(entry, maxAgeMs, silentMs) {
  const silentSec = Math.round(silentMs / 1000)
  const maxSec = Math.round(maxAgeMs / 1000)
  return (
    `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) ` +
    `timed out after ${silentSec}s of inactivity (limit ${maxSec}s) — slot freed. ` +
    `You may re-dispatch with spawn() if the work is still needed.`
  )
}

// Wake-notice sent to the parent when a subagent's LLM call failed (caught
// via `session.error`). Sibling of completionNotice / timeoutNotice — same
// emoji + phrasing vocabulary so the orchestrator's pattern-matching notices
// stay consistent. We append a `slots` line via slotsNoticeAfterFinish so the
// freed slot is visible to the orchestrator, matching the completion path.
function errorNotice(entry, message) {
  return (
    `🔔 agent-intercom: subagent "${entry.handle}" (${entry.agent}, session ${entry.sessionID}) ` +
    `failed: ${message}. Slot freed. ` +
    `You may re-dispatch with spawn() if the work is still needed.` +
    slotsNoticeAfterFinish(entry.parentID)
  )
}

// Test-only: stop the watchdog interval so unit tests don't leak timers.
export function _stopWatchdogForTests() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval)
    watchdogInterval = null
    watchdogClient = null
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
