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

export type LlmModels = Record<string, ModelRef>;

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
// screen that the plugin then ignores. The next write persists the cleanup.
function filterModels(raw: Record<string, unknown>): LlmModels {
  const out: LlmModels = {};
  for (const [agent, ref] of Object.entries(raw)) {
    if (isModelRef(ref)) out[agent] = { providerID: ref.providerID, modelID: ref.modelID };
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
