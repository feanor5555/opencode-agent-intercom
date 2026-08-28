// The runtime limits on disk, shared with the main plugin: it reads this file
// (file > env > default) for the subagent cap and context budget. Writing it
// here changes those limits live, no opencode restart needed.
//
// Every write goes through a read-modify-write: the sidebar seeds its two
// signals once at mount, so its copy is stale as soon as the file is edited
// elsewhere. Only the key the user just stepped goes into what disk currently
// holds — the other limit, and every key this TUI knows nothing about
// (searxngUrl, exaApiKey, whatever else the user put there), stay as they are.
// The stepped value itself is derived from the same read, so an outside edit to
// that very key is stepped from rather than overwritten. The merged state is
// what the caller puts back into the signals, so the panel shows the true file
// state afterwards. A key absent from the file stays absent: its env-or-default
// resolution is displayed, never written back. A key the file carries but the
// plugin rejects is dropped by the next write, so the file cannot keep a limit
// that silently is not in effect.
//
// A file that cannot be read, and a write that does not reach the disk, both
// leave the file as it is and hand back the state that is on disk, so the panel
// never shows a limit the plugin will not read.

import { createJsonObjectFile } from "./json-object-file.ts";

export interface Settings {
  maxSubagents: number;
  maxContext: number;
}

export const DEFAULT_MAX_SUBAGENTS = 1;
export const DEFAULT_MAX_CONTEXT = 40000;

const SETTING_KEYS: (keyof Settings)[] = ["maxSubagents", "maxContext"];

const file = createJsonObjectFile("agent-intercom.json");

// Test seam: point reads and writes at another file.
export function setSettingsPath(p: string): void {
  file.setPath(p);
}

// What the plugin accepts as a limit: a whole number, zero or more.
const isLimit = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0;

function envNum(name: string, def: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return def;
  const n = Number(env);
  return isLimit(n) ? n : def;
}

// Resolve the limits the same way the main plugin does: file > env var >
// default, so the inputs show whatever is actually in effect.
function resolveSettings(raw: Record<string, unknown>): Settings {
  const s: Settings = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
  };
  if (isLimit(raw.maxSubagents)) s.maxSubagents = raw.maxSubagents;
  if (isLimit(raw.maxContext)) s.maxContext = raw.maxContext;
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

// The object to write: the file's own keys, the stepped limit, and no limit the
// plugin would reject. A rejected value would otherwise stay in the file for
// good while the panel displays the env-or-default one instead.
function mergeSetting(
  raw: Record<string, unknown>,
  key: keyof Settings,
  value: number,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...raw, [key]: value };
  for (const k of SETTING_KEYS) {
    if (k in merged && !isLimit(merged[k])) delete merged[k];
  }
  return merged;
}

// Read, compute the new value from that read, merge, write. Returns the merged
// state for the signals; on an unreadable file or a failed write the file stays
// as it is and the state on disk comes back instead.
function applySetting(
  key: keyof Settings,
  next: (current: Settings) => number,
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
// plus whatever the file, env or default gives the other limit.
export function setSetting(key: keyof Settings, value: number): Settings {
  return applySetting(key, () => value);
}

// Steps one limit by `delta`, from the value the file holds at this moment
// rather than from the panel's copy, and clamps the result at `min`.
export function stepSetting(
  key: keyof Settings,
  delta: number,
  min = 0,
): Settings {
  return applySetting(key, (current) => Math.max(min, current[key] + delta));
}
