// Slice S3 — CLI wrapper around src/opendesign.js (S2).
//
// Exports `run(argv, deps = {})` so tests can inject a fake client + buffers.
// The real bin/opendesign.js is the only place that calls process.exit.
//
// Surface (commands + flags):
//   opendesign version           (alias: --version)
//   opendesign help              (alias: --help, or no args)
//   opendesign health
//   opendesign status
//   opendesign request <path> [-X <method>] [-d <json>] [-q <k=v>]...
//
// Exit codes:
//   0  success
//   1  OpenDesignHttpError or other caught failure
//   2  argument/usage error (missing <path>, bad -d JSON, unknown subcommand)
//
// On error we write a short message to stderr — no stack trace for HTTP errors.
// Unexpected programming errors are NOT caught and propagate.

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseArgs } from "node:util"

import { createClient, OpenDesignHttpError } from "./opendesign.js"

// ─── defaults ────────────────────────────────────────────────────────────────

function readVersionFromPackageJson() {
  try {
    // Resolve relative to this file so the CLI works regardless of CWD.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkgPath = path.resolve(here, "..", "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    return typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function defaultDeps() {
  return {
    client: createClient(),
    stdout: process.stdout,
    stderr: process.stderr,
    version: readVersionFromPackageJson(),
  }
}

// ─── usage text ──────────────────────────────────────────────────────────────

function usageText(version) {
  return `opendesign ${version} — thin CLI over the OpenDesign HTTP daemon

Usage:
  opendesign <command> [options]

Commands:
  version                  print the CLI version and exit
  help                     print this help and exit
  health                   call /api/health
  status                   call /api/daemon/status
  request <path>           generic request: -X <method> -d <json> -q k=v ...

Request options:
  -X, --method <method>    HTTP method (default: GET)
  -d, --data <json>        JSON body (string is parsed; must be valid JSON)
  -q, --query <k=v>        query parameter; repeat to add more

Flags (work without a subcommand):
  --version, -v            print the CLI version
  --help, -h               print this help

Config (env, no token is hardcoded):
  OPENDESIGN_BASE_URL      base URL (default: http://lukas:7456)
  OPENDESIGN_API_TOKEN     bearer token (default: unset)

Exit codes: 0 = ok, 1 = daemon error, 2 = usage/argument error.
`
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeLine(stream, text) {
  stream.write(text)
  if (!text.endsWith("\n")) stream.write("\n")
}

function parseQueryPair(pair) {
  const eq = pair.indexOf("=")
  if (eq < 0) {
    throw new Error(`query ${JSON.stringify(pair)} is not k=v`)
  }
  const k = pair.slice(0, eq)
  const v = pair.slice(eq + 1)
  if (k.length === 0) {
    throw new Error(`query ${JSON.stringify(pair)} has empty key`)
  }
  return [k, v]
}

function formatHttpError(err) {
  // Short, no stack trace. Include status + a body excerpt (truncated).
  const status = err.status != null ? String(err.status) : "?"
  const raw = err.body
  let excerpt = ""
  if (raw != null && raw !== "") {
    const s = String(raw).replace(/\s+/g, " ").trim()
    excerpt = s.length > 200 ? `${s.slice(0, 200)}…` : s
  }
  return excerpt
    ? `opendesign: HTTP ${status} — ${excerpt}`
    : `opendesign: HTTP ${status}`
}

// ─── run() ───────────────────────────────────────────────────────────────────

export async function run(argv, deps = {}) {
  const merged = { ...defaultDeps(), ...deps }
  const { client, stdout, stderr, version } = merged
  const args = Array.isArray(argv) ? argv.slice() : []

  // --version / --help as bare flags (no subcommand) — handle before parseArgs
  // so they work with or without a leading subcommand.
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    writeLine(stdout, version)
    return 0
  }
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    writeLine(stdout, usageText(version))
    return 0
  }

  const sub = args[0]
  const rest = args.slice(1)

  // --- version subcommand
  if (sub === "version") {
    writeLine(stdout, version)
    return 0
  }

  // --- help subcommand
  if (sub === "help") {
    writeLine(stdout, usageText(version))
    return 0
  }

  // --- health
  if (sub === "health") {
    try {
      const result = await client.health()
      writeLine(stdout, JSON.stringify(result, null, 2))
      return 0
    } catch (err) {
      if (err instanceof OpenDesignHttpError) {
        writeLine(stderr, formatHttpError(err))
        return 1
      }
      throw err
    }
  }

  // --- status
  if (sub === "status") {
    try {
      const result = await client.status()
      writeLine(stdout, JSON.stringify(result, null, 2))
      return 0
    } catch (err) {
      if (err instanceof OpenDesignHttpError) {
        writeLine(stderr, formatHttpError(err))
        return 1
      }
      throw err
    }
  }

  // --- request
  if (sub === "request") {
    let parsed
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: true,
        strict: true,
        options: {
          method: { type: "string", short: "X" },
          data: { type: "string", short: "d" },
          query: { type: "string", short: "q", multiple: true },
        },
      })
    } catch (err) {
      writeLine(stderr, `opendesign: ${err.message}`)
      return 2
    }

    const positionals = parsed.positionals
    if (positionals.length === 0) {
      writeLine(stderr, "opendesign: request needs a <path> argument")
      return 2
    }
    if (positionals.length > 1) {
      writeLine(stderr, `opendesign: request takes a single <path>, got ${positionals.length}`)
      return 2
    }
    const apiPath = positionals[0]

    let body
    if (parsed.values.data !== undefined) {
      try {
        body = JSON.parse(parsed.values.data)
      } catch (err) {
        writeLine(stderr, `opendesign: -d is not valid JSON: ${err.message}`)
        return 2
      }
    }

    let query
    const queryPairs = parsed.values.query
    if (queryPairs && queryPairs.length > 0) {
      query = {}
      for (const pair of queryPairs) {
        try {
          const [k, v] = parseQueryPair(pair)
          query[k] = v
        } catch (err) {
          writeLine(stderr, `opendesign: ${err.message}`)
          return 2
        }
      }
    }

    const method = parsed.values.method || "GET"

    try {
      const result = await client.request(apiPath, { method, body, query })
      writeLine(stdout, JSON.stringify(result, null, 2))
      return 0
    } catch (err) {
      if (err instanceof OpenDesignHttpError) {
        writeLine(stderr, formatHttpError(err))
        return 1
      }
      throw err
    }
  }

  // --- unknown subcommand
  writeLine(stderr, `opendesign: unknown command ${JSON.stringify(sub)} (try 'opendesign help')`)
  return 2
}
