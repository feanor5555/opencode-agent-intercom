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

import { aborted, deletedSessions, registry, lastPrimaryTool, trimByAgeAndSize } from "./state.js"
import {
  entryForSession,
  upsertSession,
  isPrimary,
  effectiveState,
  isActiveEntry,
  entryLifecycle,
  LIFECYCLE_RUNNING,
  LIFECYCLE_RETAINED,
  retentionDecision,
  recordRetainedContext,
  retentionContextDecision,
  retainEntryLocked,
  removeEntryLocked,
  reservePendingDelivery,
  releasePendingDelivery,
  registryMutex,
  shouldRefreshPrimary,
  recordPrimaryContext,
  primaryContextTokens,
  scheduleHandoffIfNeeded,
  scheduleEndlessIfNeeded,
  scheduleCompactionIfNeeded,
  cancelPendingEndless,
  cancelPendingHandoff,
  cancelPendingCompaction,
  resetEndlessProgress,
  endlessPauseReason,
  isEndlessPaused,
  clearEndlessPause,
  nestedQuotaDecision,
  sessionAgentName,
  rememberPrimaryDirectory,
  primaryDirectoryOf,
  beginToolCall,
  endToolCall,
  markMessagesSeen,
  clearAsk,
  exchangeSnapshot,
  CTX_TTL_MS,
} from "./registry.js"
import {
  fetchSnapshot,
  showToast,
  getSessionDirectory,
  forgetSessionDirectory,
} from "./client.js"
import {
  getSettings,
  primaryContextThreshold,
  endlessModeInEffect,
  contextBudgetFor,
  compactionEnabledFor,
  reuseCeilingFor,
  retentionOffered,
  retentionActive,
  retentionCapacity,
  soloModeActive,
  PACKAGE_WARN_SHARE,
  PACKAGE_REFUSE_SHARE,
} from "./settings.js"
import {
  nestedSpawnTargets,
  SPAWNABLE_ROLES,
  isSubagentRole,
  defaultAgentName,
  DEFAULT_AGENT,
  SOLO_ROLE_HEADER_NAME,
} from "./agents.js"
import { resolveSpawnPermission } from "./config.js"
import { overrideBlock, overrideToastText } from "./overrides.js"
import { removeTask, TodoFileMissingError } from "./todofile.js"
import { projectMdBlock, projectContext } from "./project.js"
import { log, errMsg } from "./log.js"
import { ABORT_NOTICE, guideBlocks, resultCeilingDemand } from "./prompts.js"
import {
  loadCustomPrompt,
  applyCustomPrompt,
  scanPromptFiles,
  rescanPromptFiles,
} from "./promptsfile.js"
import {
  tokens as fmtTokens,
  ageSeconds,
  estimateTokens,
  percent,
  retainedMinutesLeft,
} from "./format.js"
import {
  postParentNotice,
  teardownSubagent,
  dropRetainedSubagents,
  signalSessionIdle,
  waitForSessionQuiescence,
  SUBAGENT_SESSION_TITLE_MARKER,
} from "./teardown.js"
import { settleChildWaiter, detachedParentOf, hasLiveChildren } from "./childwait.js"
import { settleAsk } from "./agentmsg.js"
import {
  completionNotice,
  errorNotice,
  denialLoopNotice,
  retentionLostNotice,
  isBlockedResult,
} from "./notices.js"
import { capReplyForAgent, secureSubagentState } from "./resultfile.js"
import { ensureWatchdogStarted } from "./watchdog.js"
import { maybeRunPendingCompaction, startSubagentCompaction } from "./compaction.js"
import {
  maybeRunPendingHandoff,
  maybeRunPendingEndless,
  dropEndlessLatch,
} from "./handoffwiring.js"

// Re-exported so existing importers (test/plugin.test.js) keep resolving it
// from hooks.js after the watchdog code moved to its own module.
export { timeoutSubagent } from "./watchdog.js"

// The only tools a primary session may execute — everything else must be
// delegated to a subagent. Pure orchestration: spawn / abort / list. Even
// glob, grep, and TODO.md reads are delegated (to the planner), so the
// orchestrator stays at the coordination layer.
//
// The ORCHESTRATOR pattern's list, and it governs a primary only there. In
// solo mode none of these tools is registered and the primary is the worker,
// so the guard below takes its other branch and this set gates nothing — see
// soloModeActive (src/settings.js).
const PRIMARY_TOOLS = new Set([
  "spawn",
  "abort",
  "list",
  // The downward half of the mid-run channel. Always registered outside solo
  // mode; whether it does anything is decided live by `midRunMessaging`, which
  // is why it is listed unconditionally here and filtered only out of the
  // refusal text below.
  //
  // `ask` is deliberately NOT a member: it is the subagent's half, denied to
  // the primary in the orchestrator's own permission map (src/agents.js), and a
  // primary that calls it anyway is refused by this allowlist with the text
  // that names what it does have.
  "message",
  // Only reachable where retention is switched on. It ships on, so at the
  // default this gates a tool that is really there; at
  // `maxRetainedSubagents: 0` the tool is not registered (see createTools) and
  // this entry gates nothing.
  "reuse",
])

// Every tool name established as starting an agent of its own. Read off the
// installed opencode binary's builtin tool set (`bash`, `edit`, `write`,
// `read`, `grep`, `glob`, `list`, `patch`, `todowrite`, `webfetch`,
// `websearch`, `task`): `task` is the only one that opens a session, and it is
// the entry point to opencode's own `general` and `explore` subagents.
//
// One collection rather than a literal because both guard branches below have
// to refuse the SAME names, and because the next agent-starting tool — a
// built-in opencode adds, or one an MCP server brings — is then added in one
// place instead of two. A name added here is denied to a subagent and to a solo
// primary at once.
//
// A FROZEN array, not a Set: this is an enforcement authority read by the guard
// below, and an exported mutable Set can be emptied by any importer — a test
// that forgets to restore, a future module — at runtime. The membership test
// runs against the private Set derived from it (`agentStartingTools`), which
// nothing outside this module holds. Same shape as every other constant
// collection here (SOLO_PRIMARY_PERMISSION, BUILTIN_AUTO_AGENTS, AGENT_MODES).
export const AGENT_STARTING_TOOLS = Object.freeze(["task"])

// The two tools of the mid-run channel (specs/mid-run-messaging.md): `message`
// downward to a subagent, `ask` upward to the caller. They are the only way a
// running agent reaches anyone outside its own session before its final reply.
//
// That is why they are named here rather than written as literals at the two
// places that test them. A subagent locked down at its context budget keeps
// exactly these two: the lockdown exists to stop it spending context on work,
// not to cut it off from its caller, and without them an over-budget subagent
// with a question — or with something its caller must hear before it winds
// down — has no channel at all until it is torn down. Every other tool stays
// denied there.
//
// Solo mode denies the same two names, for the reason the block below gives;
// one collection, so the exemption and that deny cannot drift apart over which
// names make up the channel. Frozen for the reason AGENT_STARTING_TOOLS is,
// and read through the private `midRunMessagingTools` below.
export const MID_RUN_MESSAGING_TOOLS = Object.freeze(["message", "ask"])

// What a primary in SOLO mode may not run. The mode owns this set: solo mode
// exists for a backend that serves one agent at a time (a llama.cpp server at
// `parallel 1`), so nothing that could put a second agent on that slot may
// pass.
//
// Two groups. Everything agent-starting, above — that is the requirement
// itself. And the plugin's own four orchestration tools, which solo mode does
// not register at all (createTools, src/tools.js): naming them here is what
// makes the mode hold if any of them reappears in the schema by a route the
// tool map does not decide — a project override, a refactor that moves one out
// of the non-solo arm, a future caller of the handler.
//
// Deliberately a denylist and not the allowlist PRIMARY_TOOLS is: in solo mode
// the primary IS the worker and runs its own tools, MCP tools included, so
// there is no closed list of what it may do. What can be closed is the list of
// what starts a second agent.
// `list` is deliberately NOT a member, though it is one of the four
// orchestration tools. The name is not the plugin's alone: `list` is also
// opencode's own builtin directory lister, and in solo mode — where the
// plugin's `list` is not registered — that builtin is what the name resolves
// to. It is a working tool the solo primary needs and one
// SOLO_PRIMARY_PERMISSION leaves it. Denying the name here would take a
// directory listing away from the agent that has to do the work, and it would
// buy nothing: `list` starts no agent, it reports on subagents that in this
// mode do not exist.
//
// Frozen for the same reason AGENT_STARTING_TOOLS is, and read through the
// private `soloDeniedTools` below.
// `message` and `ask` are members for the same reason spawn / reuse / abort
// are: solo mode registers neither (both live in the non-solo arm of
// createTools), and a name that reappeared in the schema by a route the tool
// map does not decide would otherwise address a second agent — one to steer,
// or one to put a question to — in a mode whose whole point is that no second
// agent exists.
export const SOLO_DENIED_TOOLS = Object.freeze([
  ...AGENT_STARTING_TOOLS,
  "spawn",
  "reuse",
  "abort",
  ...MID_RUN_MESSAGING_TOOLS,
])

// The membership tests the guard branches actually run. Private to this
// module, so the exported authorities above stay frozen and there is still
// exactly one place each name is written.
const agentStartingTools = new Set(AGENT_STARTING_TOOLS)
const soloDeniedTools = new Set(SOLO_DENIED_TOOLS)
const midRunMessagingTools = new Set(MID_RUN_MESSAGING_TOOLS)

// The orchestration tools a primary may actually call right now, for the
// refusal that names them. `reuse` is left out wherever retention is not in
// effect: it is not registered at all where retention was off at load, and
// where it was switched off since it refuses every call — either way naming it
// would send the model after something it cannot use.
// `message` is filtered on the same rule for the same reason: while
// `midRunMessaging` is off it refuses every call, so naming it would send the
// model after something it cannot use. The difference is only where the answer
// comes from — retention was latched at load, this one is read live.
function availablePrimaryTools() {
  return [...PRIMARY_TOOLS]
    .filter((name) => name !== "reuse" || retentionActive())
    .filter((name) => name !== "message" || getSettings().midRunMessaging)
    .join(", ")
}

// TODO.md is the domain of the six agents that produce concrete deliverables:
// planner (plans), coder (code), debugger (diagnoses), reviewer (reviews),
// documenter (docs), designer (images). Each one can read AND write TODO.md
// — list, add new tasks, edit existing ones, remove completed ones.
// The other three subagents (researcher, grounder, gitter) get no TODO tools at
// all: they hand off whatever they find to the others, who manage the list.
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
//   - researcher / grounder / designer / gitter strip it: web research, image
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

// The reserve the STOP keeps below the context budget. The tool lockdown in
// guardToolExecute fires at the budget itself; the demand for a `Done:` /
// `Blocked:` summary fires at this share of it, so the subagent is told to
// write its account while its tools STILL WORK and it still has room to write
// in. Without the gap both fired on the same figure: the very turn the
// subagent was ordered to summarise was the turn every tool started throwing,
// and a run that spent its budget mid-tool-call could end with no text at all.
// A share of the budget, not a setting: it moves with whatever ceiling the
// agent's own `contextBudget` gives it, and the budget defaults are untouched.
const CTX_STOP_RESERVE = 0.9

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
      // block that goes with it. Decided by the runtime spawn authority, so the
      // role is told it delegates exactly when a spawn of its would be admitted.
      const delegates = isSubagent && (await delegatesNested(client, entry.agent))
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
        // primaryContextThreshold(): while endless mode is in effect,
        // endlessContext DISPLACES maxPrimaryContext. Arming both would be
        // inert, the lower one always firing first.
        //
        // WHICH RELIEF that threshold buys is resolved here, and it is a
        // three-way decision with a fixed order:
        //
        //   endless mode in effect → the cycle. It is a whole mode the user
        //     armed explicitly, its threshold already displaces
        //     maxPrimaryContext, and it replaces the session rather than
        //     shrinking it — there is nothing for a compaction to add.
        //   else compaction switched on for this agent → a compaction of this
        //     very session, so the orchestrator keeps its session, its
        //     subagents and its handles.
        //   else → the plain handoff, unchanged.
        //
        // The switch is read LIVE, at every crossing, and a user may flip it
        // between two turns of one session. So each branch cancels the other
        // two's UNCLAIMED latches, exactly as the endless branch already
        // cancels the handoff's: two latches on one primary would have the idle
        // handler fire two reliefs back to back on the same session.
        //
        // What the mode's own stops leave behind: a pause on THIS session,
        // never a written `endlessMode: false`. A paused primary takes the
        // plain-handoff branch and arms at maxPrimaryContext exactly as a
        // primary with the mode off does: the stop ends the LOOP, not the
        // session's relief from its own context. Leaving the endless threshold
        // on it would arm nothing — scheduleEndlessIfNeeded refuses a paused
        // primary — and the session would grow until the provider's own limit
        // ended it.
        //
        // The pause survives that decision: only the mode being switched OFF
        // clears it (below), so a paused primary cannot re-enter the cycle by
        // taking the plain branch. It is dropped when the primary is actually
        // replaced (forgetPrimary), which is what gives the successor session
        // the mode again.
        const endlessPaused = isEndlessPaused(sessionID)
        const pausedReason = endlessPauseReason(sessionID)
        const threshold = primaryContextThreshold({ endlessPaused })
        if (endlessModeInEffect({ endlessPaused })) {
          // The switch was turned on between the mark and this turn: drop an
          // unclaimed PLAIN-handoff latch, the mirror of the off-branch below.
          // Both latches live at once otherwise — the primary crossed
          // maxPrimaryContext with the mode off and endlessContext with it on —
          // and the idle handler fires both executors on the same primary.
          cancelPendingHandoff(sessionID)
          cancelPendingCompaction(sessionID)
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
          // Reached two ways: the user switched the mode off, or the mode
          // stopped itself for this session. Either way no cycle may start, so
          // drop a latch that has not been claimed yet — the freeze lifts with
          // it and the plain handoff owns the threshold. A cycle already
          // executing is not touched: it has written to the todo file and must
          // not leave the primary half-replaced.
          cancelPendingEndless(sessionID)
          if (!getSettings().endlessMode) {
            // The switch is off. A pause is state of the endless mode, and the
            // mode is not running: the plain handoff owns the threshold now
            // and must not be held back by a stop that belongs to a mode
            // nobody is running. Only THIS branch clears a pause — clearing it
            // while the switch is still on would undo the mode's own stop
            // within one turn and let the next crossing arm a cycle again.
            clearEndlessPause(sessionID)
            // The cross-cycle progress record belongs to a run of the mode, not
            // to the process: with the mode off it has nothing to measure, and
            // carrying its streak into the next arming would spend the user's
            // re-arm on a single cycle before the no-progress bound — the very
            // bound that switched the mode off — fired again.
            resetEndlessProgress()
          }
          // The relief this agent's own switch names. Idle-gated like the other
          // two and for the same reason recorded above: the transform hook
          // fires while the triggering turn runs, and compacting here would
          // summarize away the very turn being answered.
          if (compactionEnabledFor(agentName)) {
            cancelPendingHandoff(sessionID)
            if (scheduleCompactionIfNeeded(sessionID, threshold)) {
              log("primary compaction scheduled (idle-gated)", {
                sessionID,
                agent: agentName,
                ctx: primaryContextTokens(sessionID),
                threshold,
              })
              showToast(client, {
                title: "agent-intercom",
                message:
                  "primary context limit reached — this session is compacted at the end of this turn",
              })
            }
          } else {
            cancelPendingCompaction(sessionID)
            if (scheduleHandoffIfNeeded(sessionID, threshold)) {
              log("primary handoff scheduled (idle-gated)", { sessionID })
              showToast(client, {
                title: "agent-intercom",
                message:
                  "primary context limit reached — orchestrator handoff scheduled for the end of this turn",
              })
            }
          }
        }
        limits = formatLimitsNotice({
          sessionDir: scopeDir,
          projectMd,
          agentsMd: slices.agentsMd || "",
          endlessPausedReason: pausedReason,
          delegatingRoles: await delegatingRolesAmong(client, SPAWNABLE_ROLES),
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
          delegatingRoles: await delegatingRolesAmong(client, nestedSpawnTargets(entry.agent)),
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
        // Latched, not the live setting: it decides whether the guide names
        // `reuse`, and whether that tool exists was settled when opencode
        // resolved the tool map. Ignored on the subagent path — a subagent is
        // never told about retention (its own run is one-shot either way).
        retention: retentionOffered(),
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
      // This hook is the one that fires per LLM REQUEST, and a request made
      // after a message was queued is the only observation available that the
      // message reached the model: opencode publishes nothing between the
      // queued user message and the step that reads it. Bookkeeping only —
      // nothing for the mid-run channel is injected here, the message travels
      // as a persisted user message of its own.
      markMessagesSeen(entry)
      volatile = await contextLimitNotice(client, entry)
      if (!aborted.has(sessionID) && (await delegatesNested(client, entry.agent))) {
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

// The agent name a primary session runs under, resolved WITHOUT the system
// prompt: rung 1 of resolvePrimaryAgent (the name recorded at `chat.message`)
// and then rung 3 (this project's captured `default_agent`, under the scope the
// transform remembered for the session). Rung 2 — reading the "# Role:" header —
// needs the prompt output, which a tool-call guard does not have; it would in
// any case answer what rung 3 answers for a primary this plugin installed, since
// the solo header maps back to DEFAULT_AGENT (detectAgentFromSystem above).
//
// Used by the solo-mode permission re-check in the guard, where the question is
// which key of `config.agent` the primary's deny map hangs under. A session with
// no recorded name and no remembered scope falls to defaultAgentName(null) —
// DEFAULT_AGENT, unless exactly one project has registered another.
export function primaryAgentNameFor(sessionID) {
  return sessionAgentName(sessionID) ?? defaultAgentName(primaryDirectoryOf(sessionID))
}

// Pulls the agent name out of an "# Role: <Name>" header in the role prompt.
// Used for primary sessions where we don't have a registry entry yet — the
// agents.js role prompts all start with `# Role: Orchestrator` or
// `# Role: Coder (Subagent)` etc. Returns the lowercased agent name, or null
// if the header isn't found (rung 2 of resolvePrimaryAgent — the caller falls
// through to the captured `default_agent`).
//
// The one header that does not name a role is the solo prompt's `# Role: Solo`
// (SOLO_ROLE_HEADER_NAME, src/agents.js): solo mode replaces the primary's
// PROMPT and leaves its name alone, so the word maps back to the role the
// plugin installs the primary as — the same answer this rung gives for the
// orchestration prompt, which is what makes a solo primary load the primary's
// prompt-template file rather than a `solo.md` no role has.
function detectAgentFromSystem(output) {
  if (!Array.isArray(output?.system) || output.system.length === 0) return null
  const head = output.system[0].slice(0, 200)
  const m = /^#\s*Role:\s*([A-Za-z]+)/m.exec(head)
  if (!m) return null
  const name = m[1].toLowerCase()
  return name === SOLO_ROLE_HEADER_NAME ? DEFAULT_AGENT : name
}

// Reads the subagent's live context size and returns the block to inject when
// it is running out of room. Also keeps the entry's ctxTokens/lastActivity
// fresh as a side effect. Empty string when the budget is disabled, still far
// off, or the subagent is already aborted.
//
// Two bands, split by CTX_STOP_RESERVE:
//   reserve band — at or over CTX_STOP_RESERVE of the budget but still under
//     it. Tools still work. The subagent is told to write its `Done:` /
//     `Blocked:` summary NOW, while it has both the tools and the room. This
//     is the band that keeps a result from being lost.
//   lockdown    — at or over the budget. guardToolExecute is denying every
//     tool call on the same figure; the block escalates over successive turns
//     and notifies the parent at BUDGET_NOTIFY_AFTER.
//
// With compaction switched ON for this agent type, the budget crossing buys a
// COMPACTION of the session instead of the lockdown, up to
// MAX_SUBAGENT_COMPACTIONS. The budget itself is never lifted: it is re-armed
// against a smaller session, and every crossing the compaction cannot take —
// the switch off, the cap spent, a question open — is the lockdown's, exactly
// as before. The reserve band above is untouched either way; the subagent is
// still told to wrap up while it has room, because a compaction may yet refuse.
//
// Hot path: this runs before EVERY subagent LLM call. The snapshot HTTP fetch
// dominates cost as the subagent's message history grows, so the result is
// cached on the entry for CTX_TTL_MS. Once we get within CTX_NEAR_BUDGET of
// the limit the cache is bypassed — CTX_NEAR_BUDGET sits below
// CTX_STOP_RESERVE, so the figure is already fresh when the reserve band is
// entered and the lockdown triggers as soon as the budget is actually
// breached.
async function contextLimitNotice(client, entry) {
  const maxContext = contextBudgetFor(entry.agent)
  if (maxContext <= 0 || aborted.has(entry.sessionID)) return ""

  const now = Date.now()
  const cacheFresh = now - entry.lastTokensFetchAt < CTX_TTL_MS
  const nearBudget =
    entry.ctxTokens != null && entry.ctxTokens > maxContext * CTX_NEAR_BUDGET
  // The model this session is running on, as the snapshot below reports it.
  // Only the budget crossing uses it, and only with compaction switched on —
  // the summarize request carries its own model. Undefined where this turn read
  // the cache instead of the session, which is never the case at the crossing:
  // `nearBudget` is true from CTX_NEAR_BUDGET on, so the figure that triggers
  // the crossing and the model that serves it come from the same read.
  let sessionModel
  if (!cacheFresh || nearBudget) {
    const snapshot = await fetchSnapshot(client, entry.sessionID)
    sessionModel = snapshot.model
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

  if (entry.ctxTokens == null || entry.ctxTokens < maxContext * CTX_STOP_RESERVE) return ""

  // Reserve band: room is nearly gone but the budget is not breached, so
  // guardToolExecute is still letting tool calls through. Ask for the summary
  // here and the subagent can still write it — and can still use a tool to
  // finish the one thing it was in the middle of. Deliberately NOT counted in
  // `stopInjections`: that counter means "turns spent ignoring the lockdown",
  // it drives the denial-loop notice to the parent, and a subagent that has
  // been denied nothing is not in a denial loop. `contextWarnings` counts
  // these turns instead, for the log.
  if (entry.ctxTokens < maxContext) {
    entry.contextWarnings = (entry.contextWarnings ?? 0) + 1
    const left = maxContext - entry.ctxTokens
    log("subagent entering context reserve", {
      handle: entry.handle,
      ctxTokens: entry.ctxTokens,
      limit: maxContext,
      remaining: left,
      contextWarnings: entry.contextWarnings,
    })
    return (
      `\n\n---\n⚠️ WRAP UP NOW. agent-intercom: your context has reached ` +
      `${fmtTokens(entry.ctxTokens)} tokens of the ${fmtTokens(maxContext)} budget — about ` +
      `${fmtTokens(left)} left. At the budget every work tool is DISABLED, so this ` +
      `is your last chance to write while you still have both tools and room.\n\n` +
      `Finish only what you are already holding, then write a plain-text message beginning with ` +
      `"Done:" (or "Blocked:") naming what you accomplished and what remains. That message is ` +
      `the ONLY thing the orchestrator receives from you — start no new line of investigation, ` +
      `open no further files.` +
      // The result ceiling, named at the moment the reply is being demanded and
      // while the subagent still has the `write` the demand asks for.
      resultCeilingDemand(entry.agent, { canWrite: true }) +
      `\n---\n`
    )
  }

  // The budget is breached. With compaction switched on for this type the
  // relief is a compaction of this session rather than the lockdown: the run
  // continues in a smaller session and the budget is re-armed against it, up to
  // MAX_SUBAGENT_COMPACTIONS. startSubagentCompaction takes the decision and
  // owns the latch; false means this crossing is the lockdown's after all —
  // the switch is off, the cap is spent, or a question of this subagent's is
  // open and its waiter must not have the session summarized under it.
  //
  // The notice below is what the model is told while the compaction runs.
  // guardToolExecute is still denying on the same figure — the entry's
  // ctxTokens is over the budget until the compaction clears it — so a
  // subagent told nothing would meet a wall of refusals it has no account of.
  // It is deliberately not a STOP: nothing is being wound up here.
  if (startSubagentCompaction(client, entry, { model: sessionModel })) {
    return (
      `\n\n---\n⏳ HOLD. agent-intercom: your context has reached ` +
      `${fmtTokens(entry.ctxTokens)} tokens of the ${fmtTokens(maxContext)} budget, so your ` +
      `session is being COMPACTED right now — your history is being replaced by a summary of ` +
      `it, and you keep working in the same session afterwards.\n\n` +
      `Make NO tool call on this turn: every one is refused until the compaction lands. Say in ` +
      `one sentence what you were doing and what you will do next, and continue from there on ` +
      `your following turn.\n---\n`
    )
  }

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
  // The mid-run channel is what the lockdown leaves the subagent, so the block
  // names it — but only where the channel is actually working. With
  // `midRunMessaging` off both tools refuse every call (their handlers read the
  // setting live), and naming them would send the model after something it
  // cannot use, the same rule `availablePrimaryTools` follows for `message`.
  const channelBlock = getSettings().midRunMessaging
    ? "TWO tools are still open to you, and they are your way to reach the orchestrator before " +
      "you wind down: `ask(question)` where one answer decides what your final reply says, and " +
      "`message(subagent, text)` for a subagent of your own. Use them for that and nothing " +
      "else — neither buys you room to carry on working.\n\n"
    : ""

  const tail =
    level >= BUDGET_NOTIFY_AFTER
      ? "THE ORCHESTRATOR AND USER HAVE NOW BEEN NOTIFIED that you are stuck — the user is " +
        "being asked whether to abort you. Every further work-tool call is wasted output that " +
        'nobody will read. Your remaining move: write a plain-text message starting with "Done:" ' +
        'or "Blocked:" — now.'
      : level === 2
        ? "One more over-budget turn and the orchestrator + user will be notified that you are " +
          'stuck. Write a plain-text message starting with "Done:" now.'
        : `If you keep calling work tools, after ${BUDGET_NOTIFY_AFTER} ignored warnings the ` +
          "orchestrator + user will be notified that you are stuck. Write a plain-text message " +
          'starting with "Done:" now.'

  return (
    `\n\n---\n${head} agent-intercom: your context has reached ${fmtTokens(entry.ctxTokens)} ` +
    `tokens (budget ${fmtTokens(maxContext)}). Your work tools are now DISABLED — every such ` +
    `tool call will be rejected with an error. This is warning ${level}/${BUDGET_NOTIFY_AFTER}.\n\n` +
    channelBlock +
    'YOUR LITERAL NEXT MESSAGE MUST BEGIN WITH "Done:" (or "Blocked:") followed by 1–2 short ' +
    "sentences naming what you accomplished and what remains. No JSON, no code block — plain " +
    'text starting with "Done:" or "Blocked:". Do NOT try `read`, `edit`, `bash`, `web_search`, ' +
    '`webfetch` or any other work tool; do NOT try "just one more lookup". ' +
    tail +
    // The same ceiling the reserve band named, for the subagent that is here
    // without having passed through that band — a single turn can cross both.
    // `canWrite: false`: every work tool is denied on this figure.
    resultCeilingDemand(entry.agent, { canWrite: false }) +
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
      await postParentNotice(client, entry.parentID, denialLoopNotice(entry), {
        kind: "denial-loop",
      })
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
//
// In SOLO mode almost nothing in the block is true and what is left is the
// hidden-postings sentence alone. The spawn budgets size packages for
// subagents that are never started there, `maxSubagents` bounds a fleet that
// does not exist, and the sizing sentence points at "the orchestration
// protocol above", which is not injected in that mode (guideBlocks,
// src/prompts.js) — a reference to a block the primary was never given. The
// endless-pause sentence cannot be reached either: solo mode counts as endless
// mode off, so no cycle runs and nothing pauses (endlessModeInEffect,
// src/settings.js). With `showAgentcom` on, nothing is left and the block is
// empty — the `{{limits}}` placeholder of a prompt file then substitutes to
// nothing, which is what an empty block has always meant.
//
// `endlessPausedReason` carries the other conditional sentence: endless mode
// stopped itself for THIS session (cycle ceiling, no progress, nothing left to
// do). It is the state the orchestrator cannot infer — the mode reads as on
// everywhere else, because the settings file was deliberately not written —
// and it changes what the session can expect: no further cycle, so its open
// points are not written to the todo file again. What it does NOT change is
// the ordinary handoff: a paused primary is relieved at `maxPrimaryContext`
// like any session with the mode off, and the sentence says so. A session the
// user switched the mode off in gets no such sentence: there the row reads
// `[off]` and there is nothing the orchestrator could not read off the panel.
function formatLimitsNotice({
  sessionDir,
  projectMd = "",
  agentsMd = "",
  endlessPausedReason = "",
  delegatingRoles = new Set(),
} = {}) {
  const s = getSettings()
  if (soloModeActive()) {
    if (s.showAgentcom) return ""
    return (
      "\n\n---\n📐 agent-intercom: what this plugin posts into your session is hidden from the " +
      "user's screen. The user sees only what you write.\n---\n"
    )
  }
  const sub = s.maxSubagents > 0 ? `${s.maxSubagents}` : "unlimited"
  const snapshot = projectContext(sessionDir)
  const budgets = SPAWNABLE_ROLES
    .map((agent) => {
      const budget = contextBudgetFor(agent)
      if (budget <= 0) return `${agent} off`
      const fixed = fixedOverheadFor(agent, { projectMd, agentsMd, snapshot, delegatingRoles })
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
    (endlessPausedReason
      ? `Endless mode is PAUSED for this session — ${endlessPausedReason}. The mode itself ` +
        "is not switched off: nothing was written to the settings, the switch stays the " +
        "user's, and the next orchestrator session starts with it available again. For THIS " +
        "session no further cycle runs, so your open points are not saved to the todo file " +
        "again — the ordinary orchestrator handoff still applies and can replace this " +
        "session at the plain context limit. Bring the work you have to a close and say so " +
        "to the user.\n"
      : "") +
    "---\n"
  )
}

// Whether a subagent of this role actually delegates: two conditions, both
// necessary — the RESOLVED config must permit `spawn` for the role, and nesting
// must not be switched off installation-wide.
//
// The spawn half is asked of `resolveSpawnPermission` (config.js), the very
// function the spawn gate calls when the role makes the call, and not of the
// static role map. That is what keeps the prompt and the gate from disagreeing:
// with a project-level `agent.<role>.permission.spawn = "deny"` the static map
// still reads "may delegate", so the role would be handed the delegation guide,
// the limits block and the quota line on every single turn while every spawn it
// then makes is refused — context paid for a prompt that lies to the role.
// The direction is fixed: the prompt follows the gate, the gate is never
// loosened to match the prompt.
//
// Async for that reason, and cheaply so: the resolved config is fetched once
// per process and cached at module scope in config.js, so this adds no request
// per turn. A config that cannot be read at all falls through inside
// `resolveSpawnPermission` to this plugin's own role map — the answer the
// prompt side had before — so a read failure changes no prompt.
//
// With `maxNestedSpawns = 0` every nested spawn is refused before a session is
// created, so a role that may spawn still cannot: it is told it does not
// delegate, which is what is true of it, and neither the delegation guide nor
// the limits block nor the quota line is paid for.
//
// One predicate for both halves of what a delegating subagent is told — the
// system prompt's guide-and-limits choice and the quota line on the message —
// so the two cannot come apart and hand a role a figure for a quota it was
// never told it has.
//
// The role must be a subagent role: `resolveSpawnPermission` answers "allowed"
// for the orchestrator too (its map carries no `spawn` key), and none of the
// three blocks belongs in a primary's prompt.
//
// The target set is the fourth condition, and it is the same shape of promise:
// the gate's second check (tools.js nestedSpawnRefusal) refuses every target a
// role's NESTED_SPAWN_TARGETS entry does not name, so a role with an empty set
// can spawn nothing however its `permission.spawn` reads — and the delegation
// guide would name it a target it cannot have (delegationGuideFor falls back to
// the researcher block for a role the target table does not key). For the roles
// as they ship the condition is inert: the six with `spawn` all have a target
// and the three without have neither. It bites only where a project opens
// `spawn` on a role the target table does not carry, which is exactly the case
// reading the resolved config makes reachable here.
async function delegatesNested(client, agent) {
  if (!isSubagentRole(agent)) return false
  if (getSettings().maxNestedSpawns <= 0) return false
  if (nestedSpawnTargets(agent).length === 0) return false
  return (await resolveSpawnPermission(client, agent)) === null
}

// Which of `agents` actually delegate, as a Set — the predicate above resolved
// once for a whole list, so the limits blocks below stay synchronous text
// builders with every decision already made.
//
// The limits blocks need it per TYPE and not for the session's own role: the
// fixed overhead a spawn of a type carries depends on which of the two spawn
// guides that type is given, and a type whose `spawn` the project denies is
// given the shorter one. Without this the figure would be the overhead of a
// prompt that type never receives.
async function delegatingRolesAmong(client, agents) {
  const delegating = new Set()
  for (const agent of agents) {
    if (await delegatesNested(client, agent)) delegating.add(agent)
  }
  return delegating
}

// The reduced limits block a DELEGATING subagent is shown, in place of the
// orchestrator's. It is built only on the primary branch above, so without
// this a planner sizing a researcher package would be working from numbers it
// has never seen — its own ceiling, what its own target costs, and the shares
// at which the size gate warns and refuses are all invisible to it otherwise.
//
// Three things and nothing more (the primary's block also carries maxSubagents,
// every spawnable type's budget and the showAgentcom sentence — none of which a
// subagent can act on):
//   - its own context budget, the ceiling its run is enforced against;
//   - the budget of every type THIS role may spawn (nestedSpawnTargets), each
//     with the fixed overhead a spawn of it pays and the headroom left of it,
//     rendered exactly as the primary's block renders an entry so the two read
//     as one number;
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
function formatDelegationLimitsNotice(agent, { projectMd, agentsMd, snapshot, delegatingRoles }) {
  const own = contextBudgetFor(agent)
  const targets = nestedSpawnTargets(agent)
  const targetLine =
    targets.length === 0
      ? "nothing"
      : targets
          .map((target) => {
            const budget = contextBudgetFor(target)
            if (budget <= 0) {
              return `${target} off (no context budget set — the package gate does not size against it)`
            }
            const fixed = fixedOverheadFor(target, { projectMd, agentsMd, snapshot, delegatingRoles })
            const headroom = Math.max(0, budget - fixed)
            return `${target} ${fmtTokens(budget)} (−${fmtTokens(fixed)} fixed → ${fmtTokens(headroom)})`
          })
          .join(", ")
  return (
    "\n\n---\n📐 agent-intercom: limits on the work you delegate.\n" +
    `Your own context budget: ${own > 0 ? fmtTokens(own) : "off"} — the ceiling this whole run ` +
    "is measured against, the returned text of what you spawn included.\n" +
    `Context budget of what you may spawn: ${targetLine}.\n` +
    "The second number is the fixed overhead every spawn of that type carries before your own " +
    "words, the third the headroom left of the budget for your prompt and its work.\n" +
    `Size your spawn prompt against that budget: keep it at or under ${percent(PACKAGE_WARN_SHARE)} ` +
    `of it; over ${percent(PACKAGE_REFUSE_SHARE)} the spawn is REFUSED and no subagent starts. ` +
    "Pass bulk material as a file path, never pasted inline.\n---\n"
  )
}

// The one figure of a delegating subagent's limits that moves inside its run:
// how much of the per-run nested quota is left. `chargeNestedSpawn` increments
// the counter this reads on every admitted nested spawn, so the first LLM call
// after a nested child returns renders a lower number — which is why the line is
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
function fixedOverheadFor(agent, { projectMd, agentsMd, snapshot, delegatingRoles }) {
  // The same assembly the transform injects, so the estimate cannot count a
  // block the subagent is not given: the delegation block a role actually gets
  // depends on the nesting setting and on the resolved config's
  // `permission.spawn` for that type, and the two blocks differ by ~250 tokens,
  // which is a real share of a 100k budget. `delegatingRoles` carries both
  // conditions, already resolved by delegatingRolesAmong.
  let text =
    guideBlocks({
      agent,
      delegates: delegatingRoles?.has(agent) === true,
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
// `event` hook (status/idle). Rows are the entries isActiveEntry admits — the
// same predicate the concurrency cap counts on — so an entry that holds no
// slot is not listed here either; a subagent that finished and was destroyed
// is not in the registry at all (event hook removes them on idle). Returns the
// empty string when there is nothing to show.
//
// Where retention is switched on, a second kind of row exists: a finished
// subagent that is being HELD. It is not active — it holds no slot and
// isActiveEntry refuses it — so it gets its own clearly separated section
// rather than another row, in the same words the `list` tool uses for it
// (tools.js listHandler), and the prose above the rows stops asserting a
// one-shot rule that no longer holds without exception. Both are gated on
// retentionActive — offered at load and switched on now — which at the shipped
// default of `maxRetainedSubagents = 2` is the live branch. Only under the
// rollback `maxRetainedSubagents = 0`, where nothing is ever retained, is this
// block byte for byte what it has always been.
//
// The minutes-left figure moves, and is rendered here rather than per step
// because the whole block is memoised per user turn (snapshotForTurn). Whole
// minutes, so it moves as rarely as a figure that moves can.
function formatSubagentSnapshot(primaryID) {
  const settings = getSettings()
  const retentionOn = retentionActive()
  const entries = [...registry.values()]
  const active = entries.filter((e) => isActiveEntry(e))
  const retained = retentionOn
    ? entries.filter((e) => entryLifecycle(e) === LIFECYCLE_RETAINED)
    : []
  if (active.length === 0 && retained.length === 0) return ""
  const owned = (e) => (e.parentID === primaryID ? "" : " · [other session]")
  const ctxOf = (e) => (e.ctxTokens == null ? "? ctx" : `${fmtTokens(e.ctxTokens)} ctx`)
  const rows = active.map((e) => {
    const state = effectiveState(e)
    const age = ageSeconds(e.spawnedAt)
    const last = e.lastActivity ? ` · last: ${e.lastActivity.slice(0, 80)}` : ""
    return `• ${e.handle} (${e.agent}) — ${state} · ${ctxOf(e)} · ${age}s${last}${owned(e)}`
  })
  if (!retentionOn) {
    return (
      "\n\n---\n📋 agent-intercom: active subagents across all orchestrator sessions in this process " +
      "(the subagent cap is global). They are one-shot — a finished subagent disappears from this " +
      "list. To stop one, use `abort` (only on user request); for more work, spawn a fresh " +
      "subagent:\n" +
      rows.join("\n") +
      "\n---\n"
    )
  }
  const retainedRows = retained.map((e) => {
    const left = retainedMinutesLeft(e, settings.retainedSubagentTtlMs)
    return `• ${e.handle} (${e.agent}) — retained · ${ctxOf(e)} · ${left}m left${owned(e)}`
  })
  return (
    "\n\n---\n📋 agent-intercom: active subagents across all orchestrator sessions in this process " +
    "(the subagent cap is global). A finished subagent disappears from this list unless it is " +
    "being held for a follow-up — those are listed under RETAINED below. To stop a running one, " +
    "use `abort` (only on user request); for more work, spawn a fresh subagent:\n" +
    (rows.length > 0 ? rows.join("\n") : "• none running") +
    (retainedRows.length > 0
      ? "\n\nRETAINED — finished, NOT running, holding no slot. Their sessions are still alive " +
        "and still hold the work they did, so you can put a follow-up question to one with " +
        'reuse("<handle>", "<question>") until its window runs out. After that it is gone and ' +
        "only spawn is left.\n" +
        retainedRows.join("\n")
      : "") +
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
// The session id an event belongs to, resolved from the four payload shapes
// the opencode SDK puts one in. Every event this plugin sees carries the id in
// exactly one of them:
//
//   properties.sessionID       — the session.* family (created aside) and
//                                message.removed: the id sits at top level.
//   properties.part.sessionID  — message.part.updated / message.part.removed,
//                                whose properties are `{ part, delta? }` and
//                                carry no top-level id at all.
//   properties.info.sessionID  — message.updated, whose `info` is a Message.
//   properties.info.id         — session.created / session.updated, whose
//                                `info` is a Session, so its `id` IS the
//                                session id.
//
// The order is load-bearing at the last two. A Message carries BOTH
// `sessionID` and `id`, and its `id` is the MESSAGE id (`msg_…`), which
// addresses no session — reading `info.sessionID` first is what keeps a `msg_`
// id out of the lookup.
//
// message.part.updated is the one that matters most: while a subagent streams
// a single long step it is the ONLY event that session emits, so a resolver
// that misses it leaves a working subagent looking silent to the inactivity
// watchdog, which then kills it mid-work.
export function eventSessionID(props) {
  return props?.sessionID ?? props?.part?.sessionID ?? props?.info?.sessionID ?? props?.info?.id
}

// The first call also arms the inactivity watchdog (see sweepWatchdog).
export function createEventHandler(client) {
  ensureWatchdogStarted(client)
  return async function handleEvent({ event }) {
    try {
      const props = event?.properties ?? {}
      // Bump the entry's lastActivityAt on EVERY event for a tracked session,
      // before dispatch — this is the dead-man's-switch signal for the
      // watchdog. A subagent that keeps emitting events is alive; one that
      // goes silent gets timed out. The id is resolved from every payload
      // shape the SDK puts one in (see eventSessionID). Done unconditionally:
      // touching a non-tracked session is a cheap Map miss.
      const sid = eventSessionID(props)
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
          //
          // The catch is not decoration. runEndlessCycle never throws and
          // maybeRunPendingEndless guards its own two pre-claim reads, but a
          // detached rejection from anywhere in that path would leave an
          // unclaimed latch standing — and an endless latch is the spawn
          // freeze, so `spawn` would refuse for the life of the process. The
          // drop is a no-op once the cycle has claimed the latch.
          void maybeRunPendingEndless(client, props?.sessionID).catch((err) => {
            dropEndlessLatch(props?.sessionID, `the cycle failed to start: ${errMsg(err)}`)
          })
          // The third relief, same discipline again: only a primary whose agent
          // has compaction switched on carries this latch, so it is a set
          // lookup and a return for every other idle. Detached because a
          // compaction is a whole LLM turn over the session's history, and
          // blocking the event stream on it would starve the subagent wakes
          // above. maybeRunPendingCompaction never rejects — it catches its own
          // body and releases the latch in a `finally` — so `void` hides no
          // unhandled rejection here.
          void maybeRunPendingCompaction(client, props?.sessionID)
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
          // The endless latch is set by the transform hook DURING the turn that
          // crosses the ceiling and is cleared only on that primary's own
          // `session.idle`. A turn that ends in an error instead of an idle —
          // and a turn at the endless ceiling is exactly where provider errors
          // live — would leave it set with nothing left to clear it: the
          // orchestrator stays alive, `spawn` refuses forever, and no cycle
          // ever runs. Drop it here; the next over-threshold turn arms again.
          //
          // Dropping rather than running the cycle: the session has just
          // failed, and the cycle's first act is to ask it for a long
          // open-points turn. onSessionError above owns the subagent case and
          // returns at once for a primary, which has no registry entry.
          dropEndlessLatch(props?.sessionID, "the primary's turn ended in a session error")
          break
        case "session.deleted":
          await onSessionDeleted(props, client)
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
  const title = typeof info.title === "string" ? info.title : ""
  const prompt = title.startsWith(SUBAGENT_SESSION_TITLE_MARKER)
    ? title.slice(SUBAGENT_SESSION_TITLE_MARKER.length)
    : title
  const entry = upsertSession(info.id, { prompt, parentID: info.parentID })
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
    // A retained or closing entry has already delivered the one result this
    // path exists to deliver. Its session is alive, so a stray idle can still
    // reach us — from the user typing into it, or from a reload — and must not
    // wake the parent a second time with the same reply.
    if (entryLifecycle(e) !== LIFECYCLE_RUNNING) return null
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
    // The same statement for the other thing that makes a running session fall
    // quiet without having finished: the plugin is compacting it. What goes
    // quiet here is the compaction turn, not the subagent — taking it would
    // hand the parent a result the subagent never wrote, free the slot, and
    // delete the session in the middle of a summarize request on it.
    //
    // Left untouched for the reason above it: `dispatched` is a one-way claim
    // and `status = "idle"` would make the watchdog skip this entry for good.
    // When the compaction ends, the latch clears, the subagent answers its
    // pending turn and goes idle again — that idle finds no compaction and runs
    // the normal path. If it never speaks again, the watchdog's own window on
    // the compaction, and then the silence window, are what end it.
    if (e.compactingSince) {
      log("idle held: subagent session is being compacted", {
        handle: e.handle,
        sessionID,
        compactingSince: e.compactingSince,
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
    // The run is over, so a question it was blocked on is over with it. Settled
    // inside this section, before the counters below are read: the ask ends as
    // unanswered and the exchange snapshot has to report it that way. Both
    // calls are synchronous and lock-free, so neither nests the mutex.
    //
    // A subagent blocked in `ask` is inside a tool call and does not go idle,
    // so on the ordinary path there is nothing here to settle; what this covers
    // is the session that fell quiet around the blocked call anyway — an
    // opencode-side error, a reload — where the waiter would otherwise hold on
    // in a session about to be deleted.
    settleAsk(sessionID, {
      status: "ended",
      detail: "the subagent's run ended while its question was open",
    })
    clearAsk(e, "ended")
    // Inline removeEntry (via removeEntryLocked) instead of awaiting removeEntry:
    // removeEntry itself is wrapped in runExclusive, and the FIFO mutex is
    // not re-entrant — nesting runExclusive inside runExclusive on the same
    // `_tail` would deadlock. The body is identical to removeEntry's; we just
    // skip the inner lock acquisition because we already hold the outer one.
    // Returns a real boolean synchronously, so the truthy-branch below is
    // correct (a missing entry now actually returns null instead of leaking
    // a truthy Promise object — that was the regression slice 1a introduced).
    // Retention: with `maxRetainedSubagents` above 0 a top-level subagent that
    // ended cleanly keeps its entry and its opencode session instead of being
    // disposed of here — the delivery above is untouched either way, the
    // orchestrator gets its result at the same moment. The decision is taken on
    // what this section already holds; the one condition it cannot see, a
    // `Blocked:` reply, is applied below once the result snapshot is in.
    const retention = retentionDecision(e, retentionCapacity())
    if (retention.retain) {
      retainEntryLocked(sessionID)
    } else {
      const removed = removeEntryLocked(sessionID)
      if (!removed) return null
    }
    // The entry is out of the registry (or, retained, no longer active) from
    // here on, so countActiveSubagents no longer sees this subagent — but its
    // result has not been delivered yet. Reserve the delivery window in the SAME critical section, so the
    // quiesce predicate never observes the gap between the two: an endless
    // cycle that fired its open-points prompt in that gap would replace the
    // primary while this very result was still on its way to it. Released in
    // the `finally` below, after the teardown.
    reservePendingDelivery()
    return {
      handle: e.handle,
      parentID: e.parentID,
      agent: e.agent,
      // A detached waiter already freed its nested spawn with `expired`, so
      // its eventual result needs the one notice route that may target a
      // tracked subagent. Capture the waiter address before settlement drops it.
      lateParentID: detachedParentOf(sessionID),
      taskId: e.taskId,
      directory: e.directory,
      // The cycle's wind-down child. Its result has already reached the
      // orchestrator as the return value of its own blocking spawn call, and
      // that orchestrator is being replaced, so no wake notice is posted for it
      // on either route.
      windDown: Boolean(e.windDown),
      packageTokens: e.packageTokens,
      // Read off the entry inside the critical section, with the rest of what
      // the notice needs: the entry is removed a few lines above and is gone
      // by the time the notice is composed.
      nested: { runs: e.nestedRuns ?? 0, tokens: e.nestedTokens ?? 0 },
      // Which run of this session just ended: 1 for a spawned one, higher for
      // every run a `reuse` started. The notice reports it so a follow-up run
      // is not read as a fresh subagent's, and labels the cumulative figures
      // that come with it.
      runs: e.runs ?? 1,
      // The mid-run traffic of this run, read here for the reason `nested` is:
      // the entry is removed a few lines above and is gone by the time the
      // notice is composed. `unread` is the steering the subagent never got to
      // read — it was still inside a tool call when it finished — and the
      // notice names it rather than letting a correction be silently lost.
      exchange: exchangeSnapshot(e),
      retained: retention.retain,
    }
  })
  if (!wake) return
  const { handle, parentID, agent, taskId, directory, packageTokens, nested, runs, exchange } = wake
  // Whether the session survives this path. Starts false and is only raised
  // once the result is in hand: a snapshot fetch or a notice that throws falls
  // through to the delete below, exactly as it did before retention existed.
  let retain = false
  // The other reason it survives: the reply had to be cut and the overflow file
  // could not be written, so this session is the only copy of what was cut. The
  // teardown then holds it instead of deleting it (see `hold`, teardown.js).
  // Raised from the cap's own report and never lowered by the notice failure
  // below — a wake that failed is one more reason not to destroy the state.
  let hold = false
  try {
    const snapshot = await fetchSnapshot(client, sessionID)
    // The retention conditions the critical section could not evaluate, both
    // read off the snapshot it did not have. A `Blocked:` report is not a
    // session to hand more work to — the task continues through a fresh spawn
    // carrying the orchestrator's decision. And a session whose context is
    // missing, over its type's reuse ceiling or over that type's budget would
    // be refused by every later reuse, so holding it would only occupy a
    // retained slot and offer the orchestrator a handle it cannot use.
    // A phase-1 grant either of them fails is revoked here, and the teardown
    // below disposes of the session on the very path it always used.
    if (wake.retained) {
      const context = retentionContextDecision(snapshot.ctxTokens, {
        ceiling: reuseCeilingFor(agent),
        budget: contextBudgetFor(agent),
      })
      retain = !isBlockedResult(snapshot.result) && context.retain
      if (retain) recordRetainedContext(sessionID, snapshot.ctxTokens)
      if (!retain) {
        log("retention revoked", {
          handle,
          agent,
          ctxTokens: snapshot.ctxTokens,
          reason: isBlockedResult(snapshot.result) ? "blocked" : context.reason,
        })
      }
    }
    // The reply token ceiling, applied HERE because this is where the text
    // crosses into another agent's context: the parent's wake notice and, when
    // a session is blocked on this one, that session's tool result. Both get
    // the same capped text, resolved against the FINISHED subagent's own type.
    //
    // Before the teardown below, on purpose: what the cut leaves out is written
    // to the overflow file while the session that holds the original still
    // exists, and the marker names that file. The two readings that are not a
    // context crossing — the `Blocked:` test above and the `DONE: T<n>` marker
    // below — keep the full text: a marker sits on the reply's LAST line and a
    // cut one would silently stop ticking off tasks.
    const reply = capReplyForAgent(snapshot.result, {
      handle,
      agent,
      sessionID,
      taskId,
      runs,
      // Where the overflow file goes: `work/` under this subagent's own project
      // directory, which is where the orchestrator's next subagent can read it.
      directory,
      // The decision as it stands after phase 2, so the marker cannot offer a
      // `reuse` on a session the teardown below is about to delete.
      retained: retain,
    })
    hold = Boolean(reply.error)
    // Hand the reply to a session blocked on this one, if there is one. This
    // is the only ending path that has a RESULT rather than just a cause, so
    // it settles here rather than leaving it to teardownSubagent's fallback —
    // which still runs below and is then a no-op. `ctxTokens` rides along
    // because what a nested run burned is invisible in the parent's own
    // figure.
    settleChildWaiter(sessionID, {
      status: "completed",
      handle,
      agent,
      result: reply.text,
      ctxTokens: snapshot.ctxTokens,
    })
    // Auto-tick TODO.md based on the subagent's `DONE: T<n>` marker, if it's
    // present and matches the spawn-assigned task id. Done BEFORE
    // removeEntry/postNotice so the completion notice can report the outcome.
    const taskOutcome = autoMarkTask(directory, taskId, snapshot.result)
    // The wind-down child posts nothing. The ordinary route would duplicate the
    // tool result the orchestrator already holds, and the late route through
    // detachedParentOf would post into a primary the cycle has retired by then;
    // the late result is logged and dropped instead.
    // Routed delivery: during an executing primary handoff the notice is
    // buffered (and flushed to the NEW orchestrator after its kickoff);
    // after a completed handoff a stale parentID is redirected. Never posts
    // into the old session's teardown window.
    if (wake.windDown) {
      log("wind-down child finished; no wake notice posted", {
        handle,
        parentID,
        late: wake.lateParentID === parentID,
        taskOutcome,
      })
    } else {
      await postParentNotice(
        client,
        parentID,
        completionNotice(
          handle,
          agent,
          reply.text,
          parentID,
          taskOutcome,
          snapshot.ctxTokens,
          packageTokens,
          nested,
          runs,
          // The decision as it stands after phase 2 revoked what the snapshot
          // refused, which is the last word on it: the teardown below acts on
          // this same value, so the notice cannot claim a session the delete is
          // about to take.
          retain,
          exchange,
          // The session is being kept because the cut part could not be filed;
          // the head must not call it destroyed while the result text says the
          // opposite.
          hold,
        ),
        { allowTrackedSubagent: wake.lateParentID === parentID, kind: "completion" },
      )
      showToast(client, {
        title: "agent-intercom",
        message: `${handle} finished`,
        variant: "success",
      })
      log("notified primary of completion", { handle, parentID, taskOutcome })
    }
  } catch (err) {
    log("notify parent failed", errMsg(err))
    // Fall through to cleanup of the underlying opencode session — keeping it
    // around would only leak: a subagent whose wake failed gets no retention
    // and no second attempt. If it failed, the user can re-prompt via the
    // primary.
    retain = false
  }
  try {
    await teardownSubagent(
      client,
      { sessionID, handle, parentID, agent },
      // `entryRemoved` is false whenever the critical section left the entry in
      // place: either it is being retained, and the teardown stops before the
      // delete, or the retention was revoked above and the teardown is the
      // thing that has to remove it.
      { entryRemoved: !wake.retained, retain, hold, label: "" },
    )
    if (retain) await evictRetainedOverCapacity(client)
  } finally {
    releasePendingDelivery()
  }
}

// A session this plugin tracks was deleted by somebody else. opencode publishes
// `session.deleted` for every session it removes, its own children included, so
// this is the one signal that reaches the plugin when a session goes away
// without a plugin path having taken it there.
//
// It matters for exactly one state: a RETAINED entry. A held subagent's session
// is the only one the plugin leaves standing with the entry still in the
// registry, and it is the one a user can end from outside — the sidebar's `x`
// on a held row deletes the session, because a held subagent is idle and there
// is no run to abort. Without this, the entry outlives its session until the
// window runs out or a `reuse` walks into the gap, and `list` names a handle
// that addresses nothing.
//
// Every other lifecycle is left alone, and deliberately:
//   - "closing" is this plugin's own delete, and the entry is already on its
//     way out through the path that started it;
//   - "running" is untouched here. Its session ending under it is a different
//     matter with a different answer — the parent is waiting for a result and
//     the inactivity watchdog is what tells it — and folding it into this
//     handler would silence that notice.
//
// The check and the removal run in one critical section: a reuse that revives
// the entry between them would otherwise have its fresh run deleted out of the
// registry.
//
// The drop is NOT silent: the parent was told this handle stays reachable, so
// it is told that it no longer is — see noticeRetentionLost below for why this
// drop is woken and the capacity evictions are not.
async function onSessionDeleted(props, client) {
  const sessionID = props?.sessionID ?? props?.info?.id
  if (!sessionID) return
  rememberDeletedSession(sessionID)
  const entry = entryForSession(sessionID)
  if (!entry || entryLifecycle(entry) !== LIFECYCLE_RETAINED) return
  // The whole descriptor, not just the handle: the entry is gone by the time
  // the notice is composed, and the notice names the agent type and the
  // session, and is addressed with the parentID the entry carried.
  const dropped = await registryMutex.runExclusive(() => {
    const e = entryForSession(sessionID)
    if (!e || entryLifecycle(e) !== LIFECYCLE_RETAINED) return null
    const descriptor = { handle: e.handle, agent: e.agent, parentID: e.parentID, sessionID }
    return removeEntryLocked(sessionID) ? descriptor : null
  })
  if (!dropped) return
  forgetSessionDirectory(sessionID)
  log("retained subagent dropped: its opencode session was deleted", {
    handle: dropped.handle,
    sessionID,
  })
  await noticeRetentionLost(client, dropped)
}

// Wakes the parent for the drop above, on the same footing as every other
// ending it is told about (completion, error, timeout) and through the same
// door, postParentNotice — so a handoff in flight buffers it and a completed
// one redirects it, exactly as it does for a wake notice.
//
// Only THIS drop is woken. The capacity drops next door —
// evictRetainedOverCapacity here, trimRetainedToCapacity in watchdog.js,
// dropRetainedSubagents on a handoff or an endless cycle — stay silent, and
// nothing in the code forces that: they run through dropRetainedSubagents,
// which takes a notice and is passed none. They are quiet because they are the
// decision the parent's own configuration asked for, taken at a moment the
// parent has no reason to act on: a handoff and a cycle are replacing the very
// primary that would be woken, and an eviction hands the room to a retention
// that primary just heard about. This one is different in kind — nothing the
// parent or its settings decided, no other signal that it happened, and the
// next `reuse` is otherwise where it finds out.
//
// Best-effort. A parent that cannot be reached costs a log line and nothing
// else: the entry is already out of the registry, so `list` and `reuse` are
// straight either way.
async function noticeRetentionLost(client, dropped) {
  if (!dropped.parentID) return
  // The cascade case: deleting a primary deletes its subagent sessions too, so
  // the session this notice would wake can be as gone as the one it reports
  // on. Posting into it would spend the post's whole retry budget on a session
  // nobody will ever read.
  if (await parentDeletedWithinGrace(dropped.parentID)) {
    log("retention-drop notice skipped: the parent session is gone too", {
      handle: dropped.handle,
      parentID: dropped.parentID,
    })
    return
  }
  try {
    await postParentNotice(client, dropped.parentID, retentionLostNotice(dropped), {
      kind: "retention-lost",
    })
    log("notified primary of a dropped retention", {
      handle: dropped.handle,
      parentID: dropped.parentID,
    })
  } catch (err) {
    log("retention-drop notice failed", {
      handle: dropped.handle,
      parentID: dropped.parentID,
      err: errMsg(err),
    })
  }
}

// How long the guard above waits for the parent's own `session.deleted` before
// it settles on "the parent is still there".
//
// opencode publishes a delete cascade depth-first POST-ORDER: every descendant
// first, the deleted session's own event LAST (read off session.ts `remove`,
// confirmed in the 1.18.27 binary and on a live `opencode serve`). So at the
// moment a held child's event is handled, `deletedSessions` CANNOT yet hold the
// parent — its event has not been published. Reading the map at that instant
// says "the parent is alive" for every cascade, whatever the reader does first:
// the plugin's handler is started synchronously inside the publish and its
// promise is voided, so awaiting more promises only yields the microtask queue
// while the parent's publish waits for a later run of opencode's event fiber.
// (Measured: the immediate read held for a parent with 1 or 2 children and
// missed for the earlier ones of 4 or 8, and missed for every direct child once
// a grandchild was in the tree.) An instantaneous existence probe against the
// server is the same race and not a fix — the parent genuinely still exists at
// that moment, and `GET /session/{parentID}` answered 200 for 3 of 8 children.
//
// The only signal that separates a cascade from a lone delete is the parent's
// own event, which is guaranteed to come and guaranteed to come later. So the
// wait crosses a MACROTASK boundary (setTimeout — another await would not do)
// and the map is read again afterwards.
//
// Sized from the measured cascade: ~3 ms per session, 28 ms for a parent with
// eight empty children. 400 ms sits an order of magnitude clear of that and
// costs nothing: the notice only wakes an ALREADY IDLE primary, and the entry
// left the registry before the wait began, so `list` and `reuse` answer
// correctly throughout it — only the wake is deferred.
export const RETENTION_DROP_NOTICE_GRACE_MS = 400

let retentionDropNoticeGraceMs = RETENTION_DROP_NOTICE_GRACE_MS

// Test seam: a suite that pins this behaviour would otherwise pay the full
// grace period per case. Called with no argument it restores the shipped value.
export function _setRetentionDropNoticeGraceForTests(ms) {
  retentionDropNoticeGraceMs =
    typeof ms === "number" && ms >= 0 ? ms : RETENTION_DROP_NOTICE_GRACE_MS
}

async function parentDeletedWithinGrace(parentID) {
  // The parent's event already came: this is a cascade seen from the far side
  // (a grandchild whose whole branch was published before it), and there is
  // nothing left to wait for.
  if (deletedSessions.has(parentID)) return true
  if (retentionDropNoticeGraceMs > 0) {
    // Ref'd on purpose, unlike the plugin's periodic timers: this one is a
    // step of a notice that is being delivered right now, and an unref'd
    // handle would let the process exit out from under it.
    await new Promise((resolve) => setTimeout(resolve, retentionDropNoticeGraceMs))
  }
  return deletedSessions.has(parentID)
}

// Bounded, because a long-lived instance deletes a session per finished
// subagent and the map would otherwise grow for the life of the process. The
// window only has to outlive one delete cascade, so size alone bounds it and no
// record is ever too old to keep. The map itself lives in state.js so
// resetState can clear it between tests; `trimByAgeAndSize` there is the one
// eviction rule both short-lived per-session memories share.
const DELETED_SESSION_MEMORY = 256

function rememberDeletedSession(sessionID) {
  const now = Date.now()
  // Re-inserted, so the record's place in the iteration is its age: a session
  // id is unique per creation, so a second event for one is opencode repeating
  // itself and the later moment is the truthful one.
  deletedSessions.delete(sessionID)
  deletedSessions.set(sessionID, now)
  trimByAgeAndSize(deletedSessions, now, { max: DELETED_SESSION_MEMORY })
}

// Trims the retained set back to `maxRetainedSubagents` after one more entry
// joined it, oldest first. The newest retention always wins: what strikes the
// orchestrator later is a question about a subagent it has already read, and
// the one it just heard about is the likeliest to be asked.
//
// The same drop the handoff and the endless cycle run, with a capacity left
// standing instead of zero — see dropRetainedSubagents in teardown.js for the
// claim-then-tear-down discipline and for why an eviction is silent.
//
// This keeps the set from growing past the capacity. A capacity that FALLS
// under an already-held set is the watchdog's (trimRetainedToCapacity in
// watchdog.js): no entry joins the set at that moment, so this call is not
// reached, and at capacity 0 no entry ever joins it again.
function evictRetainedOverCapacity(client) {
  return dropRetainedSubagents(client, { keep: retentionCapacity() })
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
// touching it. It may equally fire for a subagent of ours that has no run in
// flight — a retained session the user typed into, or one whose teardown is
// already under way — and the lifecycle guard leaves those alone.
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
  // Lifecycle guard, the same one onSessionIdle carries. A retained or closing
  // entry has no live run for this event to belong to: its session is still
  // there and can still produce errors — the user typing into a held session,
  // a reload, a provider failure on a turn this plugin never started — and
  // there is nothing to tear down or report on. Handling it as a live run is
  // worse than doing nothing, because `errored` is a one-way latch: it would
  // stay on the entry through the next reuse and kill THAT run's wake notice
  // at the `|| e.errored` test, leaving the follow-up answered and undelivered
  // and its concurrency slot held.
  if (entryLifecycle(entry) !== LIFECYCLE_RUNNING) {
    log("session.error on a subagent with no live run — ignored", {
      handle: entry.handle,
      sessionID,
      lifecycle: entryLifecycle(entry),
    })
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
  // Read the session ONE more time before teardown deletes it, purely to
  // recover the last text the subagent produced. A provider failure — a
  // context-length error above all — lands on a session that has usually done
  // real work, and the error notice used to carry none of it, so the
  // orchestrator had no choice but to re-dispatch the whole task blind.
  // Best-effort by construction: fetchSnapshot swallows its own failures and
  // returns {}, and the notice simply omits the block when nothing came back.
  //
  // The read waits for the session to go quiet FIRST, and that ordering is
  // what makes it worth doing. opencode publishes `session.error` from inside
  // its run fiber's interrupt handler, ahead of the finalizer that flushes the
  // in-flight text part; while a run is streaming, only that part's empty
  // opening row is in the database and the text itself is in opencode's
  // memory. A snapshot taken on receipt of this event therefore sees nothing
  // of the paragraph the subagent was in the middle of and falls back to
  // whatever it had completed before — which on the motivating case, a
  // context-length death, is exactly the part worth having. The flush reports
  // itself as `session.idle`; the delete below already waits for it, and this
  // is the same wait, moved in front of the read. Bounded by
  // SESSION_QUIESCE_TIMEOUT_MS like every other use of it, so a session that
  // never reports idle delays this notice by that much and no more.
  const quiesceReason = await waitForSessionQuiescence(sessionID)
  if (quiesceReason === "timeout") {
    log("session.error: session quiescence timed out; reading anyway", {
      handle: entry.handle,
      sessionID,
    })
  }
  const snapshot = await fetchSnapshot(client, sessionID)
  // The mid-work securing rule (secureSubagentState, src/resultfile.js): this
  // is not a completed run whose result the orchestrator now holds — the
  // subagent was stopped in the middle of its work, and the teardown below
  // deletes the only session that held it. So the rescued text goes to its
  // result file whatever its size, before the delete and while the session
  // still exists, and the file is what the state can be read back from
  // afterwards. Wiring the hold to the CUT alone is what lost a coder's whole
  // run on an abort: its rescued reply fitted the ceiling, so nothing was
  // filed and the session was deleted regardless.
  //
  // The same call also applies the reply ceiling to what the notice carries,
  // for the reason the idle path applies it: a session that died of a
  // context-length error is exactly the one whose last text is longest.
  // `retained: false` — an errored subagent is never offered for reuse.
  const recovered = secureSubagentState(snapshot, {
    handle: entry.handle,
    agent: entry.agent,
    sessionID,
    taskId: entry.taskId,
    runs: entry.runs ?? 1,
    directory: entry.directory,
    retained: false,
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
    notice: errorNotice(
      entry,
      errText,
      wasAborted,
      recovered.text,
      !recovered.secured,
      recovered.holdReason ?? "unfiled",
    ),
    toast: {
      title: "agent-intercom",
      message: wasAborted ? `${entry.handle} aborted` : `${entry.handle} failed`,
      variant: wasAborted ? "warning" : "error",
    },
    markAborted: true,
    // The rule for every ending that is not a completed run: the session goes
    // only where its state reached a file. Held where the write failed and
    // where the session could not be read at all — in both cases this session
    // is the only remaining copy of the run, and the notice above says which
    // of the two it is.
    hold: !recovered.secured,
    // The wait above already ran to its end for this session; the teardown
    // must not arm a second one for an idle event that has already come.
    quiesced: true,
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
//   { kind: "unmigrated", id } — the id stands only in a legacy line outside
//                          the plugin's marked section; nothing was removed
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
    const res = removeTask(directory, taskId)
    // The task is finished, but its line stands outside the plugin's marked
    // section, where no writer of this plugin touches anything. Neither an
    // error nor a greenfield: the line is left exactly as it is and the next
    // wind-down migrates it.
    if (res?.unmigrated) return { kind: "unmigrated", id: taskId }
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
//    orchestrates and delegates, it does not do work itself. In SOLO mode that
//    restriction does not apply — the primary is the worker there and keeps its
//    tools; opencode's native `task` stays denied on both branches.
//
// Bound to a client so it can read live state, though the budget path no
// longer aborts: notification of the parent happens in contextLimitNotice
// when the LLM-turn-based threshold is crossed; the guard only denies.
export function createGuardToolExecute(client, permissionGuard) {
  const guard = async function guardToolExecute(input) {
    const sessionID = input?.sessionID
    if (!sessionID) return

    if (aborted.has(sessionID)) {
      log("denied tool call from aborted session", { sessionID, tool: input.tool })
      throw new Error(
        "agent-intercom: this subagent has been aborted by the orchestrator — no further tool calls permitted.",
      )
    }

    const entry = entryForSession(sessionID)

    // A tool call is a sign of life towards the watchdog, and this is the only
    // place the plugin sees one. opencode publishes nothing at all between the
    // part that announces a tool call and the part that reports its result —
    // its own `bash` tool blocks for up to 120 000 ms by default and 600 000 ms
    // on request — so a subagent inside one long call is indistinguishable, on
    // events alone, from a hung LLM call, and the sweep reaps it mid-command.
    //
    // Two records, from one clock read so they compare exactly:
    //   lastActivityAt — the sign of life itself.
    //   toolCalls      — this call, under its callID, as IN FLIGHT. While the
    //                    map is non-empty the subagent is working, and the
    //                    sweep measures the entry against maxSubagentToolCallMs
    //                    (from the oldest call's start) instead of the silence
    //                    window. The call comes out again in
    //                    recordToolCallFinished, on `tool.execute.after`.
    //
    // Done BEFORE every deny below, deliberately: a denied call is still the
    // model producing, and a subagent locked down to a text-only handover must
    // not be reaped while it writes that handover. A denied call never runs and
    // never gets an `after`, so the in-flight record it made here is taken back
    // out by the wrapper this guard is returned in — see createGuardToolExecute.
    if (entry) {
      const seenAt = Date.now()
      entry.lastActivityAt = seenAt
      beginToolCall(entry, input.callID, input.tool, seenAt)
    }

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
      //
      // Read from AGENT_STARTING_TOOLS (through its derived set) rather than
      // tested against the literal, so this deny and the solo primary's cannot
      // drift apart over which names start an agent. NOT the solo set: the
      // plugin's own `spawn` is a legitimate nested spawn for the roles
      // NESTED_SPAWN_TARGETS names, and it is gated in its own handler.
      if (agentStartingTools.has(input.tool)) {
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
            "reviewer / documenter / designer. The researcher, grounder and gitter agents do not " +
            "touch " +
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
        // The mid-run channel survives the lockdown. `message` and `ask` are
        // how a subagent reaches its caller while it runs, and a subagent that
        // has just been told to wind down is exactly the one with something to
        // say — a question whose answer decides what its final reply contains,
        // or a note its caller needs before the session is gone. Both cost the
        // session almost nothing: a handful of tokens each, against the work
        // tools this lockdown exists to stop.
        //
        // Held off while a compaction of this session is in flight. The
        // lockdown is then temporary — the run continues in the compacted
        // session and the channel comes back with it — and `ask` would park an
        // unreturned tool call in a session being summarized underneath it,
        // the very thing startSubagentCompaction refuses to do to an open
        // question (src/compaction.js).
        //
        // Returning here deliberately skips the counter reset below: the entry
        // is still over its budget, and clearing stopInjections /
        // notifiedParentOfLoop on a `message` call would reopen the escalation
        // ladder from the bottom and let the parent be notified a second time.
        if (midRunMessagingTools.has(input.tool)) {
          if (!entry.compactingSince) {
            log("mid-run channel admitted over context budget", {
              handle: entry.handle,
              tool: input.tool,
              ctxTokens: entry.ctxTokens,
              limit: maxContext,
            })
            return
          }
          // The compaction case, and its own refusal: a STOP escalation would
          // be wrong here — nothing is being wound up, the channel is held for
          // the length of one summarize and comes back with the compacted
          // session. Not counted in `budgetDenials` either: that counter feeds
          // the stuck-in-a-denial-loop notice, and a call refused by a
          // compaction is not a subagent ignoring a stop sign.
          log("mid-run channel held: session is compacting", {
            handle: entry.handle,
            tool: input.tool,
          })
          throw new Error(
            `agent-intercom: \`${input.tool}\` is held while your session is being compacted — ` +
              "your history is being replaced by a summary of it right now. Make no tool call on " +
              "this turn; the channel is open again on your next one.",
          )
        }
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
        // Every tool that reaches here is a work tool — the channel's two are
        // returned or refused above — so each rung can say what is still open.
        // Left unsaid where `midRunMessaging` is off: the two tools then refuse
        // every call in their own handlers, and the refusal would be pointing
        // at a channel that is not there.
        const channelNote = getSettings().midRunMessaging
          ? " `message` and `ask` still reach your caller."
          : ""
        const escalation =
          level >= BUDGET_NOTIFY_AFTER
            ? "🛑🛑🛑 FINAL. The orchestrator and user have been notified that you are stuck. " +
              `No work tool will succeed.${channelNote} Your path forward: write a plain-text ` +
              'message starting with "Done:" or "Blocked:".'
            : level === 2
              ? `🛑🛑 SECOND WARNING (turn ${level}/${BUDGET_NOTIFY_AFTER}). You have ignored ` +
                "the previous STOP injection. One more over-budget turn and the orchestrator + " +
                `user will be notified.${channelNote} Write a plain-text message starting with ` +
                '"Done:" now.'
              : "🛑 STOP. Your context budget is exhausted; work tools are disabled." +
                `${channelNote} Write a plain-text message starting with "Done:" (1–2 ` +
                "sentences) and return."
        throw new Error("agent-intercom: " + escalation)
      }
      // Tool call accepted — clear stale counters from a previous near-budget
      // burst that recovered (e.g. after a compact).
      if (entry.budgetDenials) entry.budgetDenials = 0
      if (entry.stopInjections) entry.stopInjections = 0
      if (entry.notifiedParentOfLoop) entry.notifiedParentOfLoop = false
      return
    }

    // Not a tracked subagent -> a primary session.
    //
    // Solo mode first: there the primary is the only agent there is, so it runs
    // its tools itself and nothing here refuses them — except what SOLO_DENIED_
    // TOOLS names. That is opencode's native `task`, denied for the same reason
    // the deny map denies it (SOLO_PRIMARY_PERMISSION, src/agents.js), plus the
    // plugin's own spawn / reuse / abort, which solo mode does not register at
    // all. A tool that reappears in the schema by a route the tool map does not
    // decide — a project override, a refactor, a future direct caller — is
    // refused here whatever put it there. This is the primary's counterpart to
    // the unconditional subagent-side deny above, and the two read the same set
    // for the names that start an agent, so they cannot drift.
    if (soloModeActive()) {
      if (soloDeniedTools.has(input.tool)) {
        log("denied second-agent tool from solo primary", { sessionID, tool: input.tool })
        throw new Error(
          `agent-intercom: solo mode runs one agent — you. \`${input.tool}\` would start or ` +
            `address a second agent, which is not available here; do the work yourself with ` +
            `your own tools.`,
        )
      }
      // Defense in depth, the primary's counterpart to the subagent-side
      // re-check further up, and it is only in solo mode that a primary needs
      // one. Under the orchestrator pattern the allowlist below refuses
      // everything outside PRIMARY_TOOLS, so a `permission.<tool> = "deny"` a
      // project writes on the primary's entry can add nothing. Solo mode drops
      // that allowlist — the primary IS the worker and runs its own tools — and
      // leaves the deny with only the LLM-side schema strip behind it. If the
      // strip is bypassed (a project override, an MCP plugin re-adding a tool,
      // a future opencode change to how tools merge), this hard-denies.
      //
      // `permission.task` is skipped by checkToolPermission itself (config.js),
      // so this does not collide with the unconditional `task` deny above.
      if (permissionGuard) {
        const agent = primaryAgentNameFor(sessionID)
        const reason = await permissionGuard.checkToolPermission(agent, input.tool)
        if (reason) {
          log("denied tool call: per-agent permission deny", {
            sessionID,
            agent,
            tool: input.tool,
            reason,
          })
          throw new Error(`agent-intercom: ${reason}. This tool is in the agent's deny map.`)
        }
      }
      return
    }

    // The orchestrator pattern: a primary may only run the intercom tools
    // (spawn/abort/list); everything else it must delegate.
    if (!PRIMARY_TOOLS.has(input.tool)) {
      log("denied non-orchestration tool from primary", { sessionID, tool: input.tool })
      const hint =
        input.tool === "task"
          ? "Use `spawn(agent, prompt)` instead — it starts the subagent non-blocking."
          : "Spawn a subagent and describe the *goal* you want — do not mention the tool. How the " +
            "subagent reaches the goal is its own concern, not yours."
      throw new Error(
        `agent-intercom: this is an orchestrator session — it delegates work, it does not run ` +
          `\`${input.tool}\` itself. ${hint} Available orchestration tools: ${availablePrimaryTools()}.`,
      )
    }

    // Anti-polling: small LLMs habitually re-call `list` instead of ending the
    // turn after a spawn — the snapshot in the system prompt already shows the
    // same info each turn, and finished subagents wake the primary on their
    // own. One `list` per "stretch" is enough; the second back-to-back call is
    // denied. Any other tool call (spawn/abort) resets the streak.
    if (input.tool === "list" && lastPrimaryTool.get(sessionID) === "list") {
      log("denied back-to-back list from primary", { sessionID })
      // The denied call never executes. Clear the marker so one refusal does
      // not latch this primary out of list for the rest of its session.
      lastPrimaryTool.delete(sessionID)
      throw new Error(
        "agent-intercom: don't call `list` twice in a row. End your turn — you will be woken.",
      )
    }
    lastPrimaryTool.set(sessionID, input.tool)
  }

  // The in-flight record the guard makes on entry is taken back out again on
  // every throw, and this wrapper is the only place that can do it: a denied
  // call never executes, so opencode never sends `tool.execute.after` for it,
  // and the record would sit in the map for the life of the entry. Nothing
  // would then read the subagent as anything but working — with
  // `maxSubagentToolCallMs` at 0 that is a subagent no clock ever ends, and
  // with a finite window it is a slot held for the whole of it over a call that
  // ran for no time at all.
  //
  // The bump of `lastActivityAt` the guard made is deliberately KEPT: the
  // denied call is still the model producing, and the silence window the entry
  // falls back to here measures from that bump.
  return async function guardToolExecuteTracked(input) {
    try {
      return await guard(input)
    } catch (err) {
      const entry = input?.sessionID ? entryForSession(input.sessionID) : undefined
      if (entry) endToolCall(entry, input.callID)
      throw err
    }
  }
}

// The other end of the in-flight record: opencode calls this once the tool has
// produced its output, which is the first moment after a long call in which the
// plugin hears anything about this session at all.
//
// Two effects, and both are needed. The call comes out of `entry.toolCalls`, so
// a subagent that is no longer working goes back onto the silence window
// instead of keeping the wide one for the rest of its run; and the return is
// itself a sign of life, so the silence window it goes back onto is measured
// from now rather than from the start of a call that may have taken minutes.
//
// Best-effort and total: an untracked session, an unknown callID and a second
// `after` for the same call all end here as a no-op.
export function recordToolCallFinished(input) {
  const sessionID = input?.sessionID
  if (!sessionID) return false
  const entry = entryForSession(sessionID)
  if (!entry) return false
  endToolCall(entry, input.callID)
  entry.lastActivityAt = Date.now()
  return true
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
