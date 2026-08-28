// The per-agent LLM parameter overrides on disk, shared with the main plugin's
// chat.params hook. Each agent is configured individually (no "*" global
// fallback; legacy "*" blocks are dropped on read). Writing this file makes the
// next LLM request pick up the new values — no opencode restart.
//
// Every write goes through a read-modify-write: the sidebar seeds its signal
// once at mount, so its copy is stale as soon as the file is edited elsewhere.
// Re-reading and merging in only the entry the user just touched keeps that
// outside edit, and the stepped value itself is derived from the same read, so
// an outside edit to that very entry is stepped from rather than overwritten.
// The merged object is what the caller puts back into the signal, so the panel
// shows the true file state afterwards. Keys absent from the file stay absent —
// nothing is materialised on the way through.
//
// The read keeps only what the params hook can use, because that hook forwards
// every key it does not recognise straight into the provider request body: a
// hand-edited entry that is not a bucket of numbers is dropped rather than
// spread into the next write.
//
// A file that cannot be read, and a write that does not reach the disk, both
// leave the file as it is and hand back the state that is on disk, so the panel
// never shows an override the plugin will not read.

import { createJsonObjectFile } from "./json-object-file.ts";

export type LlmParams = Record<string, Record<string, number>>;

// The stepping rule of one parameter: [-]/[+] move by `step` inside [min, max]
// and round the result to `decimals`.
export interface LlmParamStep {
  key: string;
  step: number;
  min: number;
  max: number;
  decimals: number;
}

const file = createJsonObjectFile("llm-params.json");

// Test seam: point reads and writes at another file.
export function setLlmParamsPath(p: string): void {
  file.setPath(p);
}

export function roundToStep(value: number, step: number, decimals: number): number {
  const stepped = Math.round(value / step) * step;
  const f = Math.pow(10, decimals);
  return Math.round(stepped * f) / f;
}

// Keep an agent only when its value is a bucket of finite numbers, and inside
// that bucket only those numbers; an agent left with nothing drops out. Also
// drops any legacy "*" global block — each agent is configured individually now.
// The next write persists both cleanups.
function filterParams(raw: Record<string, unknown>): LlmParams {
  const out: LlmParams = {};
  for (const [agent, bucket] of Object.entries(raw)) {
    if (agent === "*") continue;
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const kept: Record<string, number> = {};
    for (const [key, v] of Object.entries(bucket as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) kept[key] = v;
    }
    if (Object.keys(kept).length > 0) out[agent] = kept;
  }
  return out;
}

export function readLlmParams(): LlmParams {
  try {
    return filterParams(file.readRaw());
  } catch {
    // Unreadable or unparsable: the panel shows nothing rather than a guess.
    return {};
  }
}

// Read, let `mutate` change the entry the user touched, write. A mutation that
// returns false found nothing to change and leaves the file untouched; an
// unreadable file or a failed write does the same and hands back the state on
// disk.
function applyLlmParams(mutate: (params: LlmParams) => boolean): LlmParams {
  let merged: LlmParams;
  try {
    merged = filterParams(file.readRaw());
  } catch {
    return {};
  }
  if (!mutate(merged)) return merged;
  if (!file.write(merged)) return readLlmParams();
  return merged;
}

// Puts one value into an agent's bucket, or takes it out when `value` is null;
// an agent left with no parameters drops out of the file entirely.
function putParam(
  params: LlmParams,
  agent: string,
  key: string,
  value: number | null,
): void {
  const bucket: Record<string, number> = { ...(params[agent] ?? {}) };
  if (value === null) {
    delete bucket[key];
  } else {
    bucket[key] = value;
  }
  if (Object.keys(bucket).length === 0) {
    delete params[agent];
  } else {
    params[agent] = bucket;
  }
}

// Sets one parameter of one agent, or removes it when `value` is null. Returns
// the merged state for the signal.
export function setLlmParam(
  agent: string,
  key: string,
  value: number | null,
): LlmParams {
  return applyLlmParams((params) => {
    putParam(params, agent, key, value);
    return true;
  });
}

// Steps one parameter of one agent by `delta`. The base is the value the file
// holds for that agent at this moment, falling back to `inherited` — what
// opencode resolved for the agent, which is not in this file — and that becomes
// the new agent-specific value. With nothing anywhere, + emerges at the floor of
// the range and - is a no-op. On the agent's own value, - at the floor drops the
// override so whatever is underneath shows again. Returns the merged state for
// the signal.
export function stepLlmParam(
  agent: string,
  def: LlmParamStep,
  delta: number,
  inherited: number | null,
): LlmParams {
  return applyLlmParams((params) => {
    const own = params[agent]?.[def.key];
    const base = typeof own === "number" ? own : inherited;
    let next: number | null;
    if (base === null) {
      if (delta <= 0) return false;
      next = def.min;
    } else if (typeof own === "number" && delta < 0 && own <= def.min + 1e-9) {
      next = null;
    } else {
      const raw = Math.min(def.max, Math.max(def.min, base + delta));
      next = roundToStep(raw, def.step, def.decimals);
    }
    putParam(params, agent, def.key, next);
    return true;
  });
}

// Removes every parameter override of one agent. Returns the merged state for
// the signal; an agent that has none on disk leaves the file untouched.
export function clearLlmParamsAgent(agent: string): LlmParams {
  return applyLlmParams((params) => {
    if (!params[agent]) return false;
    delete params[agent];
    return true;
  });
}
