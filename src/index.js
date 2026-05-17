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
// `maxSubagents` and `maxContext` resolve as file > env var > default: the
// companion TUI plugin can change them live by writing
// ~/.config/opencode/agent-intercom.json — no opencode restart needed.
//
// Configuration (environment variables, all optional):
//   OPENCODE_AGENT_INTERCOM_DEBUG               on by default; "0" disables logging to
//                                               /tmp/opencode-agent-intercom/debug.log
//   OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS  "1" (default) to honor the caller's
//                                               `permission.task` allowlist in `spawn`, "0" to ignore it
//   OPENCODE_AGENT_INTERCOM_MAX_CONTEXT         subagent context budget in tokens (default 40000);
//                                               "0" disables the wrap-up nudge. Overridden by the
//                                               settings file if present.
//   OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS       max subagents one primary may run at once
//                                               (default 5); "0" for no cap. Overridden by the
//                                               settings file if present.
//   OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT     "1" (default) to prepend the project snapshot on
//                                               spawn, "0" to disable it

import { createPermissionGuard } from "./config.js"
import { createTools } from "./tools.js"
import {
  createTransformSystem,
  createEventHandler,
  createGuardToolExecute,
  rewritePendingTools,
} from "./hooks.js"
import { installAgents } from "./agents.js"
import { chatParamsHook } from "./llmparams.js"
import { captureSystem, captureMessages, captureParams } from "./reqlog.js"
import { log } from "./log.js"

// NOTE: this module must have exactly ONE export — the default factory.
// opencode 1.14.48 treats every named export of a plugin module as its own
// plugin factory and crashes on anything that isn't one. The test-only state
// reset therefore lives in state.js (`resetState`), which the tests import
// directly — it must never be re-exported from here.

export default async (ctx) => {
  const { client, directory } = ctx
  log("agent-intercom initialized")

  const permissionGuard = createPermissionGuard(client)
  const transformSystem = createTransformSystem(client)

  return {
    // Inject the plugin's agent roles (orchestrator + 6 subagents) into the
    // resolved config, so the orchestration pattern needs no per-project
    // `.opencode/agents/*.md`. Non-destructive — a project can still override
    // any role by name.
    config: async (config) => {
      try {
        installAgents(config)
      } catch (err) {
        log("config hook error", err?.message ?? String(err))
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
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        rewritePendingTools(output?.messages)
      } catch (err) {
        log("rewritePendingTools error", err?.message ?? String(err))
      }
      try {
        captureMessages(input, output)
      } catch (err) {
        log("reqlog messages error", err?.message ?? String(err))
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
    "tool.execute.before": createGuardToolExecute(client),
  }
}
