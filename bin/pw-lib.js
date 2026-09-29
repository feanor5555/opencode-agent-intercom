// The parts of `pw` (bin/pw.js) that decide something without a browser or a
// socket: which files a daemon owns, how its console record is kept, how the
// `console` command is read, and when an idle daemon exits. Kept apart from
// pw.js because pw.js runs its CLI dispatch at import time.

import path from "node:path"

// The one line `pw start` prints where no usable browser is installed. It
// downloads nothing and exits 1 at once.
export const PW_BROWSER_MISSING_LINE = "pw: browser not installed — report this check as NOT RUN"

// How long a daemon waits without a request before it exits on its own.
export const DEFAULT_PW_IDLE_EXIT_MS = 900_000

// How many console lines a daemon keeps; the oldest goes first.
export const CONSOLE_RING_LINES = 500

// The longest session suffix a file name carries.
const SESSION_SUFFIX_MAX = 64

// The file-name suffix for a `PW_SESSION` value: every character outside
// [A-Za-z0-9_-] dropped, cut to 64 characters. "" where nothing is left, so a
// value made only of other characters falls back to the unsuffixed names.
export function pwSessionSuffix(value) {
  if (typeof value !== "string") return ""
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, SESSION_SUFFIX_MAX)
}

// The socket, pid and log file of the daemon a caller talks to. With a session
// suffix every name carries it (`pw-<id>.sock`), so two sessions run two
// daemons; without one the names are `pw.sock`, `pw.pid`, `pw.log`.
export function pwPaths(runtimeDir, session) {
  const suffix = pwSessionSuffix(session)
  const stem = suffix ? `pw-${suffix}` : "pw"
  return {
    socket: path.join(runtimeDir, `${stem}.sock`),
    pid: path.join(runtimeDir, `${stem}.pid`),
    log: path.join(runtimeDir, `${stem}.log`),
  }
}

// The idle exit from `PW_IDLE_EXIT_MS`: a whole number of milliseconds, 0 for
// no idle exit; anything else gives the default.
export function pwIdleExitMs(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return DEFAULT_PW_IDLE_EXIT_MS
  return Number(value.trim())
}

// The console record of one daemon: the last `limit` lines, oldest first.
export function createConsoleRing(limit = CONSOLE_RING_LINES) {
  const lines = []
  return {
    push(line) {
      lines.push(String(line))
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    lines() {
      return lines.slice()
    },
    clear() {
      lines.length = 0
    },
  }
}

// The line a browser console message becomes: `[<type>] <text>`.
export function consoleLine(type, text) {
  return `[${type}] ${text}`
}

// The line an uncaught page error becomes: `[pageerror] <message>`.
export function pageErrorLine(message) {
  return `[pageerror] ${message}`
}

// `pw console [--clear]` read into its request, or an error text for anything
// else on the line.
export function parseConsoleArgs(args) {
  let clear = false
  for (const arg of args) {
    if (arg === "--clear") clear = true
    else return { error: `unknown argument "${arg}" — the only option is --clear` }
  }
  return { request: { cmd: "console", clear } }
}

// What `pw console` prints for a record.
export function formatConsoleRecord(lines) {
  return lines.length ? lines.join("\n") : "(no console output)"
}
