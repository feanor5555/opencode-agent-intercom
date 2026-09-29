// The `shell.env` hook: what a subagent's shell gets on top of the process
// environment. opencode calls it before every shell tool call and merges
// `output.env` over `process.env` for that call.
//
// A subagent session — one this plugin's registry tracks — gets the plugin's
// `bin/shims` in front of its PATH, so `pw` resolves to the plugin's own copy
// wherever the plugin loads, and `PW_SESSION` set to its session id, so its
// `pw` daemon is its own (bin/pw.js names the socket after it). Every other
// session keeps its environment as it is: the orchestrator has no shell, and a
// solo primary keeps the PATH its user set.

import { delimiter } from "node:path"
import { fileURLToPath } from "node:url"

import { entryForSession } from "./registry.js"
import { log, errMsg } from "./log.js"

// The directory of the plugin's shipped command shims.
export const SHIM_DIR = fileURLToPath(new URL("../bin/shims", import.meta.url))

export function shellEnvHook(input, output) {
  try {
    const sessionID = input?.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (!entryForSession(sessionID)) return
    if (!output || typeof output !== "object") return
    if (!output.env || typeof output.env !== "object") output.env = {}
    const env = output.env
    const current = env.PATH ?? process.env.PATH ?? ""
    const entries = current.split(delimiter)
    if (entries[0] !== SHIM_DIR) {
      env.PATH = current ? `${SHIM_DIR}${delimiter}${current}` : SHIM_DIR
    }
    env.PW_SESSION = sessionID
  } catch (err) {
    log("shell.env hook error", errMsg(err))
  }
}
