// The per-agent model choice on disk, shared with the main plugin's
// chat.message hook. An agent with no entry keeps whatever opencode resolved
// for it. Its own file rather than a key in the LLM parameter file, because
// that one is typed `Record<agent, Record<key, number>>` and the params hook
// forwards every key it does not recognise into `output.options`, i.e. straight
// into the provider request body — a `model` key there would be sent as a
// sampling option.
//
// Every write goes through a read-modify-write: the sidebar seeds its signal
// once at mount, so its copy is stale as soon as the file is edited elsewhere.
// Re-reading and merging in only the agent the user just touched keeps that
// outside edit, and the position the cycler steps from is taken from the same
// read, so an outside edit to that very agent is stepped from rather than
// overwritten. The merged object is what the caller puts back into the signal,
// so the panel shows the true file state afterwards. Agents absent from the file
// stay absent — nothing is materialised on the way through.
//
// A file that cannot be read, and a write that does not reach the disk, both
// leave the file as it is and hand back the state that is on disk, so the panel
// never shows a model the plugin will not read.

import { createJsonObjectFile } from "./json-object-file.ts";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

// The reasoning-effort values the effort row cycles, in cycle order.
// "default" means no override: the entry then carries no `variant` and the
// model's own default effort stands. One ladder for every model — every
// provider family the plugin maps takes low/medium/high.
export const EFFORT_LADDER = ["default", "low", "medium", "high"] as const;

export type EffortValue = (typeof EFFORT_LADDER)[number];

// An entry as it stands in the file: the model pair, plus the optional effort
// override. `variant` is absent for "default".
export interface ModelEntry extends ModelRef {
  variant?: string;
}

export type LlmModels = Record<string, ModelEntry>;

// A stored effort the plugin will act on: a ladder member other than
// "default", which is stored as the absence of the key.
const isStoredVariant = (v: unknown): v is EffortValue =>
  typeof v === "string" && v !== "default" && (EFFORT_LADDER as readonly string[]).includes(v);

export const isModelRef = (v: unknown): v is ModelRef => {
  const r = v as ModelRef | undefined;
  return (
    typeof r?.providerID === "string" &&
    r.providerID.length > 0 &&
    typeof r.modelID === "string" &&
    r.modelID.length > 0
  );
};

export const sameModel = (a: ModelRef | null, b: ModelRef | null): boolean =>
  a !== null && b !== null && a.providerID === b.providerID && a.modelID === b.modelID;

const file = createJsonObjectFile("llm-models.json");

// Test seam: point reads and writes at another file.
export function setLlmModelsPath(p: string): void {
  file.setPath(p);
}

// Keep only usable pairs, so a hand-edited file cannot put a half-entry on
// screen that the plugin then ignores. An effort rides along only when it is a
// ladder member the plugin acts on; anything else, and an old file that carries
// no effort at all, reads as the bare pair. The next write persists the cleanup.
function filterModels(raw: Record<string, unknown>): LlmModels {
  const out: LlmModels = {};
  for (const [agent, ref] of Object.entries(raw)) {
    if (!isModelRef(ref)) continue;
    const entry: ModelEntry = { providerID: ref.providerID, modelID: ref.modelID };
    const variant = (ref as ModelEntry).variant;
    if (isStoredVariant(variant)) entry.variant = variant;
    out[agent] = entry;
  }
  return out;
}

export function readLlmModels(): LlmModels {
  try {
    return filterModels(file.readRaw());
  } catch {
    // Unreadable or unparsable: the panel shows nothing rather than a guess.
    return {};
  }
}

// Read, let `mutate` change the agent the user touched, write. A mutation that
// returns false found nothing to change and leaves the file untouched; an
// unreadable file or a failed write does the same and hands back the state on
// disk.
function applyLlmModels(mutate: (models: LlmModels) => boolean): LlmModels {
  let merged: LlmModels;
  try {
    merged = filterModels(file.readRaw());
  } catch {
    return {};
  }
  if (!mutate(merged)) return merged;
  if (!file.write(merged)) return readLlmModels();
  return merged;
}

// Sets the model of one agent, or removes its entry when `ref` is null. Returns
// the merged state for the signal; a removal for an agent that has nothing on
// disk leaves the file untouched.
export function setLlmModel(agent: string, ref: ModelRef | null): LlmModels {
  return applyLlmModels((models) => {
    if (ref === null) {
      if (!models[agent]) return false;
      delete models[agent];
      return true;
    }
    models[agent] = { providerID: ref.providerID, modelID: ref.modelID };
    return true;
  });
}

// Walks the pick list by one from the position the file holds for that agent at
// this moment. The cycle carries a virtual "not set" slot in front of the first
// model, so a step off the front drops the choice and hands the agent back to
// opencode's own model without a full reset. A choice that is no longer in the
// list counts as "not set", so the next step lands in the list. An empty list
// changes nothing. Returns the merged state for the signal.
export function cycleLlmModel(
  agent: string,
  delta: number,
  choices: ModelRef[],
): LlmModels {
  if (choices.length === 0) return readLlmModels();
  return applyLlmModels((models) => {
    const own = models[agent];
    const at = isModelRef(own)
      ? choices.findIndex((c) => sameModel(c, own)) + 1
      : 0;
    const slots = choices.length + 1;
    const next = (at + delta + slots) % slots;
    const pick = next === 0 ? undefined : choices[next - 1];
    if (pick === undefined) {
      if (!models[agent]) return false;
      delete models[agent];
      return true;
    }
    models[agent] = { providerID: pick.providerID, modelID: pick.modelID };
    return true;
  });
}

// Walks EFFORT_LADDER by one from the position the file holds for that agent at
// this moment, so an effort set outside the panel is stepped from rather than
// overwritten. Landing on "default" deletes only the `variant` key and leaves
// the pair in place; landing anywhere else stores `model` with the new effort,
// materialising the pair where the agent had no entry — the effort then names
// the model it was chosen for. Returns the merged state for the signal.
export function cycleLlmVariant(
  agent: string,
  delta: number,
  model: ModelRef,
): LlmModels {
  return applyLlmModels((models) => {
    const own = models[agent];
    const at = isStoredVariant(own?.variant) ? EFFORT_LADDER.indexOf(own.variant) : 0;
    const size = EFFORT_LADDER.length;
    const variant = EFFORT_LADDER[(at + delta + size) % size];
    if (variant === "default") {
      if (own === undefined || own.variant === undefined) return false;
      delete own.variant;
      return true;
    }
    models[agent] = { providerID: model.providerID, modelID: model.modelID, variant };
    return true;
  });
}
