// Thin wrappers over the opencode SDK client.
//
// Write helpers (create/prompt/abort) delegate plainly and let the caller
// handle failures. Read helpers (status/activity) are best-effort: they catch
// internally and return undefined, since a missing reading is not an error.

import { log, errMsg } from "./log.js"
import { getSettings } from "./settings.js"

// Sleeps `ms` milliseconds. Resolved via setTimeout so a value of 0 returns
// immediately without going through the timer queue.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Wakes a session with a plain-text notice — non-blocking (204). Used to push a
// subagent-completion notice into the idle primary so it reports back proactively.
//
// Wrapped in a retry+linear-backoff loop driven by `postNoticeRetries` and
// `postNoticeRetryBackoffMs` from settings. The opencode SDK's promptAsync
// can transiently fail (network blip, server restart between attempts); a
// single 5xx must not cost the primary its wake. After `postNoticeRetries`
// RE-tries are exhausted the last error is re-thrown — the existing
// try/catch in hooks.js still runs its cleanup path (free slot, log,
// showToast variant), unchanged.
//
// `postNoticeRetries` counts RE-tries only: postNoticeRetries=3 means
// 1 initial attempt + up to 3 retries = up to 4 total attempts. A value of 0
// disables retries (single attempt, same as the pre-retry behavior).
// `postNoticeRetryBackoffMs` is the base delay; we add a small jitter (0–25%
// of the base) to avoid synchronised thundering-herd retries if opencode
// comes back up under load.
export async function postNotice(client, sessionID, text) {
  const { postNoticeRetries, postNoticeRetryBackoffMs } = getSettings()
  const maxAttempts = Math.max(1, postNoticeRetries + 1)
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
      return
    } catch (err) {
      lastErr = err
      if (attempt >= maxAttempts) break
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(postNoticeRetryBackoffMs / 4)))
      const delay = (attempt * postNoticeRetryBackoffMs) + jitter
      log("postNotice: retrying after failure", {
        attempt,
        maxAttempts,
        delayMs: delay,
        err: errMsg(err),
      })
      await sleep(delay)
    }
  }
  throw lastErr
}

// The SDK client wraps responses as { data, error, response }. Older shapes
// returned the payload directly — unwrap defensively either way.
export function unwrap(resp) {
  if (resp && typeof resp === "object" && "data" in resp) return resp.data
  return resp
}

// Creates a child session and returns its sessionID (undefined on failure).
export async function createChildSession(client, { parentID, title, directory }) {
  const created = unwrap(
    await client.session.create({ body: { parentID, title }, query: { directory } }),
  )
  return created?.id
}

// Fires a non-blocking prompt into a session — returns immediately (204).
export async function promptSession(client, { sessionID, agent, prompt }) {
  await client.session.promptAsync({
    path: { id: sessionID },
    body: { agent, parts: [{ type: "text", text: prompt }] },
  })
}

// Sends opencode's cooperative abort signal. Returns whether it was confirmed.
export async function abortSession(client, sessionID) {
  return Boolean(unwrap(await client.session.abort({ path: { id: sessionID } })))
}

// Per-session directory cache. `toolCtx.directory` and the plugin-factory
// closure's `directory` both reflect where `opencode serve` was started, NOT
// the session's actual project directory (which is set per-session via
// `?directory=...` on POST /session). The authoritative source is the session
// object itself; we fetch it lazily and cache to avoid a round-trip per tool
// call. Cache entries are dropped by `forgetSessionDirectory` when a session
// is destroyed (wake-hook + deleteSession).
const sessionDirCache = new Map()

export async function getSessionDirectory(client, sessionID) {
  if (!sessionID) return undefined
  if (sessionDirCache.has(sessionID)) return sessionDirCache.get(sessionID)
  try {
    const data = unwrap(await client.session.get({ path: { id: sessionID } }))
    const dir = data?.directory
    if (dir) sessionDirCache.set(sessionID, dir)
    return dir
  } catch (err) {
    log("session.get failed", errMsg(err))
    return undefined
  }
}

export function forgetSessionDirectory(sessionID) {
  sessionDirCache.delete(sessionID)
}

// Best-effort permanent deletion of a session in opencode (DELETE /session/{id}).
// We call this after our own registry reap, to keep the opencode server's
// session list from accumulating forever. Errors are swallowed and logged — a
// missed delete is not worth crashing the event handler over.
export async function deleteSession(client, sessionID) {
  try {
    await client.session.delete({ path: { id: sessionID } })
    return true
  } catch (err) {
    log("session.delete failed", errMsg(err))
    return false
  }
}

// Cap on the snapshot HTTP fetch so a stuck opencode server never blocks a
// subagent's whole LLM turn (the transform hook awaits this before injecting).
const SNAPSHOT_TIMEOUT_MS = 5000

// Hard cap on the subagent's final-result text that gets pushed into the
// orchestrator's wake notice. Defends against small models that paste whole
// file contents, base64 image blobs or screenshot dumps into their reply —
// without a cap the orchestrator's context blows up and it can't read its
// own wake notice. Counted in code points (not bytes) so multi-byte
// characters don't double-charge. 0 disables the cap.
//
// Env override: OPENCODE_AGENT_INTERCOM_RESULT_CHARS — useful when a big
// model legitimately needs the full output, or for debugging the truncation.
const DEFAULT_RESULT_CHARS = 8000
const resultCharCap = (() => {
  const env = process.env.OPENCODE_AGENT_INTERCOM_RESULT_CHARS
  if (env === undefined || env === "") return DEFAULT_RESULT_CHARS
  const n = Number(env)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_RESULT_CHARS
})()

function capResult(text, sessionID) {
  if (!text || resultCharCap <= 0) return text
  const arr = [...text]
  if (arr.length <= resultCharCap) return text
  const omitted = arr.length - resultCharCap
  return (
    arr.slice(0, resultCharCap).join("") +
    `\n\n[truncated — ${omitted} more characters omitted to fit the orchestrator's context. ` +
    `Open subagent session ${sessionID} in the TUI for the full output.]`
  )
}

// Best-effort snapshot of a session: a short description of its last activity,
// its context size (tokens of the most recent assistant step), and the full
// text of its final assistant message (its result). Any field may be undefined
// if unavailable. One messages() call serves all three.
export async function fetchSnapshot(client, sessionID) {
  try {
    const resp = unwrap(
      await client.session.messages({
        path: { id: sessionID },
        signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      }),
    )
    const messages = Array.isArray(resp) ? resp : []
    return {
      lastActivity: latestActivity(messages),
      ctxTokens: latestContextTokens(messages),
      result: capResult(finalResult(messages), sessionID),
    }
  } catch (err) {
    log("session.messages failed", errMsg(err))
    return {}
  }
}

// Full text of the subagent's final assistant message — its result, pushed to
// the primary on completion. Untruncated, unlike latestActivity.
function finalResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.info?.role !== "assistant") continue
    const text = (m.parts ?? [])
      .filter((p) => p?.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}

// Sums the tokens of the newest assistant message — a proxy for "how much
// context is this session working with". Mirrors opencode's own context-limit
// check (found in the opencode binary): `input + output + cache.read +
// cache.write`. cache.read/cache.write are SEPARATE from input here — the
// stored `tokens.input` is the noCache portion, so input + cache.read +
// cache.write reconstructs the total input. reasoning is INTENTIONALLY
// EXCLUDED: opencode's context-overflow check excludes it (reasoning tokens
// are generated, not retained as context fill), and including it inflated the
// measurement on thinking models — which made the orchestrator handoff
// (`maxPrimaryContext`) fire far too early, right after a reasoning-heavy turn.
// (opencode's `totalTokens` cost metric DOES add reasoning, but that is for
// billing/usage accounting, not context-size gauging — do not copy it here.)
// An in-progress assistant step carries a `tokens` object that is still
// all-zero, so skip zero sums and keep walking back to the last completed
// step. Undefined if none yet.
function latestContextTokens(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i]?.info?.tokens
    if (!t) continue
    const sum =
      (t.input ?? 0) +
      (t.output ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0)
    if (sum > 0) return sum
  }
  return undefined
}

// Best-effort TUI toast — a no-op when not running under the TUI (e.g. `serve`).
export async function showToast(client, { title, message, variant = "info" }) {
  try {
    await client.tui.showToast({ body: { title, message, variant } })
  } catch (err) {
    log("tui.showToast failed", errMsg(err))
  }
}

// Truncates to N visual characters (code points), so an emoji or surrogate
// pair at the boundary isn't sliced into a lone half. Cheap; we only hit this
// path for short activity strings.
function sliceChars(s, n) {
  const arr = [...s]
  if (arr.length <= n) return s
  return arr.slice(0, n).join("")
}

// Walks messages newest-first and returns the last meaningful part: text
// content (truncated) or a tool name.
function latestActivity(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (p?.type === "text" && p.text) return sliceChars(p.text, 280)
      if (p?.type === "tool" && p.tool) return `[tool: ${p.tool}]`
    }
  }
  return undefined
}
