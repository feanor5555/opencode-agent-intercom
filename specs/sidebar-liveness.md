# Sidebar liveness — a subagent stays visible as long as it is working

The sidebar must show a subagent row for as long as that subagent is doing
work, including while it is blocked inside a nested `spawn` and therefore not
`busy` to opencode, and including the window between its session being created
and its run being forked.

Boundary: the `opencode-agent-intercom` plugin — `src/` (server half, plain JS,
runs in the opencode server process) and `tui/src/` (TUI half, TypeScript, its
own npm package, runs in the TUI process, no import across the two). Nothing
outside this repository changes.

---

## 1. The existence rule

A sidebar row lives while its session is listed among its parent's children and
carries no retention stamp. That is the whole rule for a row's LIFETIME —
which panel draws that row is section 5. It is a statement the
plugin makes rather than one the panel observes: every ending the plugin
controls runs through `teardownSubagent` (`src/teardown.js`), which deletes the
opencode session, so "still listed" IS "the plugin has not finished with it". A
session that is listed and unstamped is work in flight, whatever
`GET /session/status` says about it.

The opencode session status is therefore a display detail and nothing more. It
cannot carry a row's lifetime: opencode spells `idle` as ABSENCE from
`GET /session/status`, and a subagent is not `busy` between its session being
created and its run being forked, nor while it is blocked inside a nested spawn
of its own, nor while a retained session is being re-prompted. A row that
vanished on any of those would be a subagent that is working with nothing on
screen to say so.

Retention breaks the existence rule in the one direction the plugin owns: a
retained subagent is finished, its session is deliberately kept alive, and the
orchestrator can put a follow-up to it with `reuse()` until its window runs
out. Whether a given subagent is really being held is the plugin's decision and
no reader of the opencode server can work it out: it is taken on the subagent's
reply, on the context the run ended at, on capacity, and on whether retention is
in effect in that plugin process at all. So the panel does not infer it. The
plugin publishes it, on the one field of a subagent session it owns — the
title, which already carries its marker and which every poll reads anyway — as
`[retained:<epoch ms the window ends>]` after that marker. `readRetentionStamp`
in `tui/src/subagent-label.ts` reads it back. The stamp is the only thing
attached to a subagent session besides the marker.

Two consequences, and they are the point:

- a retention the plugin refused is never painted as held, not even for one
  poll. No stamp, no held row: the refusal is a decision the panel is told
  about rather than one it has to observe by the session's disappearance.
- the countdown is the plugin's own window, not a second one measured from when
  the panel happened to see the run end. The two used to be a poll apart; now
  there is one figure and both halves render it.

A held row still ends when its session does. Every way a retention ends — the
TTL reap, the capacity eviction, the drop at a handoff or at an endless freeze,
an abort, a reuse that fails — has the plugin delete the opencode session, so
a held row lives exactly as long as its session is still listed among its
parent's children. `reapRows` is where that is enforced, for held and unheld
rows alike, and it is what keeps a row from outliving the session it names.

With `maxRetainedSubagents` at its default of `0` nothing about retention is
reachable: the plugin stamps no title, `decideRow` never returns a hold, no row
ever carries `retained`, and `reapRows` reaps on the session's absence alone.

## 2. The session-title channel

`SUBAGENT_SESSION_TITLE_MARKER = "[agent-intercom] "` lives in
`src/teardown.js:388`. The marker identifies a session this plugin created; it
is what the bootstrap sweep uses to tell this plugin's leftovers from anything
else on the same database, and it is what the readRetentionStamp reader uses to
find the stamp after it.

`spawn` writes the marker unconditionally (`src/tools.js:580`,
`title: SUBAGENT_SESSION_TITLE_MARKER + title`): the marker is no longer a
retention property and is not gated on `retentionOffered()`. Every spawned
session carries it, at the shipped default too. The session-title marker is not
tied to retention; it is the plugin's own attribution on every session it
spawns.

`RETENTION_STAMP_RE = /^\[retained:(\d{1,15})\]\s/` (`src/teardown.js:410`),
composed by `retentionStampedTitle` (`src/teardown.js:415-422`) and written by
`publishRetentionState` → `updateSessionTitle` → `client.session.update`
(`src/teardown.js:446-452`, `src/client.js`). `publishRetentionState` returns
`false` immediately and writes nothing where `retentionOffered()` is false
(`src/teardown.js:447`), so at the shipped default no stamp byte moves.

The reader, on the panel side, is `readRetentionStamp` in
`tui/src/subagent-label.ts`, with `RETENTION_STAMP_RE` mirrored on the same
file. `subagentTopic` (`tui/src/subagent-label.ts`) strips both the marker and
any retained stamp before the title reaches the row label, so the stamp is
state, never topic text.

## 3. What decides a row on one pass

`decideRow(observation) -> RowDecision` in `tui/src/subagent-store.ts` has two
outcomes and no third:

- `{ kind: "row", status }` — the row stays, with the chosen status.
- `{ kind: "hold", retainedUntil }` — the row stays, stamped with the
  plugin's published window.

There is no "retire" outcome, because no single observation ever ends a row —
a row ends when its session stops being listed (`reapRows`, on a completed
pass) or when opencode publishes `session.deleted` for it.

The decision runs in strict precedence:

1. **Aborted** — an abort this panel asked for is a row whose session is being
   torn down; the row says so (`status: "aborted"`) until it goes, and a
   retention is never granted for an ending that is not a clean idle.
2. **`busy` / `retry`** — a run fiber is alive in the session
   (`GET /session/status` says so). The row carries that status. This step
   sits above the retention stamp deliberately: `reuse` clears the stamp
   best-effort, and a failed clear would otherwise paint a running subagent
   as retained and get it reaped while it is still working.
3. **Retention stamp** — a stamp on the title (`[retained:<epoch>]` directly
   after the marker) is the only statement that turns a live row into a held
   one. The plugin publishes it on its own clock; the panel renders the same
   figure.
4. **Everything else: `waiting`** — listed, unstamped, no run fiber. The run
   has not been forked yet, or the subagent is blocked in a nested spawn. The
   row keeps its slot.

Steps 2 and 4 pick a status and never a lifetime: whichever of them applies,
the answer is a row. The poll never retires a row; only `reapRows` does, on a
session absent from a completed pass that both polled its parent and had its
chance at the row (`passHadItsChance` against the row's `knownAtPass`,
falling back to `startedPasses`). A row born into a pass already under way
survives that pass and is reapable from the next one; an unrecorded
`knownAtPass` grants no protection. `busy` and `retry` decide which status a
row shows; they never decide that a row ends.

## 4. The three gates

### 4.1 The poll's status filter

The poll iterates over every `polledIDs` session, fetches its children, files
each child into `seen`, marks it a subagent, and puts it into `polledIDs` in
turn, so that a subagent's own children are listed by somebody. A `Set` being
iterated takes up what is added to it, so one pass reaches every depth of the
chain. The skip on orchestrator rows (`tui/src/tui.tsx:915`,
`if (isPrimarySession(child.id)) continue`) is what stops an orchestrator from
appearing as its own subagent; it is taken after the child has been filed into
`subagentIDs`, so a discovered session is never read as an orchestrator in the
window between the two.
The row decision itself never retires; the reap pass after the loop is the only
thing that does.

### 4.2 `session.deleted`

The panel subscribes to `session.deleted` (`tui/src/tui.tsx:1285`, registered
at `:1321`). The plugin deletes a subagent's session at every ending it
controls (`teardownSubagent`, `src/teardown.js:256`), so the event is the end
of the row — the one signal that means "finished" rather than "not running
just now". The handler routes the user out of the deleted session if it was
the active route, retires the row, and increments the completed counter.

### 4.3 `onSessionIdle`

The idle event says one thing and one thing only: opencode has no run fiber in
that session at this moment. It is not the end of a subagent — a nested spawn,
a run not yet forked, and a retained session being re-prompted are all idle —
so it no longer takes a row. The row ends where the plugin ends the subagent,
which is `session.deleted`. What stays in `onSessionIdle` is the route jump:
if the user is inside the session and the last completed poll still listed it
unstamped, the route jumps to the parent before the session goes. The jump is
held back while the session is listed and unstamped — that is a subagent the
plugin has not finished with, and yanking the user out of a session that goes
on working is the same mistake as dropping its row.

## 5. Which panel a row is drawn in

The panel of an orchestrator session shows the WHOLE subagent tree beneath that
session, at any depth — not its direct children alone. The host renders a
sidebar only on a session that has no parent, so a row drawn in the panel of a
spawning subagent is a row nobody can open: it belongs to a panel that is never
put on screen and whose session the plugin deletes when the subagent ends. The
orchestrator's panel is the one place every row of its tree can be seen, so
that is where the tree is drawn.

`descendantRows(entries, rootSessionID, options)` in
`tui/src/subagent-store.ts` is the rule; the `rows` memo in `tui/src/tui.tsx`
is nothing but the call, with the panel's own session as the root. It returns
`{ entry, depth }` in render order and decides three things:

- **Membership.** An entry is on the list exactly when its parent chain reaches
  the panel's own session. A session whose ancestry does not reach it — another
  orchestrator's subagent, a row whose origin nothing records — stays off, and
  is neither shown nor counted. Nothing is adopted on the strength of being
  unattached.
- **Order.** Pre-order: a child follows its own parent. Ranking (`statusRank`:
  running first, then what is waiting or settling, then the held rows, spawn
  order within a rank) applies among siblings, which is the only place it ever
  compared rows that share a parent. Ranking the flat list would tear a busy
  grandchild away from the row that spawned it.
- **Depth.** One level per generation, direct children at `depth` 0. The panel
  indents a row by `rowIndent(depth)` = `depth * ROW_INDENT_COLUMNS`
  (`ROW_INDENT_COLUMNS = 2`), and composes its label against the panel width
  less that indent, so a deep row is cut to its own budget rather than by the
  box it sits in.

Everything the list does works off the same flattened order: `rowIDs` is the
rendered rows' session ids, so `j`/`k`, `⏎` and the abort reach a nested row
exactly as they reach a direct child, and a held row at depth is dropped by the
same keypress as one at the top.

A hole in the chain does not take a row down with it. A middle subagent can be
torn down while the subagent it spawned is still working — that descendant is
work in flight and belongs on screen, so the walk carries its ancestry across
the hole through `parentOfGone`, the panel's record of a retired row's own
parent (`finished` in `tui/src/tui.tsx`). It then hangs from the nearest
ancestor still on the list, one level shallower. Where nothing records the gone
parent the row is unattached and stays off — an unrelated session is exactly
what must not be adopted. A parent chain that loops terminates: the upward walk
stops at a session it has already stepped through and the downward walk emits
each session once, so a cycle costs the rows in it their place and never a hang.

The two figures that are not statuses follow the same tree:

- `nextHandle` numbers handles per agent type across the whole panel, so no two
  rows on screen ever carry the same handle however deep they sit.
- The completed counter is kept per orchestrator tree, not per panel process.
  A run that ends is booked to the first session up its parent chain that is
  nobody's subagent (`rootSessionOf`, resolved over the live rows and the
  retired ones together, so the chain still resolves for a subagent whose
  parents ended before it), and a panel reads the figure for its own session
  alone. `running` and `retained` are counted off the rendered rows themselves
  (`summariseRows`). The header count, the summary line and the list therefore
  name one and the same set of subagents.

## 5.1 Subagent vs orchestrator on the panel

A session counts as orchestrator only if it is polled and is not itself a known
subagent, so a subagent that spawns a nested child keeps its row, and the child
gets its own row in the orchestrator's panel:

```
isPrimarySession(sessionID) = polledIDs.has(sessionID) && !subagentIDs.has(sessionID)
```

The rule itself is `isOrchestratorSession` in `tui/src/subagent-store.ts`, which
`tui/src/tui.tsx` hands the two sets; the panel's poll and its row list both take
it, so the two cannot drift apart.

`polledIDs` is fed by the panel's own slot/route session, by every session the
user navigates into, by every child the poll lists, and by the parent named on a
`session.created` event. That last pair is what gives a nested child a row: a
subagent that spawns is asked for its children like any other parent, at any
depth, and without it a subagent's subagent is listed by nobody in the pass and
its optimistic row is reaped again. `subagentIDs` is fed by every
`session.created` event carrying a `parentID` and by every child the poll lists,
and it only grows — what has once been spawned as a subagent stays one.

Polling a session is therefore NOT what makes it an orchestrator, and that is the
guarantee the two sets exist for: every id that enters `polledIDs` on a discovery
enters `subagentIDs` first, so a spawning subagent keeps its own row on the
orchestrator's list, at its own depth, while being polled for its children. A
subagent the user has navigated into is the same case.

`polledIDs` does not grow without bound. An id leaves it when opencode publishes
`session.deleted` for that session and when a children request for it comes back
404 — both keyed on the session id, so they bound the discovered ids exactly as
they bound the seeded one. A deleted session can never re-enter: it is listed as
nobody's child again and no spawn names it as a parent.

## 6. Teardown and the bootstrap sweep

The plugin deletes the opencode session at every ending the plugin controls
(`teardownSubagent`, `src/teardown.js:256`): the normal one-shot, an abort, an
error, a timeout, a retention reap, a capacity eviction, a handoff drop, an
endless freeze. That is what makes the existence rule exact — there is no
ending the plugin knows about that does not pass through `teardownSubagent`.

If the plugin process dies mid-run, its subagent rows stay until the bootstrap
sweep clears the leftover sessions. `sweepOrphanedSubagentSessions`
(`src/teardown.js:507`) runs once at plugin load (`src/index.js:100`), on the
shipped default too — it is not gated on `retentionOffered()`. It deletes a
session only when ALL of the following hold:

1. its title carries `SUBAGENT_SESSION_TITLE_MARKER` — this plugin created it
   as a subagent session, and nothing else writes that prefix;
2. it has a parentID — it is a child; a primary is never a candidate;
3. no listed session names it as a parent — no recursive cascade;
4. this process knows nothing about it: not a tracked primary, not a registry
   entry;
5. it has been idle for longer than `ORPHAN_SWEEP_TTL_FACTOR *
   retainedSubagentTtlMs`, and in no case less than `ORPHAN_SWEEP_MIN_AGE_MS =
   600000` (ten minutes).

A running subagent is reaped by the inactivity watchdog at 90 s and a retained
one at its TTL, so nothing alive is ever this old. The ten-minute floor is the
whole bound wherever the configured retention window is shorter than half of
it, and it clears the watchdog reap by a wide margin. Sessions that cannot be
attributed with certainty are left standing, whatever it costs in leaked rows.

The "publishRetentionState is gated on retentionOffered" guard is gone from
the sweep's precondition — that gate names a writer-side concern (whether this
process stamps titles at all) and is unrelated to whether a leftover session
should be deleted. The sweep is its own attribution test.

## 7. What a held row carries

A held row carries the plugin's own published window — the moment the reap
works to and the same moment `list` and the per-turn snapshot count down to —
not a poll-local figure measured from when the panel happened to see the run
end. The window is taken on the subagent's reply, on its retained context, on
capacity, on the configured TTL, and on `retainedAt + retainedSubagentTtlMs`.
`publishRetentionState` writes it (`src/teardown.js:446-452`); the panel reads
it through `readRetentionStamp` and renders it through `retainedMinutesLeft`
(`tui/src/subagent-store.ts`), which floors to whole minutes.

The grace under which a held row may still be listed past its window before
the panel drops it on its own is `RETENTION_EXPIRY_GRACE_MS = 60000` (one
minute). The grace covers the reap tick plus the session-delete that follows;
the session going missing is the ordinary way a row ends, the grace is the
backstop for a row whose session does not go.

## 8. Failure behaviour

| situation | what the sidebar shows |
|---|---|
| No stamp at all (server half not loaded, older plugin, a foreign session) | The opencode status decides. Listed + unstamped + no status entry → `waiting`; listed + `busy`/`retry` → `busy`/`retry`. The existence rule is the existence rule. |
| A title write failed (`updateSessionTitle` returned false, logged) | A retention that the plugin intended to publish is not published. No stamp means no held row. The subagent's session is deleted at the next teardown path and the row goes with it. |
| Stamp present but past window + grace | `reapRows` drops the row on the next completed pass. The plugin's reap on its own clock has already deleted the session by then; this is the backstop. |
| Session gone from `session.children` | The row goes at once. `reapRows` runs on every completed pass, and the session's absence beats any stamp — a row must never outlive the session it names, the same rule retention already follows. |
| Plugin process died mid-run | Subagent rows stay until the bootstrap sweep clears the leftover sessions, bounded by `ORPHAN_SWEEP_TTL_FACTOR * retainedSubagentTtlMs` and the `ORPHAN_SWEEP_MIN_AGE_MS = 600000` floor. The sweep runs at the shipped default too. |
| Poll itself failing (network, server restart) | `refresh` swallows the error and reaps nothing, because `seen` is only the whole truth on a completed pass. Rows freeze rather than disappear. |

The invariant behind the table: **a row ends because something positive said
so — a session that is gone, a retention that was published, or a `session.deleted`
that arrived — never because one poll failed to find a session busy.**

## 9. Assumptions, and what would show them wrong

| # | assumption | what must hold | what would show it wrong |
|---|---|---|---|
| A1 | opencode imposes no length or character limit on a session title that the marker would breach | `PATCH /session/{id}` accepts the composed title | a `400 BadRequest` from `updateSessionTitle`, which today is swallowed into the debug log |
| A2 | A title write during a live run does not disturb the run | retention already writes titles on sessions the plugin owns, without a reported effect | a run interrupted or a prompt loop restarted at the moment of a publish |
| A3 | `Session.children` returns direct children only | read from the 1.18.25 binary: `select … where parent_id = q` | a grandchild appearing in a primary's children list, which would double-count rows |
| A4 | The marker implies "subagent, never a primary" | `src/teardown.js:482-484` states the handoff successor carries no marker | an orchestrator row disappearing from its own sidebar after a handoff |
| A5 | The status union stays `idle \| retry \| busy` and `idle` stays absence | pinned in the SDK types and in the binary schema | a fourth status value appearing, which would make `waiting` derivable from opencode itself and reduce the existence rule's job |
| A6 | Every ending the plugin knows about runs through `teardownSubagent` | the registry's mutex, the `closing` latch, and the panel's "every ending deletes the session" rule all rest on it | an ending that leaves a session listed with no plugin-side handler for it — a subagent that never goes |

The marker is the plugin's only positive attribution on a subagent session,
and `session.deleted` is the only positive signal that a subagent has finished.
The two together are what make the existence rule enforceable from the panel
side without needing a transport that does not exist.

## 10. Test approach

### Unit — the rules, where they belong

The decisions the row makes live in `tui/src/subagent-store.ts` and are
unit-tested there; the server-side publish path is unit-tested in the
existing `src/teardown.js` tests. The cases that matter:

1. `test/tui-subagent-label.test.js` — `RETENTION_STAMP_RE` and
   `readRetentionStamp` pinned against `src/teardown.js`'s writer; the marker
   stays first; `subagentTopic` strips the stamp.
2. `test/tui-sidebar-tree.test.js` — `descendantRows`, which is the `rows`
   memo itself:
   - a three-deep and a four-deep chain are one panel's list, every generation
     present, depth 0/1/2/3 and the indent `depth * ROW_INDENT_COLUMNS`;
   - pre-order: a busy grandchild stays under the parent that spawned it, and
     siblings still rank running first, then spawn order;
   - another orchestrator's subagents, and their descendants, stay off the
     list and out of the counts;
   - a descendant whose parent's row is gone keeps its place through
     `parentOfGone` and moves one level shallower; an unattached row stays off;
   - a parent cycle, a row that is its own parent, and a looping
     `parentOfGone` chain each terminate without a hang;
   - `summariseRows` counts exactly the rendered rows, and `rootSessionOf`
     books a finished run to the orchestrator at the top of its chain, over
     retired rows included.
3. `test/tui-subagent-store.test.js` — `decideRow` precedence:
   - aborted → `aborted` (never `hold`);
   - retained stamp → `hold`, even when opencode also says `busy`;
   - `busy` → `busy`, `retry` → `retry`, otherwise → `waiting`;
   - no outcome is `retire`.
   `reapRows`:
   - retires a row whose session is not in `seen` AND whose parent was polled
     AND whose `knownAtPass` is past — the row was born into the pass or earlier,
     so the pass had its chance at it (the nested-child-disappears case);
   - leaves a row whose session is not in `seen` but whose parent was never
     asked about, OR a row born after the pass started (`passHadItsChance` is
     false) — out of reach of the pass;
   - retires a held row whose published window is past the grace.
4. `test/bootstrap-sweep.test.js` — the bootstrap sweep deletes a leaked
   subagent session at the shipped default too; the marker is the
   attribution; the bound is `ORPHAN_SWEEP_TTL_FACTOR * retainedSubagentTtlMs`
   floored at `ORPHAN_SWEEP_MIN_AGE_MS = 600000`; sessions this process still
   knows about are left standing.

### End-to-end — the nested case is the one that reproduces it

`test/e2e/nested-task.sh` already drives orchestrator → coder → researcher.
The sidebar grandchild row is the case the existence rule exists for. With a
rendered TUI and the sidebar open, a screenshot taken inside the blocked
window must show, in the ORCHESTRATOR's panel, the caller's row present with
its age still advancing between two captures AND the nested subagent's own row
one indent level under it, the header count naming both.

The bootstrap sweep is observed by running an `opencode serve` against a
fixture database with two pre-seeded subagent sessions (one under the marker,
one foreign), waiting past the sweep bound, and asserting that only the
marked session is deleted — at the shipped default, where `publishRetentionState`
writes no stamp at all.
