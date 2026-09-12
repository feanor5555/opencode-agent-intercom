// Durable delivery of the notices this plugin posts into a parent session.
//
// WHY. Every parent notice travels on `POST /session/:id/prompt_async`, and
// that route answers `204` the moment it has forked `SessionPrompt.prompt` into
// a SERVER-lifetime fiber. The message row is written at the very END of that
// fiber — behind part resolution, file and image handling and the
// `chat.message` plugin hook — and every failure inside it is caught by the
// route's own `catchCause`, logged in opencode and published on the SSE stream.
// So `204` means ACCEPTED, never PERSISTED, and the caller of the post can
// establish nothing about whether the notice landed. Live consequence: a
// subagent's wake notice was lost outright — `postNotice` saw success, nothing
// logged a failure, and the orchestrator had no record its subagent had ended.
// (Evidence: work/diagnostician-promptasync-persistence.md.)
//
// WHAT THIS ADDS. Three steps around the post the call itself cannot give us:
//
//   1. JOURNAL — before the post, the notice is written to a file of its own
//      under the plugin's cache dir, with the target session, the text and the
//      process that is delivering it.
//   2. CONFIRM — after the post, the target session's TAIL is read back
//      (`session.messages` with `query: { limit: N }`, never `0` — opencode
//      reads `0` as "no limit" and answers with the whole history) and matched
//      on the delivery id the posted part carries in its metadata. A match
//      clears the journal entry; nothing else does.
//   3. REPLAY — at the next plugin load, whatever is still in the journal from
//      a process that is gone is confirmed once more and, where it really is
//      missing, posted again. That is what keeps an ending from being lost
//      across a crash.
//
// The confirmation is DETACHED from the post: `deliverParentNotice` returns as
// soon as the post is accepted, exactly as the bare `postNotice` did, and the
// confirmation runs on its own. The journal — not the confirmation — is the
// durability guarantee; the confirmation is the reconciliation that clears it,
// and holding a wake path open for the seconds a row can take to appear would
// buy nothing the replay does not already cover.
//
// SHAPE ON DISK. One file per pending notice, `<deliveryID>.json`, under
// `~/.cache/opencode-agent-intercom/notice-journal/` (0700). One file per
// notice and not one shared object, because several opencode instances write
// this directory at once and a read-modify-write over a shared file loses an
// entry to the interleaving — which is the very failure this module exists to
// stop. Each write is a temp file renamed over its target, so a reader never
// sees a half-written entry, and a file that does not parse is ignored rather
// than raised: nothing here may break plugin load.
//
// WHOSE ENTRY IS WHOSE. Every entry carries `pid` and `boot`, the id and the
// per-process token of the writer. A replay takes an entry only when it is not
// this process's own (`boot`) and its writer is gone (a dead `pid`, or our own
// `pid` under a different `boot`, which is a predecessor whose id was reused).
// An entry belonging to a LIVE other instance is left alone; that instance is
// confirming it itself.
//
// Best-effort in the log.js sense throughout: no file operation here throws
// into a notice path. A journal that cannot be written costs the delivery its
// durability and nothing else — the notice is still posted.

import fs from "node:fs"
import path from "node:path"

import { cacheDir, ensureCacheDir, log, errMsg } from "./log.js"
import { postNotice, fetchSessionTail } from "./client.js"
import { messageCarriesDelivery } from "./pluginmsg.js"

// How many of the target session's newest messages the confirmation reads. A
// notice is posted as the newest message of the session, so one would do; the
// window is wider because the primary may have written in the meantime (a user
// prompt, a second subagent's notice landing in the same second) and a
// confirmation that reads too narrowly reports a delivered notice as lost.
export const NOTICE_CONFIRM_TAIL_LIMIT = 8

// When the confirmation reads, in milliseconds after the post. The row does not
// exist when the `204` lands, so the first read is deliberately not immediate;
// the later ones cover a fiber held up by part resolution, an image, or a slow
// `chat.message` hook in another plugin. The last one is the point at which the
// notice counts as lost for THIS process — the next load's replay is what
// still stands behind it.
export const NOTICE_CONFIRM_DELAYS_MS = [500, 1500, 3000, 6000]

// How long a journal entry may be replayed for. Past this it is dropped and
// reported as lost: a wake notice for a subagent that ended a day ago tells the
// orchestrator of a session it no longer has, and an entry nothing ever clears
// would sit in the cache dir forever.
export const NOTICE_JOURNAL_TTL_MS = 24 * 3600 * 1000

// How many plugin loads may skip an entry because its target session read back
// empty before that entry is dropped and reported lost. An empty read at load
// time is very probably a session that is gone — the server is answering, we
// just started inside it — but it is also what a transient 5xx looks like, so
// one further load gets to try. Nothing else bounds a journal left by a process
// whose sessions have since been deleted.
export const MAX_REPLAY_SKIPS = 1

// How many entries one plugin load replays. Anything beyond it is LEFT in the
// journal — not dropped — so the next load takes the next batch and only the
// TTL above ever discards an entry unsent.
export const MAX_REPLAYED_NOTICES = 20

// This process instance. `pid` alone cannot identify a writer: an operating
// system reuses process ids, and an entry left by a dead predecessor that
// happened to hold our id must be replayed rather than mistaken for our own.
const BOOT_TOKEN = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`

let deliveryCounter = 0

// Where the pending notices live: a child of the plugin's private cache dir,
// beside the result overflow files.
export function noticeJournalDir() {
  return path.join(cacheDir(), "notice-journal")
}

// Best-effort mkdir of the journal dir (0700), the sibling of ensureCacheDir.
// Never throws — the caller's own write simply fails and is logged there.
export function ensureNoticeJournalDir() {
  const dir = noticeJournalDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // ignore — writeEntry reports the failure that follows
  }
  return dir
}

// A delivery id is a file name and must not steer the path it is joined into:
// everything outside [A-Za-z0-9._-] becomes `-`, which takes `/`, `..` and NUL
// with it. Applied on the way out AND on the way back in, because a replay
// reads ids off a directory listing.
function safeID(id) {
  const safe = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "-")
  return safe === "" ? "delivery" : safe
}

// A fresh id for one delivery. Sortable by time, unique across the processes
// that share this directory, and safe as a file name by construction.
export function newDeliveryID(now = Date.now()) {
  deliveryCounter += 1
  return `n-${now.toString(36)}-${process.pid.toString(36)}-${deliveryCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

export function journalFilePath(deliveryID) {
  return path.join(noticeJournalDir(), `${safeID(deliveryID)}.json`)
}

// Whether the process that wrote an entry is still running. `process.kill(pid,
// 0)` sends no signal; it answers whether the id can be signalled. EPERM means
// the process exists and belongs to somebody else, which is still alive — only
// ESRCH (and an id that is no id) means gone. The twin of `pauseWriterAlive`
// in src/endlesspause.js, kept here so this module depends on nothing but the
// cache-dir leaf and the client.
export function noticeWriterAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

// One entry as it is journalled, or null for anything that is not one. An entry
// without a target session or without text can never be delivered, so it is not
// an entry.
function normaliseEntry(deliveryID, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  if (typeof value.sessionID !== "string" || value.sessionID === "") return null
  if (typeof value.text !== "string" || value.text === "") return null
  const pid = Number.isInteger(value.pid) && value.pid > 0 ? value.pid : 0
  return {
    deliveryID,
    sessionID: value.sessionID,
    // The session the notice was addressed to before the handoff router
    // re-targeted it. Carried for the log line only; a replay posts to
    // `sessionID`, which is where the router decided it belongs.
    requestedFor: typeof value.requestedFor === "string" ? value.requestedFor : value.sessionID,
    kind: typeof value.kind === "string" ? value.kind : "notice",
    text: value.text,
    at: Number.isFinite(value.at) ? value.at : 0,
    pid,
    boot: typeof value.boot === "string" ? value.boot : "",
    replays: Number.isInteger(value.replays) && value.replays > 0 ? value.replays : 0,
    skips: Number.isInteger(value.skips) && value.skips > 0 ? value.skips : 0,
  }
}

// Atomic replace: write a sibling temp file and rename it over the target, so a
// replay never reads a half-written entry. Returns whether it reached the disk.
function writeEntry(deliveryID, entry) {
  const target = journalFilePath(deliveryID)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    ensureNoticeJournalDir()
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 })
    fs.renameSync(tmp, target)
    return true
  } catch (err) {
    log("notice journal: writing the pending entry failed", {
      deliveryID,
      error: errMsg(err),
    })
    try {
      fs.unlinkSync(tmp)
    } catch {
      // nothing to clean up
    }
    return false
  }
}

// Journals one notice as pending and answers whether it reached the disk. The
// caller posts either way: a notice that could not be journalled is exactly as
// deliverable as it was before this module existed, only without the net.
export function recordPendingNotice({
  deliveryID,
  sessionID,
  text,
  kind = "notice",
  requestedFor,
  replays = 0,
  at = Date.now(),
}) {
  if (!deliveryID || !sessionID || !text) return false
  return writeEntry(deliveryID, {
    sessionID,
    requestedFor: requestedFor ?? sessionID,
    kind,
    text,
    at: Number.isFinite(at) ? at : Date.now(),
    pid: process.pid,
    boot: BOOT_TOKEN,
    replays,
    skips: 0,
  })
}

// Takes one entry out of the journal. Returns whether a file was removed; a
// missing file is not a failure — a replay in another process may have cleared
// the same entry first.
export function clearPendingNotice(deliveryID) {
  if (!deliveryID) return false
  try {
    fs.unlinkSync(journalFilePath(deliveryID))
    return true
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log("notice journal: clearing the pending entry failed", {
        deliveryID,
        error: errMsg(err),
      })
    }
    return false
  }
}

// Every entry the journal holds right now, oldest first. `[]` for a directory
// that is not there or cannot be read: an unreadable journal is "nothing
// pending" rather than an error anybody has to handle.
export function readPendingNotices() {
  let names
  try {
    names = fs.readdirSync(noticeJournalDir())
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const deliveryID = name.slice(0, -".json".length)
    let text
    try {
      text = fs.readFileSync(path.join(noticeJournalDir(), name), "utf8")
    } catch {
      continue
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      // A file that does not parse is a half-written or corrupted entry. It is
      // dropped rather than kept: nothing can be delivered from it, and left in
      // place it would be re-read at every load for the rest of the TTL.
      log("notice journal: dropping an entry that does not parse", { deliveryID })
      clearPendingNotice(deliveryID)
      continue
    }
    const entry = normaliseEntry(deliveryID, raw)
    if (entry) out.push(entry)
    else {
      log("notice journal: dropping an entry that is not a notice", { deliveryID })
      clearPendingNotice(deliveryID)
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

// THE one place a lost notice is reported. Every path that gives up on a
// delivery comes through here, so a single line in the debug log answers
// "did anything the plugin sent fail to arrive" — which, before the journal,
// nothing did at all.
function reportLostNotice(entry, reason) {
  log("notice delivery LOST", {
    deliveryID: entry.deliveryID,
    kind: entry.kind,
    sessionID: entry.sessionID,
    requestedFor: entry.requestedFor,
    replays: entry.replays,
    ageMs: entry.at ? Date.now() - entry.at : undefined,
    reason,
    // The head of the text, so the log says WHICH ending was lost without
    // carrying a whole subagent reply into the log file.
    head: entry.text.slice(0, 120),
  })
}

// The confirmation's wait between reads. The timer is UNREF'd: a pending
// confirmation must never be the reason a process stays alive. In the server
// this changes nothing — opencode's own listener holds the loop open — and at
// shutdown it means the confirmation is simply abandoned, which is precisely
// the case the journal and the next load's replay exist for.
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === "function") timer.unref()
  })
}

// Reads the target session's tail once and answers whether the delivery landed.
// `undefined` — not `false` — where the read established nothing: an empty tail
// is a session that is gone OR a read that failed, and the two callers treat
// that differently from "read it, the notice is not there".
export async function confirmNoticeDelivered(
  client,
  sessionID,
  deliveryID,
  { tailLimit = NOTICE_CONFIRM_TAIL_LIMIT } = {},
) {
  const tail = await fetchSessionTail(client, sessionID, tailLimit)
  if (!Array.isArray(tail) || tail.length === 0) return undefined
  return tail.some((message) => messageCarriesDelivery(message, deliveryID))
}

// The confirmations this process still has running. Awaited by the replay (so a
// load does not race its own fresh posts) and by the tests, which have no other
// way to know a detached confirmation has finished.
const inFlightConfirmations = new Set()

export function awaitNoticeConfirmations() {
  return Promise.all([...inFlightConfirmations]).then(() => undefined)
}

// Polls the confirmation over NOTICE_CONFIRM_DELAYS_MS and clears the journal
// entry the moment the row is seen. An entry that is still unconfirmed when the
// schedule is spent stays in the journal — the next plugin load replays it —
// and is reported once, here at the single report site.
//
// Never throws and never rejects: it runs detached, so a rejection would be an
// unhandled one.
async function runConfirmation(client, entry, { delaysMs = NOTICE_CONFIRM_DELAYS_MS, tailLimit } = {}) {
  try {
    for (const delay of delaysMs) {
      if (delay > 0) await sleep(delay)
      const seen = await confirmNoticeDelivered(client, entry.sessionID, entry.deliveryID, {
        tailLimit,
      })
      if (seen === true) {
        clearPendingNotice(entry.deliveryID)
        return true
      }
    }
    reportLostNotice(entry, "the target session never showed the posted notice")
    return false
  } catch (err) {
    // A confirmation that itself broke establishes nothing; the entry stays
    // journalled and the next load's replay is what answers it.
    log("notice journal: the delivery confirmation failed", {
      deliveryID: entry.deliveryID,
      sessionID: entry.sessionID,
      error: errMsg(err),
    })
    return false
  }
}

function scheduleConfirmation(client, entry, options) {
  const running = runConfirmation(client, entry, options).finally(() => {
    inFlightConfirmations.delete(running)
  })
  inFlightConfirmations.add(running)
  return running
}

// Posts one parent notice DURABLY: journal, post, confirm.
//
// The post itself is `postNotice` and keeps every property it had — the retry
// policy, the `showAgentcom` visibility, the throw on an exhausted budget that
// each caller already has a failure path for. What is added around it is the
// journal entry and the detached confirmation.
//
// Returns the delivery id, so a caller that wants to wait for the confirmation
// (the replay, the tests) can. Throws exactly where `postNotice` throws.
//
// A TERMINAL failure — the session is gone, the body was refused — clears the
// entry before re-throwing: a replay of it could never land either, and an
// entry no replay can settle would only sit out its TTL and then be reported as
// lost, which would be a second, false report of the failure the caller is
// already handling.
export async function deliverParentNotice(
  client,
  sessionID,
  text,
  { kind = "notice", requestedFor, replays = 0, confirm = {} } = {},
) {
  const deliveryID = newDeliveryID()
  const entry = {
    deliveryID,
    sessionID,
    requestedFor: requestedFor ?? sessionID,
    kind,
    text,
    at: Date.now(),
    pid: process.pid,
    boot: BOOT_TOKEN,
    replays,
  }
  const journalled = recordPendingNotice(entry)
  try {
    await postNotice(client, sessionID, text, { deliveryID })
  } catch (err) {
    if (journalled) {
      if (err?.terminal) clearPendingNotice(deliveryID)
      // A non-terminal failure may still have reached the server, so the entry
      // stays and the confirmation runs: an indeterminate post that landed
      // clears itself here instead of being replayed at the next load.
      else scheduleConfirmation(client, entry, confirm)
    }
    throw err
  }
  if (journalled) scheduleConfirmation(client, entry, confirm)
  return deliveryID
}

// The line a replayed notice carries above its original text. The orchestrator
// is being told about an ending it may have been told about already, in a
// session that has restarted since — saying so is cheaper than leaving it to
// work out why a subagent it no longer knows is reporting in. The "🔔
// agent-intercom:" opening is kept because the legacy prefix backstop in
// pluginmsg.js matches on it.
export function replayHeader() {
  return (
    "🔔 agent-intercom: re-delivered after a restart — the first delivery of the notice below " +
    "was never confirmed in the session.\n\n"
  )
}

// Replays what a previous process left behind. Called once per plugin load.
//
// Per entry, in order:
//   - past the TTL          -> dropped, reported lost once.
//   - the session reads back empty (gone, or the read failed) -> LEFT in the
//     journal and skipped. This is also what keeps a journal written by a test
//     run, or by an instance whose sessions have since been deleted, from
//     posting into anything: a target that cannot be read is never posted to.
//   - the delivery id is in the tail -> it did land after all; cleared.
//   - anything else -> posted again under a NEW delivery id and journalled
//     afresh before the old entry is cleared, so a crash inside the replay
//     leaves the notice pending rather than gone.
//
// Never throws. Returns a count per outcome, which is what the tests assert on.
export async function replayPendingNotices(
  client,
  { now = Date.now(), max = MAX_REPLAYED_NOTICES, confirm = {}, tailLimit = NOTICE_CONFIRM_TAIL_LIMIT } = {},
) {
  const counts = { pending: 0, expired: 0, confirmed: 0, replayed: 0, skipped: 0, failed: 0, deferred: 0 }
  let entries
  try {
    entries = readPendingNotices()
  } catch (err) {
    log("notice journal: reading the journal failed", { error: errMsg(err) })
    return counts
  }
  counts.pending = entries.length
  let handled = 0
  for (const entry of entries) {
    // Not ours to replay: this process wrote it and is confirming it, or a
    // different LIVE instance is.
    if (entry.boot === BOOT_TOKEN) continue
    if (entry.pid !== process.pid && noticeWriterAlive(entry.pid)) continue
    if (now - entry.at > NOTICE_JOURNAL_TTL_MS) {
      counts.expired += 1
      reportLostNotice(entry, "the journal entry outlived the replay window")
      clearPendingNotice(entry.deliveryID)
      continue
    }
    if (handled >= max) {
      counts.deferred += 1
      continue
    }
    handled += 1
    try {
      const seen = await confirmNoticeDelivered(client, entry.sessionID, entry.deliveryID, {
        tailLimit,
      })
      if (seen === undefined) {
        // The target read back empty: the session is gone, or the read failed.
        // Either way nothing may be POSTED to it — a journal left by a process
        // whose sessions have since been deleted must never wake a stranger.
        if (entry.skips >= MAX_REPLAY_SKIPS) {
          counts.expired += 1
          reportLostNotice(entry, "the target session read back empty on every replay")
          clearPendingNotice(entry.deliveryID)
          continue
        }
        counts.skipped += 1
        // Rewritten under the ORIGINAL writer, so the next load still counts it
        // as an entry of a process that is gone and picks it up again.
        writeEntry(entry.deliveryID, {
          sessionID: entry.sessionID,
          requestedFor: entry.requestedFor,
          kind: entry.kind,
          text: entry.text,
          at: entry.at,
          pid: entry.pid,
          boot: entry.boot,
          replays: entry.replays,
          skips: entry.skips + 1,
        })
        log("notice journal: replay skipped, the target session read back empty", {
          deliveryID: entry.deliveryID,
          sessionID: entry.sessionID,
          kind: entry.kind,
          skips: entry.skips + 1,
        })
        continue
      }
      if (seen) {
        counts.confirmed += 1
        clearPendingNotice(entry.deliveryID)
        continue
      }
      await deliverParentNotice(client, entry.sessionID, replayHeader() + entry.text, {
        kind: entry.kind,
        requestedFor: entry.requestedFor,
        replays: entry.replays + 1,
        confirm,
      })
      clearPendingNotice(entry.deliveryID)
      counts.replayed += 1
      log("notice journal: re-delivered a notice a previous process left pending", {
        deliveryID: entry.deliveryID,
        sessionID: entry.sessionID,
        kind: entry.kind,
      })
    } catch (err) {
      counts.failed += 1
      log("notice journal: replaying a pending notice failed", {
        deliveryID: entry.deliveryID,
        sessionID: entry.sessionID,
        error: errMsg(err),
      })
    }
  }
  return counts
}
