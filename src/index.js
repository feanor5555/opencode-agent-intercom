// opencode-agent-intercom
//
// Gives the primary agent a non-blocking spawn channel to one-shot subagents:
//
//   spawn  — start a subagent non-blocking (own session + promptAsync)
//   abort  — cooperatively abort a subagent + hard-deny its further tool calls
//            (intended for user-requested stops, not orchestrator-driven)
//   list   — list active subagents
//
// One-shot lifecycle: a spawned subagent runs to a single reply, that reply is
// delivered to the primary via a wake notice, and the subagent + its opencode
// session are then destroyed. There is no mid-flight communication channel; if
// the orchestrator wants more work in the same area, it spawns a fresh subagent.
//
// Mechanism: the plugin owns subagent session creation, so it knows every
// sessionID directly and hands the primary a friendly handle (e.g.
// "researcher#1"). When a subagent goes idle the `event` hook wakes its primary
// via `promptAsync`, pushes the subagent's full result, removes the entry from
// our registry and deletes the underlying opencode session. There is no
// status-poll tool by design.
//
// Enforcement (always on): primary sessions are denied the blocking native
// `task` tool and get the orchestration protocol injected into their system
// prompt, so the async-orchestration pattern works in any project without
// per-project config. Enforcement is the plugin's core purpose — to opt out,
// remove the plugin.
//
// On spawn the subagent's task is prefixed with a light project snapshot (root,
// package.json identity, shallow file tree) so it does not start blind. While a
// subagent runs, its context size is watched; once it reaches the budget every
// tool call from that subagent is hard-denied, locking it down to a text-only
// handover back to the orchestrator.
//
// `maxSubagents` and the legacy `maxContext` fallback resolve as file > env var > default: the
// companion TUI plugin can change them live by writing
// ~/.config/opencode/agent-intercom.json — no opencode restart needed.
//
// Configuration (environment variables, all optional):
//   OPENCODE_AGENT_INTERCOM_DEBUG               on by default; "0" disables logging to
//                                               ~/.cache/opencode-agent-intercom/debug.log
//   OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS  "1" (default) to honor the caller's
//                                               `permission.task` allowlist in `spawn`, "0" to ignore it
//   OPENCODE_AGENT_INTERCOM_MAX_CONTEXT         legacy fallback for every agent type without an own `agentContext` entry;
//                                               "0" disables the wrap-up nudge. Overridden by the
//                                               settings file if present.
//   OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS       max subagents one primary may run at once
//                                               (default 1); "0" for no cap. Overridden by the
//                                               settings file if present.
//   OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT     "1" (default) to prepend the project snapshot on
//                                               spawn, "0" to disable it
//   OPENCODE_AGENT_INTERCOM_COMPACTION          "1" switches automatic compaction ON for every
//                                               agent type the settings file's `agentCompaction`
//                                               map does not name, "0" (the default) off.
//                                               opencode's own automatic compaction is switched
//                                               off in every mode whatever this says; what the
//                                               value governs is the compaction the plugin
//                                               drives itself. Overridden by the settings file
//                                               (`compaction`, `agentCompaction`) if present.
//   OPENCODE_AGENT_INTERCOM_AGENT_MODE         "orchestrator" (default) runs the primary as the
//                                               orchestrator pattern this plugin enforces;
//                                               "solo" runs the primary as a single agent that
//                                               does the work itself, with no subagent of any
//                                               kind starting (none of spawn/abort/list/reuse,
//                                               opencode's native task denied, the plugin's
//                                               subagent roles disabled, the hidden title and
//                                               summary agents switched off, endless mode
//                                               counting as off, and the orchestration guide
//                                               and limits block not injected). Latched at
//                                               plugin load — a
//                                               change needs an opencode restart and holds
//                                               across every further restart until it is
//                                               switched back. Overridden by the settings
//                                               file (`agentMode`) if present.
//                                               ~/.config/opencode/agent-intercom.json carries
//                                               "agentMode": "orchestrator" | "solo".

import { createPermissionGuard } from "./config.js"
import { createTools } from "./tools.js"
import {
  createTransformSystem,
  createTransformMessages,
  createEventHandler,
  createGuardToolExecute,
  recordToolCallFinished,
  rewritePendingTools,
} from "./hooks.js"
import { installAgents, suppressBuiltinAgentTurns } from "./agents.js"
import { applyCompactionPolicy } from "./compaction.js"
import { recordSessionAgent } from "./registry.js"
import { chatParamsHook } from "./llmparams.js"
import { chatMessageHook, applyModelChoices, messageAgent } from "./llmmodel.js"
import { captureSystem, captureMessages, captureParams } from "./reqlog.js"
import { setServerUrl } from "./client.js"
import { startAgentcomVisibilityWatch } from "./agentcomsync.js"
import { sweepOrphanedSubagentSessions } from "./teardown.js"
import { pruneResultFiles } from "./resultfile.js"
import { replayPendingNotices } from "./noticejournal.js"
import { log } from "./log.js"

// The overflow-file prune is a cache sweep, not per-session work: opencode
// calls this factory once per session in one process, and one pass over a
// directory of at most a few dozen files is enough for the life of that
// process.
let resultFilesPruned = false

// The notice-journal replay is likewise a once-per-process pass, not
// per-session work: it walks one cache directory and settles what a previous
// process left pending.
let pendingNoticesReplayed = false

// NOTE: this module must have exactly ONE export — the default factory.
// opencode 1.14.48 treats every named export of a plugin module as its own
// plugin factory and crashes on anything that isn't one. The test-only state
// reset therefore lives in state.js (`resetState`), which the tests import
// directly — it must never be re-exported from here.

export default async (ctx) => {
  const { client, directory, worktree, serverUrl } = ctx
  log("agent-intercom initialized")

  // The TUI view switch after a handoff posts `/tui/select-session` where the
  // resolved SDK client carries no method for it. `serverUrl` reaches the
  // plugin only here, in the factory context, and is the LAST route of that
  // switch, not the first: on an interactive TUI instance opencode reports the
  // placeholder `http://localhost:4096` because that instance runs no HTTP
  // listener at all. The client goes along so the resolved address is logged
  // once, next to whether that client can carry a raw route post.
  setServerUrl(serverUrl, client)

  // The `show agentcom` switch governs the parts already in the transcript, not
  // only the ones posted from here on: the companion TUI writes the setting
  // file and this loop observes the change and rewrites the `synthetic` flag on
  // the notices this plugin posted into its primaries. Idempotent and unref'd,
  // so the per-session factory call starts exactly one loop per process and it
  // never holds the process open. Best-effort — see agentcomsync.js.
  startAgentcomVisibilityWatch(client)

  // The reload leak: a subagent session this plugin left behind when it was
  // last unloaded — one being HELD for a follow-up, or one still running when
  // the process went — is still there, and nothing in opencode will ever delete
  // it: no session TTL, no garbage collection, and no shutdown hook the plugin
  // could have used. One pass at load deletes what can only be such a leftover,
  // at every setting. The sweep starts on the next event-loop turn so its
  // session.list request cannot hold up this factory or server bootstrap.
  setImmediate(() => {
    void sweepOrphanedSubagentSessions(client, { directory }).catch((err) => {
      log("bootstrap sweep failed", err?.message ?? String(err))
    })
  })

  // The other leftover a load has to clear: the overflow files behind the reply
  // token ceiling. Nothing removes them on the wake path — once the subagent's
  // session is deleted such a file is the only copy of the cut text — so a
  // single pass here drops what is older than RESULT_FILE_TTL_MS. Same
  // next-event-loop-turn discipline as the sweep above, so the fs walk cannot
  // hold up this factory; pruneResultFiles never throws.
  if (!resultFilesPruned) {
    resultFilesPruned = true
    setImmediate(() => {
      pruneResultFiles()
    })
  }

  // The third leftover, and the one whose loss is silent: a parent notice this
  // plugin posted and never got confirmed into the target session. opencode's
  // `prompt_async` answers 204 the moment it has FORKED the fiber that writes
  // the message row, so a wake notice can be accepted and never persisted, and
  // the process can go before anything notices. Every such notice is journalled
  // before it is posted (src/noticejournal.js); this pass confirms what a dead
  // process left pending and posts again what really is missing, so an ending
  // is not lost across a crash. Same next-event-loop-turn discipline as the two
  // sweeps above — it makes one bounded read per pending entry and never
  // throws.
  if (!pendingNoticesReplayed) {
    pendingNoticesReplayed = true
    setImmediate(() => {
      void replayPendingNotices(client)
        .then((counts) => {
          if (counts.pending > 0) log("notice journal replay", counts)
        })
        .catch((err) => {
          log("notice journal replay failed", err?.message ?? String(err))
        })
    })
  }

  const permissionGuard = createPermissionGuard(client)
  const transformSystem = createTransformSystem(client)
  const transformMessages = createTransformMessages(client)

  return {
    // Inject the plugin's agent roles (orchestrator + 8 subagents) into the
    // resolved config, so the orchestration pattern needs no per-project
    // `.opencode/agents/*.md`. A project can still override any role by name;
    // what it displaces is recorded in the override register and reported to
    // the user, and the per-tool-key permission merge is the one field where
    // the plugin's denies survive an override that named no key. `directory`
    // is the project a finding and this instance's `default_agent` are filed
    // under — the same value opencode puts in `session.directory`, so the
    // report reaches the sessions it belongs to; `worktree` only widens the
    // search for the file a finding names.
    config: async (config) => {
      try {
        installAgents(config, { directory, worktree })
      } catch (err) {
        log("config hook error", err?.message ?? String(err))
      }
      // Switch opencode's automatic compaction off, in BOTH agent modes and
      // whatever the settings say. opencode's switch is global and has no
      // per-agent form, so the plugin owns it: compaction is off for every
      // agent that does not carry its own `agentCompaction: true`, and the
      // side that says ON is the plugin's own driver. The write reads no
      // setting, which is what lets that per-agent switch be read live instead
      // of being latched with this config.
      try {
        applyCompactionPolicy(config)
      } catch (err) {
        log("config compaction hook error", err?.message ?? String(err))
      }
      // Solo mode only: stop opencode's own hidden `title` and `summary`
      // agents from taking a turn. They start on opencode's own
      // initiative and not through a tool call, so no guard of this plugin is
      // on their path — this config write is the only place they can be
      // reached. A no-op in the orchestrator pattern. Runs BEFORE
      // applyModelChoices so a model choice stored for one of those names still
      // lands on the entry this created.
      try {
        suppressBuiltinAgentTurns(config)
      } catch (err) {
        log("config builtin-agent hook error", err?.message ?? String(err))
      }
      // Make the per-agent model choice from ~/.config/opencode/llm-models.json
      // permanent: written into `config.agent[name].model` it also holds for
      // prompts that never reach the `chat.message` hook below. Bootstrap-only
      // — a change to the file lands on the next opencode start, the message
      // hook is what applies it live. An agent with no choice keeps whatever
      // model opencode resolves for it, and what a pin displaces is kept so
      // the message hook can put it back once the choice is removed.
      try {
        applyModelChoices(config)
      } catch (err) {
        log("config model hook error", err?.message ?? String(err))
      }
    },
    tool: createTools({ client, directory, permissionGuard }),
    "experimental.chat.system.transform": async (input, output) => {
      await transformSystem(input, output)
      try {
        captureSystem(input, output)
      } catch (err) {
        log("reqlog system error", err?.message ?? String(err))
      }
    },
    // Two jobs on the message list: repair pending tool-parts left behind by a
    // denied tool call, and deliver the per-turn notices that stay out of the
    // system prompt so the cached prefix holds — see hooks.js.
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        rewritePendingTools(output?.messages)
      } catch (err) {
        log("rewritePendingTools error", err?.message ?? String(err))
      }
      try {
        await transformMessages(output?.messages)
      } catch (err) {
        log("transformMessages error", err?.message ?? String(err))
      }
      try {
        captureMessages(input, output)
      } catch (err) {
        log("reqlog messages error", err?.message ?? String(err))
      }
    },
    // Apply the per-agent model choice from ~/.config/opencode/llm-models.json.
    // `chat.params` cannot do this — its output carries only sampling fields —
    // so the model is set on the outgoing user message instead. Companion TUI
    // panel writes that file; a choice takes effect on the next message without
    // an opencode restart. An agent with no choice keeps opencode's own model,
    // except where the `config` hook pinned one at bootstrap — then the value
    // that pin displaced is put back, so a removed choice stops running at the
    // next message instead of at the next opencode start.
    "chat.message": async (input, output) => {
      // Record which agent this turn runs as, before anything else can throw.
      // opencode triggers this hook inside createUserMessage, ahead of the
      // request loop that triggers the system transform, so the transform of
      // this very turn can read the name back — see hooks.js
      // resolvePrimaryAgent, whose first rung this is.
      try {
        recordSessionAgent(input?.sessionID, messageAgent(input, output))
      } catch (err) {
        log("session agent record error", err?.message ?? String(err))
      }
      try {
        chatMessageHook(input, output)
      } catch (err) {
        log("chat.message hook error", err?.message ?? String(err))
      }
    },
    // Apply per-agent LLM parameter overrides from ~/.config/opencode/llm-params.json
    // before each request. Companion TUI panel writes that file; values take
    // effect on the next request without an opencode restart.
    "chat.params": async (input, output) => {
      try {
        chatParamsHook(input, output)
      } catch (err) {
        log("chat.params hook error", err?.message ?? String(err))
      }
      try {
        captureParams(input, output)
      } catch (err) {
        log("reqlog params error", err?.message ?? String(err))
      }
    },
    event: createEventHandler(client),
    "tool.execute.before": createGuardToolExecute(client, permissionGuard),
    // The end of a tool call, and the only event the plugin gets about a
    // session that has been silent inside one: it takes the call out of the
    // entry's in-flight map, which is what puts the subagent back on the
    // silence window (see recordToolCallFinished, hooks.js).
    //
    // Wrapped like every other hook here: a throw out of this one would turn a
    // tool call that succeeded into a failed one for the subagent that made it.
    "tool.execute.after": async (input) => {
      try {
        recordToolCallFinished(input)
      } catch (err) {
        log("tool.execute.after hook error", err?.message ?? String(err))
      }
    },
  }
}
