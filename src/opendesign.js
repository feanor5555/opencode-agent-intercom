// Thin HTTP/JSON client for the OpenDesign daemon (lukas:7456).
//
// Slice S2 — single-file, no CLI, no live network. Token is read from the
// env or from the createClient config; it is NEVER hardcoded or logged.
//
// API surface:
//   const client = createClient({ baseURL?, token? })
//   client.health()                      -> Promise<unknown>
//   client.status()                      -> Promise<unknown>
//   client.request(path, opts?)          -> Promise<unknown>
//
//   request(path, { method = "GET", query, body, headers } = {}) ->
//     prepends baseURL to path, sets
//       Authorization: Bearer <token>   (only when token is truthy)
//       Accept: application/json
//     encodes `body` as JSON and sets Content-Type when encoding happens,
//     parses JSON response on 2xx, throws OpenDesignHttpError on non-2xx.

export class OpenDesignHttpError extends Error {
  constructor(message, { status, body, url, method }) {
    super(message)
    this.name = "OpenDesignHttpError"
    this.status = status
    this.body = body
    this.url = url
    this.method = method
  }
}

const DEFAULT_BASE_URL = "http://lukas:7456"

function resolveConfig(overrides = {}) {
  const baseURL =
    overrides.baseURL ?? process.env.OPENDESIGN_BASE_URL ?? DEFAULT_BASE_URL
  const token =
    overrides.token !== undefined
      ? overrides.token
      : (process.env.OPENDESIGN_API_TOKEN ?? null)

  return { baseURL, token }
}

function buildURL(baseURL, path, query) {
  // Accept either "/api/..." or "api/..." — normalize to "/api/..."
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  const url = new URL(baseURL.replace(/\/+$/, "") + normalizedPath)
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, String(v))
    }
  }
  return url
}

function excerptBody(text, max = 200) {
  if (text == null) return ""
  const s = String(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function createClient(overrides = {}) {
  const { baseURL, token } = resolveConfig(overrides)

  async function request(path, options = {}) {
    const method = options.method || "GET"
    const url = buildURL(baseURL, path, options.query)

    const headers = {
      Accept: "application/json",
      ...(options.headers || {}),
    }
    if (token) headers.Authorization = `Bearer ${token}`

    let body
    if (options.body !== undefined && options.body !== null) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body)
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json"
      }
    }

    const init = { method, headers }
    if (body !== undefined) init.body = body

    // Prefer global fetch (Node 18+). Fall back to node:http(s) only if it
    // is somehow missing (older embedders).
    const f = typeof globalThis.fetch === "function" ? globalThis.fetch : null
    if (!f) {
      throw new OpenDesignHttpError(
        "global fetch is not available in this runtime",
        { status: 0, body: "", url: url.toString(), method },
      )
    }

    const res = await f(url, init)

    const text = await res.text().catch(() => "")
    let parsed
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        // Not JSON — leave parsed undefined; the caller sees the raw text via error.body.
      }
    }

    if (!res.ok) {
      throw new OpenDesignHttpError(
        `OpenDesign ${method} ${url.pathname}${url.search} failed: ${res.status} ${res.statusText} — ${excerptBody(text)}`,
        { status: res.status, body: text, url: url.toString(), method },
      )
    }

    return parsed
  }

  return {
    baseURL,
    token,
    health() {
      return request("/api/health")
    },
    status() {
      return request("/api/daemon/status")
    },
    request,
  }
}
