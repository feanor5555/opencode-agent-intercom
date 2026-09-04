// Runtime-tunable settings: the subagent concurrency cap and the subagent
// context budget. Resolved as file > env var > built-in default, so the
// companion TUI plugin can change them live by writing the shared JSON file —
// no opencode restart needed.
//
// The context budget is a value PER AGENT TYPE. The file key `agentContext`
// maps an agent name to its ceiling in whole tokens, and `contextBudgetFor`
// resolves the value in effect for one type. There is no single user-facing
// ceiling governing all subagents; a type nobody configured falls back to the
// built-in table DEFAULT_AGENT_CONTEXT, and a name that table does not know to
// DEFAULT_MAX_CONTEXT. `0` is a real value at every level and means the budget
// is disabled for that type.
//
// The flat key `maxContext` is legacy-only: it is no longer the ceiling, it is
// the value for every type without an own `agentContext` entry. A file holding
// it alone therefore keeps governing every subagent exactly as it did. The env
// var OPENCODE_AGENT_INTERCOM_MAX_CONTEXT means the same thing one level down
// — the value for every unconfigured type — and is the only lever a headless
// run has. `maxContextSource` records which of the three produced the resolved
// `maxContext`, because "the user set 100000" and "nobody set anything" pick
// different budgets for a type that has a built-in default.
//
// The searxng base URL for `web_search` resolves the same way (file key
// `searxngUrl` > env OPENCODE_AGENT_INTERCOM_SEARXNG_URL > unset). Unset means
// searxng is disabled and web_search stays Exa-only.
//
// The Exa API key resolves the same way (file key `exaApiKey` > env
// EXA_API_KEY > unset). Unset is not an error: web_search then uses Exa's
// anonymous tier. The value is a secret — it is never written to the debug log.
//
// Endless mode resolves the same way: `endlessMode`, `endlessContext`,
// `endlessQuiesceTimeoutMs` and `endlessMaxCycles`.
// While `endlessMode` is on and the mode has not paused itself for the session
// in hand, `endlessContext` is the primary threshold in effect instead of
// `maxPrimaryContext` — see `primaryContextThreshold`.
// `endlessMode` is the USER's switch and this module never writes it: when one
// of the mode's own bounds ends the loop, the plugin pauses the mode for that
// one primary session (pauseEndless, src/registry.js) and leaves the file
// alone. The mode is on by default, so a self-stop that persisted `false` here
// would disable that default for good. A paused session resolves its threshold
// as if the mode were off, so the plain handoff still relieves it of context.
//
// `showAgentcom` resolves the same way and is the second boolean key. While it
// is OFF, every message the plugin posts into a session carries `synthetic:
// true` on its text part: opencode's renderer skips such a part, the model
// still receives its text verbatim. Nothing is suppressed — see
// src/pluginmsg.js.
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
//     { "maxSubagents": N, "agentContext": { "<agent>": N },
//       "maxContext": N, "maxPrimaryContext": N,
//       "maxSubagentAgeMs": N, "searxngUrl": "http://host:port",
//       "exaApiKey": "<key>", "forumBangs": ["!hn", "!lo"],
//       "postNoticeRetries": N, "postNoticeRetryBackoffMs": N,
//       "endlessMode": true|false, "endlessContext": N,
//       "endlessQuiesceTimeoutMs": N, "endlessMaxCycles": N,
//       "maxNestedSpawns": N,
//       "maxRetainedSubagents": N, "retainedSubagentTtlMs": N,
//       "maxReuseContext": N, "reuseContext": { "<agent>": N },
//       "maxResultTokens": N, "resultTokens": { "<agent>": N },
//       "showAgentcom": true|false }

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log, errMsg } from "./log.js"

// The subagent cap and context budget in effect when neither the file nor the
// env var says otherwise. Exported because the TUI plugin hardcodes the same
// two numbers and cannot import this module at runtime (separate npm package):
// test/settings-defaults-parity.test.js imports both sides and fails on a
// divergence.
export const DEFAULT_MAX_SUBAGENTS = 1
// The context budget for an agent type the built-in table below does not name —
// a project's own agent, or a subagent whose type is still provisional. Also
// the value the legacy flat `maxContext` key falls back to.
export const DEFAULT_MAX_CONTEXT = 100000
// The built-in context budget per agent type, in whole tokens. One entry per
// role the plugin installs (src/agents.js) except `orchestrator`: the budget
// governs subagents only, the primary is governed by primaryContextThreshold.
// A type absent here resolves to DEFAULT_MAX_CONTEXT. Exported for the same
// reason as the scalars above — the TUI carries its own copy and
// test/settings-defaults-parity.test.js fails on a divergence.
export const DEFAULT_AGENT_CONTEXT = {
  planner: 100000,
  coder: 100000,
  debugger: 100000,
  reviewer: 100000,
  documenter: 100000,
  researcher: 100000,
  grounder: 100000,
  designer: 100000,
  gitter: 100000,
}
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
// One subagent is silent and healthy: one blocked on a live child of its own,
// whose events all belong to the child's session. The sweep treats waiting on
// a watchdogged child as activity (see isWaitingOnWatchdoggedChild), so this
// window measures the CHILD, and the parent outlives it by construction.
// It also sets the child-waiter's own rescue ceiling — see childwait.js.
const DEFAULT_MAX_SUBAGENT_AGE_MS = 90000
// How many finished subagents may be held as retained sessions in this
// process at once. A retained subagent has delivered its result and had its
// wake posted, but its opencode session was NOT deleted, so it stays
// re-promptable. 0 switches retention off entirely: every subagent's session
// is deleted the moment its result is delivered, which is the one-shot
// behaviour this plugin has always had, and is the default.
export const DEFAULT_MAX_RETAINED_SUBAGENTS = 0
// How long one retained subagent is held, in ms, measured from the moment it
// was retained (`entry.retainedAt`). The watchdog sweep reaps a retained entry
// once this window is past. Clamped to a minimum of 1 ms: "hold forever" is
// deliberately not offered, because nothing outside this plugin ever deletes a
// subagent session — opencode has neither a session TTL nor a garbage
// collector, so an unbounded window would be an unbounded leak.
export const DEFAULT_RETAINED_SUBAGENT_TTL_MS = 3600000
// The context, in whole tokens, above which a finished subagent is never
// reused: the ceiling for every agent type the `reuseContext` map does not
// name. A session over it is not held at idle and is not re-promptable — see
// reuseCeilingFor for the resolution order and for what `0` means.
//
// It is not derived from a context budget and does not move when one moves: a
// run that ended at 85 000 under a 100 000 budget was never over its budget,
// was never STOP-injected and returned a good result, and is still not
// reusable. Exported for the parity the two retention scalars above are
// exported for (tui/src/settings-file.ts,
// test/settings-defaults-parity.test.js).
export const DEFAULT_MAX_REUSE_CONTEXT = 70000
// The ceiling, in estimated tokens, on the part of a subagent's FINAL REPLY
// that reaches the orchestrator's context: the value for every agent type the
// `resultTokens` map does not name. Everything past it is cut out of the wake
// notice and kept in an overflow file whose path the notice carries — see
// resultCeilingFor for the resolution order and for what `0` means.
//
// Measured with estimateReplyTokens (src/format.js), which runs deliberately
// high, so the figure is a ceiling on what the orchestrator can be charged and
// not a promise about a particular tokenizer. 2000 tokens is roughly 7000
// characters of English prose: a findings-and-paths reply fits whole, a pasted
// file does not.
//
// Exported for the parity the retention scalars above are exported for
// (tui/src/settings-file.ts, test/settings-defaults-parity.test.js).
export const DEFAULT_MAX_RESULT_TOKENS = 2000
// How many subagents ONE subagent run may start (a nested spawn). Delegation
// exists for preparatory work whose answer the caller then uses — summarising a
// long document, a broad lookup — not as a working mode, so the ceiling is
// deliberately small. It is a per-RUN ceiling counted on the caller's registry
// entry, which lives exactly as long as its one-shot run, so it resets with
// every fresh subagent and never has to be cleared.
//
// It counts ADMITTED spawns, not successful ones: the failure mode this bounds
// is a small model looping, and a loop that fails every time would be unbounded
// under a success-only count.
//
// 0 disables nesting entirely and is the escape hatch for a user who does not
// want it — with it set, a nested spawn is refused before any session is
// created, and a role that may delegate is told it does not (hooks.js).
//
// Exported because the TUI carries its own copy of this default
// (tui/src/settings-file.ts) and test/settings-defaults-parity.test.js pins the
// two against each other.
export const DEFAULT_MAX_NESTED_SPAWNS = 2
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
// On by default — the mode's own bounds PAUSE it for the primary in hand when
// there is no work left, no progress is made, or the cycle ceiling is reached;
// they never write this key, which stays the user's own switch.
// Exported for the same reason as the two limits above: the TUI plugin carries
// its own copy of both and test/settings-defaults-parity.test.js pins them.
export const DEFAULT_ENDLESS_MODE = true
export const DEFAULT_ENDLESS_CONTEXT = 250000
// How long a cycle waits for the last subagent to finish before it abandons.
// The inactivity watchdog (maxSubagentAgeMs) already resolves a HUNG subagent
// in ~90 s, so this bound is for one that is genuinely working.
const DEFAULT_ENDLESS_QUIESCE_TIMEOUT_MS = 600000
// How many cycles one opencode process runs before endless mode pauses itself
// for that primary. Counted over the handoff-redirect chain
// (handoffGeneration).
const DEFAULT_ENDLESS_MAX_CYCLES = 10
// Whether the plugin's own postings appear in the transcript. While it is off,
// the text part every posting carries is stamped `synthetic: true` —
// opencode's renderer skips it, the model still gets the text. On by
// default: with it off, a finished subagent's result is nowhere on screen and
// its session is already deleted, a loss the user chooses rather than
// inherits. Exported for the same reason as the limits above — the TUI plugin
// carries its own copy and test/settings-defaults-parity.test.js pins them.
export const DEFAULT_SHOW_AGENTCOM = true
const TTL_MS = 2000

let settingsPath = join(homedir(), ".config", "opencode", "agent-intercom.json")
let cache = null
let cachedAt = 0
// The masked resolved object as it was last written to the debug log, so a
// resolve that produces the same values again writes nothing. It deliberately
// survives every cache drop, including the test-only ones: what is worth a line
// is a CHANGE in the settings in effect, and dropping the cache changes
// nothing by itself.
let loggedSettings = null

// Reads a non-negative integer env var, falling back to `def` when unset/invalid.
function envNum(name, def) {
  const env = process.env[name]
  if (env === undefined || env === "") return def
  const n = Number(env)
  return Number.isInteger(n) && n >= 0 ? n : def
}

// Whether a numeric env var is set to a value envNum would actually use. Only
// needed where "the user set this number" has to be told apart from "the
// built-in default happens to be this number" — see maxContextSource.
function envNumSet(name) {
  const env = process.env[name]
  if (env === undefined || env === "") return false
  const n = Number(env)
  return Number.isInteger(n) && n >= 0
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

// Current settings: { maxSubagents, maxContext, maxContextSource, agentContext,
// maxPrimaryContext,
// maxSubagentAgeMs, searxngUrl, exaApiKey, forumBangs, postNoticeRetries,
// postNoticeRetryBackoffMs, endlessMode, endlessContext,
// endlessQuiesceTimeoutMs, endlessMaxCycles, maxNestedSpawns, showAgentcom }.
// Cached for TTL_MS so the hot paths (spawn, every subagent transform) don't
// stat the file constantly. searxngUrl is "" when unset (searxng disabled).
// exaApiKey is "" when unset (web_search falls back to Exa's anonymous tier).
// maxSubagentAgeMs is the inactivity watchdog window; 0 disables it.
// maxPrimaryContext is the orchestrator primary-session context-refresh
// threshold (tokens); 0 disables auto-handoff. agentContext is the per-agent
// context budget map exactly as the file holds it (empty when the file names
// none) and maxContext is the flat legacy value for every type it does not
// name — read both through contextBudgetFor rather than directly.
// maxContextSource is "file", "env" or "default", naming where maxContext came
// from. forumBangs is the bang set in effect: DEFAULT_FORUM_BANGS unless the
// file replaces it. postNoticeRetries
// counts RE-tries (0 = single attempt, no retry). postNoticeRetryBackoffMs is
// the base delay between attempts (linear, with a small jitter). endlessMode
// arms the self-restarting orchestrator loop and, while on, makes
// endlessContext the primary threshold in effect; endlessQuiesceTimeoutMs
// bounds a cycle's wait for the last subagent and endlessMaxCycles the maximum
// number of cycles one process runs; 0 disables the cycle ceiling.
// maxNestedSpawns is how many subagents one subagent run may start; 0 disables
// nesting.
// maxRetainedSubagents is how many finished subagents may be held alive as
// retained sessions at once; 0 (the default) switches retention off and every
// subagent's session is deleted as soon as its result is delivered.
// retainedSubagentTtlMs is how long one retained subagent is held before the
// watchdog reaps it, floored at 1 ms — the window is never "forever".
// reuseContext is the per-agent reuse ceiling exactly as the file holds it
// (empty when the file names none) and maxReuseContext the flat value for
// every type it does not name — read both through reuseCeilingFor rather than
// directly.
// showAgentcom shows the plugin's own postings in the transcript; while it is
// off they are hidden from it and still left in the model's payload.
export function getSettings() {
  const now = Date.now()
  if (cache && now - cachedAt < TTL_MS) return cache
  const resolved = {
    maxSubagents: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS", DEFAULT_MAX_SUBAGENTS),
    maxContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT", DEFAULT_MAX_CONTEXT),
    maxContextSource: envNumSet("OPENCODE_AGENT_INTERCOM_MAX_CONTEXT") ? "env" : "default",
    agentContext: {},
    maxPrimaryContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT", DEFAULT_MAX_PRIMARY_CONTEXT),
    maxSubagentAgeMs: envNum("OPENCODE_AGENT_INTERCOM_MAX_SUBAGENT_AGE_MS", DEFAULT_MAX_SUBAGENT_AGE_MS),
    maxRetainedSubagents: envNum(
      "OPENCODE_AGENT_INTERCOM_MAX_RETAINED_SUBAGENTS",
      DEFAULT_MAX_RETAINED_SUBAGENTS,
    ),
    retainedSubagentTtlMs: envNum(
      "OPENCODE_AGENT_INTERCOM_RETAINED_SUBAGENT_TTL_MS",
      DEFAULT_RETAINED_SUBAGENT_TTL_MS,
    ),
    maxReuseContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT", DEFAULT_MAX_REUSE_CONTEXT),
    reuseContext: {},
    maxResultTokens: envNum("OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS", DEFAULT_MAX_RESULT_TOKENS),
    resultTokens: {},
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
    maxNestedSpawns: envNum("OPENCODE_AGENT_INTERCOM_MAX_NESTED_SPAWNS", DEFAULT_MAX_NESTED_SPAWNS),
    showAgentcom: envBool("OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM", DEFAULT_SHOW_AGENTCOM),
  }
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"))
    if (Number.isInteger(raw?.maxSubagents) && raw.maxSubagents >= 0) {
      resolved.maxSubagents = raw.maxSubagents
    }
    if (Number.isInteger(raw?.maxContext) && raw.maxContext >= 0) {
      resolved.maxContext = raw.maxContext
      resolved.maxContextSource = "file"
    }
    // Per-agent context ceilings. A key survives only as a whole non-negative
    // integer; anything else is dropped silently, the discipline forumBangs
    // already uses — one garbage entry must not cost the user the rest of the
    // map. A value that is not a plain object (array, string, null) leaves the
    // map empty, so every type falls through to the seed or its default.
    // Nothing is materialised here: a type absent from the file stays absent.
    if (raw?.agentContext && typeof raw.agentContext === "object" && !Array.isArray(raw.agentContext)) {
      const perAgent = {}
      for (const [name, value] of Object.entries(raw.agentContext)) {
        if (name !== "" && Number.isInteger(value) && value >= 0) perAgent[name] = value
      }
      resolved.agentContext = perAgent
    }
    if (Number.isInteger(raw?.maxPrimaryContext) && raw.maxPrimaryContext >= 0) {
      resolved.maxPrimaryContext = raw.maxPrimaryContext
    }
    if (Number.isInteger(raw?.maxSubagentAgeMs) && raw.maxSubagentAgeMs >= 0) {
      resolved.maxSubagentAgeMs = raw.maxSubagentAgeMs
    }
    if (Number.isInteger(raw?.maxRetainedSubagents) && raw.maxRetainedSubagents >= 0) {
      resolved.maxRetainedSubagents = raw.maxRetainedSubagents
    }
    if (Number.isInteger(raw?.retainedSubagentTtlMs) && raw.retainedSubagentTtlMs >= 0) {
      resolved.retainedSubagentTtlMs = raw.retainedSubagentTtlMs
    }
    if (Number.isInteger(raw?.maxReuseContext) && raw.maxReuseContext >= 0) {
      resolved.maxReuseContext = raw.maxReuseContext
    }
    // Per-agent reuse ceilings, read with exactly the discipline agentContext
    // is read with above: a key survives only as a whole non-negative integer,
    // one garbage entry costs the user that entry and not the map, and a value
    // that is not a plain object leaves the map empty so every type falls
    // through to the flat value. Nothing is materialised.
    if (raw?.reuseContext && typeof raw.reuseContext === "object" && !Array.isArray(raw.reuseContext)) {
      const perAgent = {}
      for (const [name, value] of Object.entries(raw.reuseContext)) {
        if (name !== "" && Number.isInteger(value) && value >= 0) perAgent[name] = value
      }
      resolved.reuseContext = perAgent
    }
    if (Number.isInteger(raw?.maxResultTokens) && raw.maxResultTokens >= 0) {
      resolved.maxResultTokens = raw.maxResultTokens
    }
    // Per-agent reply ceilings, read with exactly the discipline reuseContext
    // is read with above: a key survives only as a whole non-negative integer,
    // one garbage entry costs the user that entry and not the map, and a value
    // that is not a plain object leaves the map empty so every type falls
    // through to the flat value. Nothing is materialised.
    if (raw?.resultTokens && typeof raw.resultTokens === "object" && !Array.isArray(raw.resultTokens)) {
      const perAgent = {}
      for (const [name, value] of Object.entries(raw.resultTokens)) {
        if (name !== "" && Number.isInteger(value) && value >= 0) perAgent[name] = value
      }
      resolved.resultTokens = perAgent
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
    // A boolean key. Anything but a real boolean ("true", 1, null) leaves the
    // env-or-default resolution standing, exactly as a bad numeric value does
    // above. `showAgentcom` below reads the same way.
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
    if (Number.isInteger(raw?.maxNestedSpawns) && raw.maxNestedSpawns >= 0) {
      resolved.maxNestedSpawns = raw.maxNestedSpawns
    }
    if (typeof raw?.showAgentcom === "boolean") {
      resolved.showAgentcom = raw.showAgentcom
    }
  } catch {
    // no file / unreadable -> env + defaults; not an error
  }
  // The retention window has a floor of 1 ms, wherever its value came from:
  // a 0 here would mean a retained session nothing ever reaps, and this plugin
  // is the only thing that deletes a subagent session. 0 switches retention
  // off through `maxRetainedSubagents`, not through the window.
  resolved.retainedSubagentTtlMs = Math.max(1, resolved.retainedSubagentTtlMs)
  cache = resolved
  cachedAt = now
  // exaApiKey is a secret: log only whether one is in effect, never its value.
  const masked = { ...resolved, exaApiKey: resolved.exaApiKey ? "<set>" : "" }
  // The resolved object is rebuilt key by key in a fixed order on every call,
  // so its JSON text is a sound identity for "the same settings again".
  const signature = JSON.stringify(masked)
  // One line per change of the settings in effect, never one per resolve. The
  // cache lives TTL_MS only, so every hot path past that window resolves again,
  // and each resolve is a line nobody can read anything out of: a heartbeat
  // that grows debug.log without bound. The first resolve of a process still
  // logs, so the log always opens with the settings that were in effect.
  if (signature !== loggedSettings) {
    loggedSettings = signature
    log("settings resolved", masked)
  }
  return cache
}

// The size a spawn's work package may take of the spawned type's context
// budget, as a share of `contextBudgetFor(agent)`. A package over the warn
// share still spawns but carries the figure back to the orchestrator; one over
// the refuse share is rejected before any session is created. The same two
// shares are what ORCHESTRATION_GUIDE tells the orchestrator, so the rule it
// is given and the gate it meets are one number each.
export const PACKAGE_WARN_SHARE = 0.2
export const PACKAGE_REFUSE_SHARE = 0.4

// The context budget in effect for one agent type, in whole tokens; 0 means
// the budget is disabled for that type. Order:
//   1. the type's own `agentContext` entry,
//   2. the flat legacy `maxContext` from the file,
//   3. the env var OPENCODE_AGENT_INTERCOM_MAX_CONTEXT,
//   4. DEFAULT_AGENT_CONTEXT[agent],
//   5. DEFAULT_MAX_CONTEXT for a name the table does not know.
// `0` is a real value at every level, never "unset": a 0 at level 1 beats a
// non-zero default, a 0 at level 2 or 3 disables every unconfigured type.
// Levels 2 and 3 are the migration path — a file carrying only `maxContext`
// keeps governing every subagent with the user's number, with no write.
//
// Resolved per call, never cached on a registry entry: a freshly spawned
// subagent is tracked as "subagent" until the spawn tool upgrades it to its
// real type, and a budget frozen in that window would be the wrong one. The
// provisional name is simply a name the table does not know (level 5) unless
// the user gave "subagent" an explicit entry, which is then honoured.
export function contextBudgetFor(agent) {
  const s = getSettings()
  if (Object.hasOwn(s.agentContext, agent)) return s.agentContext[agent]
  if (s.maxContextSource !== "default") return s.maxContext
  if (Object.hasOwn(DEFAULT_AGENT_CONTEXT, agent)) return DEFAULT_AGENT_CONTEXT[agent]
  return DEFAULT_MAX_CONTEXT
}

// The reuse ceiling in effect for one agent type, in whole tokens: the context
// above which a finished subagent of that type is never held and never
// re-prompted. Order:
//   1. the type's own `reuseContext` entry from the file,
//   2. the flat `maxReuseContext` — file, else the env var
//      OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT,
//   3. DEFAULT_MAX_REUSE_CONTEXT, which is what the flat value already
//      resolves to when neither file nor env names one.
//
// `0` means this agent type is never reused. Not "no limit": the ceiling is an
// admission threshold, and "admit sessions up to 0 tokens" is "admit none". It
// needs no branch anywhere — a real session's context is above 0, so `ctx <=
// 0` is false for every one of them. "No limit for this type" stays
// expressible as a large number.
//
// One level shorter than contextBudgetFor, deliberately. That resolver needs
// five levels and its `maxContextSource` flag because it has a built-in
// per-type table (DEFAULT_AGENT_CONTEXT) as well as a flat key, so it must
// tell "the user set the flat value" from "the built-in table happens to
// apply". This one has neither: one number for every type, and no legacy key
// to migrate, so there is nothing for a source flag to disambiguate.
//
// A ceiling above the type's context budget is neither rejected nor clamped.
// It is inert rather than unsafe — the reuse gate's budget term refuses what
// this one lets through — except where that type's budget is disabled with 0,
// which is the configuration in which a user who set a high ceiling meant it.
//
// Resolved per call, never cached on a registry entry, for the reason
// contextBudgetFor states: a freshly spawned subagent is tracked under a
// provisional type name until the spawn tool upgrades it.
export function reuseCeilingFor(agent) {
  const s = getSettings()
  if (Object.hasOwn(s.reuseContext, agent)) return s.reuseContext[agent]
  return s.maxReuseContext
}

// The reply ceiling in effect for one agent type, in estimated tokens: how much
// of that type's final reply reaches the orchestrator's context before the rest
// is cut out and filed. Order, the three levels reuseCeilingFor has:
//   1. the type's own `resultTokens` entry from the file,
//   2. the flat `maxResultTokens` — file, else the env var
//      OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS,
//   3. DEFAULT_MAX_RESULT_TOKENS, which is what the flat value already
//      resolves to when neither file nor env names one.
//
// `0` means NO ceiling for this type: the whole reply is forwarded, no overflow
// file is written, no cut marker is appended, and the reply-cap prompt block is
// omitted from that type's system prompt. This is the `0` of a cap that is
// switched off, not reuseCeilingFor's `0` (an admission threshold nothing
// clears) — a type that must hand its whole output up carries either a large
// entry or this one.
//
// Resolved per call, never cached on a registry entry, for the reason
// contextBudgetFor states: a freshly spawned subagent is tracked under a
// provisional type name until the spawn tool upgrades it.
export function resultCeilingFor(agent) {
  const s = getSettings()
  if (Object.hasOwn(s.resultTokens, agent)) return s.resultTokens[agent]
  return s.maxResultTokens
}

// Whether this process offers retention at all, decided at the first read and
// never again.
//
// opencode resolves the plugin's tool map at instance bootstrap and keeps it
// for the life of the instance, so whether the `reuse` tool exists is settled
// there, by `createTools`. Every text that NAMES that tool — the orchestrator
// guide, the `list` description — is decided on this same latched answer, so a
// settings edit mid-process can never leave the orchestrator told about a tool
// its map does not carry.
//
// What the setting still governs live is behaviour on entries, not the tool
// surface: whether a finished subagent is retained, whether `list` renders its
// retained section, whether `reuse` admits the call it was handed.
let retentionLatch = null
export function retentionOffered() {
  if (retentionLatch === null) retentionLatch = getSettings().maxRetainedSubagents > 0
  return retentionLatch
}

// How many finished subagents this process may hold RIGHT NOW: the live
// setting where retention was offered at load, and 0 where it was not.
//
// The conjunction is what keeps the two halves of the feature from drifting
// apart. The tool surface is settled at load and cannot move (retentionOffered);
// everything else — whether an entry is retained, whether `list` renders a
// retained section, whether `reuse` admits a call — reads the live file. Read
// live alone, a user who switches retention ON mid-process gets retained
// sessions and a `list` that points at a `reuse` tool the orchestrator's map
// does not carry. So: enabling retention needs an opencode restart, disabling
// it takes effect at the next settings read, and no state exists that only one
// of the two halves believes in.
export function retentionCapacity() {
  return retentionOffered() ? getSettings().maxRetainedSubagents : 0
}

// Whether retention is in effect right now — offered at load AND switched on.
export function retentionActive() {
  return retentionCapacity() > 0
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

// Whether endless mode is the mode actually in effect for ONE primary session:
// the user's switch is on AND the mode has not stopped itself for that session.
// `endlessPaused` is the caller's read of registry.isEndlessPaused — passed in
// rather than imported, because this module resolves settings and holds no
// per-session state.
//
// A self-stop pauses the mode for that one session (pauseEndless,
// src/registry.js) and writes nothing. For everything downstream of this
// predicate a paused primary is a primary with endless mode off: it starts no
// further cycle, and the plain handoff owns its threshold again. What stays
// different is that nothing was persisted — the pause dies with the session and
// the next orchestrator has the mode available.
export function endlessModeInEffect({ endlessPaused = false } = {}) {
  return getSettings().endlessMode && !endlessPaused
}

// The context threshold in effect for the primary session right now. One
// resolution point for the whole plugin: while endless mode is in effect,
// `endlessContext` DISPLACES `maxPrimaryContext` — arming both would mean the
// lower one always fires first and the endless threshold is never reached.
// `endlessContext: 0` arms nothing, the way `maxPrimaryContext: 0` disables
// the plain handoff; "endless mode on, threshold 0" is a legal state.
//
// A paused primary resolves to `maxPrimaryContext`: it starts no cycle, so
// leaving the endless threshold armed on it would arm nothing at all and the
// session would grow until the provider's own context limit ended it. Relief
// from context is not what a self-stop stops — only the loop is.
export function primaryContextThreshold({ endlessPaused = false } = {}) {
  const s = getSettings()
  return endlessModeInEffect({ endlessPaused }) ? s.endlessContext : s.maxPrimaryContext
}

// The shared settings file this process resolves from. The agentcom watch
// (src/agentcomsync.js) needs it to watch the directory it sits in, and a test
// that moved the path with setSettingsPath has to get the moved one.
export function settingsFilePath() {
  return settingsPath
}

// Drop the resolved cache so the next getSettings() reads the file again. The
// retention latch is untouched — it is taken once at plugin load and is not a
// resolved value. The agentcom watch (src/agentcomsync.js) calls this the
// moment fs.watch reports the settings file changed: that change is younger
// than the TTL, and a cached answer would still be the value before the write.
export function invalidateSettingsCache() {
  cache = null
  cachedAt = 0
}

// Test-only: point at a different file and drop the cache.
export function setSettingsPath(p) {
  settingsPath = p
  resetSettings()
}

// Test-only: invalidate the cache so the next getSettings() re-reads the file.
// The retention latch goes with it: it is taken at plugin load, and a test that
// swaps the settings under a fresh plugin has to get a fresh answer.
export function resetSettings() {
  invalidateSettingsCache()
  retentionLatch = null
}

// Test-only name for invalidateSettingsCache, kept because what it records is
// the intent at the call site: invalidate the cache and LEAVE the retention
// latch standing, so a test can move `maxRetainedSubagents` under a process
// that has already decided at load whether it offers the `reuse` tool at all.
// That combination — offered at load, switched off now, and its mirror image —
// is the whole point of retentionCapacity, and resetSettings cannot express it.
export function dropSettingsCacheKeepingLatch() {
  invalidateSettingsCache()
}
