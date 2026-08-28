// The per-agent model choice from a live-editable file
// (`~/.config/opencode/llm-models.json`), applied to opencode through two
// hooks that share this one reader. The companion TUI panel writes that file
// when the user cycles the `model` row.
//
//   `chat.message` (chatMessageHook)   — sets the model of the message about
//     to run, so a choice takes effect at the next message without an opencode
//     restart. Per call: a prompt that never reaches this hook re-resolves the
//     agent definition.
//   `config` (applyModelChoices)       — writes the same choice into
//     `config.agent[<name>].model`, the field opencode resolves an agent's
//     model from. That makes the choice hold for every prompt of the instance,
//     including those the message hook never sees. The config hook runs once at
//     instance bootstrap, so a change to the file reaches it only on the next
//     opencode start — which is why the per-call hook stays.
//
// Resolution chain, the same for both:
//   file[agent]  ({ providerID, modelID })  > unset
// "Unset" means: neither hook writes anything for that agent, so opencode's own
// resolution (agent definition > session model) stands and no choice here can
// ever force a model the user did not pick.
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

// The `config` hook half. opencode calls the hook with the resolved config;
// this writes each stored choice into `config.agent[<name>].model`, which is
// the string form `"providerID/modelID"` (`AgentConfig.model` in the opencode
// SDK types), not the pair a message carries.
//
// Only agents already present in `config.agent` are touched — a stored name
// that matches none must not bring a bare `{ model }` agent into being, and
// the own-property check keeps a `__proto__` key in the file off
// Object.prototype. Runs after installAgents(), so the plugin's own roles and
// the project's are both there; a choice the user made in the panel overrides
// a `model` the project set on that agent, exactly as the message hook does.
// Mutates `config` in place.
export function applyModelChoices(config) {
  const agents = config?.agent
  if (!agents || typeof agents !== "object") return
  for (const name of Object.keys(readModels())) {
    if (!Object.prototype.hasOwnProperty.call(agents, name)) continue
    const agent = agents[name]
    if (!agent || typeof agent !== "object") continue
    const chosen = resolveModelForAgent(name)
    if (!chosen) continue
    agent.model = `${chosen.providerID}/${chosen.modelID}`
  }
}

// Test seam: reset the in-memory cache so unit tests can swap the file
// contents between runs without a process restart.
export function resetCache() {
  cache = { mtime: 0, data: {} }
}
