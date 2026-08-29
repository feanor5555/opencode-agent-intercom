// The roles this plugin installs, as the panel knows them: every installed
// role, the prompt file each one owns, the closed set a spawn may name, and the
// built-in context budget per type.
//
// This is the TUI's copy of the authorities on the server side — AGENT_NAMES in
// src/promptsfile.js, SPAWNABLE_ROLES in src/agents.js and
// DEFAULT_AGENT_CONTEXT in src/settings.js — because the TUI is a separate npm
// package and cannot import the plugin module at runtime.
// test/settings-defaults-parity.test.js fails on a divergence, so a role added
// or removed over there cannot leave these lists behind.
//
// A role is identified by its name alone. What `mode` opencode reports for it
// is read nowhere here, so a project that overrides one of these roles to
// `mode: "primary"` moves neither the spawn gate nor anything derived below.

// Every role the plugin installs, the orchestrator first. Everything else in
// this file is derived from it: the prompt-file set, the spawnable set, and the
// per-type budget table.
export const AGENT_NAMES = [
  "orchestrator",
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "researcher",
  "designer",
  "gitter",
];

// One prompt template file per installed role, under
// <project>/.opencode/agent-intercom/. The prompts-reload button touches
// exactly these.
export const PROMPT_AGENT_FILES = AGENT_NAMES.map((name) => `${name}.md`);

// The closed set of agent types a spawn may name — the plugin's subagent roles
// and nothing else. The TUI's copy of SPAWNABLE_ROLES in src/agents.js, which
// is the spawn gate's whole authority (src/tools.js): a name outside it is
// refused, so the sidebar offers a context ceiling for no other name. The
// orchestrator falls out as the one primary role.
export const SPAWNABLE_ROLES = AGENT_NAMES.filter(
  (name) => name !== "orchestrator",
);

// The agent names of an opencode `app.agents()` listing that this plugin can
// actually spawn, in the order the listing gave them. opencode resolves more
// than the plugin's roles — its own primaries, its hidden helpers, and every
// model wrapper a project declares — and none of those is a spawn target, so
// none of them gets a ceiling row.
//
// Membership in SPAWNABLE_ROLES is the only filter, because that set is exactly
// what the spawn gate accepts (src/tools.js). The `mode` a listing entry carries
// is not read: a project may override one of the plugin's roles to
// `mode: "primary"`, and that moves neither the gate nor this list — it is
// reported through the override register instead. The orchestrator has no
// ceiling row whatever mode it is reported with, since it is not in the set.
export function spawnableAgentNames(
  agents: Array<{ name?: string; mode?: string }>,
): string[] {
  const names: string[] = [];
  for (const agent of agents) {
    if (!agent || typeof agent.name !== "string") continue;
    if (!SPAWNABLE_ROLES.includes(agent.name)) continue;
    names.push(agent.name);
  }
  return names;
}

// The built-in context budget per agent type, in whole tokens. The plugin's own
// copy is DEFAULT_AGENT_CONTEXT in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence, which also pins
// its keys to SPAWNABLE_ROLES. No orchestrator entry: the budget governs
// subagents only.
export const DEFAULT_AGENT_CONTEXT: Record<string, number> = {
  planner: 40000,
  coder: 60000,
  debugger: 60000,
  reviewer: 40000,
  documenter: 40000,
  researcher: 60000,
  designer: 30000,
  gitter: 30000,
};
