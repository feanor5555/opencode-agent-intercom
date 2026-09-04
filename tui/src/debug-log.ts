// Debug logging for the sidebar panel, written into the same file the plugin
// half writes and in the same shape (src/log.js): one line per event,
// `<ISO timestamp> <message> <JSON of every non-string argument>`, appended to
// ~/.cache/opencode-agent-intercom/debug.log. A reader therefore sees the
// panel's lines interleaved with the plugin's own by time, which is what makes
// a route or a row observable against the spawn and teardown lines around it.
//
// On by default, off with OPENCODE_AGENT_INTERCOM_DEBUG=0 — the plugin's rule.
// The env var is read per call rather than at load, because the TUI process
// outlives any single read and a test drives the switch directly.
//
// Nothing here may throw into the TUI's event loop: a log that fails is a log
// that did not happen, never a panel that crashed.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// User-private cache dir, not /tmp: a world-traversable directory with a fixed
// name lets any local user pre-create or symlink the target, and appendFileSync
// follows symlinks.
export function debugLogDir(): string {
  return join(homedir(), ".cache", "opencode-agent-intercom");
}

export function debugLogPath(): string {
  return join(debugLogDir(), "debug.log");
}

// The exact line a call writes, terminator included. Split out so the format
// can be asserted without touching the filesystem.
export function debugLogLine(
  args: readonly unknown[],
  now: Date = new Date(),
): string {
  const parts = args.map((arg) =>
    typeof arg === "string" ? arg : JSON.stringify(arg),
  );
  return `${now.toISOString()} ${parts.join(" ")}\n`;
}

export function debugLog(...args: unknown[]): void {
  if (process.env.OPENCODE_AGENT_INTERCOM_DEBUG === "0") return;
  try {
    mkdirSync(debugLogDir(), { recursive: true, mode: 0o700 });
    appendFileSync(debugLogPath(), debugLogLine(args));
  } catch {
    // logging must never break the TUI
  }
}
