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
// Whether a given finished subagent is really being held is the plugin's
// decision and no reader of the opencode server can work it out: it is taken on
// the subagent's reply, on the context the run ended at, on capacity, and on
// whether retention is in effect in that plugin process at all. So the panel
// does not infer it. The plugin PUBLISHES it, on the one field of a subagent
// session it owns — the title, which already carries its marker and which every
// poll reads anyway — as `[retained:<epoch ms the window ends>]` after that
// marker. `readRetentionStamp` in ./subagent-label.ts reads it back.
//
// Two consequences, and they are the point:
//
//   - a retention the plugin refused is never painted as held, not even for one
//     poll. No stamp, no held row: the refusal is a decision the panel is told
//     about rather than one it has to observe by the session's disappearance.
//   - the countdown is the plugin's own window, not a second one measured from
//     when the panel happened to see the run end. The two used to be a poll
//     apart; now there is one figure and both halves render it.
//
// A held row still ends when its session does. Every way a retention ends —
// the TTL reap, the capacity eviction, the drop at a handoff or at an endless
// freeze, an abort, a reuse that fails — has the plugin delete the opencode
// session, so a held row lives exactly as long as its session is still listed
// among its primary's children. `reapRetained` is where that is enforced, and
// it is what keeps a row from outliving the session it names.
//
// With `maxRetainedSubagents` at its default of 0 nothing here is reachable:
// the plugin stamps no title, `holdFinishedRow` drops on its first term, no row
// ever carries `retained`, and `reapRetained` has nothing to iterate.

import { readRetentionStamp } from "./subagent-label.ts";

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
  // The epoch ms this row's retention window ends at, exactly as the plugin
  // published it on the session title. Not a moment the panel measured: the
  // plugin stamps its own `retainedAt + retainedSubagentTtlMs`, so the row
  // counts down to the moment the reap works to. Undefined on every other
  // status.
  retainedUntil?: number;
}

// The settings members the retention rules read. The panel reads them from the
// same file the plugin does (~/.config/opencode/agent-intercom.json). The
// retention state itself is NOT read from here — that is the plugin's to
// publish — but the settings rows the panel edits still need the shape.
export interface RetentionSettings {
  maxRetainedSubagents: number;
  retainedSubagentTtlMs: number;
}

// How long a row may stay held past the end of its published window before the
// panel drops it on its own. The plugin reaps a retained entry on the watchdog
// tick that follows its TTL and then deletes the session, so a session still
// listed well after the window it published has run out is one nothing is
// holding any more — a session leaked by a plugin reload, whose window nothing
// will ever end. The grace covers the reap tick plus the teardown it starts;
// the session going missing is the ordinary way a row ends, this is the
// backstop for the row whose session does not go.
export const RETENTION_EXPIRY_GRACE_MS = 60000;

// Whether retention is switched on in the settings file. It says what the
// settings rows say and nothing about any individual subagent: a process that
// was started before the switch was turned on retains nothing whatever this
// returns, which is why no held row is decided on it.
export function retentionEnabled(settings: RetentionSettings): boolean {
  return settings.maxRetainedSubagents > 0;
}

// The row that replaces a finished one, or undefined where the row is to be
// dropped as it always was.
//
// Held only where the plugin published a retention for this very session, on
// its title, and the panel did not abort it. Everything else is dropped: a
// title with no stamp is a subagent the plugin is not holding — over its reuse
// ceiling, a `Blocked:` reply, a nested child, an error ending, or retention
// simply off — and the row goes at once rather than being claimed as held until
// a later poll withdraws it. An abort is never held either: the plugin refuses
// retention for every ending that is not a clean idle, and the session is being
// deleted.
//
// Idempotent on a row that is already held, and on a re-adopted one: the window
// comes from the stamp on every call, so a poll that revisits a held row reads
// the same figure rather than restarting a window of its own.
export function holdFinishedRow(
  entry: SubagentEntry | undefined,
  opts: { aborted: boolean; title: string | undefined },
  now: number = Date.now(),
): SubagentEntry | undefined {
  if (!entry) return undefined;
  if (opts.aborted) return undefined;
  const retainedUntil = readRetentionStamp(opts.title);
  if (retainedUntil === undefined) return undefined;
  return { ...entry, status: "retained", retainedUntil };
}

// Whether a row is being held.
export function isRetained(entry: SubagentEntry | undefined): boolean {
  return entry?.status === "retained";
}

// Milliseconds left of a held row's published window, never below zero.
export function retainedMsLeft(
  entry: SubagentEntry,
  now: number = Date.now(),
): number {
  return Math.max(0, (entry.retainedUntil ?? 0) - now);
}

// Whole minutes left of a held row's window. Mirrors retainedMinutesLeft in
// src/format.js, which is what the orchestrator is shown in `list` and in the
// per-turn snapshot, so the three surfaces name the same figure — and now from
// the same published moment rather than from two clocks a poll apart.
export function retainedMinutesLeft(
  entry: SubagentEntry,
  now: number = Date.now(),
): number {
  return Math.floor(retainedMsLeft(entry, now) / 60000);
}

// The metadata a held row carries on its second line, after the age and the
// context size: the state it is in and how much of its window is left.
export function retainedRowNote(
  entry: SubagentEntry,
  now: number = Date.now(),
): string {
  return `retained · ${retainedMinutesLeft(entry, now)}m left`;
}

// Whether a held row has been past the end of its published window for longer
// than the grace, i.e. longer than the plugin could plausibly still be holding
// it.
export function retentionExpired(
  entry: SubagentEntry,
  now: number = Date.now(),
  graceMs: number = RETENTION_EXPIRY_GRACE_MS,
): boolean {
  if (!isRetained(entry)) return false;
  return (entry.retainedUntil ?? 0) + graceMs < now;
}

// The held rows a completed poll has disproved, as their session ids.
//
// `seen` is every child the poll actually listed, across every primary it
// asked; it is only meaningful when the whole poll went through, so this is
// called on a completed pass and never on a partial one. A held row whose
// session is no longer among those children is a retention that has ended,
// whichever way it ended, and the row goes. A held row whose session is still
// there but whose published window ran out long ago is the second case:
// something is still holding the session open that is not this retention.
//
// Rows that are not held are left alone: they are the panel's live work, and
// the poll that lists them is the same one that keeps them up to date.
export function reapRetained(
  rows: Iterable<SubagentEntry>,
  opts: { seen: ReadonlySet<string> },
  now: number = Date.now(),
): string[] {
  const gone: string[] = [];
  for (const entry of rows) {
    if (!isRetained(entry)) continue;
    if (!opts.seen.has(entry.sessionID)) {
      gone.push(entry.sessionID);
      continue;
    }
    if (retentionExpired(entry, now)) gone.push(entry.sessionID);
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
