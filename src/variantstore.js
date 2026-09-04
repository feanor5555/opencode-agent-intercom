// opencode's own variant store — the file its TUI seeds the reasoning-effort
// label of a FRESH session from.
//
// Path: `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/model.json`, the same
// resolution opencode's binary does (`join(Path.state, "model.json")`, with
// `Path.state = join(XDG_STATE_HOME || ~/.local/state, "opencode")`).
//
// Shape — a single JSON object, of which only `variant` belongs to this module:
//
//   { "recent": [ { providerID, modelID }, ... ],
//     "favorite": [ ... ],
//     "variant": { "<providerID>/<modelID>": "<variant name>", ... } }
//
// The TUI resolves a session's active variant from `--variant`, then the
// variant of the session's last user message, then this map. It never reads
// `config.agent[<name>].variant`, so without this write a restarted TUI shows
// "variant default" for an agent whose effort the sidebar has set. The map is
// keyed per MODEL, not per agent; who wins a key is decided in
// `applyModelChoices` (src/llmmodel.js).
//
// A name written here only reaches the label if the model actually offers that
// variant — the TUI drops a saved name that is not in the model's `variants`
// list — so an effort a model does not know is inert rather than wrong.
//
// This is another program's state file. Two rules follow and are absolute:
// every write goes through a temp file and a rename, so no reader can ever see
// a truncated file; and a store that does not parse is left exactly as it
// stands rather than replaced with a fresh one. Nothing here throws.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { log, errMsg } from "./log.js"

const nonEmptyString = (v) => typeof v === "string" && v.length > 0
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v)

// The variant name opencode itself stores for "no effort override". Written
// rather than deleted, so the key states the choice instead of leaving the
// model to whatever the TUI would otherwise fall back to.
export const DEFAULT_VARIANT = "default"

// Test seam: null means "resolve from the environment at call time", which is
// what the plugin does in production.
let storeOverride = null

export function setVariantStorePath(p) {
  storeOverride = nonEmptyString(p) ? p : null
}

export function variantStorePath() {
  if (storeOverride) return storeOverride
  // An empty XDG_STATE_HOME falls through to the default, as it does in
  // opencode's own resolution.
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "opencode", "model.json")
}

// The key the store uses for a model.
export function modelKey(providerID, modelID) {
  return `${providerID}/${modelID}`
}

// The store as an object, or null when it must not be written: unreadable for
// any reason other than "not there", or holding something that is not a JSON
// object. A missing file reads as an empty store — that one we do create.
function readStore(path) {
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    if (err?.code === "ENOENT") return {}
    log("variant store unreadable", errMsg(err))
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (isPlainObject(parsed)) return parsed
    log("variant store is not a JSON object, left as it stands")
    return null
  } catch (err) {
    log("variant store unparseable, left as it stands", errMsg(err))
    return null
  }
}

// Temp file beside the target, then rename. Same directory so the rename stays
// within one filesystem and is therefore atomic. No explicit mode: the file
// keeps the permissions opencode's own writer would give it.
function writeStoreAtomically(path, value) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    // opencode writes this file as `JSON.stringify(value, null, 2)` with no
    // trailing newline; the same text keeps a diff of the file quiet.
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, path)
    return true
  } catch (err) {
    log("variant store write failed", errMsg(err))
    try {
      unlinkSync(tmp)
    } catch {
      // ignore — the temp file was never created, or is not ours to remove
    }
    return false
  }
}

// Sets `variant["<providerID>/<modelID>"]` for each pair in `updates`, an
// iterable of `[modelKey, variantName]`, and leaves every other entry of the
// file — `recent`, `favorite`, and the variant of every model not named — as
// it stands. Returns true only when the file was rewritten.
//
// False, with nothing written, on: no usable update, a store that does not
// parse, a failed write, and the common case of every named model already
// carrying the name it would be given.
export function saveModelVariants(updates) {
  let named
  try {
    named = [...updates].filter(([key, name]) => nonEmptyString(key) && nonEmptyString(name))
  } catch (err) {
    log("variant store updates unusable", errMsg(err))
    return false
  }
  if (named.length === 0) return false

  const path = variantStorePath()
  const store = readStore(path)
  if (!store) return false

  // Null prototype: a model key of `__proto__` — reachable from a hand-edited
  // llm-models.json — must land as an own key, not on Object.prototype.
  const variant = Object.assign(Object.create(null), isPlainObject(store.variant) ? store.variant : {})
  let changed = false
  for (const [key, name] of named) {
    if (variant[key] === name) continue
    variant[key] = name
    changed = true
  }
  if (!changed) return false

  return writeStoreAtomically(path, { ...store, variant })
}
