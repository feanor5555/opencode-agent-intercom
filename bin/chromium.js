// Shared chromium-presence + install helper for `pw` (bin/pw.js) and the
// installer (bin/install.js). The "check for the bundled binary, download it
// with `npx playwright install chromium` if missing" sequence lives here once.
//
// Placed in bin/ (no imports from src/, no imports back into pw.js/install.js)
// so both callers can pull it in without a circular dependency.

import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// This bin directory. Used as the default `cwd` for `npx playwright install`
// so the plugin's own `playwright-core` is resolved (matters when the caller's
// process.cwd() is somewhere else entirely).
const HERE = fileURLToPath(new URL(".", import.meta.url))

// Import playwright-core; throws a descriptive error if it is not installed.
export async function loadChromium() {
  try {
    const { chromium } = await import("playwright-core")
    return chromium
  } catch (err) {
    throw new Error(`playwright-core is not installed — ${err.message}`)
  }
}

// Resolve chromium's bundled executable path, "" if it can't be resolved.
export function chromiumExecutable(chromium) {
  try {
    return chromium.executablePath() || ""
  } catch {
    return ""
  }
}

// Load playwright-core and report whether the chromium binary is on disk.
export async function chromiumInstalled() {
  const chromium = await loadChromium()
  const exe = chromiumExecutable(chromium)
  return { chromium, exe, installed: Boolean(exe && fs.existsSync(exe)) }
}

// Foreground download of the chromium browser binary via playwright's installer.
// `cwd` defaults to this bin dir so `npx playwright` finds the plugin's
// playwright-core. Resolves on success, rejects on non-zero exit / spawn error.
export function installChromiumBrowser({ cwd = HERE } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["-y", "playwright@latest", "install", "chromium"], { cwd, stdio: "inherit" })
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`playwright install exited ${code}`)))) // prettier-ignore
    p.on("error", reject)
  })
}

// Ensure chromium is present, downloading it (foreground) if not. Throws if
// playwright-core is missing or the download fails. `onDownload` is invoked
// once just before a download starts (for progress logging). Returns
// { downloaded } so callers can log the already-present case themselves.
export async function ensureChromium({ cwd = HERE, onDownload } = {}) {
  const { installed } = await chromiumInstalled()
  if (installed) return { downloaded: false }
  if (onDownload) onDownload()
  await installChromiumBrowser({ cwd })
  return { downloaded: true }
}
