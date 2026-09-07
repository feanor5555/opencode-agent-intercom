// The panel's half of the endless self-stop pause: what the `endless mode` row
// shows when the loop has stopped itself, and where that state comes from.
//
// The row is the switch, and the switch is a setting in
// ~/.config/opencode/agent-intercom.json. A pause is not: endless mode stops
// itself — no open points left, the cycle ceiling, no progress over two cycles
// — for ONE primary session, writing nothing, and the state lives in the main
// plugin's process (registry.pauseEndless, src/registry.js). A panel that reads
// the settings file alone therefore paints `[on]` on a session whose loop has
// stopped, which is the state of the switch and not the state of the loop.
//
// So the plugin publishes it and this module reads it back:
// ~/.cache/opencode-agent-intercom/endless-pauses.json, one entry per paused
// session (src/endlesspause.js). Every entry carries the pid of the process
// that set it, because the pause is process-local — it dies with the plugin
// process, while the opencode session outlives it and can be resumed by an
// instance that has no pause for it. An entry whose writer is gone is not a
// pause and is dropped on read.
//
// Nothing here throws into the TUI: an absent, unreadable or malformed file
// reads as "nothing paused", which is the state the panel showed before this
// existed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FALLBACK_PANEL_W, truncate } from "./subagent-label.ts";

// One published pause, as the panel uses it.
export interface EndlessPause {
  // The sentence the stop logged and toasted, e.g. "no open points left —
  // paused for this session". Empty where the plugin published none.
  reason: string;
  // Epoch ms the mode paused itself.
  at: number;
  // The plugin process that set it.
  pid: number;
}

// What the `endless mode` row is in. `paused` is not a third setting: the
// switch is still on, and switching it off and on again is what clears the
// pause.
export type EndlessRowState = "on" | "off" | "paused";

let pausePath = join(
  homedir(),
  ".cache",
  "opencode-agent-intercom",
  "endless-pauses.json",
);

// Test seam: point the read at another file.
export function setEndlessPausePath(p: string): void {
  pausePath = p;
}

export function endlessPauseFilePath(): string {
  return pausePath;
}

// Whether the process that published an entry is still running. `kill(pid, 0)`
// sends no signal and only asks whether the id can be signalled: EPERM is a
// live process owned by somebody else, ESRCH is one that is gone.
export function pauseWriterAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// The pauses in a parsed file body, keyed by session id: every entry that has a
// live writer and is shaped like one. Pure, so the drop rules can be asserted
// without a filesystem or a process table.
export function parseEndlessPauses(
  raw: unknown,
  isAlive: (pid: number) => boolean = pauseWriterAlive,
): Map<string, EndlessPause> {
  const out = new Map<string, EndlessPause>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sessionID, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { reason?: unknown; at?: unknown; pid?: unknown };
    const pid = entry.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
    if (!isAlive(pid)) continue;
    out.set(sessionID, {
      reason: typeof entry.reason === "string" ? entry.reason : "",
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
      pid,
    });
  }
  return out;
}

// The published pauses on disk. An empty map for everything that is not a
// readable object — the row then shows the switch, as it did before.
export function readEndlessPauses(
  isAlive: (pid: number) => boolean = pauseWriterAlive,
): Map<string, EndlessPause> {
  let text: string;
  try {
    text = readFileSync(pausePath, "utf8");
  } catch {
    return new Map();
  }
  try {
    return parseEndlessPauses(JSON.parse(text), isAlive);
  } catch {
    return new Map();
  }
}

// The pause that belongs to this panel, out of the sessions it could be about,
// most specific first. The orchestrator chat the panel belongs to is the usual
// one; the route session is asked too, because the no-progress stop pauses the
// session the cycle just created (endless.js: the new primary), which the panel
// is looking at before it has taken it for its orchestrator.
export function pauseForSession(
  pauses: ReadonlyMap<string, EndlessPause>,
  sessionIDs: readonly (string | undefined)[],
): EndlessPause | undefined {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue;
    const pause = pauses.get(sessionID);
    if (pause) return pause;
  }
  return undefined;
}

// What the row shows. A pause only reads as one while the switch is on: the
// user's switch-off is the younger statement, and it is also what makes the
// plugin clear the pause on the primary's next turn.
export function endlessRowState(
  endlessMode: boolean,
  pause: EndlessPause | undefined,
): EndlessRowState {
  if (!endlessMode) return "off";
  return pause ? "paused" : "on";
}

// The cell text of the row, one width per state so the label column keeps its
// place.
export function endlessRowCell(state: EndlessRowState): string {
  if (state === "paused") return "[paused]";
  return state === "on" ? "[on] " : "[off]";
}

// The cause a stop published, without the "— paused for this session" half that
// every one of them repeats and the row already says. Empty for an empty
// reason, which is a pause published without one.
export function pauseCause(reason: string): string {
  const head = reason.split(" — ")[0] ?? "";
  return head.trim();
}

// The second row under a paused switch: the cause, cut to what is left of the
// panel beside its indent. Empty where there is nothing to name, and the row is
// then not rendered at all.
export const PAUSE_NOTE_INDENT = "    ";

export function pauseRowNote(reason: string, panelWidth?: number): string {
  const cause = pauseCause(reason);
  if (cause === "") return "";
  const panel =
    typeof panelWidth === "number" && panelWidth > 0
      ? panelWidth
      : FALLBACK_PANEL_W;
  const budget = panel - PAUSE_NOTE_INDENT.length - 2;
  return budget <= 0 ? "" : PAUSE_NOTE_INDENT + truncate(cause, budget);
}
