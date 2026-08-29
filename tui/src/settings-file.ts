// The runtime settings on disk, shared with the main plugin: it reads this file
// (file > env > default) for the subagent cap, the context budget, endless mode,
// the nested-spawn quota and the chatter switch. Writing it here changes them
// live, no opencode restart needed.
//
// The context budget is a value PER AGENT TYPE, held in the `agentContext` map.
// There is no single user-facing ceiling: a type with no entry of its own falls
// back to the flat legacy `maxContext` key, then to the env var, then to the
// built-in table DEFAULT_AGENT_CONTEXT, then to DEFAULT_MAX_CONTEXT — the order
// `effectiveAgentContext` implements and the plugin's `contextBudgetFor`
// mirrors. `0` is a real value at every level and means the budget is disabled
// for that type. `maxContextSource` says which of file, env and default
// produced `maxContext`, because a flat value the user set governs every type
// without an own entry while the built-in default does not.
//
// Every write goes through a read-modify-write: the sidebar seeds its signals
// once at mount, so its copy is stale as soon as the file is edited elsewhere.
// Only the key the user just touched goes into what disk currently holds — the
// other settings, and every key this TUI knows nothing about (searxngUrl,
// exaApiKey, endlessQuiesceTimeoutMs, whatever else the user put there), stay as
// they are. The written value itself is derived from the same read, so an
// outside edit to that very key is stepped or toggled from rather than
// overwritten. The merged state is what the caller puts back into the signals,
// so the panel shows the true file state afterwards. A key absent from the file
// stays absent: its env-or-default resolution is displayed, never written back.
// A key the file carries in a form the plugin rejects is dropped by the next
// write, so the file cannot keep a setting that silently is not in effect.
//
// The one write that materialises keys is `stepAgentContext`: the first ceiling
// edit freezes the budget every listed agent has in effect into `agentContext`
// and drops the flat `maxContext` key, so one type's ceiling lives in one place
// from then on.
//
// A file that cannot be read, and a write that does not reach the disk, both
// leave the file as it is and hand back the state that is on disk, so the panel
// never shows a limit the plugin will not read.

import { createJsonObjectFile } from "./json-object-file.ts";

// The context budget per agent type, in whole tokens. Only the types the user
// gave a value of their own; nothing is materialised on read.
export type AgentContext = Record<string, number>;

// Where the flat `maxContext` came from. "default" means nobody set it, which
// is what lets the built-in per-type table apply.
export type MaxContextSource = "file" | "env" | "default";

export interface Settings {
  maxSubagents: number;
  maxContext: number;
  maxContextSource: MaxContextSource;
  agentContext: AgentContext;
  endlessMode: boolean;
  endlessContext: number;
  maxNestedSpawns: number;
  hideChatter: boolean;
}

// The scalar keys that hold a limit, i.e. the ones a [-]/[+] row steps.
// endlessMode and hideChatter are not among them: they are the file's booleans
// and each has its own writer. maxContext is not one either: it is legacy-only
// and is written by nothing here — a ceiling is edited per agent through
// stepAgentContext. maxNestedSpawns is not one either: it is read and preserved
// for parity with the plugin, and no row edits it.
export type LimitKey = "maxSubagents" | "endlessContext";

// Every key of Settings the file itself carries. maxContextSource is derived
// from the file rather than stored in it.
type FileKey = Exclude<keyof Settings, "maxContextSource">;

// Every role the plugin installs, the orchestrator first. This is the TUI's
// copy of the one authority on the server side — AGENT_NAMES in
// src/promptsfile.js, itself Object.keys(AGENTS) in src/agents.js — because the
// TUI is a separate npm package and cannot import the plugin module at runtime.
// test/settings-defaults-parity.test.js fails on a divergence, so a role added
// or removed over there cannot leave this list behind. Everything the sidebar
// knows about roles is derived from here: the prompt-file set, the spawnable
// set, and the per-type budget table below.
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

export const DEFAULT_MAX_SUBAGENTS = 1;
// The budget for an agent type the table below does not name, and the fallback
// of the legacy flat key.
export const DEFAULT_MAX_CONTEXT = 40000;
// The built-in context budget per agent type, in whole tokens. The plugin's own
// copy is DEFAULT_AGENT_CONTEXT in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence, which also pins
// its keys to SPAWNABLE_ROLES. No orchestrator entry: the budget governs
// subagents only.
export const DEFAULT_AGENT_CONTEXT: AgentContext = {
  planner: 40000,
  coder: 60000,
  debugger: 60000,
  reviewer: 40000,
  documenter: 40000,
  researcher: 60000,
  designer: 30000,
  gitter: 30000,
};
export const DEFAULT_ENDLESS_MODE = false;
export const DEFAULT_ENDLESS_CONTEXT = 250000;
// How many subagents one subagent run may start; 0 switches nesting off. The
// plugin's own copy is DEFAULT_MAX_NESTED_SPAWNS in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence. Carried here for
// that parity and because a write must not drop a key the plugin honours — no
// row steps it.
export const DEFAULT_MAX_NESTED_SPAWNS = 2;
// Whether the plugin's own postings are hidden from the transcript. The
// plugin's own copy is DEFAULT_HIDE_CHATTER in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence.
export const DEFAULT_HIDE_CHATTER = false;

const MAX_CONTEXT_ENV = "OPENCODE_AGENT_INTERCOM_MAX_CONTEXT";

const file = createJsonObjectFile("agent-intercom.json");

// Test seam: point reads and writes at another file.
export function setSettingsPath(p: string): void {
  file.setPath(p);
}

// What the plugin accepts as a limit: a whole number, zero or more.
const isLimit = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0;

// What the plugin accepts for a boolean setting: a real boolean. "true", 1 and
// null are rejected there and are rejected here.
const isFlag = (v: unknown): v is boolean => typeof v === "boolean";

// The usable entries of an agentContext value, or null when the value is not a
// plain object at all — an array, a string or null leaves the map unset, while
// a single garbage entry inside it costs the user only that entry. Same
// discipline as the plugin's own reader.
function filterAgentContext(v: unknown): AgentContext | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const kept: AgentContext = {};
  for (const [name, value] of Object.entries(v as Record<string, unknown>)) {
    if (name !== "" && isLimit(value)) kept[name] = value;
  }
  return kept;
}

// What each key must look like for the plugin to use it. Written as a mapped
// type over the file's keys so a key added to the panel cannot be left without
// one.
const SETTING_VALIDATORS: { [K in FileKey]: (v: unknown) => boolean } = {
  maxSubagents: isLimit,
  maxContext: isLimit,
  agentContext: (v) => filterAgentContext(v) !== null,
  endlessMode: isFlag,
  endlessContext: isLimit,
  maxNestedSpawns: isLimit,
  hideChatter: isFlag,
};

function envNum(name: string, def: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return def;
  const n = Number(env);
  return isLimit(n) ? n : def;
}

// Whether a numeric env var holds a value envNum would actually use. Only
// needed where "the user set this number" has to be told apart from "the
// built-in default happens to be this number" — see maxContextSource.
function envNumSet(name: string): boolean {
  const env = process.env[name];
  if (env === undefined || env === "") return false;
  return isLimit(Number(env));
}

// The plugin reads a boolean env var as "1"/"0"; anything else leaves the
// default standing, the way a bad number does above.
function envFlag(name: string, def: boolean): boolean {
  const env = process.env[name]?.trim();
  if (env === "1") return true;
  if (env === "0") return false;
  return def;
}

// Resolve the settings the same way the main plugin does: file > env var >
// default, so the rows show whatever is actually in effect.
function resolveSettings(raw: Record<string, unknown>): Settings {
  const s: Settings = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum(MAX_CONTEXT_ENV, DEFAULT_MAX_CONTEXT),
    maxContextSource: envNumSet(MAX_CONTEXT_ENV) ? "env" : "default",
    agentContext: {},
    endlessMode: envFlag("OPENCODE_AGENT_INTERCOM_ENDLESS_MODE", DEFAULT_ENDLESS_MODE),
    endlessContext: envNum("OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT", DEFAULT_ENDLESS_CONTEXT),
    maxNestedSpawns: envNum(
      "OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS",
      DEFAULT_MAX_NESTED_SPAWNS,
    ),
    hideChatter: envFlag("OPENCODE_AGENT_INTERCOM_HIDE_CHATTER", DEFAULT_HIDE_CHATTER),
  };
  if (isLimit(raw.maxSubagents)) s.maxSubagents = raw.maxSubagents;
  if (isLimit(raw.maxContext)) {
    s.maxContext = raw.maxContext;
    s.maxContextSource = "file";
  }
  const perAgent = filterAgentContext(raw.agentContext);
  if (perAgent !== null) s.agentContext = perAgent;
  if (isFlag(raw.endlessMode)) s.endlessMode = raw.endlessMode;
  if (isLimit(raw.endlessContext)) s.endlessContext = raw.endlessContext;
  if (isLimit(raw.maxNestedSpawns)) s.maxNestedSpawns = raw.maxNestedSpawns;
  if (isFlag(raw.hideChatter)) s.hideChatter = raw.hideChatter;
  return s;
}

export function readSettings(): Settings {
  try {
    return resolveSettings(file.readRaw());
  } catch {
    // Unreadable or unparsable: show the env-or-default resolution, which is
    // what the plugin runs on for such a file.
    return resolveSettings({});
  }
}

// The context budget in effect for one agent type, and whether that value is
// the type's own or an inherited one — the ★ on the row. Same order as the
// plugin's contextBudgetFor: own entry > flat legacy key from the file > env >
// built-in table > DEFAULT_MAX_CONTEXT. `0` is a real value at every level.
export function effectiveAgentContext(
  settings: Settings,
  agent: string,
): { value: number; source: "agent" | "inherited" } {
  if (Object.hasOwn(settings.agentContext, agent)) {
    return { value: settings.agentContext[agent], source: "agent" };
  }
  if (settings.maxContextSource !== "default") {
    return { value: settings.maxContext, source: "inherited" };
  }
  if (Object.hasOwn(DEFAULT_AGENT_CONTEXT, agent)) {
    return { value: DEFAULT_AGENT_CONTEXT[agent], source: "inherited" };
  }
  return { value: DEFAULT_MAX_CONTEXT, source: "inherited" };
}

// Drops every setting the plugin would reject, so the file cannot keep one that
// silently is not in effect while the panel displays the env-or-default value
// instead. Each key is checked against its own validator, so a step on a limit
// does not drop the boolean and toggling the boolean does not drop a limit.
// agentContext is normalised rather than judged as a whole: the plugin drops a
// bad entry and keeps the rest of the map, and a map left with nothing is a key
// worth nothing.
function pruneSettings(merged: Record<string, unknown>): Record<string, unknown> {
  if ("agentContext" in merged) {
    const kept = filterAgentContext(merged.agentContext);
    if (kept === null || Object.keys(kept).length === 0) delete merged.agentContext;
    else merged.agentContext = kept;
  }
  for (const [k, isValid] of Object.entries(SETTING_VALIDATORS)) {
    if (k in merged && !isValid(merged[k])) delete merged[k];
  }
  return merged;
}

// The object to write: the file's own keys, the value the user just set, and no
// setting the plugin would reject.
function mergeSetting(
  raw: Record<string, unknown>,
  key: FileKey,
  value: number | boolean,
): Record<string, unknown> {
  return pruneSettings({ ...raw, [key]: value });
}

// Read, compute the new value from that read, merge, write. Returns the merged
// state for the signals; on an unreadable file or a failed write the file stays
// as it is and the state on disk comes back instead.
function applySetting(
  key: FileKey,
  next: (current: Settings) => number | boolean,
): Settings {
  let raw: Record<string, unknown>;
  try {
    raw = file.readRaw();
  } catch {
    return readSettings();
  }
  const merged = mergeSetting(raw, key, next(resolveSettings(raw)));
  if (!file.write(merged)) return readSettings();
  return resolveSettings(merged);
}

// Sets one limit. Returns the merged state for the signals: the written value
// plus whatever the file, env or default gives the other settings.
export function setSetting(key: LimitKey, value: number): Settings {
  return applySetting(key, () => value);
}

// Steps one limit by `delta`, from the value the file holds at this moment
// rather than from the panel's copy, and clamps the result at `min`.
export function stepSetting(
  key: LimitKey,
  delta: number,
  min = 0,
): Settings {
  return applySetting(key, (current) => Math.max(min, current[key] + delta));
}

// Steps one agent type's context ceiling by `delta`, from the value the file
// holds at this moment. `agents` is the list the panel's cycler offers.
//
// The first such edit migrates the file: every listed agent gets the ceiling it
// has in effect right now written into `agentContext`, and the flat `maxContext`
// key goes. Freezing the effective values means the migration changes no
// budget, and dropping the flat key means a type's ceiling has one home rather
// than two. Types the cycler does not list keep their own entries untouched and
// otherwise fall back to the built-in table.
//
// A step that would take the value below zero removes the agent's entry instead,
// so the inherited ceiling shows again — `0` itself stays reachable and means
// the budget is disabled for that type. Returns the merged state for the
// signals; an unreadable file or a failed write leaves the file as it is and
// hands back the state on disk.
export function stepAgentContext(
  agent: string,
  delta: number,
  agents: string[],
): Settings {
  let raw: Record<string, unknown>;
  try {
    raw = file.readRaw();
  } catch {
    return readSettings();
  }
  const current = resolveSettings(raw);
  const next: AgentContext = { ...current.agentContext };
  for (const name of [...agents, agent]) {
    if (!Object.hasOwn(next, name)) next[name] = effectiveAgentContext(current, name).value;
  }
  const stepped = next[agent] + delta;
  if (stepped < 0) delete next[agent];
  else next[agent] = stepped;
  const merged = pruneSettings({ ...raw, agentContext: next });
  // The flat key is what the frozen map was built from; leaving it would put
  // one type's ceiling in two places.
  delete merged.maxContext;
  if (!file.write(merged)) return readSettings();
  return resolveSettings(merged);
}

// Sets endless mode. A boolean, so it has its own writer rather than a spot in
// the stepping pair above.
export function setEndlessMode(value: boolean): Settings {
  return applySetting("endlessMode", () => value);
}

// Flips endless mode. The counterpart of stepSetting for a two-valued setting:
// the flip starts from what the file holds at this moment, so a switch thrown
// outside the panel — by hand, or by the plugin's own bounds writing
// endlessMode back to false — is toggled from rather than overwritten.
export function toggleEndlessMode(): Settings {
  return applySetting("endlessMode", (current) => !current.endlessMode);
}

// Sets the chatter switch. While it is on, the plugin stamps every posting it
// makes into a session as hidden: the transcript does not render it, the model
// still receives its text.
export function setHideChatter(value: boolean): Settings {
  return applySetting("hideChatter", () => value);
}

// Flips the chatter switch, from the value the file holds at this moment rather
// than from the panel's copy, which a hand edit may have made stale.
export function toggleHideChatter(): Settings {
  return applySetting("hideChatter", (current) => !current.hideChatter);
}
