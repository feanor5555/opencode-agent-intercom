// `chat.params` hook — applies per-agent LLM parameter overrides from a
// live-editable file (`~/.config/opencode/llm-params.json`). The companion TUI
// panel writes that file when the user clicks +/- on a parameter, so values
// take effect at the next LLM request without an opencode restart.
//
// Resolution chain for each key:
//   file[agent].<key>  (explicit per-role override)  > unset
// "Unset" means: the hook writes nothing for that key, so opencode's own
// resolved value stands — and where opencode has none either (the plugin's
// role definitions in src/agents.js set no sampling parameters), the request
// carries no such field at all rather than a 0 or a null. No global fallback —
// each agent is configured individually.
//
// The hook carries a second, smaller source: the reasoning effort stored per
// agent in ~/.config/opencode/llm-models.json beside the model choice. It is
// translated for the model's provider family (src/reasoningeffort.js) and
// merged into `output.options` after the params file, which wins on a shared
// key. `chat.params` is the only hook that can carry it — neither a user
// message nor an agent config field has a place for a variant.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log, errMsg } from "./log.js"
import { resolveEffortForAgent } from "./llmmodel.js"
import { effortOptions } from "./reasoningeffort.js"

let paramsFile = join(homedir(), ".config", "opencode", "llm-params.json")

// Test seam: point the reader at another file. Drops the cache so the next
// read hits the new path.
export function setParamsPath(p) {
  paramsFile = p
  resetCache()
}

// Keys that go on the output object directly (opencode-recognised).
const TOP_LEVEL_KEYS = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  max_tokens: "maxOutputTokens",
}
// Keys that have to ride through `output.options` because opencode doesn't
// model them — the openai-compatible AI-SDK passes them straight into the
// request body, which llama.cpp accepts.
const OPTION_KEYS = new Set(["min_p", "repeat_penalty", "chat_template_kwargs"])

let cache = { mtime: 0, data: {} }

// Reads the file with an mtime-keyed cache so the per-request cost is one
// stat() call. A missing/unparseable file is treated as empty (passthrough).
export function readParams() {
  try {
    const m = statSync(paramsFile).mtimeMs
    if (m !== cache.mtime) {
      const raw = JSON.parse(readFileSync(paramsFile, "utf8"))
      cache = { mtime: m, data: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} }
    }
  } catch (err) {
    if (cache.mtime !== -1) {
      cache = { mtime: -1, data: {} }
      if (err && err.code !== "ENOENT") log("llmparams read failed", errMsg(err))
    }
  }
  return cache.data
}

// For an agent name, return its key→value map from the file. Each agent is
// configured individually; there is no global fallback.
export function resolveForAgent(agent) {
  const all = readParams()
  const role = agent && all[agent] && typeof all[agent] === "object" ? all[agent] : {}
  return { ...role }
}

// Creates `output.options` on first use — opencode hands the hook an output
// whose `options` is undefined until someone assigns it.
function optionsOf(output) {
  if (!output.options || typeof output.options !== "object") output.options = {}
  return output.options
}

// The hook itself. opencode calls it with input.{sessionID, agent, model, ...}
// and a mutable output.{temperature, topP, topK, maxOutputTokens, options}.
//
// Two sources feed it, in this order: the params file, then the reasoning
// effort stored in llm-models.json. The params file wins on any key both would
// write — it is the hand-edit escape hatch and has to stay able to override the
// ladder.
export function chatParamsHook(input, output) {
  if (!output || typeof output !== "object") return
  applyParamsFile(input, output)
  applyEffort(input, output)
}

// The params file half: each key of `file[agent]` onto the field opencode
// models it as, or into `output.options` where it models none.
function applyParamsFile(input, output) {
  const resolved = resolveForAgent(input?.agent)
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined || value === null) continue
    const topField = TOP_LEVEL_KEYS[key]
    if (topField) {
      output[topField] = value
      continue
    }
    if (OPTION_KEYS.has(key)) {
      optionsOf(output)[key] = value
      continue
    }
    // Unknown key — let it through via options so an advanced user can pass
    // arbitrary llama.cpp fields by editing the file directly.
    optionsOf(output)[key] = value
  }
}

// The reasoning-effort half: the agent's stored effort, translated for the
// provider family of the model this request runs on, merged key by key into
// `output.options`. A key already standing there — set by the params file
// above, or by opencode itself — is left as it is, and where the effort
// resolves to nothing at all `output.options` is not even created.
function applyEffort(input, output) {
  const patch = effortOptions(resolveEffortForAgent(input?.agent), input?.model)
  if (!patch) return
  const options = optionsOf(output)
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(options, key)) continue
    options[key] = value
  }
}

// Test seam: reset the in-memory cache so unit tests can swap the file
// contents between runs without a process restart.
export function resetCache() {
  cache = { mtime: 0, data: {} }
}
