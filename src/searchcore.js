// Shared search core behind the `web_search` and `forum_search` tools: the two
// backend transports (Exa AI's hosted MCP endpoint and, when configured, a
// searxng instance) plus the pure parsing/merging helpers both tools render
// through. Owning them here keeps neither tool module the owner of a transport
// its sibling depends on.
//
// Exa: anonymous use 150 calls/day, 3 QPS, no auth. A key for a paid Exa tier
// is resolved via settings (file `exaApiKey` > env EXA_API_KEY > unset) and
// sent as an `x-api-key` header, never in the URL query — a query string leaks
// the secret into proxy/server access logs.
// searxng: enabled only when a base URL is configured (no token), resolved via
// settings (file `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL).
// Unset → the Exa leg alone.

import { log, errMsg } from "./log.js"
import { getSearxngUrl, getExaApiKey } from "./settings.js"

const EXA_MCP_URL = "https://mcp.exa.ai/mcp"
export const EXA_TIMEOUT_MS = 30_000
export const SEARXNG_TIMEOUT_MS = 12_000

// Build the Exa request headers. When a key is configured it goes in the
// `x-api-key` header — NOT the URL query. A `?exaApiKey=<secret>` query string
// lands in proxy/server access logs; a header does not. Verified against the
// live endpoint: a bad key in the `x-api-key` header returns the same
// `401 Invalid API key` as the query form, i.e. the endpoint honors the header.
// No key configured is normal: Exa's anonymous tier answers without one.
export function exaHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }
  // Resolved via settings: file `exaApiKey` > env EXA_API_KEY > "".
  const key = getExaApiKey()
  if (key) headers["x-api-key"] = key
  return headers
}

// Exa's HTTP MCP transport returns Server-Sent-Events: one or more
// `event: message\ndata: <json>` blocks plus the occasional heartbeat or
// `[DONE]` sentinel. Walk every `data:` line until one parses as a JSON-RPC
// payload and unwraps usable content. Non-JSON / empty data lines are skipped
// rather than thrown — otherwise a single heartbeat would crash the call.
// A result carrying `isError: true` (the free-tier rate limit answers this way,
// HTTP 200 with the limit text as content) is a failed call, not content: its
// reason is kept and thrown once the scan is through, so the caller reports a
// named reason instead of silently parsing zero entries out of an error
// message, and a later usable payload in the same body still wins. An error
// result whose content carries no text part falls back to the raw parts, so
// the reason is never nameless.
function parseSseResult(body) {
  let errorReason = null
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
    if (json.result?.isError) {
      errorReason ??= text || (parts.length > 0 ? JSON.stringify(parts).slice(0, 200) : "Exa error")
      continue
    }
    if (text) return text
  }
  throw new Error(errorReason || "Exa returned no usable content")
}

export async function callExa(toolName, args, signal) {
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: exaHeaders(),
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

export async function callSearxng(query, signal) {
  // Resolved via settings: file `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL > "".
  const base = getSearxngUrl()
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`searxng HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  const json = await res.json()
  return Array.isArray(json?.results) ? json.results : []
}

// ── The two-leg run (shared by web_search and forum_search) ───────────────

// Run both legs concurrently, each under its own timeout: Exa always, searxng
// only when a base URL is configured. Neither leg can fail the other — a
// rejected one comes back as a named reason in `exaErr`/`searxErr`, logged
// under `label`, while the other's payload still arrives. `exaText` is Exa's
// raw text and `searxRows` searxng's raw rows; both are null when that leg
// produced nothing, which the parse helpers take as an empty list.
export async function runSearchLegs({ label, exaArgs, searxQuery }) {
  const useSearxng = !!getSearxngUrl()

  const exaCtl = new AbortController()
  const exaTimer = setTimeout(() => exaCtl.abort(), EXA_TIMEOUT_MS)
  const exaTask = callExa("web_search_exa", exaArgs, exaCtl.signal).finally(() =>
    clearTimeout(exaTimer),
  )

  let searxTask = null
  let searxCtl = null
  if (useSearxng) {
    searxCtl = new AbortController()
    const searxTimer = setTimeout(() => searxCtl.abort(), SEARXNG_TIMEOUT_MS)
    searxTask = callSearxng(searxQuery, searxCtl.signal).finally(() => clearTimeout(searxTimer))
  }

  const [exaSettled, searxSettled] = await Promise.allSettled([
    exaTask,
    searxTask ?? Promise.resolve(null),
  ])

  let exaText = null
  let exaErr = null
  if (exaSettled.status === "fulfilled") {
    exaText = exaSettled.value
  } else {
    exaErr = exaCtl.signal.aborted
      ? `timed out after ${EXA_TIMEOUT_MS}ms`
      : errMsg(exaSettled.reason)
  }

  let searxRows = null
  let searxErr = null
  if (useSearxng) {
    if (searxSettled.status === "fulfilled") {
      searxRows = searxSettled.value
    } else {
      searxErr = searxCtl.signal.aborted
        ? `timed out after ${SEARXNG_TIMEOUT_MS}ms`
        : errMsg(searxSettled.reason)
    }
  }

  if (exaErr) log(`${label} exa failed`, exaErr)
  if (searxErr) log(`${label} searxng failed`, searxErr)

  return { exaText, exaErr, searxRows, searxErr }
}

// Both legs came back without entries → the tool's failure line, naming every
// reason there is. `tool` is the tool's own name, since that is the string the
// calling model sees.
export function legFailureText(tool, exaErr, searxErr) {
  const why = [exaErr && `exa: ${exaErr}`, searxErr && `searxng: ${searxErr}`]
    .filter(Boolean)
    .join("; ")
  return `${tool} failed: ${why || "no results"}`
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

// Map raw searxng result rows to the shared entry shape. `score` is searxng's
// reciprocal-rank figure and `engine` the engine that returned the row; both
// are kept for callers that rank and cap inside the searxng leg
// (`forum_search`). A row without a score scores 0, one without an engine name
// gets "". Neither field is rendered.
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
      score: Number(r.score) || 0,
      engine: (r.engine ?? "").trim(),
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
