// The per-agent LLM parameter overrides on disk, shared with the main plugin's
// chat.params hook. Each agent is configured individually (no "*" global
// fallback; legacy "*" blocks are dropped on read). Writing this file makes the
// next LLM request pick up the new values — no opencode restart.
//
// Every write goes through a read-modify-write: the sidebar seeds its signal
// once at mount, so its copy is stale as soon as the file is edited elsewhere.
// Re-reading and merging in only the entry the user just touched keeps that
// outside edit, and the merged object is what the caller puts back into the
// signal, so the panel shows the true file state afterwards. Keys absent from
// the file stay absent — nothing is materialised on the way through.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type LlmParams = Record<string, Record<string, number>>;

let paramsPath = join(homedir(), ".config", "opencode", "llm-params.json");

// Test seam: point reads and writes at another file.
export function setLlmParamsPath(p: string): void {
  paramsPath = p;
}

export function readLlmParams(): LlmParams {
  try {
    const raw = JSON.parse(readFileSync(paramsPath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      // Drop any legacy "*" global block — each agent is configured
      // individually now. Next write will persist the cleanup.
      const { ["*"]: _drop, ...rest } = raw as LlmParams;
      return rest;
    }
  } catch {
    // no file -> empty
  }
  return {};
}

function writeLlmParams(p: LlmParams): void {
  try {
    mkdirSync(dirname(paramsPath), { recursive: true });
    writeFileSync(paramsPath, JSON.stringify(p, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

// Sets one parameter of one agent, or removes it when `value` is null; an agent
// left with no parameters drops out of the file entirely. Returns the merged
// state for the signal.
export function setLlmParam(
  agent: string,
  key: string,
  value: number | null,
): LlmParams {
  const merged = readLlmParams();
  const bucket: Record<string, number> = { ...(merged[agent] ?? {}) };
  if (value === null) {
    delete bucket[key];
  } else {
    bucket[key] = value;
  }
  if (Object.keys(bucket).length === 0) {
    delete merged[agent];
  } else {
    merged[agent] = bucket;
  }
  writeLlmParams(merged);
  return merged;
}

// Removes every parameter override of one agent. Returns the merged state for
// the signal; an agent that has none on disk leaves the file untouched.
export function clearLlmParamsAgent(agent: string): LlmParams {
  const merged = readLlmParams();
  if (!merged[agent]) return merged;
  delete merged[agent];
  writeLlmParams(merged);
  return merged;
}
