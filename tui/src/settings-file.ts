// The runtime limits on disk, shared with the main plugin: it reads this file
// (file > env > default) for the subagent cap and context budget. Writing it
// here changes those limits live, no opencode restart needed.
//
// Every write goes through a read-modify-write: the sidebar seeds its two
// signals once at mount, so its copy is stale as soon as the file is edited
// elsewhere. Only the key the user just stepped goes into what disk currently
// holds — the other limit, and every key this TUI knows nothing about
// (searxngUrl, exaApiKey, whatever else the user put there), stay as they are.
// The merged state is what the caller puts back into the signals, so the panel
// shows the true file state afterwards. A key absent from the file stays
// absent: its env-or-default resolution is displayed, never written back.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface Settings {
  maxSubagents: number;
  maxContext: number;
}

export const DEFAULT_MAX_SUBAGENTS = 1;
export const DEFAULT_MAX_CONTEXT = 40000;

let settingsPath = join(homedir(), ".config", "opencode", "agent-intercom.json");

// Test seam: point reads and writes at another file.
export function setSettingsPath(p: string): void {
  settingsPath = p;
}

function envNum(name: string, def: number): number {
  const env = process.env[name];
  if (env === undefined || env === "") return def;
  const n = Number(env);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

// The file's own object, for a write that has to keep the keys it carries. A
// missing, unparsable or non-object file starts from empty, so the result is a
// fresh file holding just the touched key.
function readRawSettings(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // no file / unparsable -> empty
  }
  return {};
}

// Resolve the limits the same way the main plugin does: file > env var >
// default, so the inputs show whatever is actually in effect.
function resolveSettings(raw: Record<string, unknown>): Settings {
  const s: Settings = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
  };
  if (Number.isInteger(raw.maxSubagents) && (raw.maxSubagents as number) >= 0) {
    s.maxSubagents = raw.maxSubagents as number;
  }
  if (Number.isInteger(raw.maxContext) && (raw.maxContext as number) >= 0) {
    s.maxContext = raw.maxContext as number;
  }
  return s;
}

export function readSettings(): Settings {
  return resolveSettings(readRawSettings());
}

// Sets one limit. Returns the merged state for the signals: the written value
// plus whatever the file, env or default gives the other limit.
export function setSetting(key: keyof Settings, value: number): Settings {
  const merged = { ...readRawSettings(), [key]: value };
  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // best-effort — a failed write just means the limit is not changed
  }
  return resolveSettings(merged);
}
