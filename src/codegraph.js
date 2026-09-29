// The codegraph CLI the code-reading agents run from bash, and whether there is
// one at all. codegraph is optional: where no binary resolves, no agent is told
// about it and the plugin behaves as though it did not exist.
//
// Resolution order, first usable value wins:
//   1. settings file key `codegraphBin` — an absolute path to an executable
//      file. The usage card then names that path, because it need not be on
//      the agents' PATH.
//   2. env OPENCODE_AGENT_INTERCOM_CODEGRAPH_BIN, the same shape.
//   3. `codegraph` on PATH. The card then names the bare command.
// A configured value that is not an absolute path to an executable file is
// logged and falls to the next level.
//
// Resolved once per process, on first use, like the ctags binary in outline.js:
// the card sits in the stable system prompt, so it holds for the life of the
// process, and an install or a settings change takes an opencode restart.

import { accessSync, constants, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import { getCodegraphBins } from "./settings.js"
import { resolveToolPermission } from "./config.js"
import { log } from "./log.js"

export const CODEGRAPH_COMMAND = "codegraph"

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// The command an agent types to run codegraph, or null where none resolves.
// `configured` is the ordered list of configured binaries (file, then env).
export function resolveCodegraphCommand({ configured = [], pathEnv = "" } = {}) {
  for (const value of configured) {
    if (isAbsolute(value) && isExecutableFile(value)) return value
    log("codegraph: configured binary is not an absolute path to an executable file, trying the next level", {
      value,
    })
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && isAbsolute(dir) && isExecutableFile(join(dir, CODEGRAPH_COMMAND))) {
      return CODEGRAPH_COMMAND
    }
  }
  return null
}

function defaultResolver() {
  return resolveCodegraphCommand({ configured: getCodegraphBins(), pathEnv: process.env.PATH ?? "" })
}

let resolver = defaultResolver
// The latched command: `undefined` until the first call, then the command or null.
let resolved

// Test hook: replace the resolver (a function answering the command or null)
// and drop the latch. Called with no argument it restores the real resolution.
export function setCodegraphResolver(fn) {
  resolver = fn || defaultResolver
  resolved = undefined
}

// The command for this process, resolved on the first call.
export function codegraphCommand() {
  if (resolved === undefined) resolved = resolver()
  return resolved
}

// The command `agent` is told about, or null: a command must resolve and the
// resolved opencode config must leave the role its `bash` — the same answer the
// runtime re-check gives when the role calls it.
export async function codegraphCommandFor(client, agent) {
  const command = codegraphCommand()
  if (!command) return null
  return (await resolveToolPermission(client, agent, "bash")) === null ? command : null
}
