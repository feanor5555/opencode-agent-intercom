# Hideable agent chatter — the plugin's own messages stop rendering, keep reaching the model

Sources for the opencode behaviour of §2: the installed binary
`/home/user/.opencode/bin/opencode`, the installed packages under `node_modules/@opencode-ai/`,
this repository's live capture `test/e2e/out/11-endless.new-session-messages.json`, and the
upstream check recorded in `work/research-opencode-message-visibility.md`.

Boundary: the plugin at `/home/user/opencode-agent-intercom`, both halves — the server-side
plugin under `src/` and the sidebar plugin under `tui/`. Against opencode `1.18.25`.

Today every text the plugin pushes between the orchestrator and its subagents stands in the
chat transcript as an ordinary user-role message. In stock opencode a user never sees agents
talking to each other. This design makes that traffic invisible on screen without taking it
away from the model, behind one switch.

## 1. What the code does today

### 1.1 Two send-side chokepoints, one marking helper

Every visible posting the plugin makes goes through exactly one of two functions, and both
of them build their text part with the same helper:

- `postNotice(client, sessionID, text)` — `src/client.js:34-63`, body
  `{ parts: [intercomTextPart(text)] }` at `src/client.js:40-45`, wrapped in the
  retry loop driven by `postNoticeRetries`.
- `promptSession(client, { sessionID, agent, prompt })` — `src/client.js:85-90`, body
  `{ agent, parts: [intercomTextPart(prompt)] }`.
- `intercomTextPart(text)` — `src/pluginmsg.js:40-46`, returns
  `{ type: "text", text, metadata: { agentIntercom: true } }`. The module is a deliberate
  pure leaf ("imports nothing so BOTH sides can share it", `src/pluginmsg.js:25-28`).

`src/pluginmsg.js:26-27` states the invariant this design leans on: "postNotice +
promptSession are the only two functions in src/ that call session.promptAsync".

### 1.2 What reaches the primary's transcript through them

| Kind | Call site |
|---|---|
| Subagent completion notice (handle, full result, task outcome, spawn-size, free slots) | `src/hooks.js:670-674` → `postParentNotice` (`src/teardown.js:24-35`) |
| Error / abort notice | `src/hooks.js:752-761`, text `src/notices.js:110-121` |
| Watchdog timeout notice | `src/watchdog.js:118-122`, text `src/notices.js:95-103` |
| Denial-loop notice | `src/hooks.js:444-446`, text `src/notices.js:123-132` |
| Drain flush / abortDrain re-posts after a handoff | `src/handoffwiring.js:186-218` |
| Handoff kickoff (summary + history + doc summaries) | `src/handoff.js:249` through the adapter at `src/handoffwiring.js:146-150` |
| `DOC_SUMMARY_PROMPT` / `OPEN_POINTS_PROMPT` to the old primary | `src/handoffwiring.js:274-278` |
| Endless-cycle kickoff block, appended to the kickoff | `src/endless.js:310` → same adapter |
| Spawn task prompt (project snapshot + task) — lands in the **subagent's** session | `src/tools.js:262-264` |

### 1.3 The marking already round-trips on 1.18.25

This repository's own live capture proves it for the running version. In
`test/e2e/out/11-endless.new-session-messages.json` the handoff kickoff is stored as

```
role=user  parts=[ { type: "text", metadata: {"agentIntercom": true},
                     text: "## Stand / Aktueller Zustand\n\nLetztes Ziel: …" } ]
```

— a normal user message, metadata preserved verbatim, nothing about it marked internal.
Text parts in that dump carry exactly `id, messageID, sessionID, type, text, metadata`.

`isPluginGeneratedMessage` (`src/pluginmsg.js:56-75`) reads that marker; its only consumer
today is `lastUserGoal` (`src/handoff.js:674-695`), which uses it to keep plugin text out of
the handoff's goal scan, with a text-prefix backstop (`src/pluginmsg.js:98-102`).

### 1.4 Model-only paths, already invisible

`experimental.chat.system.transform` (`src/index.js:110-117`, `src/hooks.js:133-282`)
rewrites `output.system` wholesale. The orchestration and subagent guides, the project
block and the limits block travel there and never enter `session.messages`. The
active-subagent snapshot, the abort notice and the subagent over-budget STOP notice are
delivered by `createTransformMessages` (`src/hooks.js:363-414`) as a synthetic text part
on the last user message — the same mechanism opencode uses for its own per-turn
reminders — so the system prompt keeps a byte-identical cached prefix across turns and
only the breakpoint on the trailing messages misses. They are out of scope: they are
already invisible.

### 1.5 The sidebar, and what it can and cannot do

`tui/src/tui.tsx:1051-1564` renders one sidebar section. It reads sessions and messages
(`api.client.session.messages` at `tui/src/tui.tsx:729`) but renders no message: the plugin
TUI API of 1.18.25 exposes slots for `app`, `home_*`, `session_prompt*` and `sidebar_*`
only — `TuiHostSlotMap`, `node_modules/@opencode-ai/plugin/dist/tui.d.ts:355-386`. There is
no slot inside the transcript. A plugin cannot re-render, filter or suppress the message
list from the TUI side.

The section also ships hidden and needs room: it is off until `session.sidebar.toggle`
(`learnings.md:179-188`) and it overlays the content at 120 columns and below
(`learnings.md:206-219`).

### 1.6 The existing boolean, end to end

`endlessMode` is the reference path and every step of it is one line:

| Step | Location |
|---|---|
| Server default | `src/settings.js:120` |
| Env read | `src/settings.js:234` via `envBool` (`src/settings.js:182-187`) |
| File validator | `src/settings.js:291-296` |
| TUI type | `tui/src/settings-file.ts:52` |
| TUI default | `tui/src/settings-file.ts:84` |
| TUI validator entry | `tui/src/settings-file.ts:124` |
| TUI env read / file read | `tui/src/settings-file.ts:161`, `:171` |
| TUI writer | `tui/src/settings-file.ts:313-323` |
| Panel signal + handler | `tui/src/tui.tsx:322`, `:348-350`, prop at `:981`, type at `:1074` |
| Panel row | `tui/src/tui.tsx:1371-1379` |
| Cross-half parity pin | `test/settings-defaults-parity.test.js` |

## 2. Feasibility: what opencode 1.18.25 actually offers

A text part in opencode carries two optional booleans besides its text —
`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:142-160` (`TextPart`) and
`:1235-1247` (`TextPartInput`, i.e. accepted on the wire):

```ts
export type TextPartInput = {
  id?: string; type: "text"; text: string;
  synthetic?: boolean; ignored?: boolean;
  time?: {...}; metadata?: { [key: string]: unknown };
}
```

Their meaning comes from opencode's MCP content mapping, which is where the two flags are
minted from an `annotations.audience` list. In the installed binary
`/home/user/.opencode/bin/opencode`:

```js
function aP(C){ if(C?.length===1&&C[0]==="assistant") return {synthetic:!0};
                if(C?.length===1&&C[0]==="user")      return {ignored:!0}; return {} }
function eP(C){ let P=C.synthetic?["assistant"]:C.ignored?["user"]:void 0;
                if(!P) return {}; return {annotations:{audience:P}} }
```

**`synthetic` = for the assistant only. `ignored` = for the user only.** They are opposites,
and only the first is the one wanted here.

The two halves that make it work:

- **The renderer skips it.** The user-message component in the same binary computes its text
  as `U.parts.map(a => a.type==="text" && !a.synthetic ? a.text : null).filter(Boolean)
  .join("\n\n")` and wraps its whole bubble — the bordered box, the padding, the text — in a
  `Show when={b()}` on that string. A user message whose only text part is synthetic
  produces the empty string and therefore renders **nothing at all**: no bubble, no empty
  box. Upstream: `packages/tui/src/routes/session/index.tsx:1374-1383`. The navigation and
  palette sites are consistent — they select a message's text with
  `find(p => p.type==="text" && !p.synthetic && !p.ignored)` and skip a message that has
  none, so a hidden notice is also absent from jump-to-message and the session-title source.
- **The model still gets it.** The user→model conversion filters on `ignored` and never
  looks at `synthetic`:
  `for (let z of V.parts) { if (z.type==="text" && !z.ignored && z.text!=="")
  X.parts.push({type:"text", text:z.text}) … }`. Upstream:
  `packages/opencode/src/session/message-v2.ts:195-210`. opencode uses `synthetic` for its
  own model-facing wrappers, e.g. `{synthetic:!0, text:"Called the Read tool with the
  following input: …"}` and the MCP resource notes — text that exists to be read by the
  model and by nobody else.

What is **not** available, checked and ruled out:

- No plugin hook mutates a message before it is rendered.
  `experimental.chat.messages.transform` (`node_modules/@opencode-ai/plugin/dist/index.d.ts:259-264`)
  hands over `{ messages: { info: Message; parts: Part[] }[] }` and is the **model payload**,
  not the view — that is why `rewritePendingTools` (`src/hooks.js:1013-1040`,
  wired at `src/index.js:119-121`) can repair tool state there without the screen changing.
- No TUI slot inside the message list (§1.5).
- No config key hides messages: `Config.tui` holds only `scroll_speed`,
  `scroll_acceleration` and `diff_style`
  (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1033-1051`). `thinking_mode` and
  `tool_details_visibility` are runtime KV keys, not config
  (`tui/src/tui.tsx:557-565`).
- Deleting is not designed on. opencode does expose delete routes for a message and for a
  part, and `session.revert` / `session.unrevert`
  (`node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:192-198`). All of them remove
  persisted data: the notice would leave the model's stored history as well, so the
  orchestrator would lose the very text that woke it. A hidden message stays in the session;
  only its rendering changes.

## 3. What is decided, and what it costs

### 3.1 The posting cannot be dropped — the post *is* the wake

`session.promptAsync` is the only mechanism the plugin has for making an idle primary start
a turn; that is the stated purpose of `postNotice` (`src/client.js:32-33`, "Wakes a session
with a plain-text notice"). A system-prompt block only lands on a turn something else
started, so moving a completion notice into `transformSystem` would mean the orchestrator is
never woken and a finished subagent's result never arrives. This rules out the
suppress-and-carry-in-the-system-prompt option for every notice.

Which information must reach the model, and therefore may only be hidden, never dropped:

- the subagent's **result text** — after teardown it is the only copy the process holds; the
  subagent's own session is deleted (`src/teardown.js:92`);
- the fact and reason a subagent ended (error, abort, timeout) plus the freed slot count —
  without it the orchestrator's slot arithmetic and its re-dispatch decision are wrong;
- the denial-loop notice, which is what makes the orchestrator ask the user about an abort;
- the handoff kickoff and the doc-summary / open-points prompts — a successor orchestrator
  with no kickoff has no task at all.

Nothing in the plugin's posted traffic is decoration.

### 3.2 The mechanism: `synthetic: true` on the posted text part

Recommended. One optional field on the part the plugin already builds in one place.

| Option | Cost | What it forecloses | What it demands of the builder |
|---|---|---|---|
| **A. `synthetic: true` on the part** (recommended) | One optional field in `intercomTextPart`, one settings read in `client.js` | Nothing; the flag is per message and the switch can be flipped at any time | One argument threaded through two functions and three call sites |
| B. Suppress the post, carry the text in the system prompt | Would need a per-session notice store, a retention rule and a re-injection block | Forecloses the wake entirely (§3.1) | Rejected |
| C. Post a one-line carrier, swap the full text in at `experimental.chat.messages.transform` | A second mechanism, a per-LLM-call scan of the whole history, and a risk of writing the expanded text back into the stored part | Leaves one visible line per notice, so it never reaches "invisible" | Kept as the fallback if A's wake assumption fails (§5) |
| D. Collapse rather than remove — post the head line only | Cheapest of all | Destroys the model's copy of the result unless combined with C | Rejected as the primary: it does not meet the goal |
| E. Filter in the plugin's own TUI half | — | Impossible: no message-list slot (§1.5) | Rejected |
| F. Delete the message after delivery | — | Removes it from the model too (§2) | Rejected |
| G. `ignored: true` | — | Exactly inverted: the text leaves the model payload and stays on screen | Rejected |

A wins because it is the separation opencode itself maintains for its own model-facing text,
it needs no second data path, no retention policy and no history rewriting, and it leaves
the message intact in the session store — switching the setting off makes later messages
visible again with no migration.

### 3.3 One switch, not three

Recommended: **one** boolean, `hideChatter`.

The three kinds a user could in principle split — notices, kickoffs, tool results — do not
split by intent. Whoever wants a transcript that looks like stock opencode wants the wake
notices *and* the handoff kickoff gone, and the kickoff is the single largest block of the
three. Splitting would cost a second key through all eleven places of §1.6 and would force
every send site to declare its kind, for a distinction with no use behind it. Tool results
are excluded for a different reason and are not a second switch (§3.7).

- **File key / server field:** `hideChatter`, in the shared
  `~/.config/opencode/agent-intercom.json` beside `endlessMode`.
- **Env var:** `OPENCODE_AGENT_INTERCOM_HIDE_CHATTER`, `"1"` / `"0"` through `envBool`.
- **Default:** `false`. The plugin's own precedent for a mode that changes what the user
  sees or what the loop does is off-by-default (`DEFAULT_ENDLESS_MODE = false`,
  `src/settings.js:117-120`), and here the stake is concrete: with the switch on, a finished
  subagent's result is nowhere on screen and its session is already deleted (§4). That loss
  is the user's to accept, not the plugin's to impose. Flipping the default later is one
  constant on each half plus the parity test.
- **Scope:** the flag is read at send time and stamped on the part. It governs messages
  posted after the flip; a message already posted keeps the flag it was posted with.

### 3.4 Which sends are hidden

- `postNotice` — **always hideable**. Every one of its callers targets a primary
  (`postParentNotice`, `src/teardown.js:24-35`; the drain paths,
  `src/handoffwiring.js:186-218`). It reads the setting itself.
- `promptSession` — **opt-in per call site**, new option `hideable`, default `false`:
  - `src/handoffwiring.js:146-150` (the handoff / endless kickoff adapter) → `hideable: true`
  - `src/handoffwiring.js:274-278` (`promptOldPrimaryFor`: doc-summary, open-points) →
    `hideable: true`
  - `src/tools.js:262-264` (spawn task prompt) → left at `false`. That message lands in the
    **subagent's** session and is that session's entire instruction; hiding it would leave a
    user who opens a subagent session looking at a transcript that begins with an answer to
    nothing.

Defaulting `hideable` to `false` makes a send path added later visible until someone decides
otherwise — the safe direction for a visibility flag, and the opposite of the metadata
marker, which is inherited for free on purpose.

### 3.5 The shape of the change in code

`src/pluginmsg.js` stays a pure leaf; the decision is made in `client.js`, which already
imports `settings.js`:

```
intercomTextPart(text, { hidden = false } = {})
  → { type: "text", text, ...(hidden ? { synthetic: true } : {}),
      metadata: { agentIntercom: true } }
```

`postNotice` passes `{ hidden: getSettings().hideChatter }`; `promptSession` passes
`{ hidden: hideable && getSettings().hideChatter }`. The metadata marker is unchanged and
unconditional, so `isPluginGeneratedMessage` and the handoff's goal scan keep working on
hidden and visible messages alike, and the text-prefix backstop
(`src/pluginmsg.js:88-102`) still matches because the text itself is untouched.

Nothing else in `src/` changes behaviour. No new module, no new state, no new event.

The `chat.message` hook (`src/index.js:135-141`) could stamp the flag centrally instead, since
it can mutate parts before they are persisted. It is not chosen: it fires for every message
including the user's own, so it would have to re-derive from the metadata marker what
`client.js` already knows at send time, and it would put the decision one hop away from the
two functions that own it.

### 3.6 The orchestrator is told, once, that the user cannot see this

With the switch on, the orchestrator's completion notice is the only place a subagent's
result exists, and the user cannot read it. One sentence therefore goes into the runtime
block the primary already receives every turn — `formatLimitsNotice()`
(`src/hooks.js:465`, assembled at `src/hooks.js:228` and pushed at `src/hooks.js:267`),
appended only while `hideChatter` is on:

> Subagent results and handoff messages are hidden from the user's screen. The user sees
> only what you write. Relay the substance of a subagent's result in your own answer.

`formatLimitsNotice` is chosen over `ORCHESTRATION_GUIDE` because it is already dynamic,
already re-read per turn, and already reaches the custom-template path unchanged as the
`limits` placeholder (`src/hooks.js:236-247`) — a new placeholder would be a contract change
for user templates.

### 3.7 Tool results are not part of this change

`spawn` / `abort` / `list` / `list_open` / `todo_done` return text
(`src/tools.js:303-310, 383-387, 401-403, 413-449, 457-458`). That text is the return value
of a tool the model itself called, not a message the plugin pushed, and opencode renders it
under `tool_details_visibility` — a runtime toggle the user already owns through
`session.toggle.actions`, which this plugin's own panel already surfaces at
`tui/src/tui.tsx:1416-1424` (read at `tui/src/tui.tsx:561-565`). Hiding it from the plugin
side would take a working user choice away and would need a second, unrelated mechanism,
since a tool result is not a message part. It stays the user's to hide.

### 3.8 The panel row

One row in the plugin's own settings group, directly under `endless`
(`tui/src/tui.tsx:1371-1379`), same two-valued shape:

```
  hide chatter   [on] / [off]
```

It goes in the plugin group rather than beside `thinking` and `tool details`, because those
two write opencode's KV store through `api.keymap.dispatchCommand` while this one writes the
plugin's own JSON file through the same read-modify-write path as `endlessMode`
(`applySetting`, `tui/src/settings-file.ts:236-260`). Grouping by writer keeps the panel's
two halves honest about which file a click touches.

## 4. What the user loses when it is on

Stated plainly, because it is real:

- **A finished subagent's output is nowhere on screen.** The completion notice was the only
  rendered copy: the subagent's own session is deleted at teardown
  (`src/teardown.js:92`). The text is not destroyed — it stays in the primary's message
  store and `session.messages` still returns it, flag and all — but nothing in the TUI
  displays it.
- **The wake is unexplained.** The orchestrator resumes with nothing above it. Whoever reads
  the transcript later sees an answer with no question.
- **Switching the flag off does not bring old messages back.** The flag is stamped per
  message at send time. Only messages sent after the flip render.

**The sidebar does not close this gap**, and it should not be claimed that it does. It ships
hidden and needs `session.sidebar.toggle` first (`learnings.md:179-188`); below 121 columns
it overlays the chat instead of docking beside it (`learnings.md:206-219`); its rows carry
handle, state, age, ctx tokens and an abort control and **no result text**; and a row
disappears the moment the subagent finishes, leaving only the `✓ N done` counter
(`tui/src/tui.tsx:1300-1306`). It tells the user that something is running, never what came
back.

What does carry the user through, and is enough:

- the completion toast that already fires beside every notice — `${handle} finished`,
  variant `success` (`src/hooks.js:675-679`), plus its siblings on spawn
  (`src/tools.js:302`), on a stuck subagent (`src/hooks.js:449-453`) and on a scheduled
  handoff (`src/hooks.js:199-204`, `:221-226`). Toasts are not transcript and stay visible
  with the switch on;
- the sentence of §3.6, which makes the orchestrator itself the channel: it is told the user
  cannot see the notice and must relay its substance. That is the honest fix for an
  unexplained wake — the explanation comes from the agent that was woken.

## 5. Assumptions, and what would show them wrong

- **A message whose only text part is synthetic still starts the turn.** The turn is started
  by the prompt endpoint, and the model-message builder skips only messages with zero parts
  (`if (V.parts.length===0) continue`) — ours has one, and it survives the `!ignored &&
  text!==""` filter. Unverified end to end. Wrong if, with the switch on, a subagent
  finishes and the orchestrator never answers; the debug log
  (`~/.cache/opencode-agent-intercom/debug.log`) would show
  `notified primary of completion` with no turn following. The fallback is option C of
  §3.2: a one-line visible carrier plus a synthetic payload part in the same message.
- **`promptAsync` accepts `synthetic` on input and persists it.** It is a first-class field
  of `TextPartInput` (`types.gen.d.ts:1235-1247`), unlike `metadata`, which is opaque and
  was verified empirically at `src/pluginmsg.js:14-23`. Wrong if the prompt call starts
  returning 400 — visible as `postNotice: retrying after failure` in the debug log and, once
  the retries are exhausted, as a lost wake.
- **Nothing at all renders for an all-synthetic user message.** Read from the `Show when`
  guard around the whole bubble (§2). Wrong if the screenshot of step 5 shows an empty
  bordered box where a notice used to be; the remedy is the same fallback C, which gives the
  box something to say.
- **An opencode version that stops honouring `synthetic` degrades, it does not break.** The
  part is a normal text part with an extra boolean: an implementation that ignores the flag
  simply renders the text again. The user sees chatter return; the model sees exactly what
  it saw before; nothing is lost and nothing has to be migrated. Wrong only if a future
  version rejects unknown-to-it flag combinations at the API, which would surface as a 400
  on the very first notice after an upgrade.
- **The primary context measurement is unaffected.** `latestContextTokens`
  (`src/client.js:283`) reads assistant token counts, and the hidden text still reaches the
  model, so the handoff and endless thresholds see the same numbers as today. Wrong if the
  measured `ctx` drops noticeably after switching the flag on, at the same workload.
- **`ignored` is never set by this plugin.** It is the inverse flag and would silently take
  a notice out of the model payload while leaving it on screen. Wrong if it ever appears in
  a `session.messages` dump of a plugin-sent part; the e2e capture of step 5 is where that
  would be seen.

## 6. The steps, and the order they run in

Each step leaves the tree building and `npm run check` / `npm test` green.

1. **Settings plumbing, both halves, flag dormant.** `DEFAULT_HIDE_CHATTER = false` and the
   `hideChatter` field, env read and file validator in `src/settings.js` (mirroring
   `:120`, `:234`, `:291-296`); the same three plus the type in
   `tui/src/settings-file.ts` (`:52`, `:84`, `:124`, `:161`, `:171`); the writers
   `setHideChatter` / `toggleHideChatter` beside `setEndlessMode`
   (`tui/src/settings-file.ts:311-323`); the key added to
   `test/settings-defaults-parity.test.js` and to the file-shape comment at
   `src/settings.js:48-54`; the README row beside
   `OPENCODE_AGENT_INTERCOM_ENDLESS_MODE` (`README.md:338`). Nothing reads the flag yet.
   Depends on nothing.
2. **The mechanism.** `intercomTextPart(text, { hidden })` in `src/pluginmsg.js`;
   `postNotice` and `promptSession` in `src/client.js` resolve `hidden`; the `hideable`
   option added and set at `src/handoffwiring.js:146-150` and `:274-278`. Tests extend
   `test/pluginmsg.test.js`, which already pins that both chokepoints mark their part.
   Depends on step 1.
3. **The orchestrator sentence.** The conditional tail in `formatLimitsNotice`
   (`src/hooks.js:465`). Depends on step 1 only; independent of step 2.
4. **The panel row.** Signal, handler, prop and row in `tui/src/tui.tsx` along the
   `endlessMode` path (`:322`, `:348-350`, `:981`, `:1074`, `:1371-1379`); a write test
   beside `test/tui-settings-write.test.js`. Depends on step 1 only; independent of 2 and 3.
5. **Live verification, once.** With the flag on, one `opencode serve` run through
   `test/e2e/run-task.sh`: a screenshot of the session showing the orchestrator's answer
   with no notice and no empty bubble above it, saved under `work/screenshots/`; and the
   run's own `out/*.full-messages.json` showing the notice part present with
   `"synthetic": true`, `"metadata": {"agentIntercom": true}` and its text intact. The pair
   is the proof: hidden on screen, kept in the store. Depends on 2, 3 and 4.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `getSettings()`: no file → `hideChatter: false`; `"hideChatter": true` → true;
  `"true"`, `1`, `null` → false without throwing; the env var resolves when the file is
  silent and loses to the file when it is not.
- `intercomTextPart`: without the option → no `synthetic` key at all (not `false`);
  with `{ hidden: true }` → `synthetic: true`; the metadata marker present in both cases and
  the text byte-identical.
- `postNotice`: with the setting off the posted part has no `synthetic` key; with it on the
  part carries `synthetic: true` — asserted on the captured `promptAsync` body, the way
  `test/pluginmsg.test.js` already captures it.
- `promptSession`: setting on and `hideable` absent → visible; setting on and
  `hideable: true` → hidden; setting off and `hideable: true` → visible.
- `isPluginGeneratedMessage` and `lastUserGoal` still skip a hidden message — the marker is
  independent of the flag.
- `formatLimitsNotice`: the sentence appears only while the setting is on.
- Parity: `test/settings-defaults-parity.test.js` pins `hideChatter` at the same default,
  the same env name and the same file-over-env order on both halves.
- TUI: `toggleHideChatter` flips the value on disk and leaves `endlessMode`,
  `maxSubagents` and `agentContext` untouched; a rejected value for one key does not drop
  the others (`pruneSettings`, `tui/src/settings-file.ts:207-222`).

## 8. Open, and outside this boundary

- Whether the default should become `true` once the user has lived with the switch. That is
  a preference, and the change is one constant on each half plus the parity pin.
- Whether the sidebar should grow a place to read a hidden notice back — the text is in the
  session store and `api.client.session.messages` already reaches it
  (`tui/src/tui.tsx:729`). Deliberately not designed here: §3.6 covers the need through the
  orchestrator, and a second reader of the transcript in the sidebar is a feature of its
  own.
- `promptAsync` also accepts `noReply?: boolean`
  (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:2329-2342`), which posts a message
  without starting a turn. Unused here, and the tool for the opposite need — a record that
  must not wake the orchestrator.
