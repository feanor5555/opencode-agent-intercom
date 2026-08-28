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
// Endless mode resolves the same way: `endlessMode` (the only boolean key in
// the file), `endlessContext`, `endlessQuiesceTimeoutMs` and `endlessMaxCycles`.
// While `endlessMode` is on, `endlessContext` is the primary threshold in
// effect instead of `maxPrimaryContext` — see `primaryContextThreshold`. The
// plugin writes `endlessMode: false` back itself when one of the mode's own
// bounds ends the loop (`writeEndlessMode`).
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
//       "postNoticeRetries": N, "postNoticeRetryBackoffMs": N,
//       "endlessMode": true|false, "endlessContext": N,
//       "endlessQuiesceTimeoutMs": N, "endlessMaxCycles": N }

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { log, errMsg } from "./log.js"

// The subagent cap and context budget in effect when neither the file nor the
// env var says otherwise. Exported because the TUI plugin hardcodes the same
// two numbers and cannot import this module at runtime (separate npm package):
// test/settings-defaults-parity.test.js imports both sides and fails on a
// divergence.
export const DEFAULT_MAX_SUBAGENTS = 1
export const DEFAULT_MAX_CONTEXT = 40000
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
// on its bang. Four of the five return thread URLs on their own site —
// stackoverflow, askubuntu, superuser, hackernews; lobste.rs is carried as a
// discovery engine whose rows are the SUBMITTED page rather than the
// discussion, so they sink under the route's own order and quota. No github: it
// returns repository roots, and a repository is not what this route offers.
// Replaced (never extended) by the `forumBangs` file key.
export const DEFAULT_FORUM_BANGS = ["!st", "!ubuntu", "!su", "!hn", "!lo"]
// Retry policy for the postNotice transport call (pushes a wake notice into
// the primary session on subagent completion/timeout/error). The opencode
// SDK can transiently fail to deliver a promptAsync; without retries a single
// network blip costs the primary its wake. Mirrors the maxContext pattern —
// file > env > default. 0 disables retries (single attempt). postNoticeRetries
// counts RE-tries only — the first attempt is always made.
const DEFAULT_POST_NOTICE_RETRIES = 3
const DEFAULT_POST_NOTICE_RETRY_BACKOFF_MS = 500
// Endless mode: the orchestrator is replaced by a fresh session whenever its
// context reaches `endlessContext`, after its open points have been written to
// the project's todo file, and the new session is told to work that file off.
// Off by default — the mode is a loop and is only ever armed deliberately.
// Exported for the same reason as the two limits above: the TUI plugin carries
// its own copy of both and test/settings-defaults-parity.test.js pins them.
export const DEFAULT_ENDLESS_MODE = false
export const DEFAULT_ENDLESS_CONTEXT = 250000
// How long a cycle waits for the last subagent to finish before it abandons.
// The inactivity watchdog (maxSubagentAgeMs) already resolves a HUNG subagent
// in ~90 s, so this bound is for one that is genuinely working.
const DEFAULT_ENDLESS_QUIESCE_TIMEOUT_MS = 600000
// How many cycles one opencode process runs before endless mode switches
// itself off. Counted over the handoff-redirect chain (handoffGeneration).
const DEFAULT_ENDLESS_MAX_CYCLES = 10
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

// Reads a "1"/"0" env var as a boolean, falling back to `def` for anything
// else — the same discipline the numeric readers use for a bad value.
function envBool(name, def) {
  const env = process.env[name]?.trim()
  if (env === "1") return true
  if (env === "0") return false
  return def
}

// Reads a non-empty string env var, falling back to `def` when unset/blank.
function envStr(name, def) {
  const env = process.env[name]
  if (env === undefined || env.trim() === "") return def
  return env.trim()
}

// Current settings: { maxSubagents, maxContext, maxPrimaryContext,
// maxSubagentAgeMs, searxngUrl, exaApiKey, forumBangs, postNoticeRetries,
// postNoticeRetryBackoffMs, endlessMode, endlessContext,
// endlessQuiesceTimeoutMs, endlessMaxCycles }.
// Cached for TTL_MS so the hot paths (spawn, every subagent transform) don't
// stat the file constantly. searxngUrl is "" when unset (searxng disabled).
// exaApiKey is "" when unset (web_search falls back to Exa's anonymous tier).
// maxSubagentAgeMs is the inactivity watchdog window; 0 disables it.
// maxPrimaryContext is the orchestrator primary-session context-refresh
// threshold (tokens); 0 disables auto-handoff. forumBangs is the bang set in
// effect: DEFAULT_FORUM_BANGS unless the file replaces it. postNoticeRetries
// counts RE-tries (0 = single attempt, no retry). postNoticeRetryBackoffMs is
// the base delay between attempts (linear, with a small jitter). endlessMode
// arms the self-restarting orchestrator loop and, while on, makes
// endlessContext the primary threshold in effect; endlessQuiesceTimeoutMs
// bounds a cycle's wait for the last subagent and endlessMaxCycles the maximum
// number of cycles one process runs; 0 disables the cycle ceiling.
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
    endlessMode: envBool("OPENCODE_AGENT_INTERCOM_ENDLESS_MODE", DEFAULT_ENDLESS_MODE),
    endlessContext: envNum("OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT", DEFAULT_ENDLESS_CONTEXT),
    endlessQuiesceTimeoutMs: envNum(
      "OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS",
      DEFAULT_ENDLESS_QUIESCE_TIMEOUT_MS,
    ),
    endlessMaxCycles: envNum("OPENCODE_AGENT_INTERCOM_ENDLESS_MAX_CYCLES", DEFAULT_ENDLESS_MAX_CYCLES),
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
    // The only boolean key in the file. Anything but a real boolean ("true",
    // 1, null) leaves the env-or-default resolution standing, exactly as a bad
    // numeric value does above.
    if (typeof raw?.endlessMode === "boolean") {
      resolved.endlessMode = raw.endlessMode
    }
    if (Number.isInteger(raw?.endlessContext) && raw.endlessContext >= 0) {
      resolved.endlessContext = raw.endlessContext
    }
    if (Number.isInteger(raw?.endlessQuiesceTimeoutMs) && raw.endlessQuiesceTimeoutMs >= 0) {
      resolved.endlessQuiesceTimeoutMs = raw.endlessQuiesceTimeoutMs
    }
    if (Number.isInteger(raw?.endlessMaxCycles) && raw.endlessMaxCycles >= 0) {
      resolved.endlessMaxCycles = raw.endlessMaxCycles
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

// The context threshold in effect for the primary session right now. One
// resolution point for the whole plugin: while endless mode is on,
// `endlessContext` DISPLACES `maxPrimaryContext` — arming both would mean the
// lower one always fires first and the endless threshold is never reached.
// `endlessContext: 0` arms nothing, the way `maxPrimaryContext: 0` disables
// the plain handoff; "endless mode on, threshold 0" is a legal state.
export function primaryContextThreshold() {
  const s = getSettings()
  return s.endlessMode ? s.endlessContext : s.maxPrimaryContext
}

// Writes `endlessMode` into the settings file — the plugin's own half of the
// switch, used by the bounds that end the loop (nothing left to do, no
// progress, cycle ceiling). Read-modify-write over what is on disk right now,
// mirroring the sidebar's writer: every other key, known or not, is carried
// over untouched. A file that is present but unreadable or unparsable is NOT
// written over — one stray character from a hand edit must not cost the user
// the rest of the file. Returns whether the value reached the disk.
export function writeEndlessMode(enabled) {
  let raw
  try {
    raw = JSON.parse(readFileSync(settingsPath, "utf8"))
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log("settings: endlessMode write skipped, file unreadable", errMsg(err))
      return false
    }
    // Absent file: the write creates it.
    raw = {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
  try {
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ ...raw, endlessMode: enabled }, null, 2) + "\n")
  } catch (err) {
    log("settings: endlessMode write failed", errMsg(err))
    return false
  }
  // Drop the cache so the next getSettings() sees the value we just wrote
  // instead of serving the old one for the rest of the TTL.
  resetSettings()
  return true
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
