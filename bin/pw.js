#!/usr/bin/env node
// `pw` — tiny CLI wrapper around Playwright so subagents (verifier, debugger) can
// inspect a generated web page from bash.
//
// Architecture
// ------------
// One file, two modes:
//   - CLI mode (default): parses argv, connects to a Unix socket, sends one
//     JSON request, prints the response, exits.
//   - Daemon mode (`pw __daemon`, used internally by `pw start`): launches a
//     persistent Chromium + BrowserContext + Page, listens on a Unix socket,
//     handles requests against the same Page across calls.
//
// Statefulness comes from the daemon holding a single Page reference: every
// subsequent `pw goto` / `pw click` / `pw evaluate` runs on it, so navigation,
// cookies, localStorage and DOM state persist across separate shell calls —
// the property `pw` was built for.
//
// Commands deliberately mirror Playwright's Page-method names 1:1
// (`goto`, `click`, `fill`, `evaluate`, `screenshot`, `textContent`,
// `innerText`, `waitForSelector`, `url`, `title`, `content`, `press`, `hover`,
// `selectOption`). `evaluate` is the escape hatch for anything not covered.
//
// One daemon per caller session: where `PW_SESSION` is set (the plugin sets it
// in every subagent's shell, src/shellenv.js) the socket, pid and log names
// carry it, so two subagents drive two browsers. The daemon keeps the page's
// console messages and uncaught page errors in a ring (`pw console`) and exits
// on its own after `PW_IDLE_EXIT_MS` without a request.

import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { chromiumExecutable, chromiumInstalled } from "./chromium.js"
import {
  PW_BROWSER_MISSING_LINE,
  consoleLine,
  createConsoleRing,
  formatConsoleRecord,
  pageErrorLine,
  parseConsoleArgs,
  pwIdleExitMs,
  pwPaths,
} from "./pw-lib.js"

// User-private runtime dir for the daemon socket/pid/log. Deliberately NOT under
// a shared /tmp: a fixed socket path there is reachable by any local user, who
// could then drive the browser (incl. arbitrary JS via `evaluate`). Prefer the
// per-user XDG runtime dir, fall back to ~/.cache. Both CLI and daemon modes run
// this same module, so the path is computed once for both.
function runtimeDir() {
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-agent-intercom")
}

const RUNTIME_DIR = runtimeDir()
try { fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }) } catch {}

const { socket: SOCKET, pid: PID, log: LOG } = pwPaths(RUNTIME_DIR, process.env.PW_SESSION)
const IDLE_EXIT_MS = pwIdleExitMs(process.env.PW_IDLE_EXIT_MS)
const READY_TIMEOUT_MS = 30_000
// Inactivity ceiling for a single daemon round-trip (sendOverSocket). A hung
// daemon (dead event loop, deadlocked page) would otherwise block the caller's
// Bash invocation forever. Declared here with the other module constants so it
// is initialized before the top-level CLI dispatch runs (no TDZ).
const SOCKET_TIMEOUT_MS = 120_000

// ─── entry ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const cmd = argv[0]

if (cmd === "__daemon") {
  // Hidden: re-entry point for the detached daemon process started by `pw start`.
  await runDaemon(argv.includes("--headed"))
} else if (!cmd || cmd === "-h" || cmd === "--help") {
  printHelp()
  process.exit(cmd ? 0 : 1)
} else if (cmd === "start") {
  await cmdStart(argv.includes("--headed"))
} else {
  // All other commands are sent to the running daemon.
  await cmdSend(cmd, argv.slice(1))
}

// ─── CLI: start the daemon ──────────────────────────────────────────────────

async function cmdStart(headed) {
  if (await isDaemonAlive()) {
    console.error("pw: daemon already running — use `pw stop` first or just send commands")
    process.exit(1)
  }
  try { fs.unlinkSync(SOCKET) } catch {}

  await requireInstalledBrowser()

  const self = fileURLToPath(import.meta.url)
  const out = fs.openSync(LOG, "a")
  const child = spawn(process.execPath, [self, "__daemon", ...(headed ? ["--headed"] : [])], {
    detached: true,
    stdio: ["ignore", out, out],
  })
  child.unref()

  // Wait for the daemon to bind the socket.
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDaemonAlive()) {
      console.log(`pw: daemon started (pid ${readPid() ?? "?"}, ${headed ? "headed" : "headless"})`)
      return
    }
    await sleep(150)
  }
  console.error(`pw: daemon did not become ready within ${READY_TIMEOUT_MS}ms — see ${LOG}`)
  process.exit(1)
}

// `pw start` uses the Chromium already on disk and never downloads one: where
// playwright-core or its Chromium binary is missing it prints one line and
// exits 1 before any daemon is spawned. The installer
// (`npx opencode-agent-intercom-install`) is what puts Chromium in place.
async function requireInstalledBrowser() {
  let installed = false
  try {
    ;({ installed } = await chromiumInstalled())
  } catch {
    installed = false
  }
  if (!installed) {
    console.error(PW_BROWSER_MISSING_LINE)
    process.exit(1)
  }
}

// ─── CLI: send a command to the daemon ──────────────────────────────────────

async function cmdSend(cmd, args) {
  // Pre-parse args per command so the CLI catches obvious mistakes (missing
  // selector, missing path) without a socket round-trip.
  const req = buildRequest(cmd, args)
  if (!req) process.exit(2)

  let res
  try {
    res = await sendOverSocket(req)
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      console.error("pw: no daemon — run `pw start` first")
      process.exit(1)
    }
    console.error(`pw: ${err.message}`)
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`pw: ${res.error}`)
    process.exit(1)
  }
  if (res.result !== undefined && res.result !== null) {
    if (typeof res.result === "string") console.log(res.result)
    else console.log(JSON.stringify(res.result, null, 2))
  }
}

function buildRequest(cmd, args) {
  switch (cmd) {
    case "stop":
      return { cmd }
    case "goto":
      return need(cmd, args, ["url"])
    case "click":
    case "hover":
      return need(cmd, args, ["selector"])
    case "fill":
      return need(cmd, args, ["selector", "value"])
    case "textContent":
    case "innerText":
      // selector optional — defaults to "body" on the daemon side
      return { cmd, selector: args[0] ?? "body" }
    case "evaluate": {
      // `pw evaluate <expr>` runs the JS as an expression (the common case);
      // `pw evaluate --body '<stmts>'` runs it as a function body, so a script
      // that needs `return` / multiple statements doesn't rely on a fragile
      // text match. Mutually exclusive — the daemon picks one mode by flag.
      const bodyIdx = args.indexOf("--body")
      if (bodyIdx !== -1) {
        const script = args[bodyIdx + 1]
        if (!script) return missing(cmd, "body")
        return { cmd, script, body: true }
      }
      return need(cmd, args, ["script"])
    }
    case "waitForSelector": {
      if (!args[0]) return missing(cmd, "selector")
      const timeout = args[1] != null ? Number(args[1]) : undefined
      if (timeout != null && !Number.isFinite(timeout)) return bad(cmd, "timeout must be a number")
      return { cmd, selector: args[0], timeout }
    }
    case "screenshot": {
      if (!args[0]) return missing(cmd, "path")
      return { cmd, path: path.resolve(args[0]), fullPage: args.includes("--fullPage") }
    }
    case "url":
    case "title":
    case "content":
      return { cmd }
    case "console": {
      const parsed = parseConsoleArgs(args)
      return parsed.error ? bad(cmd, parsed.error) : parsed.request
    }
    case "press":
      return need(cmd, args, ["key"])
    case "selectOption":
      return need(cmd, args, ["selector", "value"])
    default:
      console.error(`pw: unknown command "${cmd}" — try \`pw --help\``)
      return null
  }
}

function need(cmd, args, fields) {
  const out = { cmd }
  for (let i = 0; i < fields.length; i++) {
    if (args[i] == null) return missing(cmd, fields[i])
    out[fields[i]] = args[i]
  }
  return out
}
function missing(cmd, field) {
  console.error(`pw ${cmd}: missing <${field}>`)
  return null
}
function bad(cmd, msg) {
  console.error(`pw ${cmd}: ${msg}`)
  return null
}

function sendOverSocket(req) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET)
    let buf = ""
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      conn.destroy()
      reject(err)
    }
    // One inactivity timer covers both a stalled connect and a daemon that
    // accepted the request but never replies (it resets on every byte). We only
    // call conn.end() to half-close the WRITE side after sending the request —
    // the read side stays open for the reply, which depends on the daemon
    // server keeping its half open (allowHalfOpen, documented footgun); nothing
    // here touches that.
    conn.setTimeout(SOCKET_TIMEOUT_MS)
    conn.on("timeout", () =>
      fail(new Error(`daemon did not respond within ${SOCKET_TIMEOUT_MS}ms`)),
    )
    conn.on("connect", () => conn.end(JSON.stringify(req)))
    conn.on("data", (c) => { buf += c.toString() })
    conn.on("end", () => {
      if (settled) return
      settled = true
      try { resolve(JSON.parse(buf)) }
      catch (err) { reject(new Error(`malformed daemon response: ${err.message}`)) }
    })
    conn.on("error", fail)
  })
}

async function isDaemonAlive() {
  if (!fs.existsSync(SOCKET)) return false
  try {
    const res = await sendOverSocket({ cmd: "__ping" })
    return res.ok === true
  } catch {
    return false
  }
}

function readPid() {
  try { return Number(fs.readFileSync(PID, "utf8")) || null } catch { return null }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ─── daemon ────────────────────────────────────────────────────────────────

async function runDaemon(headed) {
  let chromium
  try {
    ;({ chromium } = await import("playwright-core"))
  } catch (err) {
    console.error("pw daemon: `playwright-core` not installed —", err.message)
    process.exit(1)
  }

  // The daemon never downloads Chromium; a missing binary ends it at once.
  const exe = chromiumExecutable(chromium)
  if (!exe || !fs.existsSync(exe)) {
    console.error(PW_BROWSER_MISSING_LINE)
    process.exit(1)
  }

  let browser, context, page
  try {
    browser = await chromium.launch({ headless: !headed })
    context = await browser.newContext()
    page = await context.newPage()
  } catch (err) {
    console.error("pw daemon: launch failed —", err.message)
    process.exit(1)
  }

  // What the page prints and throws, kept for `pw console`. Registered before
  // the first `goto`, so an error thrown while a page loads is in the record.
  const record = createConsoleRing()
  page.on("console", (msg) => record.push(consoleLine(msg.type(), msg.text())))
  page.on("pageerror", (err) => record.push(pageErrorLine(err?.message ?? String(err))))

  // A daemon whose caller is gone exits on its own: the timer is re-armed at
  // every request and at every reply, and 0 switches it off.
  let idleTimer = null
  const armIdleExit = () => {
    if (IDLE_EXIT_MS <= 0) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] pw daemon idle for ${IDLE_EXIT_MS}ms — exiting`)
      shutdown(browser, server).then(() => process.exit(0))
    }, IDLE_EXIT_MS)
  }

  try { fs.unlinkSync(SOCKET) } catch {}
  // `allowHalfOpen: true` is critical — without it Node auto-closes the
  // writable side as soon as the client's FIN arrives, racing our async
  // response write to a silent drop. The client sends data+FIN, we read it,
  // then need the writable side still open to send the JSON response back.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    armIdleExit()
    let buf = ""
    conn.on("data", (chunk) => { buf += chunk.toString() })
    conn.on("end", async () => {
      let res
      try {
        const req = JSON.parse(buf)
        res = { ok: true, result: await dispatch(req, { page, browser, server, record }) }
      } catch (err) {
        res = { ok: false, error: err.message }
      }
      armIdleExit()
      conn.end(JSON.stringify(res))
    })
    conn.on("error", () => {})
  })
  server.listen(SOCKET, () => {
    // Tighten the socket to owner-only; the 0700 dir already blocks other users,
    // this is defense in depth against a lax umask.
    try { fs.chmodSync(SOCKET, 0o600) } catch {}
    fs.writeFileSync(PID, String(process.pid))
    console.log(`[${new Date().toISOString()}] pw daemon ready on ${SOCKET}`)
    armIdleExit()
  })

  // Best-effort cleanup so a kill -TERM doesn't leave a stale socket.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => { await shutdown(browser, server); process.exit(0) })
  }
}

async function dispatch(req, { page, browser, server, record }) {
  switch (req.cmd) {
    case "__ping": return "ok"
    case "stop":
      // Reply first, then tear down so the client gets the ack.
      setTimeout(() => shutdown(browser, server).then(() => process.exit(0)), 50)
      return "stopping"
    case "goto":
      await page.goto(req.url)
      return page.url()
    case "click":
      await page.click(req.selector)
      return null
    case "hover":
      await page.hover(req.selector)
      return null
    case "fill":
      await page.fill(req.selector, req.value)
      return null
    case "textContent":
      return await page.textContent(req.selector)
    case "innerText":
      return await page.innerText(req.selector)
    case "evaluate": {
      // Two modes — chosen by the CLI:
      //   default: `req.script` is a JS expression, wrap with `return (...)`
      //            so `document.title`, `1+1`, etc. all work.
      //   body:    `req.script` is a function body containing its own `return`
      //            and/or multiple statements; run it verbatim. The flag
      //            beats a regex on req.script because the regex would also
      //            match the word "return" inside strings or comments.
      const wrapped = req.body
        ? `(async () => { ${req.script} })()`
        : `(async () => { return (${req.script}) })()`
      const result = await page.evaluate(wrapped)
      return result === undefined ? null : result
    }
    case "waitForSelector":
      await page.waitForSelector(req.selector, req.timeout ? { timeout: req.timeout } : undefined)
      return null
    case "screenshot":
      await page.screenshot({ path: req.path, fullPage: !!req.fullPage })
      return req.path
    case "url":
      return page.url()
    case "title":
      return await page.title()
    case "content":
      return await page.content()
    case "console": {
      const text = formatConsoleRecord(record.lines())
      if (req.clear) record.clear()
      return text
    }
    case "press":
      await page.keyboard.press(req.key)
      return null
    case "selectOption":
      return await page.selectOption(req.selector, req.value)
    default:
      throw new Error(`unknown command: ${req.cmd}`)
  }
}

async function shutdown(browser, server) {
  try { await browser?.close() } catch {}
  try { server?.close() } catch {}
  try { fs.unlinkSync(SOCKET) } catch {}
  try { fs.unlinkSync(PID) } catch {}
}

// ─── help ──────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write(`pw — Playwright control for opencode subagents

  pw start [--headed]              launch a persistent chromium daemon; with
                                   no browser installed it exits 1 at once
  pw stop                          stop the daemon

  pw goto <url>                    page.goto
  pw click <selector>              page.click
  pw fill <selector> <value>       page.fill
  pw textContent [selector]        page.textContent (default: body)
  pw innerText [selector]          page.innerText   (default: body)
  pw evaluate '<expr>'             page.evaluate — JS expression (wrapped in
                                   return); add --body for a multi-statement
                                   function body: \`pw evaluate --body '<js>'\`
  pw waitForSelector <sel> [ms]    page.waitForSelector
  pw screenshot <path> [--fullPage]  page.screenshot
  pw url | pw title | pw content   page.url / .title / .content
  pw console [--clear]             console messages and page errors so far
                                   (last 500 lines); --clear empties the record
  pw press <key>                   page.keyboard.press
  pw hover <selector>              page.hover
  pw selectOption <sel> <value>    page.selectOption

State persists across calls — navigation, cookies, localStorage, DOM.
With PW_SESSION set, each session runs its own daemon. A daemon exits after
PW_IDLE_EXIT_MS (default 900000, 0 = never) without a request.
`)
}
