// `web_search` custom tool — talks to Exa AI's hosted MCP endpoint via raw
// HTTPS/JSON-RPC, without registering Exa as an MCP server in opencode. Two
// reasons for the custom-tool route over `config.mcp.exa`:
//   1. MCP-server-supplied tool descriptions (~1.5 KB) would land in every LLM
//      call's system prompt; we control a short description here instead.
//   2. opencode also ships a gated built-in tool literally called `websearch`
//      — registering a plugin tool of the same name collides and opencode
//      ends up exposing neither. We pick `web_search` (snake case) to dodge
//      that.
//
// Anonymous use: 150 calls/day, 3 QPS, no auth. Set EXA_API_KEY in the
// environment to use a paid Exa tier (the key is appended to the URL).
// Disable entirely with OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH=1.

import { tool } from "@opencode-ai/plugin"
import { log, errMsg } from "./log.js"

const z = tool.schema

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const DEFAULT_TIMEOUT_MS = 30_000

function exaUrl() {
  const key = process.env.EXA_API_KEY
  return key ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}` : EXA_MCP_URL
}

// Exa's HTTP MCP transport returns Server-Sent-Events: one or more
// `event: message\ndata: <json>` blocks plus the occasional heartbeat or
// `[DONE]` sentinel. Walk every `data:` line until one parses as a JSON-RPC
// payload and unwraps usable content. Non-JSON / empty data lines are skipped
// rather than thrown — otherwise a single heartbeat would crash the call.
function parseSseResult(body) {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (json.error) throw new Error(json.error.message || "Exa error")
    const parts = json.result?.content ?? []
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n").trim()
    if (text) return text
  }
  throw new Error("Exa returned no usable content")
}

async function callExa(toolName, args, signal) {
  const res = await fetch(exaUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Exa HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  return parseSseResult(await res.text())
}

export function isWebsearchEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH !== "1"
}

export function createWebsearchTool() {
  return tool({
    description:
      "Web search (Exa AI). Returns the top hits as clean text with title, URL, " +
      "publish date and content excerpt — usually enough to answer without a follow-up fetch. " +
      'Phrase the query as a description of the ideal page, not keywords ("blog post comparing ' +
      'X and Y performance" beats "X vs Y"). Use webfetch on a returned URL for the full page.',
    args: {
      query: z
        .string()
        .min(1)
        .describe("Natural-language description of the ideal page (not just keywords)"),
      numResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many hits to return, default 5"),
    },
    execute: async (args) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS)
      try {
        const text = await callExa(
          "web_search_exa",
          { query: args.query, numResults: args.numResults ?? 5 },
          ctl.signal,
        )
        return { output: text }
      } catch (err) {
        const msg = ctl.signal.aborted ? `timed out after ${DEFAULT_TIMEOUT_MS}ms` : errMsg(err)
        log("websearch failed", msg)
        return { output: `websearch failed: ${msg}` }
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
