// `grounded_search` custom tool — one call to Google's Gemini API with the
// Search grounding tool switched on. Unlike `web_search` and `forum_search`,
// which return rows for the model to read, this returns a written answer plus
// the pages it was grounded in: the search, the fetching and the reading all
// happen on Google's side and one call comes back.
//
// The request body carries `tools: [{ google_search: {} }]` — the snake_case
// form is Google's current documented shape for the v1beta generateContent
// endpoint. The API key travels in the `x-goog-api-key` header, never in the
// URL query: a query string leaks the secret into proxy/server access logs.
//
// Disable the whole tool with OPENCODE_AGENT_INTERCOM_DISABLE_GROUNDED_SEARCH=1.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"
import { log } from "./log.js"

const z = tool.schema

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

// Search grounding runs on this model and on no other.
export const DEFAULT_GROUNDING_MODEL = "gemini-3.7-flash"

// A grounded answer is a search, several page fetches and a generation behind
// one request, so the ceiling sits far above the plain search tools'.
export const DEFAULT_GROUNDING_TIMEOUT_MS = 90_000

export const DEFAULT_MAX_SOURCES = 8
export const MIN_MAX_SOURCES = 1
export const MAX_MAX_SOURCES = 20

// The four places a key is looked for, in this order. Named in the missing-key
// error so the user can act on it without reading the source.
export const API_KEY_ENV_VARS = [
  "OPENCODE_AGENT_INTERCOM_GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
]

// opencode's own credential store. `google.key` is where `opencode auth login`
// puts a Gemini key, so a machine already logged in needs no extra env var.
export function authFilePath() {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
  const base = dataHome || join(homedir(), ".local", "share")
  return join(base, "opencode", "auth.json")
}

// Read `google.key` out of opencode's auth file. Every failure — missing file,
// unreadable file, broken JSON, absent field — is "no key here", never a throw:
// the env vars above may still carry one, and the missing-key error below is
// the single place that reports the absence.
function keyFromAuthFile() {
  let raw
  try {
    raw = readFileSync(authFilePath(), "utf8")
  } catch {
    return ""
  }
  try {
    const parsed = JSON.parse(raw)
    const key = parsed?.google?.key
    return typeof key === "string" ? key.trim() : ""
  } catch {
    return ""
  }
}

// The key in effect, or "" when there is none. A whitespace-only value counts
// as unset, the same way settings.js treats a blank env var. The VALUE is
// returned to the caller only; it is never logged and never rendered.
export function resolveGoogleApiKey() {
  for (const name of API_KEY_ENV_VARS) {
    const value = process.env[name]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return keyFromAuthFile()
}

// The message the tool fails with when no key is configured. Names all four
// places, in the order they are consulted, and never echoes a value.
export function missingKeyMessage() {
  return (
    `grounded_search needs a Google Gemini API key and found none. Set one of the environment ` +
    `variables ${API_KEY_ENV_VARS.join(", ")}, or put it in the "google" entry of opencode's ` +
    `auth file at ${authFilePath()} as its "key" field (\`opencode auth login\` writes it there). ` +
    `Nothing was sent.`
  )
}

export function groundingTimeoutMs() {
  const raw = Number(process.env.OPENCODE_AGENT_INTERCOM_GROUNDING_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GROUNDING_TIMEOUT_MS
}

// Clamp the caller's `max_sources` into 1..20. The parameter is optional, so
// an absent one — `undefined`, `null` or a blank string, all of which a model
// does send for "not given" — takes the default rather than converting to 0 and
// clamping up to 1. A non-numeric value takes the default too; a fractional one
// is floored, so 8.9 means 8 rather than a list length nothing can produce.
export function clampMaxSources(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_SOURCES
  if (typeof value === "string" && value.trim() === "") return DEFAULT_MAX_SOURCES
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_MAX_SOURCES
  return Math.min(MAX_MAX_SOURCES, Math.max(MIN_MAX_SOURCES, Math.floor(n)))
}

// The endpoint for one model. Path-encoded, so a model name carrying a slash
// or a space cannot reshape the URL.
export function generateContentUrl(model) {
  return `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`
}

// The request body: one user turn plus the Search grounding tool.
export function groundedRequestBody(prompt) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  }
}

// The answer text: every text part of the first candidate, in order. Parts
// flagged `thought` are the model's own reasoning summary, not its answer, so
// they stay out.
export function extractAnswer(json) {
  const parts = json?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p) => p?.thought !== true && typeof p?.text === "string")
    .map((p) => p.text)
    .join("")
    .trim()
}

// The pages the answer is grounded in, deduped by URI and capped at `limit`.
//
// `groundingSupports` maps spans of the answer onto chunk indices, so walking
// the supports in order yields the sources in the order the answer leans on
// them — the ordering a reader follows. `groundingChunks` is the flat pool
// behind those indices and is used directly when the supports produced nothing
// usable (no supports at all, or indices pointing at chunks without a web URI),
// because a grounded answer whose supports are absent still names its pages
// there.
export function extractSources(metadata, limit) {
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : []
  const supports = Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports : []

  const seen = new Set()
  const sources = []
  const take = (chunk) => {
    const web = chunk?.web
    const uri = typeof web?.uri === "string" ? web.uri.trim() : ""
    if (!uri || seen.has(uri)) return
    seen.add(uri)
    const title = typeof web?.title === "string" ? web.title.trim() : ""
    sources.push({ title: title || uri, uri })
  }

  for (const support of supports) {
    const indices = Array.isArray(support?.groundingChunkIndices)
      ? support.groundingChunkIndices
      : []
    for (const i of indices) take(chunks[i])
  }
  if (sources.length === 0) for (const chunk of chunks) take(chunk)

  return Number.isFinite(limit) ? sources.slice(0, limit) : sources
}

// The queries Google actually ran for this answer — what makes the search
// itself inspectable rather than a black box.
export function extractSearchQueries(metadata) {
  const queries = metadata?.webSearchQueries
  if (!Array.isArray(queries)) return []
  return queries.map((q) => String(q).trim()).filter((q) => q !== "")
}

// The rendered result: the answer, then the numbered sources, then the queries.
// A block with nothing in it is left out entirely rather than printed empty.
export function renderGroundedResult({ answer, sources, queries }) {
  const blocks = []
  if (answer) blocks.push(answer)
  if (sources.length > 0) {
    const rows = sources.map((s, i) => `${i + 1}. ${s.title} — ${s.uri}`)
    blocks.push(`Sources:\n${rows.join("\n")}`)
  }
  if (queries.length > 0) blocks.push(`Search queries: ${queries.join(", ")}`)
  if (blocks.length === 0) {
    return "grounded_search: the model returned neither an answer nor any grounding source."
  }
  return blocks.join("\n\n")
}

// A non-2xx reply. Google answers errors as JSON carrying `error.message`; that
// message is what names the cause (bad key, quota, unknown model). A body that
// is not that shape — an HTML error page from a proxy, an empty body — is
// surfaced verbatim, because guessing at it would hide the only evidence there is.
export function httpErrorMessage(status, body) {
  const text = typeof body === "string" ? body.trim() : ""
  if (text !== "") {
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.error?.message
      if (typeof message === "string" && message.trim() !== "") {
        return `Gemini HTTP ${status}: ${message.trim()}`
      }
    } catch {
      // not JSON — fall through and surface the body as it came
    }
    return `Gemini HTTP ${status}: ${text}`
  }
  return `Gemini HTTP ${status}`
}

export function isGroundedSearchEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_GROUNDED_SEARCH !== "1"
}

export function createGroundedSearchTool() {
  return tool({
    description:
      "Ask Google's Gemini a question with Search grounding on: it runs the searches, reads the " +
      "pages and returns a written answer plus the sources it used. Use this when you want the " +
      "ANSWER to a factual question — a version, a release date, whether something is supported — " +
      "rather than pages to read yourself; use `web_search` when you need the pages, and " +
      "`forum_search` for lived user experience. Every claim comes back with the source list it " +
      "was grounded in; `webfetch` a source to verify it.",
    args: {
      query: z
        .string()
        .min(1)
        .describe("The question to answer, in prose — as you would ask a person"),
      max_sources: z
        .number()
        .min(MIN_MAX_SOURCES)
        .max(MAX_MAX_SOURCES)
        .optional()
        .describe(`How many grounding sources to list, 1-20, default ${DEFAULT_MAX_SOURCES}`),
    },
    execute: async (args, toolCtx) => {
      const key = resolveGoogleApiKey()
      if (!key) {
        log("groundedsearch: no api key configured")
        throw new Error(missingKeyMessage())
      }

      const model = DEFAULT_GROUNDING_MODEL
      const maxSources = clampMaxSources(args.max_sources)
      const timeoutMs = groundingTimeoutMs()

      // Own controller for the timeout, plus the caller's signal chained onto
      // it, so a tool call the model or the user cancels stops the request
      // instead of running out its own ceiling.
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      const callerSignal = toolCtx?.abort
      const onCallerAbort = () => ctl.abort()
      if (callerSignal?.aborted) ctl.abort()
      else callerSignal?.addEventListener?.("abort", onCallerAbort)

      // The timer covers reading the body too, not just the fetch: a response
      // whose stream stalls half-way is the same hang as one that never
      // arrives. The non-2xx failure is carried out of the block rather than
      // thrown inside it, so the abort mapping below cannot dress an HTTP error
      // up as a timeout.
      let json = null
      let httpFailure = null
      try {
        const res = await fetch(generateContentUrl(model), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Header, never a URL query: a query string lands in access logs.
            "x-goog-api-key": key,
          },
          body: JSON.stringify(groundedRequestBody(args.query)),
          signal: ctl.signal,
        })
        if (res.ok) json = await res.json()
        else httpFailure = { status: res.status, body: await res.text().catch(() => "") }
      } catch (err) {
        if (ctl.signal.aborted) {
          throw new Error(
            callerSignal?.aborted
              ? "grounded_search: the call was aborted"
              : `grounded_search: timed out after ${timeoutMs}ms`,
          )
        }
        throw err
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener?.("abort", onCallerAbort)
      }

      if (httpFailure) {
        log("groundedsearch http error", { model, status: httpFailure.status })
        throw new Error(httpErrorMessage(httpFailure.status, httpFailure.body))
      }

      const metadata = json?.candidates?.[0]?.groundingMetadata
      const answer = extractAnswer(json)
      const sources = extractSources(metadata, maxSources)
      const queries = extractSearchQueries(metadata)
      const grounded = sources.length > 0 || queries.length > 0

      log(
        "groundedsearch answer",
        `model=${model}`,
        `grounded=${grounded}`,
        `sources=${sources.length}/${maxSources}`,
        `queries=${queries.length}`,
        `answerChars=${answer.length}`,
      )

      return {
        output: renderGroundedResult({ answer, sources, queries }),
        metadata: {
          model,
          grounded,
          searchQueries: queries,
          sourceCount: sources.length,
        },
      }
    },
  })
}
