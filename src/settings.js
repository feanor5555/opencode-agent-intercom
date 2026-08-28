// Runtime-tunable settings: the subagent concurrency cap and the subagent
// context budget. Resolved as file > env var > built-in default, so the
// companion TUI plugin can change them live by writing the shared JSON file —
// no opencode restart needed.
//
// The searxng base URL for `web_search` resolves the same way (file key
// `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL > unset). Unset means
// searxng is disabled and web_search stays Exa-only.
//
// The Exa API key resolves the same way (file key `exaApiKey` > env
// EXA_API_KEY > unset). Unset is not an error: web_search then uses Exa's
// anonymous tier. The value is a secret — it is never written to the debug log.
//
// The searxng engine bangs `forum_search` chains resolve from the file key
// `forumBangs` alone (no env var). It is the only array-valued key and it
// REPLACES the built-in set rather than extending it: the set describes one
// searxng instance's engines, so a user must be able to drop a bang their
// instance does not know. An empty, non-array or all-invalid value leaves
// DEFAULT_FORUM_BANGS in effect.
//
// Shared file path (the TUI plugin hardcodes the same path, it is a separate
// npm package and cannot import this module):
//   ~/.config/opencode/agent-intercom.json
//     { "maxSubagents": N, "maxContext": N, "maxPrimaryContext": N,
//       "maxSubagentAgeMs": N, "searxngUrl": "http://host:port",
//       "exaApiKey": "<key>", "forumBangs": ["!hn", "!lo"],
//       "postNoticeRetries": N, "postNoticeRetryBackoffMs": N }

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./log.js"

const DEFAULT_MAX_SUBAGENTS = 1
const DEFAULT_MAX_CONTEXT = 40000
// Threshold (in tokens) at which the orchestrator primary session triggers a
// context-refresh handoff. Independent of maxContext (which gates subagents).
// 0 disables auto-handoff entirely.
const DEFAULT_MAX_PRIMARY_CONTEXT = 80000
// Inactivity watchdog for subagents: if a tracked subagent produces no events
// for this many ms, the hooks sweep aborts it, frees its slot, and wakes the
// orchestrator with a timeout notice. 0 disables the watchdog entirely.
// 90 s is the default — long enough that a healthy long-running subagent
// (which keeps emitting events) is never tripped, short enough that a hung
// LLM call doesn't silently pin a slot for the life of the process.
const DEFAULT_MAX_SUBAGENT_AGE_MS = 90000
// Built-in searxng bang set for `forum_search`, each engine verified to answer
// on its bang: hackernews, lobste.rs, stackoverflow, askubuntu, superuser,
// github. Replaced (never extended) by the `forumBangs` file key.
export const DEFAULT_FORUM_BANGS = ["!hn", "!lo", "!st", "!ubuntu", "!su", "!gh"]
// Retry policy for the postNotice transport call (pushes a wake notice into
// the primary session on subagent completion/timeout/error). The opencode
// SDK can transiently fail to deliver a promptAsync; without retries a single
// network blip costs the primary its wake. Mirrors the maxContext pattern —
// file > env > default. 0 disables retries (single attempt). postNoticeRetries
// counts RE-tries only — the first attempt is always made.
const DEFAULT_POST_NOTICE_RETRIES = 3
const DEFAULT_POST_NOTICE_RETRY_BACKOFF_MS = 500
const TTL_MS = 2000

let settingsPath = join(homedir(), ".config", "opencode", "agent-intercom.json")
let cache = null
let cachedAt = 0

// Reads a non-negative integer env var, falling back to `def` when unset/invalid.
function envNum(name, def) {
  const env = process.env[name]
  if (env === undefined || env === "") return def
  const n = Number(env)
  return Number.isInteger(n) && n >= 0 ? n : def
}

// Reads a non-empty string env var, falling back to `def` when unset/blank.
function envStr(name, def) {
  const env = process.env[name]
  if (env === undefined || env.trim() === "") return def
  return env.trim()
}

// Current settings: { maxSubagents, maxContext, maxPrimaryContext,
// maxSubagentAgeMs, searxngUrl, exaApiKey, forumBangs, postNoticeRetries,
// postNoticeRetryBackoffMs }.
// Cached for TTL_MS so the hot paths (spawn, every subagent transform) don't
// stat the file constantly. searxngUrl is "" when unset (searxng disabled).
// exaApiKey is "" when unset (web_search falls back to Exa's anonymous tier).
// maxSubagentAgeMs is the inactivity watchdog window; 0 disables it.
// maxPrimaryContext is the orchestrator primary-session context-refresh
// threshold (tokens); 0 disables auto-handoff. forumBangs is the bang set in
// effect: DEFAULT_FORUM_BANGS unless the file replaces it. postNoticeRetries
// counts RE-tries (0 = single attempt, no retry). postNoticeRetryBackoffMs is
// the base delay between attempts (linear, with a small jitter).
export function getSettings() {
  const now = Date.now()
  if (cache && now - cachedAt < TTL_MS) return cache
  const resolved = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
    maxPrimaryContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT", DEFAULT_MAX_PRIMARY_CONTEXT),
    maxSubagentAgeMs: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS", DEFAULT_MAX_SUBAGENT_AGE_MS),
    searxngUrl: envStr("OPENCODE_AGENT_INTERCOM_SEARXNG_URL", ""),
    exaApiKey: envStr("EXA_API_KEY", ""),
    forumBangs: [...DEFAULT_FORUM_BANGS],
    postNoticeRetries: envNum("OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRIES", DEFAULT_POST_NOTICE_RETRIES),
    postNoticeRetryBackoffMs: envNum("OPENCODE_AGENT_INTERCOM_POST_NOTICE_RETRY_BACKOFF_MS", DEFAULT_POST_NOTICE_RETRY_BACKOFF_MS),
  }
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"))
    if (Number.isInteger(raw?.maxSubagents) && raw.maxSubagents >= 0) {
      resolved.maxSubagents = raw.maxSubagents
    }
    if (Number.isInteger(raw?.maxContext) && raw.maxContext >= 0) {
      resolved.maxContext = raw.maxContext
    }
    if (Number.isInteger(raw?.maxPrimaryContext) && raw.maxPrimaryContext >= 0) {
      resolved.maxPrimaryContext = raw.maxPrimaryContext
    }
    if (Number.isInteger(raw?.maxSubagentAgeMs) && raw.maxSubagentAgeMs >= 0) {
      resolved.maxSubagentAgeMs = raw.maxSubagentAgeMs
    }
    if (typeof raw?.searxngUrl === "string" && raw.searxngUrl.trim() !== "") {
      resolved.searxngUrl = raw.searxngUrl.trim()
    }
    if (typeof raw?.exaApiKey === "string" && raw.exaApiKey.trim() !== "") {
      resolved.exaApiKey = raw.exaApiKey.trim()
    }
    if (Array.isArray(raw?.forumBangs)) {
      // Keep the non-empty strings, trimmed; drop everything else silently —
      // a garbage entry must not cost the caller the whole configured set.
      // Nothing usable left means the built-in set stays in effect.
      const bangs = raw.forumBangs
        .filter((b) => typeof b === "string" && b.trim() !== "")
        .map((b) => b.trim())
      if (bangs.length > 0) resolved.forumBangs = bangs
    }
    if (Number.isInteger(raw?.postNoticeRetries) && raw.postNoticeRetries >= 0) {
      resolved.postNoticeRetries = raw.postNoticeRetries
    }
    if (Number.isInteger(raw?.postNoticeRetryBackoffMs) && raw.postNoticeRetryBackoffMs >= 0) {
      resolved.postNoticeRetryBackoffMs = raw.postNoticeRetryBackoffMs
    }
  } catch {
    // no file / unreadable -> env + defaults; not an error
  }
  cache = resolved
  cachedAt = now
  // exaApiKey is a secret: log only whether one is in effect, never its value.
  log("settings resolved", { ...resolved, exaApiKey: resolved.exaApiKey ? "<set>" : "" })
  return cache
}

// The resolved searxng base URL (file > env > ""), trailing slashes stripped.
// Empty string means searxng is disabled and web_search stays Exa-only.
export function getSearxngUrl() {
  const url = getSettings().searxngUrl
  return url ? url.replace(/\/+$/, "") : ""
}

// The resolved Exa API key (file > env > ""). Empty string means no key is
// configured — web_search then uses Exa's anonymous tier, which is not an error.
export function getExaApiKey() {
  return getSettings().exaApiKey
}

// The searxng bang set `forum_search` chains (file `forumBangs` > built-in).
// Replacement, not union — the set is a property of one searxng instance, and a
// user whose instance lacks an engine (or names its shortcut differently) has
// to be able to drop a bang, not only add one.
export function getForumBangs() {
  return getSettings().forumBangs
}

// Test-only: point at a different file and drop the cache.
export function setSettingsPath(p) {
  settingsPath = p
  resetSettings()
}

// Test-only: invalidate the cache so the next getSettings() re-reads the file.
export function resetSettings() {
  cache = null
  cachedAt = 0
}
