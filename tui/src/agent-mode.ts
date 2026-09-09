// The panel's half of the `mode` row: which pattern the plugin runs the primary
// agent in, and the two-step question the row asks before it changes that.
//
// The setting is `agentMode` in ~/.config/opencode/agent-intercom.json, one of
// two values: `orchestrator`, the delegation pattern the plugin enforces, and
// `solo`, in which the primary works by itself. The disk half lives beside the
// other settings of that file (settings-file.ts, readAgentMode/toggleAgentMode);
// this module holds the concept — the values, the arming, and the text the row
// and its note line show.
//
// The switch is deliberately NOT a single click. The plugin latches this key at
// load, so the value the panel writes reaches nothing until opencode is
// restarted: a click that silently disagrees with the running instance is worse
// than no row at all. So the first click arms the row, the note line under it
// names the restart and asks for the confirmation, and only a second click
// writes. This is the same arm-and-confirm the abort question uses
// (abort-arming.ts) — that one is keyed by the session it would kill and cannot
// be shared, but the shape, the timeout and the decide-once entry point are
// alike on purpose.
//
// The arming is short-lived: it falls away by itself once
// AGENT_MODE_CONFIRM_MS have passed, and the panel takes it back on Escape and
// on the next interaction elsewhere in the sidebar, so a click can never
// confirm a question the user has already left behind.

import { rowNoteLine } from "./subagent-label.ts";

// What the plugin runs the primary agent as. `orchestrator` is the default and
// the pattern this plugin exists for; `solo` is the primary working by itself,
// with no delegation enforced.
export type AgentMode = "orchestrator" | "solo";

// Both values, in the order the row steps through them.
export const AGENT_MODES = ["orchestrator", "solo"] as const;

// The value in effect where the file names none, or names one the plugin would
// not accept.
export const DEFAULT_AGENT_MODE: AgentMode = "orchestrator";

// What the file must hold for the value to be used: exactly one of the two
// strings. Anything else — a number, a boolean, "Solo", an empty string —
// leaves the default standing, the way a bad number does on a limit.
export function isAgentMode(v: unknown): v is AgentMode {
  return v === "orchestrator" || v === "solo";
}

// The value a switch takes the current one to. Two values, so the switch is a
// flip rather than a cycle.
export function otherAgentMode(mode: AgentMode): AgentMode {
  return mode === "orchestrator" ? "solo" : "orchestrator";
}

// How long an armed row stays armed. The same window the abort question uses:
// long enough to read the note and click again, short enough that the row does
// not sit in the confirm state while the user has gone on to something else.
export const AGENT_MODE_CONFIRM_MS = 4000;

// The row's pending question: it is asked once and answered by the next click.
export interface ArmedAgentMode {
  readonly armedAt: number;
}

// What a click on the row amounts to: arming it, or carrying out the switch the
// user has now confirmed. The confirmed switch names no value: what is written
// is the flip of what the FILE holds at that moment, the read-modify-write
// every setting of this panel goes through, so a hand edit between the two
// clicks is flipped from rather than overwritten.
export type AgentModeDecision =
  | { readonly kind: "arm"; readonly armed: ArmedAgentMode }
  | { readonly kind: "switch" };

// Whether the row is armed and its arming still live. An arming stamped in the
// future counts as live: a clock that jumped must not turn a fresh arming into
// an expired one.
export function isAgentModeArmed(
  armed: ArmedAgentMode | undefined,
  nowMs: number,
  timeoutMs: number = AGENT_MODE_CONFIRM_MS,
): boolean {
  if (!armed) return false;
  return nowMs - armed.armedAt < timeoutMs;
}

// The single decision point the row's click goes through: a click on a row that
// is armed and still live switches, every other click arms.
export function decideAgentModeSwitch(
  armed: ArmedAgentMode | undefined,
  nowMs: number,
  timeoutMs: number = AGENT_MODE_CONFIRM_MS,
): AgentModeDecision {
  if (isAgentModeArmed(armed, nowMs, timeoutMs)) return { kind: "switch" };
  return { kind: "arm", armed: { armedAt: nowMs } };
}

// The arming that survives the passage of time.
export function armingAfterAgentModeTimeout(
  armed: ArmedAgentMode | undefined,
  nowMs: number,
  timeoutMs: number = AGENT_MODE_CONFIRM_MS,
): ArmedAgentMode | undefined {
  if (!armed) return undefined;
  return nowMs - armed.armedAt < timeoutMs ? armed : undefined;
}

// The width of the row's cell, the longer of the two values plus its brackets,
// so the cell keeps its place while the row is armed and while it is not.
export const AGENT_MODE_CELL_W = "[orchestrator]".length;

// What the row shows. Unarmed it is the value in effect; armed it is the value
// the pending click would write, with the question mark that says the click has
// not happened yet — the confirm state is on the row itself, not only in the
// note under it.
export function agentModeRowCell(
  mode: AgentMode,
  armed: boolean = false,
): string {
  const cell = armed ? `[${otherAgentMode(mode)}?]` : `[${mode}]`;
  return cell.padEnd(AGENT_MODE_CELL_W);
}

// The note under an armed row, in the order the user needs it: why the click
// did not just do it, then what to do about it. Two short lines rather than one
// long one, because the panel is narrow enough to cut a sentence in half.
export const AGENT_MODE_NOTE_LINES = [
  "needs an opencode restart",
  "click again to confirm",
] as const;

// Those lines composed for a panel `panelWidth` columns wide, each cut to what
// is left beside its indent — the same note line the endless pause's cause is
// rendered as. A line with no room left is empty and is not rendered.
export function agentModeNoteLines(panelWidth?: number): string[] {
  return AGENT_MODE_NOTE_LINES.map((line) => rowNoteLine(line, panelWidth)).filter(
    (line) => line !== "",
  );
}
