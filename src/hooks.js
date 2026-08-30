// opencode lifecycle hooks: system-prompt injection, session events, and the
// tool-call guard (aborted-subagent hard-deny + native-`task` enforcement).
//
// The notice builders live in notices.js, the shared subagent teardown +
// parent-notice delivery in teardown.js, the inactivity watchdog in
// watchdog.js, and the primary-handoff wiring in handoffwiring.js — this file
// keeps the four hook factories (system transform / messages transform /
// event / guard) plus their close helpers.
//
// Provider-side prompt caching bounds what the split between the two transform
// hooks buys. Providers match a cached prefix by exact content in the order
// tools → system → messages, so a byte that differs anywhere in the system
// prompt re-processes the tool definitions and the system prompt with it, and
// every later breakpoint — including the ones on the trailing messages — misses
// too. That is why every block whose text moves from turn to turn is delivered
// by the messages hook and the system prompt carries stable text only.
//
// The lifetime of the entry is five minutes: opencode writes
// `cacheControl: { type: "ephemeral" }` with no `ttl` field, which is
// Anthropic's default, measured from the request that writes or reads the
// entry and refreshed by each read. So a stable prefix produces a hit only
// between turns closer together than that. An orchestrator that spawns a
// subagent, ends its turn and is woken minutes later starts cold whatever this
// file does; the gain is in back-to-back turns and in the steps of one tool
// loop. The one-hour TTL that would cover the longer wait is priced per write
// and is not set here.
//
// The xAI path gets no marker from opencode at all — its provider map has no
// `xai` key — because xAI caching is automatic and matches on the leading
// message prefix. Prefix stability is the only lever that path has, and it is
// the same lever.

import { aborted, registry, lastPrimaryTool } from "./state.js"
import {
  entryForSession,
  upsertSession,
  isPrimary,
  effectiveState,
  removeEntryLocked,
  reservePendingDelivery,
  releasePendingDelivery,
  registryMutex,
  shouldRefreshPrimary,
  recordPrimaryContext,
  primaryContextTokens,
  scheduleHandoffIfNeeded,
  scheduleEndlessIfNeeded,
  cancelPendingEndless,
  cancelPendingHandoff,
  resetEndlessProgress,
  nestedQuotaDecision,
  sessionAgentName,
  rememberPrimaryDirectory,
  primaryDirectoryOf,
  CTX_TTL_MS,
} from "./registry.js"
import { fetchSnapshot, showToast, getSessionDirectory } from "./client.js"
import {
  getSettings,
  primaryContextThreshold,
  contextBudgetFor,
  PACKAGE_WARN_SHARE,
  PACKAGE_REFUSE_SHARE,
} from "./settings.js"
import { NESTED_SPAWN_TARGET, SPAWNABLE_ROLES, mayDelegate, defaultAgentName } from "./agents.js"
import { overrideBlock, overrideToastText } from "./overrides.js"
import { removeTask, TodoFileMissingError } from "./todofile.js"
import { projectMdBlock, projectContext } from "./project.js"
import { log, errMsg } from "./log.js"
import { ABORT_NOTICE, guideBlocks } from "./prompts.js"
import {
  loadCustomPrompt,
  applyCustomPrompt,
  scanPromptFiles,
  rescanPromptFiles,
} from "./promptsfile.js"
import { tokens as fmtTokens, ageSeconds, estimateTokens, percent } from "./format.js"
import { postParentNotice, teardownSubagent, signalSessionIdle } from "./teardown.js"
import { settleChildWaiter, hasLiveChildren } from "./childwait.js"
import { completionNotice, errorNotice, denialLoopNotice } from "./notices.js"
import { ensureWatchdogStarted } from "./watchdog.js"
import { maybeRunPendingHandoff, maybeRunPendingEndless } from "./handoffwiring.js"

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
export const TODO_AGENTS = new Set([
  "planner", "coder", "debugger", "reviewer", "documenter", "designer",
])

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
// whether the agent needs it. The layout is two elements:
//
//   [0] <role prompt — preserved from opencode>
//       <AGENTS.md project state — only for agents that benefit from it>
//       <plugin guide — prompts.js guideBlocks() for this role>
//       <PROJECT.md block>
//       <limits — the orchestrator's, or the reduced block for a delegating
//                 subagent>
//       <override findings — primary only>
//   [1] <env — cwd / worktree / platform / date / git flag>
//
// Both elements carry a cache breakpoint: opencode marks the first two system
// messages, and one array element becomes one system message. `env` stands on
// its own because it is the only block here that can change by itself — a
// calendar-day rollover, a cwd or worktree change — and as its own element
// those events cost the ~80 tokens of `env` instead of invalidating the whole
// stable mass in element [0].
//
// Nothing in either element varies from turn to turn, on either branch. What
// moves inside a session is delivered by transformMessages on the last user
// message instead: the primary's active-subagent snapshot, the subagent's
// over-budget STOP notice, the abort notice, and a delegating subagent's
// remaining nested-spawn quota — the one figure that counts down as the run
// spends it. Both branches are pinned as such in
// test/system-prompt-stability.test.js.
//
// The blocks that stay here move only where a person moves them: a settings
// edit, a PROJECT.md or AGENTS.md edit, a prompt file appearing or changing.
// The PROJECT.md block and the limits block are read under the latched
// `primaryScope` (`scopeDir` below) and not under this turn's directory
// lookup, so a failed `session.get` cannot move them either.
//
// We keep opencode's `<env>` block intact since it's small and useful; we drop
// the "You are powered by the model named …" line (zero signal) and
// conditionally drop the AGENTS.md inject.
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

      // Resolve the session's directory so we can inject the project-spec block.
      // Subagents already have it on their registry entry (captured at spawn);
      // primaries are looked up via the session API (cached per session).
      const sessionDir = isSubagent
        ? entry.directory
        : await getSessionDirectory(client, sessionID)

      // The project a PRIMARY belongs to, held for the whole session (see
      // registry.rememberPrimaryDirectory). Everything keyed by project reads
      // this and not `sessionDir` directly, so one failed `session.get` cannot
      // move the scope — and with it the stable system-prompt element — for a
      // turn: the override block selects its findings by it, the prompt-file
      // scan runs under it, and the last rung of the agent chain answers with
      // THIS project's `default_agent`. Null for a subagent (its findings ride
      // the primary's block) and while no turn has ever resolved a directory.
      const primaryScope = isSubagent ? null : rememberPrimaryDirectory(sessionID, sessionDir)

      // The directory every project-derived block of the STABLE element is read
      // under. For a primary that is the latched scope, not this turn's lookup:
      // `getSessionDirectory` caches successes only and answers undefined when
      // `session.get` fails, so reading the raw lookup would collapse the
      // PROJECT.md block to "" and the limits block's fixed-overhead figures to
      // their no-PROJECT.md values for that one turn, and restore them on the
      // next — two invalidations of element [0] for an error the user never
      // sees. For a subagent it is the entry's own directory, captured at spawn
      // and never re-looked-up.
      const scopeDir = primaryScope ?? sessionDir

      const agentName = isSubagent ? entry.agent : resolvePrimaryAgent(sessionID, output, primaryScope)

      // Decide whether this agent gets AGENTS.md
      const keepAgentsMd = isSubagent
        ? AGENTS_MD_SUBAGENTS.has(agentName)
        : true // primaries (orchestrator) always keep AGENTS.md

      // Parse opencode's combined system into the three slices we care about.
      const slices = parseOpencodeSystem(output.system)

      // Build the runtime parts once — both the auto-assembled path and the
      // custom-template path need them. Only blocks that hold their text
      // across the turns of a session belong here; `limits` qualifies because
      // it re-reads the settings file, whose content moves on a user edit and
      // not otherwise.
      const projectMd = projectMdBlock(scopeDir) || ""
      // Whether THIS subagent gets the delegation guide and the reduced limits
      // block that goes with it.
      const delegates = isSubagent && delegatesNested(entry.agent)
      let limits = ""
      if (!isSubagent) {
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
        //
        // Which threshold is armed is resolved in ONE place —
        // primaryContextThreshold(): while endless mode is on, endlessContext
        // DISPLACES maxPrimaryContext. Arming both would be inert, the lower
        // one always firing first.
        const threshold = primaryContextThreshold()
        if (getSettings().endlessMode) {
          // The switch was turned on between the mark and this turn: drop an
          // unclaimed PLAIN-handoff latch, the mirror of the off-branch below.
          // Both latches live at once otherwise — the primary crossed
          // maxPrimaryContext with the mode off and endlessContext with it on —
          // and the idle handler fires both executors on the same primary.
          cancelPendingHandoff(sessionID)
          if (scheduleEndlessIfNeeded(sessionID, threshold)) {
            log("endless: scheduled", { sessionID, ctx: primaryContextTokens(sessionID), threshold })
            showToast(client, {
              title: "agent-intercom",
              message:
                "endless mode: context ceiling reached — open points are saved and the " +
                "orchestrator is replaced at the end of this turn",
            })
          }
        } else {
          // The switch was turned off between the mark and this turn: drop a
          // latch that has not been claimed yet, so the freeze lifts and the
          // plain handoff owns the threshold again. A cycle already executing
          // is not touched — it has written to the todo file and must not
          // leave the primary half-replaced.
          cancelPendingEndless(sessionID)
          // The cross-cycle progress record belongs to a run of the mode, not
          // to the process: with the mode off it has nothing to measure, and
          // carrying its streak into the next arming would spend the user's
          // re-arm on a single cycle before the no-progress bound — the very
          // bound that switched the mode off — fired again.
          resetEndlessProgress()
          if (scheduleHandoffIfNeeded(sessionID, threshold)) {
            log("primary handoff scheduled (idle-gated)", { sessionID })
            showToast(client, {
              title: "agent-intercom",
              message:
                "primary context limit reached — orchestrator handoff scheduled for the end of this turn",
            })
          }
        }
        limits = formatLimitsNotice({
          sessionDir: scopeDir,
          projectMd,
          agentsMd: slices.agentsMd || "",
        })
      } else if (delegates) {
        // A delegating subagent gets its own, much smaller block: it has to
        // size a researcher package and it has never seen the orchestrator's.
        // The quota figure is not in it — that one counts down inside the run
        // and rides on the last user message (nestedQuotaNotice).
        limits = formatDelegationLimitsNotice(entry.agent, {
          projectMd,
          agentsMd: slices.agentsMd || "",
          snapshot: projectContext(scopeDir),
        })
      }

      // The plugin's own guide blocks for this role. One value for both paths:
      // the auto-assembled prompt pushes it, and a user's prompt file gets it
      // under `{{guide}}` — a file that carries the token therefore holds the
      // CURRENT contract instead of the wording it was rendered from, which is
      // what keeps a freshly written file from going stale.
      const guide = guideBlocks({
        primary: !isSubagent,
        agent: agentName,
        delegates,
      })

      // Detector B (overrides.js): the prompt files this project has on disk,
      // judged against the current contract. Eager and once per directory —
      // `scanPromptFiles` holds the claim — so the finding set is complete
      // before the block below is rendered for the first time, and so no fs
      // work lands on the per-request path. Every later judgement of these files
      // happens off this path, on the primary's idle
      // (`rescanPromptFilesForPrimary`).
      if (primaryScope) scanPromptFiles(primaryScope)

      // Outlets two and three of the override report (overrides.js): a toast
      // once per process and a block in the primary's system prompt naming
      // every finding and telling the orchestrator to pass it on. Report only —
      // nothing here refuses anything.
      //
      // Primary only. A subagent cannot reach the user. Select findings by the
      // primary's project directory so a process serving multiple projects
      // cannot put another project's file path in this block. The scan above
      // records under the same key the block selects by, and detector A files
      // its findings under the instance directory opencode also writes into
      // `session.directory` — one key on both sides of the report.
      //
      // With no scope at all — no turn of this session has resolved a directory
      // yet — nothing is rendered and nothing is toasted. There is no project to
      // report on, and a block selected under a null scope would show findings
      // that carry no directory to a session that has one.
      //
      // The block belongs in the STABLE element (and to the custom path, after
      // the template): its text depends on the selected finding set alone, so it
      // holds its bytes for exactly as long as that set does and costs no
      // breakpoint per turn. Nothing writes that set under a turn already in
      // flight: the eager scan runs just above, before this call reads it, and
      // every later judgement runs on the primary's idle. So the block cannot
      // move inside a turn, and between two turns it moves only where the user
      // changed a file.
      //
      // The toast is fired from the same place so a user with a TUI
      // attached sees it at once instead of only in the next answer; showToast
      // is best-effort and a `serve` instance without a TUI drops it.
      let overrideNotice = ""
      if (primaryScope) {
        overrideNotice = overrideBlock(primaryScope)
        if (overrideNotice) {
          const toast = overrideToastText(primaryScope)
          if (toast) {
            showToast(client, { title: "agent-intercom", message: toast, variant: "warning" })
          }
        }
      }

      // User-editable per-agent template: `<scopeDir>/.opencode/agent-intercom/<agent>.md`.
      // `scopeDir` is the primary's latched project scope or the subagent's
      // captured directory, so prompt loading uses the same scope as scanning.
      // When present, it REPLACES the auto-assembled prompt wholesale, with
      // `{{placeholder}}` tokens for the runtime parts the user chose to keep.
      // Caches by mtime so the per-turn cost is one stat() call.
      //
      // `snapshot`, `context_budget` and `abort_notice` are retired tokens: the
      // blocks they named are delivered by transformMessages and are not
      // template-controlled. They keep substituting to the empty string so an
      // already-written file degrades to the current behaviour instead of
      // showing the model a literal `{{snapshot}}` — substitutePrompt leaves an
      // unknown key in place by design.
      //
      // The user's template owns the whole layout, so this path emits ONE
      // element: `{{env}}` sits wherever the file puts it and cannot be split
      // off into its own system message.
      const customTemplate = scopeDir ? loadCustomPrompt(scopeDir, agentName) : null
      if (customTemplate) {
        const result = applyCustomPrompt(customTemplate, {
          env: slices.env || "",
          agents_md: keepAgentsMd ? slices.agentsMd || "" : "",
          project_md: projectMd,
          guide,
          limits,
          snapshot: "",
          context_budget: "",
          abort_notice: "",
        })
        output.system.length = 0
        // The template owns the layout, so the block goes AFTER it rather than
        // into it: a warning that a project file displaced this plugin's role —
        // or that the template itself is stale — cannot be inside the very file
        // it warns about.
        output.system.push(result + overrideNotice)
        return
      }

      // No custom file → auto-assemble as before.
      const guideParts = []
      if (isSubagent) {
        if (!aborted.has(sessionID)) {
          guideParts.push(guide)
          if (projectMd) guideParts.push(projectMd)
          // Last, because the delegation block above points at it for the
          // researcher's budget. Empty unless `delegates`.
          if (limits) guideParts.push(limits)
        }
      } else {
        guideParts.push(guide)
        if (projectMd) guideParts.push(projectMd)
        guideParts.push(limits)
        guideParts.push(overrideNotice)
      }

      const stable =
        slices.role +
        (keepAgentsMd ? slices.agentsMd : "") +
        guideParts.join("")
      // Mutate the array opencode handed us. It keeps its own reference to it
      // and never reads a property back off the output object, so assigning
      // `output.system = [...]` would be a silent no-op.
      output.system.length = 0
      output.system.push(stable)
      // Second element only when there is one to make: parseOpencodeSystem
      // returns an empty `env` whenever opencode's markers are absent, and an
      // empty system message is worth nothing to either the model or the cache.
      if (slices.env) output.system.push(slices.env)
    } catch (err) {
      log("transform error", errMsg(err))
      // never break the session
    }
  }
}

// Rendered active-subagent snapshot per primary session, keyed by the id of
// the user message it hangs off. One entry per primary; the id changes with
// every new user turn and the stale text is overwritten with it.
const snapshotByTurn = new Map()

// Test seam: the map is process-wide state that outlives a single session.
export function resetTurnNotices() {
  snapshotByTurn.clear()
}

// The snapshot for one user turn of a primary, rendered once and reused for
// every step of that turn's tool loop.
//
// Re-rendering per step would be wrong twice over. The block hangs off the LAST
// USER message, which in a multi-step loop already has assistant and tool
// messages behind it — moving its text moves the prefix of the loop's own
// history, so every step would re-read what the step before it just wrote.
// And `ageSeconds(e.spawnedAt)` moves every second, so it would move on
// essentially every step. The orchestrator reads the figure to decide whether
// to spawn or abort, which it does once per turn, so a per-turn value is also
// the right resolution.
function snapshotForTurn(primaryID, userMessageID) {
  const cached = snapshotByTurn.get(primaryID)
  if (cached && cached.messageID === userMessageID) return cached.text
  const text = formatSubagentSnapshot(primaryID) || ""
  snapshotByTurn.set(primaryID, { messageID: userMessageID, text })
  return text
}

// Marks the text part this plugin pushes, so a second pass over the same array
// replaces its own part instead of appending a duplicate.
const TURN_NOTICE_SUFFIX = "-agent-intercom-turn"

// Delivers the blocks whose text moves from turn to turn: the abort notice, the
// primary's active-subagent snapshot, the subagent's over-budget STOP notice
// and a delegating subagent's remaining nested-spawn quota. They ride on the
// LAST USER message as a synthetic text part — the
// same mechanism opencode uses for its own per-turn reminders — rather than in
// the system prompt, so that the cached prefix (tool definitions plus system
// prompt) stays byte-identical across the turns of a session.
//
// The cost is deliberate and is the cheapest one available: the breakpoint on
// the trailing messages misses, while everything ahead of it — tools, system
// prompt and all prior history — still matches.
//
// The array is the per-request copy opencode transforms and never writes back,
// so the push is in memory only and nothing is persisted to the session.
//
// The hook's `input` is empty, so the session is read off the message itself,
// the same field opencode's own reminder code reads.
export function createTransformMessages(client) {
  return async function transformMessages(messages) {
    if (!Array.isArray(messages)) return
    const userMessage = messages.findLast((m) => m?.info?.role === "user")
    if (!userMessage || !Array.isArray(userMessage.parts)) return
    const sessionID = userMessage.info.sessionID
    if (!sessionID) return

    const entry = entryForSession(sessionID)
    // The over-budget notice is NOT memoised per turn, unlike the snapshot: it
    // counts the LLM turns on which the subagent has seen the stop sign, and a
    // subagent is one-shot — it lives its whole life under a single user
    // message. Keyed on that id the counter would stand still at 1 and the
    // one-shot parent notice at BUDGET_NOTIFY_AFTER would never fire. Its
    // escalation is the point of the block, and the session it belongs to is
    // one to three turns from ending, so the prefix it moves is short.
    //
    // The quota line is not memoised either, for the plainer reason that it is
    // the figure that moves: it counts down as the run spends its quota, and a
    // value held per user message would stand still for the subagent's whole
    // life. An ABORTED subagent is told to stop and call no further tool, so it
    // is not handed a spawn allowance on the way out — the same gate
    // contextLimitNotice applies to itself.
    let volatile
    if (entry) {
      volatile = await contextLimitNotice(client, entry)
      if (!aborted.has(sessionID) && delegatesNested(entry.agent)) {
        volatile += nestedQuotaNotice(sessionID)
      }
    } else {
      volatile = snapshotForTurn(sessionID, userMessage.info.id)
    }
    const text = (aborted.has(sessionID) ? ABORT_NOTICE : "") + volatile
    if (!text) return

    const id = userMessage.info.id + TURN_NOTICE_SUFFIX
    const part = {
      id,
      messageID: userMessage.info.id,
      sessionID,
      type: "text",
      text,
      synthetic: true,
    }
    const existing = userMessage.parts.findIndex((p) => p?.id === id)
    if (existing >= 0) userMessage.parts[existing] = part
    else userMessage.parts.push(part)
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

// The agent name of a PRIMARY session, resolved most-authoritative-first.
// Subagents never come here — their name stands on their registry entry, which
// the caller uses instead.
//
// 1. What the `chat.message` hook recorded for this session. opencode triggers
//    that hook once per user turn inside createUserMessage, before the request
//    loop that triggers this transform, so it is in hand at the first transform
//    of every turn — and it is the only rung a project markdown file cannot
//    disturb, because it is the name opencode itself resolved.
// 2. The `# Role:` header of the prompt this plugin wrote. Correct whenever the
//    plugin's own prompt is intact, and the only source for a session whose
//    first request arrived by a path that skipped createUserMessage.
// 3. The `default_agent` captured at the `config` hook OF THIS PROJECT —
//    `directory` is the session's project scope and picks it. What opencode
//    starts a primary as when nothing else says otherwise. Passing the scope
//    matters in a process serving two projects: the value is captured once per
//    plugin instance, and without the key the last instance to load would name
//    the other project's primary here.
//
// The name is not cosmetic: it selects the user's per-agent prompt template
// (`.opencode/agent-intercom/<agentName>.md`), so a primary called something
// other than the plugin's own default loads ITS file, not the orchestrator's.
export function resolvePrimaryAgent(sessionID, output, directory) {
  return (
    sessionAgentName(sessionID) ??
    detectAgentFromSystem(output) ??
    defaultAgentName(directory)
  )
}

// Pulls the agent name out of an "# Role: <Name>" header in the role prompt.
// Used for primary sessions where we don't have a registry entry yet — the
// agents.js role prompts all start with `# Role: Orchestrator` or
// `# Role: Coder (Subagent)` etc. Returns the lowercased agent name, or null
// if the header isn't found (rung 2 of resolvePrimaryAgent — the caller falls
// through to the captured `default_agent`).
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
  const maxContext = contextBudgetFor(entry.agent)
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

// Block telling the orchestrator the CURRENT runtime limits so the
// "right-sized chunks" sizing rule in ORCHESTRATION_GUIDE has concrete numbers
// to anchor on. The user can change them at runtime via the settings file, so
// they are injected fresh per turn.
//
// The context budget is a value per agent type, so the block lists one ceiling
// per role the orchestrator can spawn — SPAWNABLE_ROLES, this plugin's own
// subagent roles, which is exactly the closed set the spawn gate accepts
// (src/tools.js). An agent the project's config or the opencode server
// additionally resolves is not spawnable and gets no budget line here, or the
// orchestrator would read the line as an offer. "off" means that type's budget
// is disabled, "unlimited" that the subagent cap is.
//
// Each entry carries the fixed overhead that type's spawns pay before the
// orchestrator's own words and the headroom left over, so a package sized
// against the bare budget is not over the ceiling by an amount the
// orchestrator cannot see.
//
// While `showAgentcom` is off, the block also carries the one sentence that
// tells the orchestrator the user cannot read the notices it receives: the
// completion notice is then the only copy of a subagent's result and nothing
// renders it, so the orchestrator is the channel to the user.
function formatLimitsNotice({ sessionDir, projectMd = "", agentsMd = "" } = {}) {
  const s = getSettings()
  const sub = s.maxSubagents > 0 ? `${s.maxSubagents}` : "unlimited"
  const snapshot = projectContext(sessionDir)
  const budgets = SPAWNABLE_ROLES
    .map((agent) => {
      const budget = contextBudgetFor(agent)
      if (budget <= 0) return `${agent} off`
      const fixed = fixedOverheadFor(agent, { projectMd, agentsMd, snapshot })
      const headroom = Math.max(0, budget - fixed)
      return `${agent} ${fmtTokens(budget)} (−${fmtTokens(fixed)} fixed → ${fmtTokens(headroom)})`
    })
    .join(" · ")
  return (
    "\n\n---\n📐 agent-intercom: current limits — " +
    `maxSubagents = ${sub}.\n` +
    `Context budget per agent: ${budgets}.\n` +
    "Per entry: the budget, the fixed overhead every spawn of that type carries before your own " +
    "words (subagent guides, PROJECT.md, the project snapshot the plugin prepends, AGENTS.md " +
    "where that type keeps it), and the headroom left of the budget for your prompt text and the " +
    "subagent's own work.\n" +
    "Use the budget — the first number of the agent you are spawning — in the " +
    "right-sized-chunks rule of the orchestration protocol above.\n" +
    (!s.showAgentcom
      ? "Subagent results and handoff messages are hidden from the user's " +
        "screen. The user sees only what you write. Relay the substance of a " +
        "subagent's result in your own answer.\n"
      : "") +
    "---\n"
  )
}

// Whether a subagent of this role actually delegates: two conditions, both
// necessary — the role must allow `spawn`, and nesting must not be switched off
// installation-wide. With `maxNestedSpawns = 0` every nested spawn is refused
// before a session is created, so a role that may delegate still cannot: it is
// told it does not delegate, which is what is true of it, and neither the
// delegation guide nor the limits block nor the quota line is paid for.
//
// One predicate for both halves of what a delegating subagent is told — the
// system prompt's guide-and-limits choice and the quota line on the message —
// so the two cannot come apart and hand a role a figure for a quota it was
// never told it has.
function delegatesNested(agent) {
  return mayDelegate(agent) && getSettings().maxNestedSpawns > 0
}

// The reduced limits block a DELEGATING subagent is shown, in place of the
// orchestrator's. It is built only on the primary branch above, so without
// this a planner sizing a researcher package would be working from numbers it
// has never seen — its own ceiling, what a researcher costs, and the shares at
// which the size gate warns and refuses are all invisible to it otherwise.
//
// Three things and nothing more (the primary's block also carries maxSubagents,
// every spawnable type's budget and the showAgentcom sentence — none of which a
// subagent can act on):
//   - its own context budget, the ceiling its run is enforced against;
//   - the researcher's budget with the fixed overhead every researcher spawn
//     pays and the headroom left of it, rendered exactly as the primary's block
//     renders an entry so the two read as one number;
//   - the two package shares, which the gate applies to a nested spawn the same
//     way it applies them to the orchestrator's (packageSizeVerdict sizes
//     against the TARGET type's budget, whoever the caller is).
//
// All three are settings- and file-derived, so the block holds its bytes for
// the life of the run and belongs in the cached element. The fourth figure a
// delegating subagent needs — how much of the per-run nested quota is left —
// counts down WITHIN the run off the caller's registry entry, so it rides on
// the last user message instead (nestedQuotaNotice, delivered by
// transformMessages).
function formatDelegationLimitsNotice(agent, { projectMd, agentsMd, snapshot }) {
  const own = contextBudgetFor(agent)
  const target = NESTED_SPAWN_TARGET
  const budget = contextBudgetFor(target)
  const targetLine =
    budget <= 0
      ? `${target} off (no context budget set — the package gate does not size against it)`
      : (() => {
          const fixed = fixedOverheadFor(target, { projectMd, agentsMd, snapshot })
          const headroom = Math.max(0, budget - fixed)
          return `${target} ${fmtTokens(budget)} (−${fmtTokens(fixed)} fixed → ${fmtTokens(headroom)})`
        })()
  return (
    "\n\n---\n📐 agent-intercom: limits on the work you delegate.\n" +
    `Your own context budget: ${own > 0 ? fmtTokens(own) : "off"} — the ceiling this whole run ` +
    "is measured against, the researcher's returned text included.\n" +
    `Context budget of what you may spawn: ${targetLine}.\n` +
    "The second number is the fixed overhead every researcher spawn carries before your own " +
    "words, the third the headroom left of the budget for your prompt and its work.\n" +
    `Size your spawn prompt against that budget: keep it at or under ${percent(PACKAGE_WARN_SHARE)} ` +
    `of it; over ${percent(PACKAGE_REFUSE_SHARE)} the spawn is REFUSED and no subagent starts. ` +
    "Pass bulk material as a file path, never pasted inline.\n---\n"
  )
}

// The one figure of a delegating subagent's limits that moves inside its run:
// how much of the per-run nested quota is left. `chargeNestedSpawn` increments
// the counter this reads on every admitted nested spawn, so the first LLM call
// after a researcher returns renders a lower number — which is why the line is
// delivered on the last user message and not in the system prompt, where it
// would invalidate the tool definitions and the whole stable element behind it
// once per nested spawn.
//
// The line stands on its own there rather than under the limits block's
// heading, so it names itself. It is rendered only for a caller the delegation
// block was built for — a subagent whose role may delegate, with nesting
// switched on — so the figure reaches exactly the roles that were told they
// have a quota.
function nestedQuotaNotice(sessionID) {
  const quota = nestedQuotaDecision(sessionID, getSettings().maxNestedSpawns)
  const left = Math.max(0, quota.limit - quota.used)
  return (
    "\n\n---\n⤷ agent-intercom: nested spawns left this run: " +
    `${left} of ${quota.limit}. The quota does not reset.\n---\n`
  )
}

// The tokens a spawn of `agent` carries before the orchestrator's own words:
// the plugin's subagent guides, the PROJECT.md block, the project snapshot
// prepended to every spawn prompt, and AGENTS.md for the types that keep it.
// Estimated with the same chars/4 estimator the spawn gate uses, so the
// headroom in the limits block and the figure the gate reports are one method.
// The type's own role prompt is not counted — it comes from opencode and is
// not resolved on a primary turn. Nor is the delegation limits block above:
// it is built from the caller's live registry entry, which does not exist on
// the turn this estimate is made, and at ~150 tokens it moves no verdict.
function fixedOverheadFor(agent, { projectMd, agentsMd, snapshot }) {
  // The same assembly the transform injects, so the estimate cannot count a
  // block the subagent is not given: the delegation block a role actually gets
  // depends on the nesting setting too, and the two blocks differ by ~250
  // tokens, which is a real share of a 100k budget.
  let text =
    guideBlocks({
      agent,
      delegates: mayDelegate(agent) && getSettings().maxNestedSpawns > 0,
    }) +
    projectMd +
    snapshot
  if (AGENTS_MD_SUBAGENTS.has(agent)) text += agentsMd
  return estimateTokens(text)
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

// Re-judges the prompt files of the project a primary session belongs to. Runs
// off the LLM path, on that session's idle, so the finding register can only
// change BETWEEN turns — the transform keeps doing what it always did, read the
// register and render it.
//
// The gate is the project scope alone. `primaryDirectory` is written by the
// transform's primary branch and by nothing else (rememberPrimaryDirectory), so
// a scope here means "a primary whose turn resolved a directory": a subagent
// idle and a primary still without a directory both fall through before any fs
// work. The scope is READ, never written — an event carries the instance's own
// location, not the answer `getSessionDirectory` gave for this session.
//
// Nine stats per primary idle, and content re-read only for the files whose
// mtime moved, because the scan shares the loader's cache. When nothing on disk
// changed the register is untouched and the block renders byte-identically.
function rescanPromptFilesForPrimary(sessionID) {
  const scope = primaryDirectoryOf(sessionID)
  if (!scope) return
  rescanPromptFiles(scope)
}

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
          // The endless twin, same discipline: only a primary that crossed the
          // endless threshold has the latch, so this is a set lookup and a
          // return for every other idle. Detached because a cycle waits for
          // quiesce and then runs a full handoff.
          void maybeRunPendingEndless(client, props?.sessionID)
          // Detector B stays true within the session: the prompt files are
          // re-judged between turns, never during one, so the finding block
          // moves its bytes only where the user actually changed a file.
          //
          // Last in the branch and synchronous. It shares no state with the
          // three calls above, and standing after them means a throw from here
          // reaches the outer catch only once the wake path and both latches
          // have had their run.
          rescanPromptFilesForPrimary(props?.sessionID)
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

// A session created under a parent this plugin knows is one of ours, and gets
// its registry entry at once rather than waiting for `spawn` to reach
// upsertSession after its own promptSession await.
//
// "A parent this plugin knows" is two cases, and both must be here. A PRIMARY
// parent is the orchestrator's own spawn (and a native `task` child under it).
// A SUBAGENT parent — one that has a registry entry — is a nested spawn: the
// caller is blocked inside its `spawn` call, and until this entry exists its
// live child is not a tracked one, which is precisely the condition the
// watchdog exemption is bounded by (isWaitingOnWatchdoggedChild). In that
// window the parent's own silence would count against it and the sweep could
// reap the very session waiting for this child. Registering here closes the
// window at the earliest moment the child's id exists.
function onSessionCreated({ info }) {
  if (!info?.id || !info.parentID) return
  if (!isPrimary(info.parentID) && !entryForSession(info.parentID)) return
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
  // Resolve an abort/error teardown's delete gate before normal idle handling.
  // The entry may already be removed and marked aborted, so this must happen
  // before the registry lookup below.
  signalSessionIdle(sessionID)
  // CRITICAL SECTION: read all delivery-target fields from the
  // registry and remove the entry from the registry under the same mutex,
  // then release the lock BEFORE any network I/O (postNotice/fetchSnapshot).
  // The wake race: a future reparentSubagents swaps parentID on
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
    // A subagent that is blocked on a child of its own has NOT finished: an
    // idle event reaching us here is the session falling quiet around a tool
    // call that has not returned, not the one-shot reply this path exists to
    // deliver. Taking it would post a premature (empty) result to the parent,
    // free the slot, and delete a session whose DELETE then cascades over the
    // live child — the child's answer would never reach the very session that
    // asked for it.
    //
    // Left completely untouched, not latched: `dispatched` is a one-way claim
    // and `status = "idle"` would make the watchdog skip this entry for good.
    // When the child settles, the tool call returns, the session speaks again
    // and goes idle a second time — that idle finds no live children and runs
    // the normal path. If the child never settles, the waiter's own ceiling
    // and the watchdog are what end it.
    if (hasLiveChildren(sessionID)) {
      log("idle held: subagent is waiting on a live child", {
        handle: e.handle,
        sessionID,
      })
      return null
    }
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
    if (!removed) return null
    // The entry is out of the registry from here on, so countActiveSubagents
    // no longer sees this subagent — but its result has not been delivered
    // yet. Reserve the delivery window in the SAME critical section, so the
    // quiesce predicate never observes the gap between the two: an endless
    // cycle that fired its open-points prompt in that gap would replace the
    // primary while this very result was still on its way to it. Released in
    // the `finally` below, after the teardown.
    reservePendingDelivery()
    return {
      handle: e.handle,
      parentID: e.parentID,
      agent: e.agent,
      taskId: e.taskId,
      directory: e.directory,
      packageTokens: e.packageTokens,
      // Read off the entry inside the critical section, with the rest of what
      // the notice needs: the entry is removed a few lines above and is gone
      // by the time the notice is composed.
      nested: { runs: e.nestedRuns ?? 0, tokens: e.nestedTokens ?? 0 },
    }
  })
  if (!wake) return
  const { handle, parentID, agent, taskId, directory, packageTokens, nested } = wake
  try {
    const snapshot = await fetchSnapshot(client, sessionID)
    // Hand the reply to a session blocked on this one, if there is one. This
    // is the only ending path that has a RESULT rather than just a cause, so
    // it settles here rather than leaving it to teardownSubagent's fallback —
    // which still runs below and is then a no-op. `ctxTokens` rides along
    // because what a nested run burned is invisible in the parent's own
    // figure. No-op for every subagent today: nothing registers a waiter yet.
    settleChildWaiter(sessionID, {
      status: "completed",
      handle,
      agent,
      result: snapshot.result,
      ctxTokens: snapshot.ctxTokens,
    })
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
      completionNotice(
        handle,
        agent,
        snapshot.result,
        parentID,
        taskOutcome,
        snapshot.ctxTokens,
        packageTokens,
        nested,
      ),
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
  try {
    await teardownSubagent(
      client,
      { sessionID, handle, parentID, agent },
      { entryRemoved: true, label: "" },
    )
  } finally {
    releasePendingDelivery()
  }
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
    outcome: {
      status: wasAborted ? "aborted" : "error",
      handle: entry.handle,
      agent: entry.agent,
      detail: errText,
    },
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

// Marker the subagent is taught to put on the FIRST or LAST non-empty line of
// its final reply. `DONE: T<n>` — the wake-hook removes the matching task from
// TODO.md. There is no blocked marker HERE: a subagent that could not finish
// opens its reply with `Blocked:` (prompts.js), which this regex does not
// match, so TODO.md stays unchanged and the notice (notices.js) hands the
// decision to the orchestrator.
const MARKER_RE = /^\s*DONE:\s*(T\d+)\s*$/i

// Parses the marker out of the subagent's final reply and removes the task
// from TODO.md if it matches the spawn-assigned task id. Returns one of:
//   { kind: "no-task" }   — subagent wasn't spawned with a task id
//   { kind: "no-marker" } — task id given but reply has no accepted DONE line
//   { kind: "mismatch" }  — marker present but for a different id (ignored)
//   { kind: "no-todo" }   — no todo file in the directory (greenfield)
//   { kind: "done", id }  — successfully removed
//   { kind: "error", message } — TODO.md operation threw (id not found etc.)
function autoMarkTask(directory, taskId, finalReply) {
  if (!taskId) return { kind: "no-task" }
  const lines = nonEmptyLines(finalReply)
  const markerLines = lines.length > 1 ? [lines[0], lines[lines.length - 1]] : lines
  let m = null
  for (const line of markerLines) {
    m = MARKER_RE.exec(line)
    if (m) break
  }
  if (!m) return { kind: "no-marker" }
  const markerId = m[1]
  if (markerId !== taskId) return { kind: "mismatch", expected: taskId, got: markerId }
  if (!directory) return { kind: "no-todo" }
  // The todo-file lookup itself decides whether this is greenfield: only a
  // directory with no todo file at all is "no-todo". Several candidate files,
  // a non-regular file or an unreadable directory are faults that surface as
  // "error" — reporting them as greenfield would silently drop the marker for
  // a task that is still standing in a file we merely failed to resolve.
  try {
    removeTask(directory, taskId)
    return { kind: "done", id: taskId }
  } catch (err) {
    if (err instanceof TodoFileMissingError && err.kind === "missing") return { kind: "no-todo" }
    return { kind: "error", message: errMsg(err) }
  }
}

function nonEmptyLines(text) {
  if (!text) return []
  return text.split("\n").filter((line) => line.trim())
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
      // Hard backstop: a subagent may not spawn work of its own. The custom
      // `spawn` tool is gated in its handler (friendly refusal); opencode's
      // native blocking `task` has no handler of ours to gate, and
      // checkToolPermission below deliberately skips `task` (see config.js), so
      // deny it here unconditionally — independent of the per-agent permission
      // map, so a project override that dropped the schema-strip deny cannot
      // re-open it. The subagent reports any need for another agent in its
      // final reply; the orchestrator dispatches.
      if (input.tool === "task") {
        log("denied native task from subagent", { sessionID, agent: entry.agent })
        throw new Error(
          "agent-intercom: a subagent cannot spawn other agents. If this task needs another " +
            "agent, name it and what it should do in your final reply — the orchestrator decides " +
            "and dispatches it.",
        )
      }
      if (TODO_TOOLS.has(input.tool) && !TODO_AGENTS.has(entry.agent)) {
        log("denied todo tool from non-todo subagent", {
          sessionID,
          agent: entry.agent,
          tool: input.tool,
        })
        throw new Error(
          `agent-intercom: \`${input.tool}\` is restricted to planner / coder / debugger / ` +
            "reviewer / documenter / designer. The researcher and gitter agents do not touch " +
            "TODO.md. Put `DONE: T<n>` on the FIRST or LAST non-empty line of your final message " +
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
      const maxContext = contextBudgetFor(entry.agent)
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
