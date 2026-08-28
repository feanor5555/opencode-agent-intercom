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
// outside edit, and the merged object is what the caller puts back into the
// signal, so the panel shows the true file state afterwards. Agents absent from
// the file stay absent — nothing is materialised on the way through.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

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

let modelsPath = join(homedir(), ".config", "opencode", "llm-models.json");

// Test seam: point reads and writes at another file.
export function setLlmModelsPath(p: string): void {
  modelsPath = p;
}

export function readLlmModels(): LlmModels {
  try {
    const raw = JSON.parse(readFileSync(modelsPath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: LlmModels = {};
      for (const [agent, ref] of Object.entries(raw as Record<string, unknown>)) {
        // Skip anything that is not a usable pair, so a hand-edited file cannot
        // put a half-entry on screen that the plugin then ignores.
        if (isModelRef(ref)) out[agent] = { providerID: ref.providerID, modelID: ref.modelID };
      }
      return out;
    }
  } catch {
    // no file -> empty
  }
  return {};
}

function writeLlmModels(m: LlmModels): void {
  try {
    mkdirSync(dirname(modelsPath), { recursive: true });
    writeFileSync(modelsPath, JSON.stringify(m, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

// Sets the model of one agent, or removes its entry when `ref` is null. Returns
// the merged state for the signal; a removal for an agent that has nothing on
// disk leaves the file untouched.
export function setLlmModel(agent: string, ref: ModelRef | null): LlmModels {
  const merged = readLlmModels();
  if (ref === null) {
    if (!merged[agent]) return merged;
    delete merged[agent];
  } else {
    merged[agent] = { providerID: ref.providerID, modelID: ref.modelID };
  }
  writeLlmModels(merged);
  return merged;
}
