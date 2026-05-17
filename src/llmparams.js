// `chat.params` hook — applies per-agent LLM parameter overrides from a
// live-editable file (`~/.config/opencode/llm-params.json`). The companion TUI
// panel writes that file when the user clicks +/- on a parameter, so values
// take effect at the next LLM request without an opencode restart.
//
// Resolution chain for each key:
//   file[agent].<key>  (explicit per-role override)  > unset
// "Unset" means: leave opencode's resolved value alone (typically the
// AgentConfig.temperature baked into src/agents.js). No global fallback —
// each agent is configured individually.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log, errMsg } from "./log.js"

const PARAMS_FILE = join(homedir(), ".config", "opencode", "llm-params.json")

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
    const m = statSync(PARAMS_FILE).mtimeMs
    if (m !== cache.mtime) {
      const raw = JSON.parse(readFileSync(PARAMS_FILE, "utf8"))
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

// The hook itself. opencode calls it with input.{sessionID, agent, model, ...}
// and a mutable output.{temperature, topP, topK, maxOutputTokens, options}.
export function chatParamsHook(input, output) {
  const resolved = resolveForAgent(input?.agent)
  if (!resolved || Object.keys(resolved).length === 0) return
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined || value === null) continue
    const topField = TOP_LEVEL_KEYS[key]
    if (topField) {
      output[topField] = value
      continue
    }
    if (OPTION_KEYS.has(key)) {
      if (!output.options || typeof output.options !== "object") output.options = {}
      output.options[key] = value
      continue
    }
    // Unknown key — let it through via options so an advanced user can pass
    // arbitrary llama.cpp fields by editing the file directly.
    if (!output.options || typeof output.options !== "object") output.options = {}
    output.options[key] = value
  }
}

// Test seam: reset the in-memory cache so unit tests can swap the file
// contents between runs without a process restart.
export function resetCache() {
  cache = { mtime: 0, data: {} }
}
