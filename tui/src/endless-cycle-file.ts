// The panel's half of a running endless cycle: which step the cycle is in, so
// the `endless mode` row can read `[restarting]` with that step beneath it for
// the whole wait, instead of `[on]`.
//
// The plugin publishes it (src/endlesscycle.js) to
// ~/.cache/opencode-agent-intercom/endless-cycles.json, one entry per primary
// whose cycle is pending or executing, taken off when the successor has taken
// over, the cycle abandoned or the mode paused itself. The latches in the
// plugin's process stay the authority; this file is an indicator. Every entry
// carries the pid of the process that set it, and an entry whose writer is
// gone is dropped on read — the cycle died with that process.
//
// Nothing here throws into the TUI: an absent, unreadable or malformed file
// reads as "no cycle running".

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pauseWriterAlive } from "./endless-pause-file.ts";

// The steps as the plugin publishes them, in the order a cycle passes them.
export type EndlessCycleStep = "turn" | "quiesce" | "wind-down" | "successor";

const STEPS: readonly EndlessCycleStep[] = [
  "turn",
  "quiesce",
  "wind-down",
  "successor",
];

// One published cycle, as the panel uses it.
export interface EndlessCycle {
  step: EndlessCycleStep;
  // The primary's own subagents still running; published for `quiesce` only.
  running?: number;
  // Epoch ms the step was entered.
  at: number;
  // The plugin process whose latch this mirrors.
  pid: number;
}

let cyclePath = join(
  homedir(),
  ".cache",
  "opencode-agent-intercom",
  "endless-cycles.json",
);

// Test seam: point the read at another file.
export function setEndlessCyclePath(p: string): void {
  cyclePath = p;
}

export function endlessCycleFilePath(): string {
  return cyclePath;
}

// The cycles in a parsed file body, keyed by session id: every entry with a
// live writer, a known step and a pid. Pure, so the drop rules can be asserted
// without a filesystem or a process table.
export function parseEndlessCycles(
  raw: unknown,
  isAlive: (pid: number) => boolean = pauseWriterAlive,
): Map<string, EndlessCycle> {
  const out = new Map<string, EndlessCycle>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sessionID, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as {
      step?: unknown;
      running?: unknown;
      at?: unknown;
      pid?: unknown;
    };
    const pid = entry.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (!STEPS.includes(entry.step as EndlessCycleStep)) continue;
    if (!isAlive(pid)) continue;
    const cycle: EndlessCycle = {
      step: entry.step as EndlessCycleStep,
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
      pid,
    };
    if (
      typeof entry.running === "number" &&
      Number.isInteger(entry.running) &&
      entry.running >= 0
    ) {
      cycle.running = entry.running;
    }
    out.set(sessionID, cycle);
  }
  return out;
}

// The published cycles on disk; an empty map for everything that is not a
// readable object.
export function readEndlessCycles(
  isAlive: (pid: number) => boolean = pauseWriterAlive,
): Map<string, EndlessCycle> {
  let text: string;
  try {
    text = readFileSync(cyclePath, "utf8");
  } catch {
    return new Map();
  }
  try {
    return parseEndlessCycles(JSON.parse(text), isAlive);
  } catch {
    return new Map();
  }
}

// The cycle that belongs to this panel, out of the sessions it could be about,
// most specific first — the same lookup the pause uses.
export function cycleForSession(
  cycles: ReadonlyMap<string, EndlessCycle>,
  sessionIDs: readonly (string | undefined)[],
): EndlessCycle | undefined {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue;
    const cycle = cycles.get(sessionID);
    if (cycle) return cycle;
  }
  return undefined;
}
