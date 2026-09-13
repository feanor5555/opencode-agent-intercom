// The panel's half of the `run (min)` row: the line it owes when the run
// ceiling it shows cannot do what the row suggests it does.
//
// The value itself is an ordinary limit in
// ~/.config/opencode/agent-intercom.json — the flat `maxSubagentRunMs` — and
// the row steps it through setSetting/stepSetting (settings-file.ts) like the
// two watchdog rows above it. What makes this row different from those two is
// that its number does not stand on its own: the run ceiling is the outermost
// of three windows, and the two inside it decide whether this one leaves any
// room to act before it fires.
//
// Written in the register of compaction-row.ts: the causes are named constants,
// the verdict is one pure function over the settings, and the note is composed
// with rowNoteLine so every settings-row note sits at the one indent.

import { type Settings } from "./settings-file.ts";
import { ROW_NOTE_INDENT, rowNoteLine } from "./subagent-label.ts";

// The share of the run ceiling at which the plugin warns the subagent that the
// ceiling is coming (RUN_WRAP_UP, src/settings.js). What is left after it is
// the room the subagent has to hand its work back in, which is what the second
// cause below is about.
export const RUN_WRAP_UP = 0.75;

// The run ceiling is at or below the window one tool call may take, so a single
// long call — a build, a test suite — is cut off by the run ceiling rather than
// ever reaching its own window.
export const SHORTER_THAN_IN_TOOL_CAUSE =
  "shorter than the in-tool window — one long call is cut off";

// The run ceiling is armed, but what is left after the wrap-up warning is less
// than one tool call's window, so the subagent may be inside a single call for
// the whole of its handover room and never get to write a reply.
export const NO_HANDOVER_ROOM_CAUSE = "no room left for a handover";

// The inactivity watchdog is off, and the run check lives inside the running
// branch behind it (src/watchdog.js): a user who took out the dead-man's switch
// gets no run ceiling either, whatever this row shows.
export const WATCHDOG_OFF_CAUSE = "the inactivity watchdog is off — no run ceiling either";

// The note line sits under the row at the indent every settings-row note uses.
export const RUN_CEILING_NOTE_INDENT = ROW_NOTE_INDENT;

// What the line under the row says, or "" where the row needs no explaining.
//
// Order: the watchdog being off outranks both, because it makes the whole row
// inert rather than merely tight. A ceiling inside the in-tool window is named
// before the handover case, because it is the sharper statement of the same
// relation — the handover line would only repeat it.
export function runCeilingRowCause(settings: Settings): string {
  if (settings.maxSubagentAgeMs === 0) return WATCHDOG_OFF_CAUSE;
  if (settings.maxSubagentRunMs === 0) return "";
  if (settings.maxSubagentRunMs <= settings.maxSubagentToolCallMs) {
    return SHORTER_THAN_IN_TOOL_CAUSE;
  }
  if (settings.maxSubagentRunMs * (1 - RUN_WRAP_UP) < settings.maxSubagentToolCallMs) {
    return NO_HANDOVER_ROOM_CAUSE;
  }
  return "";
}

// The composed note line, cut to what is left of the panel beside its indent.
// Empty where there is nothing to say, and the row then renders no line at all.
export function runCeilingRowNote(settings: Settings, panelWidth?: number): string {
  return rowNoteLine(runCeilingRowCause(settings), panelWidth);
}
