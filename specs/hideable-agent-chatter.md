# Hideable agent chatter — the `show agentcom` switch

Sources for the opencode behaviour of §2: the installed binary
`~/.opencode/bin/opencode`, the installed packages under `node_modules/@opencode-ai/`,
this repository's live capture `test/e2e/out/11-endless.new-session-messages.json`, and the
upstream check recorded in `work/research-opencode-message-visibility.md`.

Boundary: the plugin at `~/opencode-agent-intercom`, both halves — the server-side
plugin under `src/` and the sidebar plugin under `tui/`. Against opencode `1.18.25`.

Every text the plugin pushes between the orchestrator and its subagents is posted into the
chat transcript as a user-role message. One boolean, `showAgentcom`, decides whether that
traffic renders on screen. With it on (the default) the postings render; with it off they
are stamped `synthetic: true`, opencode's renderer skips them, and the model still receives
their text verbatim.

## 1. The send paths

### 1.1 Two send-side chokepoints, one marking helper

Every posting the plugin makes goes through exactly one of two functions, and both of them
build their text part with the same helper:

- `postNotice(client, sessionID, text, { deliveryID, agent })` — `src/client.js:258-283`, body
  `{ agent?, parts: [intercomTextPart(text, { hidden: !showAgentcom, deliveryID })] }` at
  `src/client.js:271-274`, wrapped in the retry loop driven by `postNoticeRetries`.
- `promptSession(client, { sessionID, agent, prompt, hideable, noReply })` —
  `src/client.js:367-407`, body `{ agent, parts: [intercomTextPart(prompt, { hidden })] }`
  with `hidden = hideable && !showAgentcom` (`src/client.js:372`).
- `intercomTextPart(text, { hidden, deliveryID })` — `src/pluginmsg.js:72-82`, returns
  `{ type: "text", text, synthetic?: true, metadata: { agentIntercom: true, … } }`.
  `synthetic` is absent, not `false`, on a visible part. The module is a pure leaf ("a pure
  leaf (imports nothing) so BOTH sides can share it", `src/pluginmsg.js:35`); the `hidden`
  decision is made in `client.js`, which reads `getSettings().showAgentcom` at send time.

`src/pluginmsg.js:36-37` states the invariant the switch leans on: "postNotice +
promptSession are the only two functions in src/ that call session.promptAsync".

### 1.2 What reaches the primary's transcript through them

| Kind | Call site |
|---|---|
| Subagent completion notice (handle, full result, task outcome, run-size, free slots) | `src/hooks.js:2297-2322` → `postParentNotice` (`src/teardown.js:177-242`) |
| Error / abort notice | `src/hooks.js:2695-2702`, text `src/notices.js:535-561` |
| Watchdog timeout notice | `src/watchdog.js:561-563`, text `src/notices.js:430-491` |
| Denial-loop notice | `src/hooks.js:1447-1449`, text `src/notices.js:607-616` |
| Drain flush / abortDrain re-posts after a handoff | `src/handoffwiring.js:265-314` |
| Handoff kickoff (summary + history + doc summaries) | `src/handoff.js:358` through the adapter at `src/handoffwiring.js:213-219` |
| `DOC_SUMMARY_PROMPT` / `OPEN_POINTS_PROMPT` to the old primary | `src/handoffwiring.js:384-390` |
| Endless-cycle kickoff block, appended to the kickoff | `src/endless.js:766` → same adapter |
| Spawn task prompt (project snapshot + task) — lands in the **subagent's** session | `src/tools.js:787` |

### 1.3 The marking round-trips on 1.18.25

This repository's own live capture shows it for the running version. In
`test/e2e/out/11-endless.new-session-messages.json` the handoff kickoff is stored as

```
role=user  parts=[ { type: "text", metadata: {"agentIntercom": true},
                     text: "## Stand / Aktueller Zustand\n\nLetztes Ziel: …" } ]
```

— a normal user message, metadata preserved verbatim. Text parts in that dump carry
exactly `id, messageID, sessionID, type, text, metadata`.

`isPluginGeneratedMessage` (`src/pluginmsg.js:120-139`) reads that marker; its consumer
is `lastUserGoal` (`src/handoff.js:845-867`), which uses it to keep plugin text out of
the handoff's goal scan, with a text-prefix backstop (`src/pluginmsg.js:155-166`). The
marker is unconditional, so hidden and visible postings are recognised alike. The
retroactive sweep (§3.3) identifies a notice part by the same marker
(`isIntercomNoticePart`, `src/client.js:1032`).

### 1.4 Model-only paths, invisible regardless of the switch

`experimental.chat.system.transform` (`src/index.js:283-290`, `src/hooks.js:457-850`)
rewrites `output.system` wholesale. The orchestration and subagent guides, the project
block and the limits block travel there and never enter `session.messages`. The
active-subagent snapshot, the abort notice and the subagent over-budget STOP notice are
delivered by `createTransformMessages` (`src/hooks.js:951-1022`) as a synthetic text part
on a primary's last user message, and for a subagent in a carrier message appended at the end
of the array (`tailNoticeCarrier`, `src/hooks.js:907`) — the same mechanism opencode uses for its own per-turn
reminders. None of them is ever rendered, so the switch does not govern them.

### 1.5 The sidebar, and what it can and cannot do

`tui/src/tui.tsx:1738-1832` registers one sidebar section (`sidebar_content`, rendered by
`SubagentPanel` at `tui/src/tui.tsx:1833`). It reads sessions and messages
(`api.client.session.messages` at `tui/src/tui.tsx:1328`) but renders no message: the plugin
TUI API of 1.18.25 exposes slots for `app`, `home_*`, `session_prompt*` and `sidebar_*`
only — `TuiHostSlotMap`, `node_modules/@opencode-ai/plugin/dist/tui.d.ts:355-386`. There is
no slot inside the transcript. A plugin cannot re-render, filter or suppress the message
list from the TUI side; the switch therefore acts on the posted parts themselves.

The section ships hidden and needs room: it is off until `session.sidebar.toggle`
(`learnings.md:191-200`) and it overlays the content at 120 columns and below
(`learnings.md:220-235`).

## 2. What opencode 1.18.25 offers

A text part in opencode carries two optional booleans besides its text —
`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:142-157` (`TextPart`) and
`:1231-1244` (`TextPartInput`, i.e. accepted on the wire):

```ts
export type TextPartInput = {
  id?: string; type: "text"; text: string;
  synthetic?: boolean; ignored?: boolean;
  time?: {...}; metadata?: { [key: string]: unknown };
}
```

Their meaning comes from opencode's MCP content mapping, which is where the two flags are
minted from an `annotations.audience` list. In the installed binary
`~/.opencode/bin/opencode`:

```js
function aP(C){ if(C?.length===1&&C[0]==="assistant") return {synthetic:!0};
                if(C?.length===1&&C[0]==="user")      return {ignored:!0}; return {} }
function eP(C){ let P=C.synthetic?["assistant"]:C.ignored?["user"]:void 0;
                if(!P) return {}; return {annotations:{audience:P}} }
```

**`synthetic` = for the assistant only. `ignored` = for the user only.** They are opposites;
the plugin sets only `synthetic` and never `ignored`.

- **The renderer skips a synthetic part.** The user-message component computes its text
  as `U.parts.map(a => a.type==="text" && !a.synthetic ? a.text : null).filter(Boolean)
  .join("\n\n")` and wraps its whole bubble — the bordered box, the padding, the text — in a
  `Show when={b()}` on that string. A user message whose only text part is synthetic
  produces the empty string and renders **nothing at all**: no bubble, no empty box.
  Upstream: `packages/tui/src/routes/session/index.tsx:1374-1383`. The navigation and
  palette sites select a message's text with
  `find(p => p.type==="text" && !p.synthetic && !p.ignored)` and skip a message that has
  none, so a hidden notice is also absent from jump-to-message and the session-title source.
- **The model still gets it.** The user→model conversion filters on `ignored` and never
  looks at `synthetic`:
  `for (let z of V.parts) { if (z.type==="text" && !z.ignored && z.text!=="")
  X.parts.push({type:"text", text:z.text}) … }`. Upstream:
  `packages/opencode/src/session/message-v2.ts:195-210`.
- **A posted part can be changed afterwards.** opencode serves
  `PATCH /session/{sessionID}/message/{messageID}/part/{partID}`, in a route group annotated
  "Experimental HttpApi session routes" at version 0.0.1. The mutation publishes
  `message.part.updated` carrying the whole part, which a drawn TUI applies without a resync.

What opencode does not offer: no plugin hook mutates a message before it is rendered
(`experimental.chat.messages.transform`, `node_modules/@opencode-ai/plugin/dist/index.d.ts:259-264`,
is the model payload, not the view); no TUI slot inside the message list (§1.5); no config
key that hides messages (`Config.tui` holds only `scroll_speed`, `scroll_acceleration` and
`diff_style`, `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1033-1051`).

## 3. The switch

### 3.1 The setting

- **File key:** `showAgentcom`, in the shared `~/.config/opencode/agent-intercom.json`.
  Taken from the file only as a real boolean (`src/settings.js:744-746`); anything else
  leaves the env-or-default resolution standing.
- **Env var:** `OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM`, `"1"` / `"0"` through `envBool`
  (`src/settings.js:599`).
- **Default:** `true` — `DEFAULT_SHOW_AGENTCOM`, `src/settings.js:383`, and the TUI's own
  copy at `tui/src/settings-file.ts:289`.
- **Precedence:** file key over env var over default, as for every key of the file.
- **Read:** per send, through `getSettings()` (cached for `TTL_MS = 2000`,
  `src/settings.js:414`; the settings-file watch of §3.3 invalidates the cache on a write).

The server-side path end to end:

| Step | Location |
|---|---|
| Server default | `src/settings.js:383` |
| Env read | `src/settings.js:599` |
| File validator | `src/settings.js:744-746` |
| Read at send time | `src/client.js:259`, `:371-372` |
| Limits sentence | `src/hooks.js:1492`, `:1556-1560` |
| Retroactive sweep | `src/agentcomsync.js`, started at `src/index.js:147` |

The TUI half:

| Step | Location |
|---|---|
| TUI type | `tui/src/settings-file.ts:139` |
| TUI default | `tui/src/settings-file.ts:289` |
| TUI validator entry | `tui/src/settings-file.ts:362` |
| TUI env read / file read | `tui/src/settings-file.ts:450`, `:487` |
| TUI writers `setShowAgentcom` / `toggleShowAgentcom` | `tui/src/settings-file.ts:807-816` |
| Panel accessor + handler | `tui/src/tui.tsx:483`, `:522-524`, props at `:1791-1792`, types at `:1890-1891` |
| Panel row | `tui/src/tui.tsx:2575-2584` |
| Cross-half parity pin | `test/settings-defaults-parity.test.js` |

### 3.2 Which sends are governed

- `postNotice` — **always governed**. Every one of its callers targets a primary
  (`postParentNotice`, `src/teardown.js:177-242`; the drain paths,
  `src/handoffwiring.js:265-314`). It stamps `hidden: !showAgentcom`.
- `promptSession` — **governed per call site** through the option `hideable`, default
  `false` (`src/client.js:369`):
  - `src/handoffwiring.js:213-219` (the handoff / endless kickoff adapter) → `hideable: true`;
  - `src/handoffwiring.js:384-390` (`promptOldPrimaryFor`: doc-summary, open-points) →
    `hideable: true`;
  - every other call site passes no `hideable` and stays visible: the spawn task prompt
    (`src/tools.js:787`), the `reuse` follow-up (`src/tools.js:1272`), the wind-down
    subagent prompt (`src/handoffwiring.js:438`) and the mid-run `message` delivery
    (`src/midrun.js:239-248`). Each lands in a **subagent's** session and is that session's
    instruction.

The post is the wake: `session.promptAsync` is the only mechanism that starts a turn in an
idle primary, so a hidden notice is still posted in full and still wakes the orchestrator.
Only its rendering changes; the text, the metadata marker and the message in the session
store are the same as with the switch on.

### 3.3 The switch is retroactive

The switch governs the parts already in the transcript, not only the ones posted from then
on. `startAgentcomVisibilityWatch` (`src/agentcomsync.js:152-170`, started once per process
from the plugin factory at `src/index.js:147`) watches the **directory** of the settings
file with `fs.watch` — the TUI replaces the file rather than rewriting it in place — and,
`AGENTCOM_WATCH_DEBOUNCE_MS = 120` after the events of one write settle, compares the
resolved `showAgentcom` with the last value seen. A fallback tick every
`AGENTCOM_FALLBACK_INTERVAL_MS = 300000` ms runs the same comparison for a write the watch
did not report. The first observation only records; a value already off at start is not a
flip.

On a flip, `syncAgentcomVisibility` (`src/agentcomsync.js:75-98`) sweeps the union of two
session sets:

- the tracked primaries (`primarySessions`, `src/state.js`) — every orchestrator that has
  called one of the plugin's tools in this process;
- the sessions this process has posted switch-governed traffic into
  (`agentcomSessionIds`, `src/client.js:480-501`) — every `postNotice` target and every
  hideable `promptSession` target, which covers the fresh orchestrator a handoff creates
  before it has called a tool.

For each session `applyAgentcomVisibility` (`src/client.js:1155-1233`) reads the history,
collects newest-first every plugin-marked text part whose `synthetic` differs from the
target, and PATCHes up to `MAX_VISIBILITY_PATCHES = 200` of them through the part route of
§2 (`patchPartSynthetic`, `src/client.js:1092`), via the client's own transport and only
through a bare `fetch` at `serverUrl` for a client that has none. Everything is
best-effort: every failure is logged and swallowed, a failure before any part is written
ends that session's sweep, and a server that does not answer the route leaves the notices
exactly as they were posted. One sweep runs at a time.

A session outside both sets — an old orchestrator session reopened after an opencode
restart that has not used the plugin since — keeps the flags its notices were posted with
until it uses the plugin again. The spawn task prompt is not hideable, so its subagent
session enters neither set.

### 3.4 The orchestrator is told the user cannot see its notices

While `showAgentcom` is off, `formatLimitsNotice` (`src/hooks.js:1519`, assembled at
`src/hooks.js:678`) — the runtime block the primary receives every turn — carries one
sentence:

> Subagent results and handoff messages are hidden from the user's screen. The user sees
> only what you write. Relay the substance of a subagent's result in your own answer.

In solo mode the whole block is reduced to its hidden-postings form ("what this plugin
posts into your session is hidden from the user's screen. The user sees only what you
write."), and is empty while the switch is on (`src/hooks.js:1528-1534`).

### 3.5 Tool results are not governed

`spawn` / `abort` / `list` / `reuse` and the other plugin tools return text that is the
return value of a tool the model itself called, not a message the plugin posted. opencode
renders it under `tool_details_visibility`, a runtime toggle the user owns through
`session.toggle.actions`, which the plugin's panel surfaces as the `tool details` row
(read at `tui/src/tui.tsx:870`, dispatched at `:872`).

### 3.6 The panel row

`show agentcom` is the third row of the panel's **TUI settings** group, directly under
`thinking` and `tool details` (`tui/src/tui.tsx:2575-2584`):

```
  show agentcom   [on] / [off]
```

A click calls `toggleShowAgentcom` (`tui/src/settings-file.ts:814-816`), which flips the
value the file holds at that moment through the read-modify-write path `applySetting`, and
disarms a pending `mode` confirmation (`alsoDisarmAgentMode`, `tui/src/tui.tsx:1792`). The
row takes effect without a restart: new postings read the setting per send, and the
retroactive sweep of §3.3 brings the existing ones to the switch's current value.

## 4. What the user loses with the switch off

- **A finished subagent's output is not on screen.** The completion notice is its only
  rendered copy: the subagent's own session is deleted at teardown (`src/teardown.js:567`)
  unless retention holds it for a `reuse`. The text stays in the primary's message store and
  `session.messages` returns it, flag and all, but nothing in the TUI displays it.
- **The wake is unexplained on screen.** The orchestrator resumes with nothing visible
  above it; the sentence of §3.4 makes the orchestrator relay the substance itself.
- **The sidebar does not close this gap.** Its rows carry handle, state, age, ctx tokens and
  an abort control and no result text, and a row disappears when the subagent finishes,
  leaving the `✓ N done` counter (`tui/src/tui.tsx:2253`).

What stays visible: the toasts beside the notices — `${handle} finished`, variant `success`
(`src/hooks.js:2323-2327`), plus the ones on spawn (`src/tools.js:875`), on a stuck subagent
(`src/hooks.js:1454-1458`) and on a scheduled handoff (`src/hooks.js:600-605`, `:670-674`).
Toasts are not transcript.

## 5. Assumptions, and what would show them wrong

- **A message whose only text part is synthetic still starts the turn.** The model-message
  builder skips only messages with zero parts (`if (V.parts.length===0) continue`); a
  hidden notice has one and survives the `!ignored && text!==""` filter. Wrong if, with the
  switch off, a subagent finishes and the orchestrator never answers; the debug log
  (`~/.cache/opencode-agent-intercom/debug.log`) would show `notified primary of
  completion` with no turn following.
- **`promptAsync` accepts `synthetic` on input and persists it.** It is a first-class field
  of `TextPartInput` (`types.gen.d.ts:1231-1244`). Wrong if the prompt call returns 400 —
  visible as `postNotice: retrying after failure` in the debug log and, once the retries are
  exhausted, as a lost wake.
- **Nothing renders for an all-synthetic user message.** Read from the `Show when` guard
  around the whole bubble (§2). Wrong if an empty bordered box appears where a notice was.
- **The part route stays served.** It carries no compatibility promise. A server that drops
  or changes it makes the flip non-retroactive — later postings still follow the switch —
  and logs `agentcom visibility patch failed` / `refused`.
- **An opencode version that stops honouring `synthetic` degrades, it does not break.** The
  text renders again; the model sees exactly what it saw before.
- **The primary context measurement is unaffected.** `latestContextTokens`
  (`src/context-figure.js`, reached through `fetchSnapshot`, `src/client.js`) reads
  assistant token counts, and the hidden text still reaches the model, so the handoff and
  endless thresholds see the same numbers with the switch on or off.
- **`ignored` is never set by this plugin.** It would take a notice out of the model
  payload while leaving it on screen.

## 6. Tests

- `test/settings-defaults-parity.test.js` — both halves share `DEFAULT_SHOW_AGENTCOM`, take
  the file key only as a real boolean, let the file win over the env var, and read the env
  var as `1`/`0` only.
- `test/show-agentcom.test.js` — the server-side resolution: default on, file boolean,
  env `1`/`0`, file over env, an unreadable file, and a `hideChatter` key in the file
  leaving `showAgentcom` untouched.
- `test/pluginmsg.test.js` — `intercomTextPart` with and without `hidden`; `postNotice` and
  `promptSession` stamping per setting and `hideable`; a hidden part still recognised as
  plugin-generated and skipped by the goal scan.
- `test/agentcom-retroactive.test.js` — `applyAgentcomVisibility` (marker selection, hide
  and show, no request when nothing is stale, transport vs. bare `fetch`, the early end on a
  first failure, the cap keeping the newest parts) and `syncAgentcomVisibility` (first
  observation records, flip in both directions, the sweep sets, one attempt per flip).
- `test/agentcom-watch.test.js` — the settings-file watch: a write or a replace sweeps
  without the tick, an unchanged value sweeps nothing, a missing directory leaves the watch
  startable.
- `test/plugin.test.js`, `test/nested-delegation.test.js` — the limits sentence of §3.4.
- `test/tui-settings-write.test.js` — `toggleShowAgentcom` flips the value on disk and
  leaves the other keys untouched.
