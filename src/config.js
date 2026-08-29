// Honors each caller's `permission.task` allowlist in `spawn`, re-enforces
// each subagent's `permission.<tool> = "deny"` map at the runtime tool guard
// (defense in depth — the schema strip in agents.js hides denied tools from
// the LLM, but a project override or future opencode change could re-expose
// them), and resolves `permission.spawn` for the nested-spawn gate, where the
// map is the decision rather than a second line of defence.
//
// The custom `spawn` tool sits outside opencode's native `permission.task`
// enforcement, so it would otherwise bypass the allowlist. We deliberately
// honor it anyway. Disable with OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS="0".

import { unwrap } from "./client.js"
import { AGENTS } from "./agents.js"
import { log, errMsg } from "./log.js"

const RESPECT_TASK_PERMS = process.env.OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS !== "0"

// The resolved opencode config is the same for every plugin instance in this
// process. Caching it at module scope (instead of in the factory closure) keeps
// state where every other piece of cross-session state already lives — and
// avoids re-fetching it once per session.
let configCache
let configInflight
let serverAgentsCache
let serverAgentsInflight

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

// The agent names the project's own opencode config defines. Read from the
// same module-level cached config the permission guard uses, so classifying a
// refused name costs no extra request. Empty when the config carries no `agent`
// map — a project that defines none. Module-private: a project's agents are not
// spawn targets, they only need naming when a spawn of one is refused.
async function projectAgentNames(client) {
  const config = await loadConfig(client)
  const agents = config?.agent
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return []
  return Object.keys(agents).filter((name) => name !== "")
}

// Every agent the SERVER resolves, whatever its mode. Unlike the config above
// this sees opencode's own built-ins — `build`, `plan`, `general`, `explore`,
// `compaction`, `title`, `summary` — which never appear in `config.agent`: the
// server constructs them before the project config is folded in, and only
// overlays that config onto them.
//
// Fails soft on purpose. No `app` namespace (every unit-test mock client), an
// older server without the route, or a transport error all yield the empty list
// rather than a throw, which leaves each caller at the behaviour it had before
// this reader existed.
//
// Cached at module scope like the config above: one request per process.
async function loadServerAgents(client) {
  if (serverAgentsCache !== undefined) return serverAgentsCache
  if (serverAgentsInflight) return serverAgentsInflight
  serverAgentsInflight = (async () => {
    try {
      const agents = unwrap(await client.app.agents())
      if (!Array.isArray(agents)) return []
      return agents.filter((a) => a && typeof a.name === "string" && a.name !== "")
    } catch (err) {
      log("app.agents failed", errMsg(err))
      return []
    }
  })()
  serverAgentsCache = await serverAgentsInflight
  serverAgentsInflight = undefined
  return serverAgentsCache
}

// Every agent name this opencode instance knows, mapped to what kind of thing
// it is. None of them is a spawn target — the spawn gate's authority is the
// plugin's own SPAWNABLE_ROLES (agents.js) — this map exists so a REFUSAL can
// state the reason that is true of the name instead of reporting every one of
// them as a name nobody resolves:
//
//   "primary" — `mode: "primary"` (`build`, `plan`, and opencode's internal
//     `compaction`/`title`/`summary`, which are primary and hidden both).
//   "hidden"  — `hidden: true` on a non-primary agent.
//   "other"   — a name the project's config defines or the server otherwise
//     resolves (`general`, `explore`, a model wrapper the project added). It is
//     an agent opencode would run; it is simply not one of this plugin's roles.
//
// A name absent from the map is one nothing resolves at all — a typo.
//
// The server's answer wins over the project config for a name both carry: it is
// the resolved truth, config plus built-in defaults folded together.
export async function knownAgentKinds(client) {
  const kinds = new Map()
  for (const name of await projectAgentNames(client)) kinds.set(name, "other")
  for (const agent of await loadServerAgents(client)) {
    const kind = agent.mode === "primary" ? "primary" : agent.hidden === true ? "hidden" : "other"
    kinds.set(agent.name, kind)
  }
  return kinds
}

// Test-only: drop the cached config and server agent list so a fresh ctx-mock
// is re-read.
export function resetPermissionGuardCache() {
  configCache = undefined
  configInflight = undefined
  serverAgentsCache = undefined
  serverAgentsInflight = undefined
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

  // Defense-in-depth runtime re-check of the per-agent `permission.<tool>`
  // deny map. Returns null when the tool is allowed for `callerAgent`, or a
  // reason string when it is denied. Reads the same live config the
  // Permission.disabled schema strip uses, so a project override that REMOVED
  // a deny is honored (no false-deny). Returns null on any read failure — the
  // primary hard-deny layer (PRIMARY_TOOLS, aborted, over-budget) still runs
  // and the LLM-side schema strip is the main defense.
  //
  // The `task` key is intentionally NOT handled here. `permission.task` is an
  // allowlist, not a simple deny, and its enforcement lives in
  // `checkTaskPermission` above (called from `spawn`). Honoring a bare
  // `task: "deny"` here would over-deny: that string is the signal we use to
  // HIDE opencode's blocking native `task` tool, NOT to disable `spawn`.
  async function checkToolPermission(callerAgent, tool) {
    if (!callerAgent || !tool || tool === "task") return null
    try {
      const config = await loadConfig(client)
      const decision = config?.agent?.[callerAgent]?.permission?.[tool]
      if (decision === "deny") {
        return `agent "${callerAgent}" is not permitted to call "${tool}" (permission.${tool})`
      }
      return null
    } catch (err) {
      log("checkToolPermission failed", errMsg(err))
      return null
    }
  }

  // Whether `callerAgent` may make a NESTED spawn — one whose caller is itself
  // a subagent. Returns null when it may, a reason string when it may not.
  //
  // Fail-CLOSED, and that is the one thing separating it from
  // checkToolPermission above. That check is a defence-in-depth re-deny sitting
  // behind a schema strip which has already hidden the tool from the model, so
  // a config it cannot read costs nothing and it answers "allowed". Here the
  // permission map IS the decision — the schema strip is the model's view of
  // its own tool list, not a caller-side gate, and no third layer stands behind
  // this one — so an unreadable config, a role the config does not carry and a
  // role this plugin does not define all have to resolve to "no".
  //
  // Resolution, absence deciding differently at each rung:
  //   1. the live config's `agent.<role>.permission.spawn` when it carries a
  //      decision — a project override is honoured in both directions, the way
  //      checkToolPermission honours one;
  //   2. otherwise this plugin's own role definition, read with opencode's
  //      semantics: an explicit "deny" denies, an ABSENT key allows (that
  //      absence is exactly how the delegating roles are granted `spawn`);
  //   3. otherwise — a role neither side defines — deny. A project's own agent
  //      type can therefore not nest; the orchestrator spawns for it.
  async function checkSpawnPermission(callerAgent) {
    if (!callerAgent) return "the calling agent could not be identified"
    let decision
    try {
      const config = await loadConfig(client)
      decision = config?.agent?.[callerAgent]?.permission?.spawn
    } catch (err) {
      log("checkSpawnPermission: config read failed", errMsg(err))
    }
    if (decision === undefined && Object.hasOwn(AGENTS, callerAgent)) {
      decision = AGENTS[callerAgent].permission?.spawn ?? "allow"
    }
    if (decision === undefined) {
      return `agent "${callerAgent}" is not a role this plugin defines, so it cannot spawn`
    }
    if (decision === "deny") {
      return `agent "${callerAgent}" is not permitted to call "spawn" (permission.spawn)`
    }
    return null
  }

  return { checkTaskPermission, checkToolPermission, checkSpawnPermission }
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
