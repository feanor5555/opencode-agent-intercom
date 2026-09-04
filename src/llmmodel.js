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
// "Unset" means: no hook ever forces a model the user did not pick. For an
// agent the `config` hook has already pinned, the message hook puts back the
// value that stood in `config.agent[<name>].model` before the pin — from
// bootstrap on, that pinned string *is* opencode's resolution, so a choice
// removed in the panel would otherwise keep running to the end of the instance.
// Where the agent carried no model before the pin, the earlier resolution
// cannot be reconstructed and removing the choice takes effect at the next
// opencode start.
//
// An entry may carry one optional key beside the pair, `variant`: the reasoning
// effort for that agent. The config hook writes it to
// `config.agent[<name>].variant`; `chatParamsHook` (src/llmparams.js) also
// translates it per request through `output.options`.
//
// Neither of those two routes reaches the label opencode's TUI prints in the
// chat area: it seeds a fresh session's variant from its own per-model store
// (src/variantstore.js) and never reads `config.agent[<name>].variant`. The
// config hook therefore writes the effort there as well. That store is keyed
// per MODEL, so it cannot express two agents that share a model at different
// efforts; the key takes the effort of the primary agent, the session the chat
// area shows, and every other agent's effort keeps travelling by the two routes
// above alone.
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
import { DEFAULT_VARIANT, modelKey, saveModelVariants } from "./variantstore.js"

let modelsFile = join(homedir(), ".config", "opencode", "llm-models.json")

// Test seam: point the reader at another file. Drops the cache and the record
// of what the `config` hook overwrote, so the next read hits the new path with
// no state from the previous one.
export function setModelsPath(p) {
  modelsFile = p
  resetCache()
  pinnedBefore.clear()
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

// The reasoning-effort ladder steps that mean an override. `default` is stored
// as the absence of a `variant` key, so it is not a member here.
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh"])

// For an agent name, return the reasoning effort stored beside its model pair
// — `"low"`, `"medium"`, `"high"` or `"xhigh"` — or null where the entry
// carries no `variant`, or one outside that set. The closed set is what keeps a
// hand-edited file from putting an arbitrary string into a provider request:
// `chatParamsHook` merges the result through `src/reasoningeffort.js`, which
// only knows these four. `xhigh` is not offered by every model; the panel keeps
// it off the ladder of a model that does not name it, and a model that is sent
// it anyway rejects it as it would any effort it does not take.
//
// Independent of the model pair: an entry whose pair is unusable can still
// carry an effort, and it then applies to whatever model opencode resolved.
export function resolveEffortForAgent(agent) {
  if (!nonEmptyString(agent)) return null
  const entry = readModels()[agent]
  if (!entry || typeof entry !== "object") return null
  const { variant } = entry
  return typeof variant === "string" && EFFORT_VALUES.has(variant) ? variant : null
}

// Splits the `providerID/modelID` string form `config.agent[<name>].model`
// carries into the pair a message carries, at the first `/`. Null for anything
// that is not both halves.
function splitModelRef(ref) {
  if (!nonEmptyString(ref)) return null
  const slash = ref.indexOf("/")
  if (slash < 1 || slash === ref.length - 1) return null
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

// The agent name of the turn a `chat.message` call describes: what opencode
// resolved (`input.agent`), falling back to the name it stamped on the user
// message it just created. Null when neither carries one.
//
// Two readers: the model choice below, and the session -> agent record in
// index.js that the primary identification chain in hooks.js reads back. Both
// want the same name, so the read lives in one place.
export function messageAgent(input, output) {
  if (nonEmptyString(input?.agent)) return input.agent
  const fromMessage = output?.message?.agent
  return nonEmptyString(fromMessage) ? fromMessage : null
}

// The hook itself. opencode calls it with input.{sessionID, agent, model, ...}
// and a mutable output.{message, parts}; `output.message.model` is the pair the
// request will run with.
export function chatMessageHook(input, output) {
  const message = output?.message
  if (!message) return
  const agent = messageAgent(input, output)
  const chosen = resolveModelForAgent(agent)
  if (chosen) {
    message.model = chosen
    return
  }
  // No choice stored. For an agent the `config` hook pinned at bootstrap, the
  // model opencode now resolves is that pin, so removing the choice has to put
  // the pre-bootstrap value back on the message. An agent that carried no model
  // before the pin has nothing to put back — see the header.
  const previous = splitModelRef(pinnedBefore.get(agent))
  if (previous) message.model = previous
}

// What the `config` hook displaced, per agent name: the `providerID/modelID`
// string that stood in `config.agent[<name>].model` before the pin, or
// undefined where the agent carried none. Lives for the instance, like the
// bootstrap config itself.
const pinnedBefore = new Map()

// The `config` hook half. opencode calls the hook with the resolved config;
// this writes each stored choice into `config.agent[<name>].model`, which is
// the string form `"providerID/modelID"` (`AgentConfig.model` in the opencode
// SDK types), not the pair a message carries.
//
// Only agents already present in `config.agent` are touched — a stored name
// that matches none must not bring a bare `{ model }` agent into being, and
// iterating the config side keeps a `__proto__` key in the file off
// Object.prototype. Runs after installAgents(), so the plugin's own roles and
// the project's are both there; a choice the user made in the panel overrides
// a `model` the project set on that agent, exactly as the message hook does.
// Mutates `config` in place.
export function applyModelChoices(config) {
  const agents = config?.agent
  if (!agents || typeof agents !== "object") return
  const stored = readModels()
  const primaries = []
  for (const name of Object.keys(agents)) {
    if (!Object.hasOwn(stored, name)) continue
    const agent = agents[name]
    if (!agent || typeof agent !== "object") continue
    const effort = resolveEffortForAgent(name)
    if (effort) agent.variant = effort
    else delete agent.variant
    const chosen = resolveModelForAgent(name)
    if (isVisiblePrimary(agent)) {
      // The model this agent will run: the choice from the panel, or — where
      // the panel holds only an effort for it — the model already standing in
      // the config. Neither is invented, and where there is no model at all
      // the store has no key to write.
      const ref = chosen ?? splitModelRef(agent.model)
      // A `default` or absent effort is written as the name opencode itself
      // stores for it, not as a deleted key.
      if (ref) primaries.push({ name, key: modelKey(ref.providerID, ref.modelID), variant: effort ?? DEFAULT_VARIANT })
    }
    if (!chosen) continue
    // Record what the pin displaces, once per agent, so a second run of the
    // hook cannot overwrite the value with the plugin's own. The message hook
    // reads it back when the choice is later removed.
    if (!pinnedBefore.has(name)) pinnedBefore.set(name, agent.model)
    agent.model = `${chosen.providerID}/${chosen.modelID}`
  }
  writePrimaryVariants(config, primaries)
}

// A primary agent whose sessions the user actually sees. opencode's internal
// `compaction`, `title` and `summary` are `mode: "primary"` and hidden both;
// the chat area never shows one, so neither may claim a model's variant key.
function isVisiblePrimary(agent) {
  return agent.mode === "primary" && agent.hidden !== true
}

// Puts the primary agents' efforts into opencode's per-model variant store.
//
// The store has one entry per model, so two primaries sharing a model at
// different efforts have to be ordered: `default_agent` wins, since that is the
// agent a fresh session starts as, and among the rest the first in config order
// does. The loser is not written anywhere else — its effort still travels by
// `config.agent[<name>].variant` and by `chat.params`, as every subagent's
// does.
//
// A model no visible primary uses is never named here, so whatever stands in
// the file for it survives. Never throws: this is a state file of another
// program and a failure to update it must not cost the plugin its load.
function writePrimaryVariants(config, primaries) {
  if (primaries.length === 0) return
  const preferred = config?.default_agent
  const ordered = [
    ...primaries.filter((p) => p.name === preferred),
    ...primaries.filter((p) => p.name !== preferred),
  ]
  const perModel = new Map()
  for (const { key, variant } of ordered) if (!perModel.has(key)) perModel.set(key, variant)
  try {
    saveModelVariants(perModel)
  } catch (err) {
    log("variant store update failed", errMsg(err))
  }
}

// Test seam: reset the in-memory cache so unit tests can swap the file
// contents between runs without a process restart.
export function resetCache() {
  cache = { mtime: 0, data: {} }
}
