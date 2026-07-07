// `web_search` custom tool — queries Exa AI's hosted MCP endpoint AND (when
// configured) a searxng instance, then merges + de-duplicates the hits into a
// single Exa-shaped text block so small models keep parsing one stable format.
//
// Two reasons for the custom-tool route over `config.mcp.exa`:
//   1. MCP-server-supplied tool descriptions (~1.5 KB) would land in every LLM
//      call's system prompt; we control a short description here instead.
//   2. opencode also ships a gated built-in tool literally called `websearch`
//      — registering a plugin tool of the same name collides and opencode
//      ends up exposing neither. We pick `web_search` (snake case) to dodge
//      that.
//
// Exa: anonymous use 150 calls/day, 3 QPS, no auth. Set EXA_API_KEY in the
// environment to use a paid Exa tier (the key is appended to the URL).
// searxng: enabled only when a base URL is configured (no token), resolved via
// settings (file `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL).
// Unset → Exa-only, the historic behaviour.
// Disable the whole tool with OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH=1.

import { tool } from "@opencode-ai/plugin"
import { log, errMsg } from "./log.js"
import { getSearxngUrl } from "./settings.js"

const z = tool.schema

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
const EXA_TIMEOUT_MS = 30_000
const SEARXNG_TIMEOUT_MS = 12_000

function exaUrl() {
  const key = process.env.EXA_API_KEY
  return key ? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}` : EXA_MCP_URL
}

function searxngUrl() {
  // Resolved via settings: file `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL > "".
  const base = getSearxngUrl()
  return base ? base : null
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

async function callSearxng(query, signal) {
  const base = searxngUrl()
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`searxng HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  const json = await res.json()
  return Array.isArray(json?.results) ? json.results : []
}

// ── Parsing / merging (pure, unit-tested) ─────────────────────────────────

// Collapse a URL to a comparison key: drop the scheme, lowercase the host,
// strip a trailing slash. Query string is intentionally kept — different
// queries are different pages. Falsy/garbage URLs return "" (never merged).
export function normalizeUrl(raw) {
  if (!raw || typeof raw !== "string") return ""
  let s = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  const slash = s.indexOf("/")
  if (slash === -1) return s.toLowerCase().replace(/\/+$/, "")
  const host = s.slice(0, slash).toLowerCase()
  const rest = s.slice(slash).replace(/\/+$/, "")
  return host + rest
}

// Parse Exa's formatted text into structured entries. Exa emits blocks
// separated by a lone `---` line, each with `Title:`/`URL:`/`Published:`/
// `Author:` lines and a trailing `Highlights:` body.
export function parseExaEntries(text) {
  if (!text) return []
  const entries = []
  for (const raw of text.split(/\n\s*---\s*\n/)) {
    const block = raw.trim()
    if (!block) continue
    const grab = (label) => {
      const m = block.match(new RegExp(`^${label}:[ \\t]*(.*)$`, "m"))
      return m ? m[1].trim() : ""
    }
    const url = grab("URL")
    if (!url) continue
    const hi = block.split(/^Highlights:[ \t]*$/m)
    const content = (hi.length > 1 ? hi.slice(1).join("\n") : "").trim()
    entries.push({
      title: grab("Title"),
      url,
      published: grab("Published"),
      author: grab("Author"),
      content,
      source: "exa",
    })
  }
  return entries
}

// Map raw searxng result rows to the shared entry shape.
export function searxToEntries(results) {
  const entries = []
  for (const r of results ?? []) {
    if (!r?.url) continue
    entries.push({
      title: (r.title ?? "").trim(),
      url: String(r.url).trim(),
      published: (r.publishedDate ?? "").toString().trim(),
      author: "",
      content: (r.content ?? "").trim(),
      source: "searxng",
    })
  }
  return entries
}

// Merge entry lists de-duplicated by normalized URL. On collision keep the
// entry with the richer snippet, but remember every source the URL showed up
// in. Returns the full deduped list plus a small stats object for logging.
export function mergeAndDedup(...lists) {
  const byKey = new Map()
  const order = []
  let duplicates = 0
  for (const list of lists) {
    for (const e of list ?? []) {
      const key = normalizeUrl(e.url)
      if (!key) continue
      const prev = byKey.get(key)
      if (!prev) {
        const entry = { ...e, sources: new Set([e.source]) }
        byKey.set(key, entry)
        order.push(key)
        continue
      }
      duplicates++
      prev.sources.add(e.source)
      // Prefer the richer snippet; fill any empty scalar fields from the other.
      if ((e.content?.length ?? 0) > (prev.content?.length ?? 0)) prev.content = e.content
      if (!prev.title && e.title) prev.title = e.title
      if (!prev.published && e.published) prev.published = e.published
      if (!prev.author && e.author) prev.author = e.author
    }
  }
  const merged = order.map((k) => {
    const e = byKey.get(k)
    return { ...e, sources: [...e.sources] }
  })
  return { merged, duplicates }
}

// Render merged entries back into Exa's text shape so downstream parsing is
// unchanged whether one or both backends answered.
export function renderEntries(entries) {
  return entries
    .map((e) => {
      const lines = [
        `Title: ${e.title || "N/A"}`,
        `URL: ${e.url}`,
        `Published: ${e.published || "N/A"}`,
        `Author: ${e.author || "N/A"}`,
        "Highlights:",
        e.content || "N/A",
      ]
      return lines.join("\n")
    })
    .join("\n\n---\n\n")
}

export function isWebsearchEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH !== "1"
}

export function createWebsearchTool() {
  return tool({
    description:
      "Web search (Exa AI + searxng). Returns the top hits as clean text with title, URL, " +
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
      const numResults = args.numResults ?? 5
      const useSearxng = !!searxngUrl()

      const exaCtl = new AbortController()
      const exaTimer = setTimeout(() => exaCtl.abort(), EXA_TIMEOUT_MS)
      const exaTask = callExa(
        "web_search_exa",
        { query: args.query, numResults },
        exaCtl.signal,
      ).finally(() => clearTimeout(exaTimer))

      let searxTask = null
      let searxCtl = null
      let searxTimer = null
      if (useSearxng) {
        searxCtl = new AbortController()
        searxTimer = setTimeout(() => searxCtl.abort(), SEARXNG_TIMEOUT_MS)
        searxTask = callSearxng(args.query, searxCtl.signal).finally(() => clearTimeout(searxTimer))
      }

      const [exaSettled, searxSettled] = await Promise.allSettled([
        exaTask,
        searxTask ?? Promise.resolve(null),
      ])

      let exaEntries = []
      let exaErr = null
      if (exaSettled.status === "fulfilled") {
        exaEntries = parseExaEntries(exaSettled.value)
      } else {
        exaErr = exaCtl.signal.aborted
          ? `timed out after ${EXA_TIMEOUT_MS}ms`
          : errMsg(exaSettled.reason)
      }

      let searxEntries = []
      let searxErr = null
      if (useSearxng) {
        if (searxSettled.status === "fulfilled") {
          searxEntries = searxToEntries(searxSettled.value)
        } else {
          searxErr = searxCtl.signal.aborted
            ? `timed out after ${SEARXNG_TIMEOUT_MS}ms`
            : errMsg(searxSettled.reason)
        }
      }

      if (exaErr) log("websearch exa failed", exaErr)
      if (searxErr) log("websearch searxng failed", searxErr)

      // Both backends dead → historic error-output shape, no crash.
      if (exaEntries.length === 0 && searxEntries.length === 0) {
        const why = [exaErr && `exa: ${exaErr}`, searxErr && `searxng: ${searxErr}`]
          .filter(Boolean)
          .join("; ")
        return { output: `websearch failed: ${why || "no results"}` }
      }

      const { merged, duplicates } = mergeAndDedup(exaEntries, searxEntries)
      const capped = merged.slice(0, numResults)
      log(
        "websearch merge",
        `exa=${exaEntries.length}`,
        `searxng=${searxEntries.length}`,
        `merged=${merged.length}`,
        `dupesRemoved=${duplicates}`,
        `returned=${capped.length}`,
      )
      return { output: renderEntries(capped) }
    },
  })
}
