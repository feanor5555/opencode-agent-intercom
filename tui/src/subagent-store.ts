// The state behind the sidebar's subagent rows: the shape of a row, the status
// it carries, when a row exists at all, and when it goes.
//
// A row lives while its session is listed among its parent's children and
// carries no retention stamp. That is the whole existence rule, and it is a
// statement the plugin makes rather than one the panel observes: every ending
// the plugin controls runs through `teardownSubagent` (src/teardown.js), which
// deletes the opencode session, so "still listed" IS "the plugin has not
// finished with it". A session that is listed and unstamped is work in flight,
// whatever `GET /session/status` says about it.
//
// The opencode session status is therefore a display detail and nothing more.
// It cannot carry a row's lifetime: opencode spells `idle` as ABSENCE from
// `GET /session/status`, and a subagent is not `busy` between its session
// being created and its run being forked, nor while it is blocked inside a
// nested spawn of its own, nor while a retained session is being re-prompted.
// A row that vanished on any of those would be a subagent that is working with
// nothing on screen to say so.
//
// Retention breaks the existence rule in the one direction the plugin owns: a
// retained subagent is finished, its session is deliberately kept alive, and
// the orchestrator can put a follow-up to it with reuse() until its window runs
// out. Whether a given subagent is really being held is the plugin's decision
// and no reader of the opencode server can work it out: it is taken on the
// subagent's reply, on the context the run ended at, on capacity, and on
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
// among its parent's children. `reapRows` is where that is enforced, for held
// and unheld rows alike, and it is what keeps a row from outliving the session
// it names.
//
// With `maxRetainedSubagents` at its default of 0 nothing about retention is
// reachable: the plugin stamps no title, `decideRow` never returns a hold, no
// row ever carries `retained`, and `reapRows` reaps on the session's absence
// alone.

import { readRetentionStamp } from "./subagent-label.ts";

// The status of one row. It says what the row SHOWS, never whether the row
// exists — that is decided by the session still being listed.
//
// `waiting` is a subagent that is listed and unstamped while opencode reports
// no run in its session: its run has not been forked yet, or it is blocked
// inside a nested spawn of its own. It is working, and it is not `idle` in any
// sense the panel may paint as finished. `retained` is the one status that does
// not mirror an opencode session status at all: a retained session's opencode
// status is `idle`, and stays `idle` for as long as it is held.
export type SubagentStatus =
  | "busy"
  | "waiting"
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
  // True once the subagent has been observed running. Nothing decides on it:
  // a row's lifetime is the session being listed, and a subagent that has been
  // seen running is in no different position from one whose run has not been
  // forked yet. It is kept because it is the one record the panel has of a row
  // ever having been busy.
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

// The two session sets the panel keeps: the sessions whose children the poll
// asks for, and the sessions that have ever been seen as somebody's child or
// been created carrying a parentID.
//
// `polled` grows with every subagent the panel discovers, because a subagent
// that spawns has children of its own that have to be listed by somebody.
// `subagents` only ever grows: what has once been spawned as a subagent stays
// one.
export interface SessionRoles {
  polled: ReadonlySet<string>;
  subagents: ReadonlySet<string>;
}

// Whether a session is an orchestrator: one the panel polls that was never
// spawned as a subagent.
//
// This is the guarantee that lets the poll ask a subagent for its children
// without turning it into an orchestrator. Being polled is not what makes an
// orchestrator — a session that is polled AND known as a subagent is a
// subagent, keeps its own row in its parent's list, and is polled purely so
// that its own children get rows of their own. Orchestrator-ness is therefore
// decided by the second set alone once a session is polled, and the second set
// never forgets.
export function isOrchestratorSession(
  sessionID: string,
  roles: SessionRoles,
): boolean {
  return roles.polled.has(sessionID) && !roles.subagents.has(sessionID);
}

// One session child as returned by the opencode API. The panel only uses the
// fields needed to identify and display the row.
export interface SessionChild {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

// The outcome of one session.children request. A missing parent is different
// from a failed request: the former can leave the poll set, while the latter
// must leave the current rows untouched.
export type SessionChildrenRead =
  | { kind: "ok"; children: SessionChild[] }
  | { kind: "missing" }
  | { kind: "error" };

export function readSessionChildren(result: unknown): SessionChildrenRead {
  if (typeof result !== "object" || result === null) {
    return { kind: "error" };
  }
  const response = result as {
    data?: unknown;
    error?: unknown;
    response?: { status?: unknown };
  };
  if (response.error !== undefined && response.error !== null) {
    return response.response?.status === 404
      ? { kind: "missing" }
      : { kind: "error" };
  }
  if (!Array.isArray(response.data)) return { kind: "error" };
  return { kind: "ok", children: response.data as SessionChild[] };
}

// One pass's observation of one listed child session: everything the panel
// knows about it at that moment, and nothing it inferred.
export interface RowObservation {
  // The session id, carried so a decision can be traced back to its row.
  sessionID: string;
  // Aborted from this panel. The opencode status alone does not distinguish an
  // abort from any other ending, so the panel remembers its own aborts.
  aborted: boolean;
  // The session title exactly as the server lists it, retention stamp and all.
  title: string | undefined;
  // What `GET /session/status` said about this session on this pass: "busy",
  // "retry", or undefined — which is how opencode spells idle, the map holding
  // only the sessions that have a run fiber alive.
  serverStatus: string | undefined;
}

// What one observation makes of a row. Two outcomes and no third: a row that
// is shown with a status, or a row that is held on the plugin's published
// window. There is no "retire" outcome, because no single observation ever
// ends a row — a row ends when its session stops being listed (`reapRows`) or
// when opencode publishes `session.deleted` for it.
export type RowDecision =
  | { kind: "row"; status: SubagentStatus }
  | { kind: "hold"; retainedUntil: number };

// The decision, in strict precedence:
//
//   1. an abort this panel asked for — the session is being torn down and the
//      row says so until it goes;
//   2. `busy` / `retry` from opencode — a run fiber is alive in the session and
//      takes precedence over a retention stamp left by a failed title clear;
//   3. a retention stamp on the title — the plugin has published that this
//      subagent is finished and is being held;
//   4. everything else: waiting. Listed, unstamped, no run fiber — the run has
//      not been forked yet, or the subagent is blocked in a nested spawn. It
//      keeps its row.
//
// Steps 2 and 4 pick a status and never a lifetime: whichever of them applies,
// the answer is a row. A live run outranks a stale retention stamp because reuse
// makes the session busy before it can replace that stamp.
export function decideRow(observation: RowObservation): RowDecision {
  if (observation.aborted) return { kind: "row", status: "aborted" };
  if (observation.serverStatus === "busy") {
    return { kind: "row", status: "busy" };
  }
  if (observation.serverStatus === "retry") {
    return { kind: "row", status: "retry" };
  }
  const retainedUntil = readRetentionStamp(observation.title);
  if (retainedUntil !== undefined) return { kind: "hold", retainedUntil };
  return { kind: "row", status: "waiting" };
}

// Apply one row decision to the session record from a completed poll. Fields
// not present in the child response remain from the existing row, while a
// status decision clears a retention window that no longer applies.
export function assembleSubagentEntry(
  base: SubagentEntry,
  child: SessionChild,
  parentID: string,
  decision: RowDecision,
  handle: string,
): SubagentEntry {
  const running =
    decision.kind === "row" &&
    (decision.status === "busy" || decision.status === "retry");
  return {
    ...base,
    sessionID: child.id,
    parentID: child.parentID ?? parentID,
    agent: child.agent ?? base.agent,
    handle,
    title: child.title ?? base.title,
    status: decision.kind === "hold" ? "retained" : decision.status,
    retainedUntil:
      decision.kind === "hold" ? decision.retainedUntil : undefined,
    wasBusy: base.wasBusy || running,
    createdAt: child.time?.created ?? base.createdAt,
    updatedAt: child.time?.updated ?? base.updatedAt,
  };
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

// The rows a completed poll has disproved, as their session ids.
//
// `seen` is every child the poll actually listed, across every parent it asked;
// it is only meaningful when the whole poll went through, so this is called on
// a completed pass and never on a partial one. `polled` is the set of sessions
// the pass asked for children of, and it is what makes an absence evidence: a
// row whose parent was never asked about was not disproved by the pass, it was
// simply out of its reach, so it stays. A nested child is normally IN reach —
// every session discovered as a subagent is polled for its own children — but
// it is out of it in the window between a spawn and the first pass that lists
// the spawning parent, and again once that parent has left the polled set on
// its own deletion. Reaping either would delete a row for work that is running.
//
// Within that reach the rule is the existence rule and holds for every row,
// held or not: a session no longer listed among its parent's children is one
// the plugin has finished with — `teardownSubagent` deletes the session at
// every ending the plugin controls — and the row goes. `session.deleted` says
// the same thing sooner, and this is the pass that catches what the event
// missed.
//
// The second case is a held row alone: its session is still listed, but its
// published window ran out longer ago than the grace allows, so nothing is
// holding it any more.
export function reapRows(
  rows: Iterable<SubagentEntry>,
  opts: { seen: ReadonlySet<string>; polled: ReadonlySet<string> },
  now: number = Date.now(),
): string[] {
  const gone: string[] = [];
  for (const entry of rows) {
    if (!opts.seen.has(entry.sessionID)) {
      if (opts.polled.has(entry.parentID)) gone.push(entry.sessionID);
      continue;
    }
    if (retentionExpired(entry, now)) gone.push(entry.sessionID);
  }
  return gone;
}

export interface RouteEscapeQuery {
  // The route the TUI is on right now, and the session it names when it is a
  // session route.
  routeName: string;
  routeSessionID?: string;
  // The session whose row is ending, and the parent it hung under.
  sessionID: string;
  parentID?: string;
  // Whether the server is known to still hold this session. This is the one
  // test the target has to pass — "the panel has no row for it" is not the same
  // question and does not answer it.
  isAlive: (sessionID: string) => boolean;
  // The parent a session's retired row carried, which is what carries the walk
  // across a chain that ended from the top down.
  parentOfGone: (sessionID: string) => string | undefined;
  // The orchestrator chat to land on when no ancestor is alive. It is held to
  // `isAlive` like any other target.
  orchestratorID?: string;
}

// The session the view has to be moved to because the session `sessionID` is
// ending, or `undefined` to leave the view where it is.
//
// A row that is retired means the plugin has finished with that subagent and
// its session is gone or about to go. A route still naming it points at a
// session the server does not have, and the TUI answers that by falling back to
// its start page — the user loses the orchestrator chat. So the view escapes up
// the parent chain to the first ancestor the server still holds, and to the
// orchestrator when the chain yields none.
//
// Every returned target has passed `isAlive`. An ancestor that is merely
// unknown — one this panel never held a row for, or one whose row it retired —
// is walked past rather than jumped to: jumping to a session that is equally
// gone is not an escape, it is the same start page one link further up.
// `undefined` comes back when the user is elsewhere (the common case, nothing
// to do), when the route is not a session route, and when neither the chain nor
// the orchestrator yields a session known to be alive.
export function routeEscapeTarget(query: RouteEscapeQuery): string | undefined {
  if (query.routeName !== "session") return undefined;
  if (query.routeSessionID !== query.sessionID) return undefined;
  let candidate = query.parentID;
  const walked = new Set<string>([query.sessionID]);
  while (
    typeof candidate === "string" &&
    candidate !== "" &&
    !walked.has(candidate)
  ) {
    if (query.isAlive(candidate)) return candidate;
    walked.add(candidate);
    candidate = query.parentOfGone(candidate);
  }
  const fallback = query.orchestratorID;
  if (typeof fallback !== "string" || fallback === "") return undefined;
  if (walked.has(fallback)) return undefined;
  return query.isAlive(fallback) ? fallback : undefined;
}

// The dot in front of a row. A held row is neither running nor gone, so it
// carries neither the pulsing dot of a run nor the tick of a finished one; a
// waiting row carries no tick either, because it is not finished — it is a run
// that has not been forked yet or a subagent blocked in a spawn of its own.
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
      return "◌";
  }
}

// Where a row sorts: running work first, then what is waiting or settling, then
// the held rows, which are the only finished rows on the list. Rows of equal
// rank keep their spawn order.
export function statusRank(status: SubagentStatus): number {
  if (status === "busy" || status === "retry") return 0;
  return status === "retained" ? 2 : 1;
}

// ---------------------------------------------------------------- the tree

// One rendered row: the entry, and how deep beneath the panel's own session it
// sits. `depth` 0 is a direct child of that session, 1 its child, and so on
// without a ceiling.
export interface SubagentRow {
  entry: SubagentEntry;
  depth: number;
}

// The columns one level of nesting indents a row by.
export const ROW_INDENT_COLUMNS = 2;

// The left offset of a row at this depth, in columns.
export function rowIndent(depth: number): number {
  return Math.max(0, depth) * ROW_INDENT_COLUMNS;
}

// What the row list needs beyond the entries themselves.
export interface RowTreeOptions {
  // An orchestrator session never gets a row of its own — it is the session a
  // panel is rendered for, not a subagent of it. Same test the poll takes.
  isOrchestrator?: (sessionID: string) => boolean;
  // The parent of a session whose own row is already gone. A middle subagent
  // can be torn down while the subagent it spawned is still working, and that
  // descendant belongs on screen for as long as it works; this is what carries
  // its ancestry across the hole. Returning undefined means "not known", which
  // leaves the descendant unattached and therefore off this panel — an
  // unrelated session is exactly the case that must not be adopted.
  parentOfGone?: (sessionID: string) => string | undefined;
}

// The whole subagent tree beneath one session, flattened for display.
//
// A panel is rendered for the orchestrator session alone — the host draws no
// sidebar inside a session that has a parent — so a row that belonged only to
// its own parent's panel belonged to a panel nobody can open. Every descendant
// of the panel's session is therefore its business, at any depth.
//
// Three things the walk fixes:
//
//   - membership: an entry is on this list only if its parent chain reaches
//     the panel's session. Sessions from another tree, and rows whose ancestry
//     cannot be established, stay off it.
//   - order: pre-order, so a child follows its own parent rather than sorting
//     away from it. Siblings keep the list's own order — running first, then
//     what is waiting or settling, then the held rows, and spawn order within
//     a rank — because that ordering only ever compared rows that share a
//     parent anyway.
//   - depth: one level per generation, which the panel indents by.
//
// A parent chain that loops, and an entry that is its own ancestor, terminate:
// the upward walk stops at a session it has already stepped through, and the
// downward walk emits each session once.
export function descendantRows(
  entries: Iterable<SubagentEntry>,
  rootSessionID: string,
  options: RowTreeOptions = {},
): SubagentRow[] {
  const isOrchestrator = options.isOrchestrator ?? (() => false);
  const parentOfGone = options.parentOfGone ?? (() => undefined);

  const candidates = new Map<string, SubagentEntry>();
  for (const entry of entries) {
    if (entry.sessionID === rootSessionID) continue;
    if (isOrchestrator(entry.sessionID)) continue;
    candidates.set(entry.sessionID, entry);
  }

  // The session this row hangs under on screen: its own parent where that
  // parent still has a row, the panel's session where it is a direct child,
  // and otherwise the nearest ancestor still on the list, found across the
  // rows that have already gone. Undefined where no such ancestor exists.
  const attachTo = (entry: SubagentEntry): string | undefined => {
    let id: string | undefined = entry.parentID;
    const walked = new Set<string>([entry.sessionID]);
    while (typeof id === "string" && id !== "" && !walked.has(id)) {
      if (id === rootSessionID) return rootSessionID;
      if (candidates.has(id)) return id;
      walked.add(id);
      id = parentOfGone(id);
    }
    return undefined;
  };

  const children = new Map<string, SubagentEntry[]>();
  for (const entry of candidates.values()) {
    const parent = attachTo(entry);
    if (parent === undefined) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => {
      const byRank = statusRank(a.status) - statusRank(b.status);
      if (byRank !== 0) return byRank;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0;
    });
  }

  const rows: SubagentRow[] = [];
  const emitted = new Set<string>();
  const walk = (parentID: string, depth: number): void => {
    for (const entry of children.get(parentID) ?? []) {
      if (emitted.has(entry.sessionID)) continue;
      emitted.add(entry.sessionID);
      rows.push({ entry, depth });
      walk(entry.sessionID, depth + 1);
    }
  };
  walk(rootSessionID, 0);
  return rows;
}

// The header figures, taken from the rendered rows themselves so the summary
// line can never name a subagent the list does not show. `done` is not in here:
// it counts runs that are over, whose rows are gone by definition, and it is
// kept per orchestrator tree in the panel.
export interface RowCounts {
  total: number;
  running: number;
  retained: number;
}

export function summariseRows(rows: Iterable<SubagentRow>): RowCounts {
  let total = 0;
  let running = 0;
  let retained = 0;
  for (const row of rows) {
    total += 1;
    if (row.entry.status === "busy" || row.entry.status === "retry") {
      running += 1;
    } else if (row.entry.status === "retained") retained += 1;
  }
  return { total, running, retained };
}

// The orchestrator a subagent belongs to: the first session up its parent
// chain that is nobody's subagent, i.e. the one `lookup` has no entry for. The
// lookup is given the live rows and the rows that have already gone, so the
// chain still resolves for a subagent whose parents were torn down before it.
//
// This is what keeps the completed counter attached to a tree instead of to
// the panel process: a run that ends is counted for the orchestrator it ran
// under, and a panel shows the figure for its own session alone.
export function rootSessionOf(
  entry: SubagentEntry,
  lookup: (sessionID: string) => SubagentEntry | undefined,
): string {
  let id = entry.parentID;
  const walked = new Set<string>([entry.sessionID]);
  while (typeof id === "string" && id !== "" && !walked.has(id)) {
    const parent = lookup(id);
    if (parent === undefined) return id;
    walked.add(id);
    id = parent.parentID;
  }
  return typeof id === "string" ? id : "";
}
