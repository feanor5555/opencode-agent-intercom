// The panel's half of the `compaction` row: what the row shows for the agent
// the LLM section's cycler has selected, and when it owes a line saying that
// the value cannot take effect.
//
// The switch itself is an ordinary setting in
// ~/.config/opencode/agent-intercom.json — the `agentCompaction` map over the
// flat `compaction` key — and the row writes it through toggleAgentCompaction
// (settings-file.ts). What makes this row different from the other booleans is
// that its value alone does not say whether anything will happen: a compaction
// is driven by the plugin at a CONTEXT THRESHOLD, and an agent may have none
// armed, or have it owned by endless mode.
//
// The row is LIVE and needs no restart note, unlike `mode`. The global
// `compaction.auto: false` the plugin writes into opencode's config is
// unconditional and reads no setting (applyCompactionPolicy, src/compaction.js),
// so nothing this row writes has to reach opencode's bootstrap snapshot; the
// driver re-reads the settings file at every crossing. A later change that made
// the global write depend on this value would turn the row into a lie that only
// an opencode restart could resolve.
//
// Which threshold is the armed one is resolved here exactly as the plugin
// resolves it:
//
//   the primary role   — endlessContext while endless mode is in effect,
//                        otherwise maxPrimaryContext (primaryContextThreshold,
//                        src/settings.js).
//   a subagent role    — that type's own context budget (contextBudgetFor,
//                        src/settings.js; effectiveAgentContext here).
//
// `0` on either arms nothing, which is what the first and third note lines are
// about.

import { SPAWNABLE_ROLES } from "./agent-roles.ts";
import {
  type Settings,
  effectiveAgentContext,
  effectiveCompaction,
} from "./settings-file.ts";
import { ROW_NOTE_INDENT, rowNoteLine } from "./subagent-label.ts";

// Compaction is on for this agent, but no threshold is armed for it, so the
// driver is never reached: the primary with maxPrimaryContext at 0 (or endless
// mode in effect on an endlessContext of 0), a subagent role whose budget is 0.
export const NO_THRESHOLD_CAUSE = "no threshold armed — compaction never fires";

// Compaction is on for the primary, but endless mode is in effect and wins:
// its threshold displaces maxPrimaryContext and its cycle replaces the session
// rather than shrinking it, so the crossing buys a cycle and not a compaction
// (the three-way relief resolution, src/hooks.js).
export const ENDLESS_OWNS_CAUSE = "endless mode owns the primary threshold";

// Compaction is off for the primary and nothing else is armed either — no
// handoff threshold, no endless cycle. opencode's own automatic compaction is
// switched off for the whole process, so this session runs into the provider's
// context limit and ends in a ContextOverflowError. Not guarded anywhere: the 0
// is the user's own, and the row says what it costs.
export const NO_RELIEF_CAUSE = "no context relief armed — the session will overflow";

// The note line sits under the row at the indent every settings-row note uses.
export const COMPACTION_NOTE_INDENT = ROW_NOTE_INDENT;

// Everything the row draws itself from, resolved in one place so the cell, the
// ★ and the note can never disagree.
export interface CompactionRowState {
  // The switch in effect for this agent.
  on: boolean;
  // Whether that value is the agent's own entry or the inherited flat one —
  // the ★ the neighbouring per-agent rows carry.
  source: "agent" | "inherited";
  // Whether this agent is the primary role rather than a subagent role.
  primary: boolean;
  // The context threshold in effect for this agent, in whole tokens. 0 means
  // nothing is armed.
  threshold: number;
  // Whether endless mode is in effect for the session the panel belongs to.
  // Only ever true for the primary's own relief.
  endlessInEffect: boolean;
}

// Whether an agent name is the primary role. Derived from the spawn gate's own
// closed set rather than from a hard-coded name, so a role added to
// SPAWNABLE_ROLES is a subagent here without a second edit.
export function isPrimaryRole(agent: string): boolean {
  return !SPAWNABLE_ROLES.includes(agent);
}

// The row's state for one agent. `endlessInEffect` is the `endless mode` row's
// own verdict — on, not paused, not solo — because that is precisely when the
// cycle owns the primary threshold.
export function compactionRowState(
  settings: Settings,
  agent: string,
  endlessInEffect: boolean,
): CompactionRowState {
  const { value, source } = effectiveCompaction(settings, agent);
  const primary = isPrimaryRole(agent);
  const threshold = primary
    ? endlessInEffect
      ? settings.endlessContext
      : settings.maxPrimaryContext
    : effectiveAgentContext(settings, agent).value;
  return { on: value, source, primary, threshold, endlessInEffect };
}

// The cell text, one width per state so the label column keeps its place — the
// shape the `show agentcom` row uses.
export function compactionRowCell(state: CompactionRowState): string {
  return state.on ? "[on] " : "[off]";
}

// What the line under the row says, or "" where the row needs no explaining.
//
// Order: an `on` that nothing can fire is named before the one endless mode
// merely outranks, because a threshold of 0 under an endless cycle means no
// relief at all and not a cycle taking the crossing. With the switch off only
// the primary's overflow case is worth a line: a subagent that has neither a
// budget nor a compaction is bounded by its own run, not by this panel.
export function compactionRowCause(state: CompactionRowState): string {
  if (state.on) {
    if (state.threshold === 0) return NO_THRESHOLD_CAUSE;
    if (state.primary && state.endlessInEffect) return ENDLESS_OWNS_CAUSE;
    return "";
  }
  return state.primary && state.threshold === 0 ? NO_RELIEF_CAUSE : "";
}

// The composed note line, cut to what is left of the panel beside its indent.
// Empty where there is nothing to say, and the row then renders no line at all.
export function compactionRowNote(
  state: CompactionRowState,
  panelWidth?: number,
): string {
  return rowNoteLine(compactionRowCause(state), panelWidth);
}
