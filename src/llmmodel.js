// `chat.message` hook — applies the per-agent model choice from a
// live-editable file (`~/.config/opencode/llm-models.json`). The companion TUI
// panel writes that file when the user cycles the `model` row, so the choice
// takes effect at the next message without an opencode restart.
//
// Resolution chain:
//   file[agent]  ({ providerID, modelID })  > unset
// "Unset" means: the hook leaves `output.message.model` exactly as opencode
// resolved it (agent definition > session model), so no choice here can ever
// force a model the user did not pick.
//
// This is deliberately a separate file from llm-params.json: that one is typed
// `Record<agent, Record<key, number>>` and `chatParamsHook` forwards every key
// it does not recognise into `output.options`, which goes straight into the
// provider request body. A `model` key living there would be sent to the
// provider as a sampling option.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log, errMsg } from "./log.js"

let modelsFile = join(homedir(), ".config", "opencode", "llm-models.json")

// Test seam: point the reader at another file. Drops the cache so the next
// read hits the new path.
export function setModelsPath(p) {
  modelsFile = p
  resetCache()
}

let cache = { mtime: 0, data: {} }

// Reads the file with an mtime-keyed cache so the per-message cost is one
// stat() call. A missing/unparseable file is treated as empty (passthrough).
export function readModels() {
  try {
    const m = statSync(modelsFile).mtimeMs
    if (m !== cache.mtime) {
      const raw = JSON.parse(readFileSync(modelsFile, "utf8"))
      cache = { mtime: m, data: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} }
    }
  } catch (err) {
    if (cache.mtime !== -1) {
      cache = { mtime: -1, data: {} }
      if (err && err.code !== "ENOENT") log("llmmodel read failed", errMsg(err))
    }
  }
  return cache.data
}

const nonEmptyString = (v) => typeof v === "string" && v.length > 0

// For an agent name, return its `{ providerID, modelID }` pair from the file,
// or null when the agent has no choice stored or the stored entry is not a
// usable pair. Each agent is configured individually; there is no global
// fallback.
export function resolveModelForAgent(agent) {
  if (!nonEmptyString(agent)) return null
  const entry = readModels()[agent]
  if (!entry || typeof entry !== "object") return null
  const { providerID, modelID } = entry
  if (!nonEmptyString(providerID) || !nonEmptyString(modelID)) return null
  return { providerID, modelID }
}

// The hook itself. opencode calls it with input.{sessionID, agent, model, ...}
// and a mutable output.{message, parts}; `output.message.model` is the pair the
// request will run with.
export function chatMessageHook(input, output) {
  const message = output?.message
  if (!message) return
  const agent = nonEmptyString(input?.agent) ? input.agent : message.agent
  const chosen = resolveModelForAgent(agent)
  if (!chosen) return
  message.model = chosen
}

// Test seam: reset the in-memory cache so unit tests can swap the file
// contents between runs without a process restart.
export function resetCache() {
  cache = { mtime: 0, data: {} }
}
