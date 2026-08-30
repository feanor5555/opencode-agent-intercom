// The state behind the sidebar's subagent rows: the shape of a row, the status
// it carries, and the rules that decide when a finished row is held and when it
// goes.
//
// The panel's model has always been "idle means gone": a subagent that stops
// running is dropped from the list and never re-added, because the plugin
// deletes its opencode session the moment the run ends. Retention breaks
// exactly that premise. A retained subagent is idle, its session is alive, and
// the orchestrator can put a follow-up to it with reuse() until its window runs
// out — so its row stays, marked `retained`, the same word the plugin's `list`
// tool and its per-turn snapshot block use for the same state.
//
// The panel shares no state with the plugin's registry. Both halves read the
// same settings file, and everything else the panel knows about a subagent it
// reads off the opencode server. A held row is therefore never kept on the
// strength of an event that did not arrive: the authority is the session
// itself. Every way a retention ends — the TTL reap, the capacity eviction, the
// drop at a handoff or at an endless freeze, an abort, a reuse that fails — has
// the plugin delete the opencode session, so a held row lives exactly as long
// as its session is still listed among its primary's children. `reapRetained`
// is where that is enforced, and it is what keeps a row from outliving the
// session it names.
//
// Two things this file is deliberately careful about:
//
//   - Whether a given finished subagent is really being held is the plugin's
//     decision, taken on the reply and on the context the run ended at, and the
//     panel cannot see it. So a row is held optimistically the moment retention
//     is switched on in the settings file and a run of that row ends, and the
//     next poll settles it: a subagent the plugin did not retain has had its
//     session deleted and its row goes with the session. The held state is a
//     claim the poll either confirms or withdraws, never a state the panel
//     invents and keeps.
//   - The retention window is measured from when the panel saw the run end,
//     while the plugin measures it from its own idle critical section. The two
//     are a poll apart at most, which is why the countdown is rendered in whole
//     minutes — the same granularity `retainedMinutesLeft` in src/format.js
//     renders it at for the orchestrator.
//
// With `maxRetainedSubagents` at its default of 0 nothing here is reachable:
// `holdFinishedRow` drops on its first term, no row ever carries `retained`,
// and `reapRetained` has nothing to iterate.

// The status of one row. `retained` is the one status that does not mirror an
// opencode session status: a retained session's opencode status is `idle`, and
// stays `idle` for as long as it is held.
export type SubagentStatus =
  | "busy"
  | "idle"
  | "retry"
  | "aborted"
  | "error"
  | "retained";

export interface SubagentEntry {
  sessionID: string;
  parentID: string;
  agent: string;
  handle: string;
  title: string;
  status: SubagentStatus;
  // True once the subagent has been observed running. A subagent that has run
  // and is no longer running is finished: it is dropped from the panel, or held
  // as `retained` where retention is switched on.
  wasBusy: boolean;
  createdAt: number;
  updatedAt: number;
  ctxTokens?: number;
  lastTokenFetch: number;
  // When the panel saw this row's run end and began holding it. Set on the
  // transition into `retained` and kept across polls, so the countdown is
  // measured from one moment rather than from the last time the row was looked
  // at. Undefined on every other status.
  retainedAt?: number;
}

// The settings members the retention rules read. The panel reads them from the
// same file the plugin does (~/.config/opencode/agent-intercom.json).
export interface RetentionSettings {
  maxRetainedSubagents: number;
  retainedSubagentTtlMs: number;
}

// How long a row may stay held past the end of its own window before the panel
// drops it on its own. The plugin reaps a retained entry on the watchdog tick
// that follows its TTL and then deletes the session, so a session still listed
// well after the window has run out is one nothing is holding any more — a
// session leaked by a reload, or one this panel began holding while the plugin
// never retained it at all. The grace covers the reap tick plus the teardown it
// starts; the session going missing is the ordinary way a row ends, this is the
// backstop for the row whose session does not go.
export const RETENTION_EXPIRY_GRACE_MS = 60000;

// Whether the panel may hold a finished subagent at all. `maxRetainedSubagents`
// is the same switch the plugin reads: 0 — the default — means no subagent is
// ever kept, and the panel then behaves exactly as it did before retention
// existed.
export function retentionEnabled(settings: RetentionSettings): boolean {
  return settings.maxRetainedSubagents > 0;
}

// The row that replaces a finished one, or undefined where the row is to be
// dropped as it always was.
//
// Held only where retention is switched on and the run ended on its own. An
// abort is never held: the plugin refuses retention for every ending that is
// not a clean idle, and the session is being deleted. A row the panel never saw
// is not held either — nothing is known about what it did.
//
// Idempotent on a row that is already held: the status and the original
// `retainedAt` are kept, so a poll that revisits a held row does not restart its
// window.
export function holdFinishedRow(
  entry: SubagentEntry | undefined,
  opts: { aborted: boolean; settings: RetentionSettings },
  now: number = Date.now(),
): SubagentEntry | undefined {
  if (!entry) return undefined;
  if (opts.aborted) return undefined;
  if (!retentionEnabled(opts.settings)) return undefined;
  return {
    ...entry,
    status: "retained",
    retainedAt: entry.retainedAt ?? now,
  };
}

// Whether a row is being held.
export function isRetained(entry: SubagentEntry | undefined): boolean {
  return entry?.status === "retained";
}

// Milliseconds left of a held row's window, never below zero.
export function retainedMsLeft(
  entry: SubagentEntry,
  ttlMs: number,
  now: number = Date.now(),
): number {
  return Math.max(0, (entry.retainedAt ?? 0) + ttlMs - now);
}

// Whole minutes left of a held row's window. Mirrors retainedMinutesLeft in
// src/format.js, which is what the orchestrator is shown in `list` and in the
// per-turn snapshot, so the three surfaces name the same figure.
export function retainedMinutesLeft(
  entry: SubagentEntry,
  ttlMs: number,
  now: number = Date.now(),
): number {
  return Math.floor(retainedMsLeft(entry, ttlMs, now) / 60000);
}

// The metadata a held row carries on its second line, after the age and the
// context size: the state it is in and how much of its window is left.
export function retainedRowNote(
  entry: SubagentEntry,
  ttlMs: number,
  now: number = Date.now(),
): string {
  return `retained · ${retainedMinutesLeft(entry, ttlMs, now)}m left`;
}

// Whether a held row has been past the end of its window for longer than the
// grace, i.e. longer than the plugin could plausibly still be holding it.
export function retentionExpired(
  entry: SubagentEntry,
  ttlMs: number,
  now: number = Date.now(),
  graceMs: number = RETENTION_EXPIRY_GRACE_MS,
): boolean {
  if (!isRetained(entry)) return false;
  return (entry.retainedAt ?? 0) + ttlMs + graceMs < now;
}

// The held rows a completed poll has disproved, as their session ids.
//
// `seen` is every child the poll actually listed, across every primary it
// asked; it is only meaningful when the whole poll went through, so this is
// called on a completed pass and never on a partial one. A held row whose
// session is no longer among those children is a retention that has ended,
// whichever way it ended, and the row goes. A held row whose session is still
// there but whose window ran out long ago is the second case: something is
// still holding the session open that is not this retention.
//
// Rows that are not held are left alone: they are the panel's live work, and
// the poll that lists them is the same one that keeps them up to date.
export function reapRetained(
  rows: Iterable<SubagentEntry>,
  opts: { seen: ReadonlySet<string>; settings: RetentionSettings },
  now: number = Date.now(),
): string[] {
  const gone: string[] = [];
  for (const entry of rows) {
    if (!isRetained(entry)) continue;
    if (!opts.seen.has(entry.sessionID)) {
      gone.push(entry.sessionID);
      continue;
    }
    if (retentionExpired(entry, opts.settings.retainedSubagentTtlMs, now)) {
      gone.push(entry.sessionID);
    }
  }
  return gone;
}

// The dot in front of a row. A held row is neither running nor gone, so it
// carries neither the pulsing dot of a run nor the tick of a finished one.
export function statusMarker(status: SubagentStatus): string {
  switch (status) {
    case "busy":
      return "●";
    case "retry":
      return "◐";
    case "retained":
      return "◆";
    case "aborted":
      return "✕";
    case "error":
      return "✕";
    default:
      return "✓";
  }
}

// Where a row sorts: running work first, then what is still settling, then the
// held rows, which are finished and are the only rows that stay. Rows of equal
// rank keep their spawn order.
export function statusRank(status: SubagentStatus): number {
  if (status === "busy" || status === "retry") return 0;
  return status === "retained" ? 2 : 1;
}
