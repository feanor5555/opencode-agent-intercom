// The runtime settings on disk, shared with the main plugin: it reads this file
// (file > env > default) for the subagent cap, the context budget and endless
// mode. Writing it here changes them live, no opencode restart needed.
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
// A file that cannot be read, and a write that does not reach the disk, both
// leave the file as it is and hand back the state that is on disk, so the panel
// never shows a limit the plugin will not read.

import { createJsonObjectFile } from "./json-object-file.ts";

export interface Settings {
  maxSubagents: number;
  maxContext: number;
  endlessMode: boolean;
  endlessContext: number;
}

// The keys that hold a limit, i.e. the ones a [-]/[+] row steps. endlessMode is
// not one of them: it is the file's only boolean and has its own writer.
export type LimitKey = "maxSubagents" | "maxContext" | "endlessContext";

export const DEFAULT_MAX_SUBAGENTS = 1;
export const DEFAULT_MAX_CONTEXT = 40000;
export const DEFAULT_ENDLESS_MODE = false;
export const DEFAULT_ENDLESS_CONTEXT = 250000;

const file = createJsonObjectFile("agent-intercom.json");

// Test seam: point reads and writes at another file.
export function setSettingsPath(p: string): void {
  file.setPath(p);
}

// What the plugin accepts as a limit: a whole number, zero or more.
const isLimit = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0;

// What the plugin accepts for endless mode: a real boolean. "true", 1 and null
// are rejected there and are rejected here.
const isFlag = (v: unknown): v is boolean => typeof v === "boolean";

// What each key must look like for the plugin to use it. Written as a mapped
// type over Settings so a key added to the panel cannot be left without one.
const SETTING_VALIDATORS: { [K in keyof Settings]: (v: unknown) => boolean } = {
  maxSubagents: isLimit,
  maxContext: isLimit,
  endlessMode: isFlag,
  endlessContext: isLimit,
};

function envNum(name: string, def: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return def;
  const n = Number(env);
  return isLimit(n) ? n : def;
}

// The plugin reads its one boolean env var as "1"/"0"; anything else leaves the
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
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
    endlessMode: envFlag("OPENCODE_AGENT_INTERCOM_ENDLESS_MODE", DEFAULT_ENDLESS_MODE),
    endlessContext: envNum("OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT", DEFAULT_ENDLESS_CONTEXT),
  };
  if (isLimit(raw.maxSubagents)) s.maxSubagents = raw.maxSubagents;
  if (isLimit(raw.maxContext)) s.maxContext = raw.maxContext;
  if (isFlag(raw.endlessMode)) s.endlessMode = raw.endlessMode;
  if (isLimit(raw.endlessContext)) s.endlessContext = raw.endlessContext;
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

// The object to write: the file's own keys, the value the user just set, and no
// setting the plugin would reject. A rejected value would otherwise stay in the
// file for good while the panel displays the env-or-default one instead. Each
// key is checked against its own validator, so a step on a limit does not drop
// the boolean and toggling the boolean does not drop a limit.
function mergeSetting(
  raw: Record<string, unknown>,
  key: keyof Settings,
  value: number | boolean,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...raw, [key]: value };
  for (const [k, isValid] of Object.entries(SETTING_VALIDATORS)) {
    if (k in merged && !isValid(merged[k])) delete merged[k];
  }
  return merged;
}

// Read, compute the new value from that read, merge, write. Returns the merged
// state for the signals; on an unreadable file or a failed write the file stays
// as it is and the state on disk comes back instead.
function applySetting(
  key: keyof Settings,
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

// Sets endless mode. The file's only boolean, so it has its own writer rather
// than a spot in the stepping pair above.
export function setEndlessMode(value: boolean): Settings {
  return applySetting("endlessMode", () => value);
}

// Flips endless mode. The counterpart of stepSetting for the one two-valued
// setting: the flip starts from what the file holds at this moment, so a switch
// thrown outside the panel — by hand, or by the plugin's own bounds writing
// endlessMode back to false — is toggled from rather than overwritten.
export function toggleEndlessMode(): Settings {
  return applySetting("endlessMode", (current) => !current.endlessMode);
}
