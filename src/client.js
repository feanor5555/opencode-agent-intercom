// Thin wrappers over the opencode SDK client.
//
// Every wrapper runs its SDK call through `attempt` (or `withRetry`, which is
// built on it), because this client reports a failed request by RESOLVING with
// an error envelope rather than rejecting — see requestFailure below. Three
// contracts, and no fourth:
//
//   Required write — postNotice, promptSession: throws once its retry policy
//     is spent. The caller has a failure path and must reach it.
//   Reported write — deleteSession, archiveSession, updateSessionTitle,
//     abortSession: returns false, logs once, never retries. The caller reads
//     a truthful boolean and proceeds either way.
//   Best-effort read — getSessionDirectory, listSessions, fetchMessages,
//     fetchSnapshot: returns the empty value (undefined / [] / [] / {}), logs
//     once. Each reader has a degraded answer designed for it.
//
// createChildSession stands beside them as a creator: it answers undefined for
// a session that was not created, and logs why.

import { log, errMsg } from "./log.js"
import { getSettings } from "./settings.js"
import { INTERCOM_MESSAGE_METADATA_KEY, intercomTextPart } from "./pluginmsg.js"

// Sleeps `ms` milliseconds. Resolved via setTimeout so a value of 0 returns
// immediately without going through the timer queue.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The SDK client opencode hands a plugin is built WITHOUT `throwOnError`, so a
// failed request does not reject: the call RESOLVES with an envelope
// `{ error, request, response }` carrying the HTTP status, e.g.
// `response.status: 404` with `error.name: "NotFoundError"` for a session that
// is gone. A caller that only awaits the promise therefore cannot tell a
// delivered post from a refused one.
//
// This turns such an envelope into the Error it is, and returns undefined for a
// delivered post. Success takes every other shape the client has used:
// `undefined`, a bare payload, `{ data }`, and `{ data, request, response }`
// with a 2xx/3xx status — a present `response` alone is not a failure, since a
// successful promptAsync answers 204 with one.
//
// The same reading the TUI's readSessionChildren does (tui/src/subagent-store.ts):
// an `error` that is neither undefined nor null is the failure, and a status
// >= 400 is one too, even where no `error` body was parsed.
//
// `op` labels the operation for the message and the log. It names both the
// wrapper the caller called and the SDK route that refused, e.g.
// "deleteSession (session.delete)", so a log line says at once which contract
// was in force and which request carried it.
//
// The Error carries three fields:
//
//   status    — the HTTP status, or undefined where the envelope has none.
//   errorName — `error.name`, e.g. "NotFoundError".
//   terminal  — a failure retrying cannot repair: ANY 4xx (the server refused
//               the request on its content, and the same content will be
//               refused again) and every NotFoundError. Spending a retry
//               budget on one only delays the caller's cleanup path.
//   kind      — the axis the retry policy turns on:
//               "refused"       — the server answered with a status. The write
//                                 did NOT take effect, so a retry cannot
//                                 duplicate it.
//               "indeterminate" — no response was seen (a thrown transport
//                                 error, or an envelope carrying no status at
//                                 all). The write may or may not have taken
//                                 effect, so a retry may duplicate it.
export function requestFailure(result, op = "request") {
  if (!result || typeof result !== "object") return undefined
  const status = typeof result.response?.status === "number" ? result.response.status : undefined
  const failed = (result.error !== undefined && result.error !== null) || (status !== undefined && status >= 400)
  if (!failed) return undefined
  const name = typeof result.error?.name === "string" ? result.error.name : undefined
  const detail =
    result.error?.data?.message ??
    result.error?.message ??
    (typeof result.error === "string" ? result.error : undefined) ??
    name
  const err = new Error(
    `${op} failed${status === undefined ? "" : ` (HTTP ${status})`}` +
      `${detail ? `: ${detail}` : ""}`,
  )
  err.status = status
  err.errorName = name
  err.terminal = (status !== undefined && status >= 400 && status < 500) || name === "NotFoundError"
  err.kind = status === undefined ? "indeterminate" : "refused"
  err.op = op
  return err
}

// Runs one SDK call and folds BOTH failure routes into one value:
// `{ ok: true, data }` or `{ ok: false, error }`. Never throws.
//
// The two routes are the thrown exception (transport-level — the socket died,
// an AbortSignal fired, the client rejected before it sent) and the resolved
// error envelope (HTTP-level — see requestFailure above). Only the first kind
// rejects on this client, so a wrapper that awaits an SDK call bare cannot see
// the second one at all and reports a refused request as done.
//
// Every wrapper in this module is written on this primitive and on nothing
// else: a bare `await client.*` here is a defect by construction.
//
// `data` is unwrapped, so a caller reads the payload and never the envelope.
export async function attempt(op, call) {
  try {
    const result = await call()
    const failure = requestFailure(result, op)
    if (failure) return { ok: false, error: failure }
    return { ok: true, data: unwrap(result) }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(errMsg(err))
    // A throw means no response was seen. The message is left as the thrower
    // wrote it — callers of postNotice match on it.
    if (error.kind === undefined) error.kind = "indeterminate"
    if (error.terminal === undefined) error.terminal = false
    if (error.op === undefined) error.op = op
    return { ok: false, error }
  }
}

// Logs one failed request, once, at the wrapper that owns the contract.
function logFailure(op, error, fields = {}) {
  log(`${op} failed`, {
    ...fields,
    status: error?.status,
    kind: error?.kind,
    err: errMsg(error),
  })
}

// Runs `call` under a retry+linear-backoff policy and returns its unwrapped
// data, or throws the LAST failure once the budget is spent.
//
//   retries     — RE-tries only: 3 means 1 initial attempt + up to 3 retries.
//                 0 disables retrying (a single attempt).
//   backoffMs   — the base delay; the wait is `attempt * backoffMs` plus a
//                 0–25 % jitter, so retries from several processes do not
//                 synchronise into a thundering herd when opencode comes back
//                 up under load.
//   retryKinds  — which failure kinds are worth another attempt. This is where
//                 an idempotency decision is written down: a non-idempotent
//                 write must not retry an "indeterminate" failure, because the
//                 first delivery may already have taken effect.
//   shouldRetry — an extra predicate over the error, for a policy narrower
//                 than a kind (promptSession retries a refused 5xx only).
//   context     — fields added to every log line of this call.
//
// A `terminal` failure breaks out at once whatever the policy says: the
// request can never succeed, and the caller's failure path is the answer to it.
export async function withRetry(op, call, {
  retries = 0,
  backoffMs = 0,
  retryKinds = ["refused", "indeterminate"],
  shouldRetry,
  context = {},
} = {}) {
  const maxAttempts = Math.max(1, retries + 1)
  let lastErr
  for (let n = 1; n <= maxAttempts; n++) {
    const outcome = await attempt(op, call)
    if (outcome.ok) return outcome.data
    const failure = outcome.error
    lastErr = failure
    if (failure.terminal) {
      log(`${op}: not retrying, the request was refused for good`, {
        ...context,
        attempt: n,
        status: failure.status,
        kind: failure.kind,
        err: errMsg(failure),
      })
      break
    }
    if (!retryKinds.includes(failure.kind) || (shouldRetry && !shouldRetry(failure))) {
      log(`${op}: not retrying, the failure is outside the retry policy`, {
        ...context,
        attempt: n,
        status: failure.status,
        kind: failure.kind,
        err: errMsg(failure),
      })
      break
    }
    if (n >= maxAttempts) break
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(backoffMs / 4)))
    const delay = (n * backoffMs) + jitter
    log(`${op}: retrying after failure`, {
      ...context,
      attempt: n,
      maxAttempts,
      delayMs: delay,
      err: errMsg(failure),
    })
    await sleep(delay)
  }
  throw lastErr
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
// BOTH failure kinds are retried here, and that asymmetry against
// promptSession is deliberate: a duplicate wake notice costs the primary a
// repeated paragraph, a lost one costs it the result of a whole subagent run.
//
// A terminal failure — the target session is gone, or the body was refused —
// breaks out at once instead of retrying: the notice can never land, and the
// caller's catch is where the answer to that is.
//
// `postNoticeRetries` counts RE-tries only: postNoticeRetries=3 means
// 1 initial attempt + up to 3 retries = up to 4 total attempts. A value of 0
// disables retries (single attempt, same as the pre-retry behavior).
// `postNoticeRetryBackoffMs` is the base delay.
// Every caller of postNotice targets a primary, so the notice is hidden
// whenever `showAgentcom` is off — the setting is read here, per send.
export async function postNotice(client, sessionID, text) {
  const { postNoticeRetries, postNoticeRetryBackoffMs, showAgentcom } = getSettings()
  rememberAgentcomSession(sessionID)
  await withRetry(
    "postNotice (session.promptAsync)",
    () =>
      client.session.promptAsync({
        path: { id: sessionID },
        // intercomTextPart marks the message as plugin-generated
        // (metadata: { agentIntercom: true }) so history scans like the
        // handoff's lastUserGoal can skip it, and stamps `synthetic: true`
        // when the notice is hidden — see src/pluginmsg.js. The text reaches
        // the model either way; the post is the wake and is never dropped.
        body: { parts: [intercomTextPart(text, { hidden: !showAgentcom })] },
      }),
    {
      retries: postNoticeRetries,
      backoffMs: postNoticeRetryBackoffMs,
      retryKinds: ["refused", "indeterminate"],
      context: { sessionID },
    },
  )
}

// The SDK client wraps responses as { data, error, response }. Older shapes
// returned the payload directly — unwrap defensively either way.
export function unwrap(resp) {
  if (resp && typeof resp === "object" && "data" in resp) return resp.data
  return resp
}

// Creates a child session and returns its sessionID, or undefined where the
// server refused the request — the caller's `if (!sessionID)` branch is the
// answer to that, and the log line names the status it was refused with.
//
// A THROWN failure still propagates, unlike in every other wrapper here: no
// response was seen, so nothing is known about whether a session was created,
// and the callers of this one treat an exception as the abort of the whole
// sequence they are in the middle of.
//
// `onRefused` is handed the Error behind a refused create, with its `status`
// and `kind`. It exists because `undefined` alone cannot tell a caller WHY:
// the spawn tool reports the failure to the orchestrator in its own output, and
// a refusal the server decided on ("that parent is gone") reads differently to
// the orchestrator than a server that is down. Optional — a caller that only
// needs the branch passes nothing.
export async function createChildSession(client, { parentID, title, directory, onRefused }) {
  const op = "createChildSession (session.create)"
  const outcome = await attempt(op, () =>
    client.session.create({ body: { parentID, title }, query: { directory } }),
  )
  if (!outcome.ok) {
    if (outcome.error?.kind === "indeterminate") throw outcome.error
    logFailure(op, outcome.error, { parentID })
    onRefused?.(outcome.error)
    return undefined
  }
  return outcome.data?.id
}

// Fires a non-blocking prompt into a session — returns immediately (204).
// The part is marked as plugin-generated (see src/pluginmsg.js): this
// covers the handoff kickoff, the DOC_SUMMARY prompt and spawn task
// prompts — none of them is a REAL user message and none may ever be
// picked up as `Letztes Ziel:` by a later handoff's goal scan.
//
// `hideable` says whether this call site's prompt is chatter between the
// orchestrator and the plugin, and so may be hidden while `showAgentcom` is
// off. It defaults to false, so a send path added later stays visible until
// someone decides otherwise. The spawn task prompt is one such site on
// purpose: it lands in the SUBAGENT's session and is that session's entire
// instruction.
// A REQUIRED write: it THROWS where the prompt did not reach the session, and
// every call site has the failure path that belongs to — the spawn tears the
// child down and reports to the orchestrator, the reuse restores the retained
// entry, the handoff reverts before its point of no return. A prompt that was
// refused and reported as sent leaves a session that will never answer and a
// waiter that will never be woken.
//
// The retry policy is deliberately narrower than postNotice's: promptAsync is
// NOT idempotent — a second delivery starts a second turn in the child, and a
// second kickoff hands the fresh orchestrator its instructions twice. So only
// a "refused" failure with status >= 500 is retried: the server answered, so
// the prompt provably did not run, and a 5xx is the transient case. A refused
// 4xx is terminal (the session is gone, or the body was rejected) and an
// "indeterminate" throw is ambiguous — there the duplicate-prompt risk
// outweighs the retry, and it throws on the first failure.
export async function promptSession(client, { sessionID, agent, prompt, hideable = false }) {
  const { showAgentcom, postNoticeRetries, postNoticeRetryBackoffMs } = getSettings()
  const hidden = hideable && !showAgentcom
  // Only a hideable send puts the session under the switch. The one call site
  // that is not hideable — the spawn task prompt — lands in the SUBAGENT's
  // session and stays visible whatever the switch says, so that session must
  // never enter the sweep set.
  if (hideable) rememberAgentcomSession(sessionID)
  await withRetry(
    "promptSession (session.promptAsync)",
    () =>
      client.session.promptAsync({
        path: { id: sessionID },
        body: { agent, parts: [intercomTextPart(prompt, { hidden })] },
      }),
    {
      retries: postNoticeRetries,
      backoffMs: postNoticeRetryBackoffMs,
      retryKinds: ["refused"],
      shouldRetry: (err) => typeof err.status === "number" && err.status >= 500,
      context: { sessionID },
    },
  )
}

// Sends opencode's cooperative abort signal. A REPORTED write: it returns
// whether the abort was CONFIRMED, and never throws.
//
// `false` covers two different things on purpose, and the callers treat them
// alike: a request that failed (logged here with its status), and a request
// the server answered with a falsy body — "not confirmed". Every caller
// proceeds regardless, so the distinction would buy them nothing.
export async function abortSession(client, sessionID) {
  const op = "abortSession (session.abort)"
  const outcome = await attempt(op, () => client.session.abort({ path: { id: sessionID } }))
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return false
  }
  return Boolean(outcome.data)
}

// Per-session directory cache. `toolCtx.directory` and the plugin-factory
// closure's `directory` both reflect where `opencode serve` was started, NOT
// the session's actual project directory (which is set per-session via
// `?directory=...` on POST /session). The authoritative source is the session
// object itself; we fetch it lazily and cache to avoid a round-trip per tool
// call. Cache entries are dropped by `forgetSessionDirectory` when a session
// is destroyed (wake-hook + deleteSession).
const sessionDirCache = new Map()

// The sessions this process has posted switch-governed traffic into: every
// postNotice target and every hideable promptSession target. It is what the
// visibility sweep walks, beside the tracked primaries — a primary is tracked
// only once it has called one of the plugin's tools (trackPrimary,
// src/tools.js), so the fresh orchestrator a handoff creates has received its
// kickoff long before it appears in that set, and its notices would otherwise
// stay outside the switch until its first spawn.
//
// Bounded by the number of orchestrator sessions one process serves, and
// dropped with the session's other per-session cache in
// forgetSessionDirectory.
const agentcomSessions = new Set()

function rememberAgentcomSession(sessionID) {
  if (sessionID) agentcomSessions.add(sessionID)
}

// The sessions the visibility sweep has to consider from this process's own
// sends. Read by src/agentcomsync.js, which unions it with the tracked
// primaries.
export function agentcomSessionIds() {
  return [...agentcomSessions]
}

// Best-effort read: undefined on any failure, and nothing is cached then, so a
// later call asks again rather than serving a reading that was never made.
export async function getSessionDirectory(client, sessionID) {
  if (!sessionID) return undefined
  if (sessionDirCache.has(sessionID)) return sessionDirCache.get(sessionID)
  const op = "getSessionDirectory (session.get)"
  const outcome = await attempt(op, () => client.session.get({ path: { id: sessionID } }))
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return undefined
  }
  const dir = outcome.data?.directory
  if (dir) sessionDirCache.set(sessionID, dir)
  return dir
}

export function forgetSessionDirectory(sessionID) {
  sessionDirCache.delete(sessionID)
  agentcomSessions.delete(sessionID)
}

// Permanent deletion of a session in opencode (DELETE /session/{id}), as a
// REPORTED write: `true` only where the server confirmed it, `false` with one
// log line otherwise, and it never throws — a missed delete is not worth
// crashing the event handler over. We call this after our own registry reap,
// to keep the opencode server's session list from accumulating forever.
//
// No retry, on purpose. A session whose DELETE was refused is collected at the
// next plugin load by sweepOrphanedSubagentSessions (teardown.js), whose
// criteria admit exactly it; a retry loop on the teardown hot path buys
// nothing that reconciliation does not already give and delays a wake that has
// already been delivered.
//
// NEVER use this on a session that may still have LIVE children: opencode's
// DELETE cascades recursively over child sessions (source-verified + live on
// 1.17.15), and if a reparented subagent is still streaming its final reply,
// the cascade wipes its rows mid-write → `FOREIGN KEY constraint failed`,
// `session.error` instead of `session.idle`, and the deterministic auto-tick
// is skipped. The primary-handoff path must ARCHIVE the old primary instead —
// see `archiveSession`.
//
// On the subagent side the precondition is no longer free: a subagent that
// spawned a child of its own has live children like anything else. It is
// ENFORCED instead — `endLiveChildrenOf` in teardown.js ends a session's live
// children immediately before every delete on that path, and the abort tool
// does the same before its own delete. Abort/error paths also wait for the
// session's own idle event (or their bounded fallback) before deleting.
export async function deleteSession(client, sessionID) {
  const op = "deleteSession (session.delete)"
  const outcome = await attempt(op, () => client.session.delete({ path: { id: sessionID } }))
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return false
  }
  return true
}

// Rename of a session (PATCH /session/{id} with `title`), a REPORTED write. The
// title is the one field of a subagent session this plugin owns from the
// outside, and it is what carries the retention state to any reader of the
// opencode session list — the sidebar included (publishRetentionState in
// teardown.js). Returns whether the write went through; a failure is logged and
// costs the reader nothing but the state it would have shown.
export async function updateSessionTitle(client, sessionID, title) {
  const op = "updateSessionTitle (session.update)"
  const outcome = await attempt(op, () =>
    client.session.update({ path: { id: sessionID }, body: { title } }),
  )
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return false
  }
  return true
}

// Every session opencode holds, optionally narrowed to one project directory.
// Read-only and best-effort: an empty array on any failure, so a caller that
// sweeps on this list does nothing rather than something wrong when the call
// does not come back.
export async function listSessions(client, { directory } = {}) {
  const op = "listSessions (session.list)"
  const outcome = await attempt(op, () =>
    client.session.list(directory ? { query: { directory } } : undefined),
  )
  if (!outcome.ok) {
    logFailure(op, outcome.error, { directory })
    return []
  }
  return Array.isArray(outcome.data) ? outcome.data : []
}

// ARCHIVE of a session (PATCH /session/{id} with `time.archived`), as a
// REPORTED write: `true` only where the server confirmed it, `false` with one
// log line otherwise, and it never throws.
//
// Used in place of deleteSession for the OLD primary in the orchestrator
// handoff: archiving retires the session WITHOUT triggering opencode's
// recursive child-delete cascade, so any subagent still reparented under the
// old primary's DB parent keeps its rows and finishes on `session.idle`
// instead of dying on a FK-constraint mid-write (root cause of the skipped
// auto-tick — see the module header of handoff.js step 8).
//
// The pinned SDK (1.14.48) types the update body with `title` only, but the
// opencode 1.17.15 server's UpdatePayload schema accepts
// `time: { archived: <finite timestamp> }` and returns 200 (source- and
// live-verified). The generated hey-api client serialises the body verbatim,
// so the extra field passes through at runtime despite the narrower type.
export async function archiveSession(client, sessionID) {
  const op = "archiveSession (session.update)"
  const outcome = await attempt(op, () =>
    client.session.update({
      path: { id: sessionID },
      body: { time: { archived: Date.now() } },
    }),
  )
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return false
  }
  return true
}

// Cap on the snapshot HTTP fetch so a stuck opencode server never blocks a
// subagent's whole LLM turn (the transform hook awaits this before injecting).
const SNAPSHOT_TIMEOUT_MS = 5000

// Best-effort fetch of a session's full message list (Array<{info, parts}>).
// Returns [] on any failure — callers treat "no messages" and "fetch failed"
// alike (e.g. the handoff's last-user-goal lookup degrades to an empty goal).
// Same timeout discipline as fetchSnapshot.
export async function fetchMessages(client, sessionID) {
  const op = "fetchMessages (session.messages)"
  const outcome = await attempt(op, () =>
    client.session.messages({
      path: { id: sessionID },
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    }),
  )
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return []
  }
  return Array.isArray(outcome.data) ? outcome.data : []
}

// Best-effort snapshot of a session: a short description of its last activity,
// its context size (tokens of the most recent assistant step), and the full
// text of its final assistant message (its result). Any field may be undefined
// if unavailable. One messages() call serves all three.
//
// `result` is the reply WHOLE and is never shortened here. The reply token
// ceiling is applied where the text crosses into another agent's context —
// resultfile.js `capReplyForAgent`, called from the wake paths in hooks.js and
// from the watchdog's timeout path — so a caller that only parses the reply
// (the handoff's open-points fetch) gets all of it, and this function keeps to
// being a read.
//
// The only read whose caller branches on WHY it is empty, so its failure is
// split in two (see snapshotOutcome):
//   status 404      — the session is genuinely gone. `{ messageCount: 0 }`,
//                     which classifies as "gone".
//   every other one — a 500, a timeout, a transport error. Nothing was
//                     established about the session, so `{}`, which classifies
//                     as "unavailable". A caller must not destroy a retained
//                     handle over a transient server error.
export async function fetchSnapshot(client, sessionID) {
  const op = "fetchSnapshot (session.messages)"
  const outcome = await attempt(op, () =>
    client.session.messages({
      path: { id: sessionID },
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    }),
  )
  if (!outcome.ok) {
    logFailure(op, outcome.error, { sessionID })
    return outcome.error?.status === 404 ? { messageCount: 0 } : {}
  }
  const messages = Array.isArray(outcome.data) ? outcome.data : []
  return {
    // How many messages the session answered with. It is what tells a session
    // that is GONE apart from one that could not be READ: both leave every
    // other field undefined, and only the unreadable one returns {}.
    // See snapshotOutcome.
    messageCount: messages.length,
    lastActivity: latestActivity(messages),
    ctxTokens: latestContextTokens(messages),
    result: finalResult(messages),
  }
}

// Classifies what a fetchSnapshot call actually established about the session,
// for the callers that have to act differently per case rather than degrade to
// "no figure". Three outcomes and no fourth:
//
//   "ok"          — the session answered with messages. Its fields are the
//                   truth about it right now; an individual field may still be
//                   undefined (a step whose tokens are all zero yields no
//                   ctxTokens), which is the reading caller's business.
//   "unavailable" — the fetch could not be made: a timeout, a transport
//                   error, a 5xx — anything that produced {}. Nothing was
//                   established about the session; it is very probably still
//                   there.
//   "gone"        — the session's id addresses nothing. Either the fetch
//                   SUCCEEDED and the session has no messages at all (a
//                   session this plugin created was prompted before it was
//                   ever registered, so it always has messages; an empty list
//                   means it was deleted underneath the plugin — an
//                   `opencode session delete`, a database reset), or the
//                   server answered the read with a 404.
export function snapshotOutcome(snapshot) {
  if (!snapshot || typeof snapshot.messageCount !== "number") return "unavailable"
  return snapshot.messageCount > 0 ? "ok" : "gone"
}

// A text part whose whole content is a tool INVOCATION written out as prose
// rather than issued on the native tool channel. Small models fall back to
// this shape when their tool calling misfires, and it then sits in the
// session as the newest assistant text — carrying nothing about the work.
// Three forms, and the match is anchored so only a part that is NOTHING BUT
// the blob counts; a summary that happens to quote one keeps its text.
//   <tool_call>…</tool_call> / <function_call>…</function_call> — the
//     XML-ish wrapper of the Hermes/Qwen family and its relatives.
//   [TOOL_CALLS]…                                              — the Mistral marker.
//   {"name": …, "arguments": …}                                — the bare OpenAI call object,
//     required to carry BOTH a name-ish and an arguments-ish key so a
//     result that is legitimately JSON is not swallowed.
const TOOL_SCAFFOLD_RE =
  /^(?:<(tool_call|function_call|tool▁call)>[\s\S]*|\[TOOL_CALLS\][\s\S]*|\{[\s\S]*"(?:name|function)"[\s\S]*"(?:arguments|parameters)"[\s\S]*\}|\{[\s\S]*"(?:arguments|parameters)"[\s\S]*"(?:name|function)"[\s\S]*\})$/

// Whether a message part carries text the subagent actually SAID, as opposed
// to text that only exists to run the machinery. Unusable, in order:
//   - anything that is not a text part (tool, reasoning, step markers);
//   - `synthetic: true` — opencode's own model-facing wrappers and this
//     plugin's injected turn notices (see src/pluginmsg.js). Their text is
//     the plugin talking to the model, never the model reporting back;
//   - whitespace-only text;
//   - a part that is nothing but tool-call scaffolding (TOOL_SCAFFOLD_RE).
function usableText(part) {
  if (part?.type !== "text" || typeof part.text !== "string") return ""
  if (part.synthetic) return ""
  const text = part.text.trim()
  if (!text) return ""
  if (TOOL_SCAFFOLD_RE.test(text)) return ""
  return text
}

// The subagent's result, pushed to the primary on completion and on failure.
// Untruncated, unlike latestActivity.
//
// The newest assistant message is the result whenever it has usable text.
// Where it has none — the run died mid-tool-call, the provider blew up on the
// closing turn, the model emitted only scaffolding — this walks BACK through
// the earlier assistant messages and returns the most recent usable text
// instead. That is the last thing the subagent actually said about its work,
// and handing it up is what keeps a run from being repeated from scratch.
// Undefined only when the session holds no usable assistant text at all.
export function finalResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.info?.role !== "assistant") continue
    const text = (m.parts ?? [])
      .map(usableText)
      .filter(Boolean)
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

// The opencode server's base URL. The plugin factory receives it in its
// context object (`PluginInput.serverUrl`) and hands it over at init, so the
// TUI view switch below has a target even where the resolved SDK client does
// not carry the method. Empty until then, which only costs the fallback.
let serverUrl = ""

export function setServerUrl(url) {
  serverUrl = url ? String(url).replace(/\/+$/, "") : ""
}

// How many of one session's stale notice parts a single visibility sweep
// rewrites, newest first. A flip costs one PATCH per part whose flag has to
// change, over the whole session history, so the sweep is bounded: the newest
// end is what is on or near the screen, and a session holding more stale
// notices than this keeps the older ones as they are rather than firing an
// unbounded burst of requests at the server.
export const MAX_VISIBILITY_PATCHES = 200

// Whether a message part is one of THIS plugin's postings — a text part
// carrying the marker metadata intercomTextPart stamps (see src/pluginmsg.js),
// plus the two ids the part route is addressed by. The marker is persisted
// verbatim and comes back on `session.messages`, so a notice is identifiable
// with no bookkeeping at send time: `promptAsync` answers 204 with an empty
// body and never reveals the ids it created.
export function isIntercomNoticePart(part) {
  return Boolean(
    part &&
      part.type === "text" &&
      part.metadata &&
      typeof part.metadata === "object" &&
      part.metadata[INTERCOM_MESSAGE_METADATA_KEY] === true &&
      typeof part.id === "string" &&
      part.id !== "" &&
      typeof part.messageID === "string" &&
      part.messageID !== "",
  )
}

// PATCHes one part's `synthetic` flag. The body is the WHOLE part with the one
// field replaced: the route's payload schema is `Part` with
// `additionalProperties: false`, i.e. a complete valid part, not a diff.
//
// Returns "ok", or the kind of failure, so the caller can tell "this one part
// could not be written" from "this server has no such route".
async function patchPartSynthetic(part, sessionID, hidden) {
  const url =
    `${serverUrl}/session/${encodeURIComponent(part.sessionID ?? sessionID)}` +
    `/message/${encodeURIComponent(part.messageID)}/part/${encodeURIComponent(part.id)}`
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...part,
        sessionID: part.sessionID ?? sessionID,
        synthetic: hidden,
      }),
    })
    if (res?.ok) return "ok"
    log("agentcom visibility patch refused", { status: res?.status, partID: part.id })
    return "refused"
  } catch (err) {
    log("agentcom visibility patch failed", { partID: part.id, err: errMsg(err) })
    return "unreachable"
  }
}

// Makes the `show agentcom` switch retroactive for one session: every part this
// plugin posted into it gets its `synthetic` flag brought to `hidden`, so a
// notice already on screen goes away when the switch is turned off and comes
// back when it is turned on. opencode's transcript renderer skips a synthetic
// text part and its user->model conversion does not look at the flag at all, so
// only the rendering changes; the text keeps reaching the model either way.
// (`ignored` is the inverse flag — it takes the text out of the model payload
// and leaves it on screen. It is never set here.)
//
// The route is `PATCH /session/{sessionID}/message/{messageID}/part/{partID}`.
// The plugin's v1 client carries no `part` namespace, so this posts to
// `serverUrl` directly, the way selectTuiSession does for `/tui/select-session`.
// The mutation publishes `message.part.updated` carrying the whole part, which
// is what reaches a drawn TUI without a resync — nothing more has to be pushed
// from here.
//
// BEST-EFFORT THROUGHOUT, and deliberately so: the route sits in a group
// annotated "Experimental HttpApi session routes" at version 0.0.1, so its
// path, its payload and its existence carry no compatibility promise across
// opencode releases. Every failure is logged and swallowed, nothing is thrown
// at the caller, and the outcome of a server that does not answer this route is
// that the notices stay exactly as they were posted — today's behaviour. The
// first failure while nothing has been written yet ends the sweep, so a missing
// route or a dead server costs one request rather than one per part; a failure
// after a part HAS been written is a per-part problem and the rest still runs.
//
// UNVERIFIED, the same gap selectTuiSession's direct post has: the request
// carries no authorization header. A server that demands one refuses the PATCH,
// and the notices then stay as they are.
//
// Returns { stale, patched, failed, aborted }: how many parts needed the flag
// changed, how many were changed, how many attempts failed, and whether the
// sweep gave up early.
export async function applyAgentcomVisibility(client, sessionID, { hidden } = {}) {
  const outcome = { stale: 0, patched: 0, failed: 0, aborted: false }
  if (!sessionID) return outcome
  if (!serverUrl) {
    log("agentcom visibility sweep skipped: no server URL")
    return outcome
  }
  const messages = await fetchMessages(client, sessionID)
  // Newest first: the near end of the history is what the user is looking at,
  // and it is what the cap must keep when a session holds more than it.
  const stale = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (!isIntercomNoticePart(part)) continue
      if (Boolean(part.synthetic) === hidden) continue
      stale.push(part)
    }
  }
  outcome.stale = stale.length
  for (const part of stale.slice(0, MAX_VISIBILITY_PATCHES)) {
    const result = await patchPartSynthetic(part, sessionID, hidden)
    if (result === "ok") {
      outcome.patched++
      continue
    }
    outcome.failed++
    if (outcome.patched === 0) {
      outcome.aborted = true
      break
    }
  }
  if (outcome.stale > 0) {
    log("agentcom visibility sweep", { sessionID, hidden: Boolean(hidden), ...outcome })
  }
  return outcome
}

// Best-effort TUI view switch: point the interactive TUI at `sessionID`
// (`POST /tui/select-session`, "Navigate the TUI to display the specified
// session"). Called right after the handoff kickoff — without it the user
// keeps looking at the session that is about to be archived.
//
// Two routes to the same server endpoint, for the same reason `archiveSession`
// sends a field the pinned types do not know: the generated typed client lags
// the server here. The v2-generated client carries `tui.selectSession`, the
// root one does not, and which of the two a given opencode build resolves is
// not something this plugin can decide. So: call the method where the resolved
// client has one, and post the route directly otherwise — including when the
// method is there but rejects the argument shape.
//
// The call carries the session id in BOTH shapes and asks for a rejection in
// both ways, because the two clients disagree on all of it (read off the
// resolved @opencode-ai/sdk 1.18.23):
//   - the v2 client's signature is `selectSession({ sessionID }, options)` and
//     it maps the flat key into the request body itself, dropping every key it
//     does not know (`dist/v2/gen/core/params.gen.js`) — so a lone
//     `{ body: { sessionID } }` would post an EMPTY body;
//   - a root-style client takes one options object with `body` and
//     `throwOnError`, and its `Tui` class carries no `selectSession` at all on
//     this version (`dist/gen/sdk.gen.d.ts`), so that branch is inert here.
// Without `throwOnError` a 4xx comes back as `{ data, error }` rather than
// throwing (`dist/error-interceptor.js`), which is why `res.error` is checked
// as well: either shape has to reach the fallback below, and a reported
// success has to mean the server accepted it.
//
// UNVERIFIED: the direct post carries no authorization header. The plugin
// runtime builds `client` with the server's auth headers; a server that
// requires them will refuse the bare post, and the switch then degrades to
// today's behaviour (the TUI stays on the old session).
//
// Best-effort throughout — a failed switch is a presentation failure, never a
// data one, and is logged and swallowed rather than thrown into the handoff.
export async function selectTuiSession(client, sessionID) {
  if (!sessionID) return false
  if (typeof client?.tui?.selectSession === "function") {
    try {
      const res = await client.tui.selectSession(
        { sessionID, body: { sessionID }, throwOnError: true },
        { throwOnError: true },
      )
      if (res?.error) throw new Error(errMsg(res.error))
      return true
    } catch (err) {
      log("tui.selectSession failed, falling back to the direct post", errMsg(err))
    }
  }
  if (!serverUrl) {
    log("tui select-session skipped: no server URL")
    return false
  }
  try {
    const res = await fetch(`${serverUrl}/tui/select-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
    })
    if (!res.ok) {
      log("tui select-session post failed", { status: res.status })
      return false
    }
    return true
  } catch (err) {
    log("tui select-session post failed", errMsg(err))
    return false
  }
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
