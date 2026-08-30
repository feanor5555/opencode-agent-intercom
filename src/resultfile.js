// The overflow file behind the reply token ceiling: when a subagent's final
// reply is longer than the ceiling its type carries, the part that does not
// reach the orchestrator's context is not lost — the reply is written HERE in
// full, and the wake notice carries this file's path instead of the cut tail.
//
// The guarantee is the plugin's, not the subagent's. A subagent is asked (in
// its guide) to file long material itself while it works, but the truncation is
// decided plugin-side after the reply exists, and a subagent at its context
// budget has every tool denied precisely when its reply is longest. So the
// backstop sits here and is unconditional.
//
// Best-effort in the log.js sense: nothing in this module throws into the wake
// path. A write that fails comes back as `{ error }` and turns into a different
// sentence in the notice — the wake itself is never held up or lost.
//
// The file is machine state, not a deliverable: it goes under the user-private
// cache dir (0700), never into the project, so a long reply cannot pollute a
// user's `git status`. The subagent's own voluntary file is the one that
// belongs under the project.

import fs from "node:fs"
import path from "node:path"

import { cacheDir, log, errMsg } from "./log.js"
import { estimateReplyTokens, cutToTokens } from "./format.js"
import { resultCeilingFor } from "./settings.js"

// How long an overflow file is kept. Once the subagent's session is deleted
// this file is the ONLY copy of the cut text, so nothing removes it on the wake
// path; a single pass at plugin load drops what is older than this. A fixed
// constant and not a setting: it bounds a cache directory, it does not express
// an intent the user has about their work.
export const RESULT_FILE_TTL_MS = 7 * 24 * 3600 * 1000

// Where the overflow files live: a child of the plugin's private cache dir.
export function resultsDir() {
  return path.join(cacheDir(), "results")
}

// Best-effort mkdir of the results dir (0700), the sibling of ensureCacheDir.
// Never throws — the caller's own write simply fails and is reported.
export function ensureResultsDir() {
  const dir = resultsDir()
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // ignore — writeOverflow reports the failure that follows
  }
  return dir
}

// A handle is user-facing text (`researcher#1`) and must not steer the path it
// is pasted into: everything outside [A-Za-z0-9._-] becomes `-`, which takes
// `/`, `..` and NUL with it. An empty or missing handle still yields a name.
function safeHandle(handle) {
  const safe = String(handle ?? "").replace(/[^A-Za-z0-9._-]/g, "-")
  return safe === "" ? "subagent" : safe
}

// `<safeHandle>-<sessionID>.md`, plus `-run<N>` from the second run of a
// RETAINED session on: a follow-up put through `reuse` must not overwrite the
// file the first run left behind, and handle and session are identical across
// the runs of one held subagent.
export function resultFileName({ handle, sessionID, runs }) {
  const suffix = Number.isInteger(runs) && runs > 1 ? `-run${runs}` : ""
  return `${safeHandle(handle)}-${safeHandle(sessionID)}${suffix}.md`
}

// Writes one reply in full — including the part that was cut — and returns
// `{ path }`, or `{ error }` with the reason as its message. The header names
// what the notice cannot: which subagent, which session, when, which task, how
// big the whole reply was and where it was cut. Everything after the `---`
// line is the reply verbatim, byte for byte, so a subagent reading this file
// gets the text and not a rendering of it.
export function writeOverflow({
  handle,
  agent,
  sessionID,
  taskId,
  runs,
  text,
  estimate,
  ceiling,
  finishedAt,
}) {
  const full = text == null ? "" : String(text)
  const size = Number.isFinite(estimate) ? estimate : estimateReplyTokens(full)
  const file = path.join(ensureResultsDir(), resultFileName({ handle, sessionID, runs }))
  const header =
    `# subagent result — ${handle} (${agent})\n` +
    `session: ${sessionID}\n` +
    `finished: ${finishedAt ?? new Date().toISOString()}\n` +
    (taskId ? `task: ${taskId}\n` : "") +
    `size: ~${size} tokens (estimated), cut to ${ceiling} in the orchestrator's notice\n` +
    `\n---\n\n`
  try {
    fs.writeFileSync(file, header + full, { mode: 0o600 })
    log("result overflow filed", { file, size, ceiling })
    return { path: file }
  } catch (err) {
    const error = errMsg(err)
    log("result overflow write failed", { file, error })
    return { error }
  }
}

// The three forms of the cut marker (§2.5 of specs/result-token-ceiling.md).
// The word is "cut", never "truncated", so a reader cannot confuse it with
// `outline`'s `[truncated — N more declarations]`. Figures are plain integers:
// the notice's other token counts round to `5.4k`, and an omitted count reading
// `3.4k` beside a ceiling reading `2000` would be two units on one line.
//
// The marker is plugin framing, like the notice's head and tail, and is not
// itself counted against the ceiling.
function filedMarker({ ceiling, omitted, file, handle, retained }) {
  const tail = retained
    ? `The session is also still held, so reuse("${handle}", "…") can ask it about the cut part directly.`
    : `This file is the only copy; the subagent's session is gone.`
  return (
    `\n\n[cut at ${ceiling} tokens — ${omitted} more tokens of this reply are not shown here.\n` +
    `The reply IN FULL, including everything cut, is the file\n` +
    `${file}\n` +
    `You cannot read that file yourself. If the rest is needed, spawn a subagent and put the ` +
    `path in its prompt — it reads the file. ${tail}]`
  )
}

function unfiledMarker({ ceiling, omitted, error, sessionID }) {
  return (
    `\n\n[cut at ${ceiling} tokens — ${omitted} more tokens of this reply are not shown here, ` +
    `and the overflow file could not be written (${error}). The cut text exists only in subagent ` +
    `session ${sessionID} — open that session in the TUI to read it, or have the work redone ` +
    `with a brief that asks for less.]`
  )
}

// The whole ceiling, applied to one subagent's final reply at the point where
// it crosses into another agent's context. Returns
// `{ text, path, error, cut }`:
//   text  — what the notice carries: the reply whole, or its kept prefix with
//           the marker appended,
//   path  — the overflow file, where one was written,
//   error — why it was not, where the write failed,
//   cut   — whether anything was cut at all.
//
// The ceiling is resolved from the PRODUCING agent's type on every call
// (resultCeilingFor), never from a value frozen on a registry entry, and `0`
// for that type means the reply passes whole with no file and no marker.
//
// meta: { handle, agent, sessionID, taskId, runs, retained, finishedAt }.
// `retained` is whether that subagent's session is being HELD, which is the
// only thing that changes the marker's last sentence.
export function capReplyForAgent(text, meta = {}) {
  const full = text == null ? "" : String(text)
  const ceiling = resultCeilingFor(meta.agent)
  if (full === "" || !(ceiling > 0)) return { text: full, path: null, error: null, cut: false }

  const { kept, omittedTokens } = cutToTokens(full, ceiling)
  if (omittedTokens === 0) return { text: full, path: null, error: null, cut: false }

  const { path: file, error } = writeOverflow({
    handle: meta.handle,
    agent: meta.agent,
    sessionID: meta.sessionID,
    taskId: meta.taskId,
    runs: meta.runs,
    text: full,
    estimate: estimateReplyTokens(full),
    ceiling,
    finishedAt: meta.finishedAt,
  })

  const marker = file
    ? filedMarker({
        ceiling,
        omitted: omittedTokens,
        file,
        handle: meta.handle,
        retained: Boolean(meta.retained),
      })
    : unfiledMarker({ ceiling, omitted: omittedTokens, error, sessionID: meta.sessionID })

  return { text: kept + marker, path: file ?? null, error: error ?? null, cut: true }
}

// One pass over the results dir, dropping every file whose mtime is older than
// RESULT_FILE_TTL_MS. Runs once per process at load, beside the bootstrap
// sweep. Returns how many files it removed. Never throws: a missing directory,
// an unreadable one and a file that vanished between the listing and the unlink
// are all normal.
export function pruneResultFiles(now = Date.now()) {
  let removed = 0
  const dir = resultsDir()
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const st = fs.statSync(file)
      if (!st.isFile() || now - st.mtimeMs <= RESULT_FILE_TTL_MS) continue
      fs.unlinkSync(file)
      removed++
    } catch {
      // gone already, or not ours to remove — nothing to repair
    }
  }
  if (removed > 0) log("result files pruned", { dir, removed })
  return removed
}
