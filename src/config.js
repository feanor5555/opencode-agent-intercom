// Honors each caller's `permission.task` allowlist in `spawn`.
//
// The custom `spawn` tool sits outside opencode's native `permission.task`
// enforcement, so it would otherwise bypass the allowlist. We deliberately
// honor it anyway. Disable with OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS="0".

import { unwrap } from "./client.js"
import { log, errMsg } from "./log.js"

const RESPECT_TASK_PERMS = process.env.OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS !== "0"

// The resolved opencode config is the same for every plugin instance in this
// process. Caching it at module scope (instead of in the factory closure) keeps
// state where every other piece of cross-session state already lives — and
// avoids re-fetching it once per session.
let configCache
let configInflight

async function loadConfig(client) {
  if (configCache !== undefined) return configCache
  if (configInflight) return configInflight
  configInflight = (async () => {
    try {
      return unwrap(await client.config.get()) ?? null
    } catch (err) {
      log("config.get failed", errMsg(err))
      return null
    }
  })()
  configCache = await configInflight
  configInflight = undefined
  return configCache
}

// Test-only: drop the cached config so a fresh ctx-mock is re-read.
export function resetPermissionGuardCache() {
  configCache = undefined
  configInflight = undefined
}

// Creates a guard over the opencode config. The config is fetched once and
// cached at module scope across all guard instances in this process.
export function createPermissionGuard(client) {
  // Returns null if the spawn is allowed, or a reason string if denied.
  async function checkTaskPermission(callerAgent, targetAgent) {
    if (!RESPECT_TASK_PERMS) return null
    const config = await loadConfig(client)
    const taskPerm = config?.agent?.[callerAgent]?.permission?.task
    if (taskPerm === undefined) return null // no allowlist configured -> allow
    if (resolveTaskDecision(taskPerm, targetAgent) === "deny") {
      return `agent "${callerAgent}" is not permitted to spawn "${targetAgent}" (permission.task)`
    }
    return null
  }

  return { checkTaskPermission }
}

// `permission.task` is either a bare decision string or a per-agent map with an
// optional "*" wildcard. Resolves the effective decision for one target agent.
//
// We deliberately ignore the bare-string form: opencode interprets
// `permission.task = "deny"` as "this agent cannot use the built-in `task`
// tool" (it gets stripped from the LLM schema by Permission.disabled). Our
// `spawn` is a separate, non-blocking tool — denying it via the same key would
// make the agents.js orchestrator config unable to spawn anything, since we
// already set `permission.task = "deny"` to hide opencode's blocking task tool
// from the orchestrator. Only the per-agent object form is the spawn-allowlist
// we honor.
function resolveTaskDecision(taskPerm, targetAgent) {
  if (taskPerm && typeof taskPerm === "object") return taskPerm[targetAgent] ?? taskPerm["*"]
  return undefined
}
