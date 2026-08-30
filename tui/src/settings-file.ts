// The runtime settings on disk, shared with the main plugin: it reads this file
// (file > env > default) for the subagent cap, the context budget, endless mode,
// the nested-spawn quota, the subagent-retention window, the per-type reuse
// ceiling and the agentcom visibility switch. Writing it here changes them
// live, no opencode restart needed.
//
// The context budget is a value PER AGENT TYPE, held in the `agentContext` map.
// There is no single user-facing ceiling: a type with no entry of its own falls
// back to the flat legacy `maxContext` key, then to the env var, then to the
// built-in table DEFAULT_AGENT_CONTEXT (agent-roles.ts), then to
// DEFAULT_MAX_CONTEXT — the order `effectiveAgentContext` implements and the
// plugin's `contextBudgetFor` mirrors. `0` is a real value at every level and
// means the budget is disabled for that type. `maxContextSource` says which of
// file, env and default produced `maxContext`, because a flat value the user
// set governs every type without an own entry while the built-in default does
// not.
//
// The reuse ceiling — the context above which a finished subagent is never held
// and never re-prompted — is a value PER AGENT TYPE the same way, held in the
// `reuseContext` map, and its fallback chain is one level shorter: a type with
// no entry of its own falls back to the flat `maxReuseContext` key, then to the
// env var, then to DEFAULT_MAX_REUSE_CONTEXT. There is no built-in per-type
// table behind it and no legacy key, so there is no source flag either. `0` is
// a real value and means that type is never reused.
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

import { DEFAULT_AGENT_CONTEXT, type AgentContext } from "./agent-roles.ts";
import { createJsonObjectFile } from "./json-object-file.ts";

// The context budget per agent type, in whole tokens. Only the types the user
// gave a value of their own; nothing is materialised on read. Declared beside
// the built-in table it falls back on and re-exported here, where the settings
// shape is read.
export type { AgentContext };

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
  maxRetainedSubagents: number;
  retainedSubagentTtlMs: number;
  maxReuseContext: number;
  reuseContext: AgentContext;
  showAgentcom: boolean;
}

// The scalar keys that hold a limit, i.e. the ones a [-]/[+] row steps.
// endlessMode and showAgentcom are not among them: they are the file's booleans
// and each has its own writer. maxContext is not one either: it is legacy-only
// and is written by nothing here — a ceiling is edited per agent through
// stepAgentContext. maxNestedSpawns is not one either: it is read and preserved
// for parity with the plugin, and no row edits it — and neither are
// maxRetainedSubagents, retainedSubagentTtlMs and maxReuseContext, for the same
// reason. The per-type reuse ceiling is not a scalar at all: like the budget it
// is edited per agent, in reuseContext.
export type LimitKey = "maxSubagents" | "endlessContext";

// Every key of Settings the file itself carries. maxContextSource is derived
// from the file rather than stored in it.
type FileKey = Exclude<keyof Settings, "maxContextSource">;

export const DEFAULT_MAX_SUBAGENTS = 1;
// The budget for an agent type the built-in table DEFAULT_AGENT_CONTEXT
// (agent-roles.ts) does not name, and the fallback of the legacy flat key.
export const DEFAULT_MAX_CONTEXT = 100000;
export const DEFAULT_ENDLESS_MODE = false;
export const DEFAULT_ENDLESS_CONTEXT = 250000;
// How many subagents one subagent run may start; 0 switches nesting off. The
// plugin's own copy is DEFAULT_MAX_NESTED_SPAWNS in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence. Carried here for
// that parity and because a write must not drop a key the plugin honours — no
// row steps it.
export const DEFAULT_MAX_NESTED_SPAWNS = 2;
// How many finished subagents may be held alive as re-promptable sessions at
// once; 0 switches retention off, which is the shipped default and the one-shot
// behaviour. The plugin's own copy is DEFAULT_MAX_RETAINED_SUBAGENTS in
// src/settings.js and test/settings-defaults-parity.test.js fails on a
// divergence. Carried here for that parity and because a write must not drop a
// key the plugin honours — no row steps it.
export const DEFAULT_MAX_RETAINED_SUBAGENTS = 0;
// How long one retained subagent is held, in ms, measured from the moment it
// was retained. The plugin's own copy is DEFAULT_RETAINED_SUBAGENT_TTL_MS in
// src/settings.js. Read and preserved like the key above; no row steps it.
export const DEFAULT_RETAINED_SUBAGENT_TTL_MS = 3600000;
// The reuse ceiling for an agent type the reuseContext map does not name: the
// context above which a finished subagent of that type is never held and never
// re-prompted. The plugin's own copy is DEFAULT_MAX_REUSE_CONTEXT in
// src/settings.js and test/settings-defaults-parity.test.js fails on a
// divergence. Carried here for that parity and because a write must not drop a
// key the plugin honours — no row steps it yet.
export const DEFAULT_MAX_REUSE_CONTEXT = 70000;
// The floor under the retention window, applied wherever the value came from:
// the plugin never holds a session on a window of 0, because nothing outside it
// ever deletes a subagent session. Retention is switched off through
// maxRetainedSubagents, not through the window.
const MIN_RETAINED_SUBAGENT_TTL_MS = 1;
// Whether the plugin's own postings appear in the transcript. The plugin's own
// copy is DEFAULT_SHOW_AGENTCOM in src/settings.js and
// test/settings-defaults-parity.test.js fails on a divergence.
export const DEFAULT_SHOW_AGENTCOM = true;

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
  maxRetainedSubagents: isLimit,
  retainedSubagentTtlMs: isLimit,
  maxReuseContext: isLimit,
  reuseContext: (v) => filterAgentContext(v) !== null,
  showAgentcom: isFlag,
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
    maxRetainedSubagents: envNum(
      "OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS",
      DEFAULT_MAX_RETAINED_SUBAGENTS,
    ),
    retainedSubagentTtlMs: envNum(
      "OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS",
      DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    ),
    maxReuseContext: envNum(
      "OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT",
      DEFAULT_MAX_REUSE_CONTEXT,
    ),
    reuseContext: {},
    showAgentcom: envFlag("OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM", DEFAULT_SHOW_AGENTCOM),
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
  if (isLimit(raw.maxRetainedSubagents)) s.maxRetainedSubagents = raw.maxRetainedSubagents;
  if (isLimit(raw.retainedSubagentTtlMs)) s.retainedSubagentTtlMs = raw.retainedSubagentTtlMs;
  // The floor the plugin applies last, after file, env and default alike, so a
  // 0 on this key resolves to 1 ms on both sides rather than to a window
  // nothing would ever reap.
  s.retainedSubagentTtlMs = Math.max(MIN_RETAINED_SUBAGENT_TTL_MS, s.retainedSubagentTtlMs);
  if (isLimit(raw.maxReuseContext)) s.maxReuseContext = raw.maxReuseContext;
  const perAgentReuse = filterAgentContext(raw.reuseContext);
  if (perAgentReuse !== null) s.reuseContext = perAgentReuse;
  if (isFlag(raw.showAgentcom)) s.showAgentcom = raw.showAgentcom;
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

// The reuse ceiling in effect for one agent type, and whether that value is the
// type's own or the inherited flat one — the same { value, source } pair the
// budget row's ★ is read from. Same order as the plugin's reuseCeilingFor: own
// entry > the flat maxReuseContext, itself resolved file > env >
// DEFAULT_MAX_REUSE_CONTEXT.
//
// One level shorter than effectiveAgentContext, and deliberately so: there is
// no built-in per-type table of reuse ceilings and no legacy key, so there is
// nothing a source flag would have to disambiguate between. `0` is a real value
// here too and means the type is never reused.
export function effectiveReuseContext(
  settings: Settings,
  agent: string,
): { value: number; source: "agent" | "inherited" } {
  if (Object.hasOwn(settings.reuseContext, agent)) {
    return { value: settings.reuseContext[agent], source: "agent" };
  }
  return { value: settings.maxReuseContext, source: "inherited" };
}

// Drops every setting the plugin would reject, so the file cannot keep one that
// silently is not in effect while the panel displays the env-or-default value
// instead. Each key is checked against its own validator, so a step on a limit
// does not drop the boolean and toggling the boolean does not drop a limit.
// agentContext is normalised rather than judged as a whole: the plugin drops a
// bad entry and keeps the rest of the map, and a map left with nothing is a key
// worth nothing.
function pruneSettings(merged: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["agentContext", "reuseContext"] as const) {
    if (!(key in merged)) continue;
    const kept = filterAgentContext(merged[key]);
    if (kept === null || Object.keys(kept).length === 0) delete merged[key];
    else merged[key] = kept;
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

// Sets the agentcom visibility switch. While it is off, the plugin stamps every
// posting it makes into a session as hidden: the transcript does not render it,
// the model still receives its text.
export function setShowAgentcom(value: boolean): Settings {
  return applySetting("showAgentcom", () => value);
}

// Flips the agentcom visibility switch, from the value the file holds at this
// moment rather than from the panel's copy, which a hand edit may have made
// stale.
export function toggleShowAgentcom(): Settings {
  return applySetting("showAgentcom", (current) => !current.showAgentcom);
}
