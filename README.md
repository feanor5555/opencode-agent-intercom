# opencode-agent-intercom

> **Make your local LLM ship real features. Without the wait. Without the context bloat.**

**Built for local LLMs in the 3–40 B range** (currently tested daily on a 9 B
model). Designed around the failure modes of small models — short contexts,
shaky planning, weak tool selection — not retrofitted from a frontier-model
pattern.

You spin up a local model on your own hardware, point
[opencode](https://opencode.ai) at it, and… it kind of works. Edits one file,
then forgets the project. Calls `task`, your terminal hangs for four minutes,
comes back with garbage. Melts down at 80 % context. You go back to the cloud.

**This plugin closes that gap.**

It turns a modest local model into a workflow-driven team. A long-living
**primary** that coordinates and **never blocks** — keep steering,
course-correct mid-flight, or fan out subagents in parallel while the first one
runs. One-shot subagents do exactly one job in their own lean context, reply,
and disappear. The framework guards your model's most precious resource — its
context window — at every layer.

The difference between *"interesting demo"* and *"this just shipped feature X."*

## Install

```sh
npx opencode-agent-intercom-install
```

That is the whole setup. The installer wires both halves of the plugin
(server-side + sidebar TUI), builds universal-ctags so `outline` works, fetches
Chromium for the `pw` browser CLI, and writes a `.bak` of every config file it
touches. Restart opencode. Done.

Manual fallback: add `"opencode-agent-intercom"` to your project's
`opencode.json` `plugin` array and `"opencode-agent-intercom-tui"` to
`~/.config/opencode/tui.json` (user-global, **not** the project file). The TUI
plugin does **not** resolve from a directory path — for a local checkout,
point at the built file directly (`/path/to/.../tui/dist/tui.js`, after
`npm run build` in `tui/`).

### How you actually see it

After restarting opencode, two things still have to happen before the
`Subagents` panel paints:

1. **Turn on the sidebar.** opencode ships the sidebar hidden. The toggle is
   the opencode command `session.sidebar.toggle` (palette entries `Show
   sidebar` / `Hide sidebar`, default keybind `<leader>b` — i.e. `Ctrl+X`
   then `b`). Without this step the plugin loads but you see nothing of it.
   Note: when the sidebar is already open the palette offers `Hide sidebar`,
   so a literal search for `show sidebar` returns no result — that is the
   command doing the right thing, not a missing entry.
2. **Enter or create a session.** The panel only renders on a session
   route — the home screen has no sidebar slot. Open or start a session
   and the right sidebar (its own column beside the content, not an
   overlay) shows `Subagents (N)` with `● N running · ✓ M done` counters,
   agent rows with an `x` abort control and an age, plus `max subagents`
   and a per-agent-type context ceiling: an agent cycler and the selected
   type's ceiling in k tokens (with `★` marking a type that has its own
   value and `off` for a ceiling of `0`; stepping a type's own value below
   zero drops the entry so it falls back to the inherited ceiling again),
   and collapsed `TUI settings` / `LLM params` / `Prompts` sections.
   opencode 1.18.25 offers no layout choice — the
   SDK's `layout` field is `"auto" | "stretch"` and marked deprecated with
   "Always uses stretch layout", and `tui.json` has no `sidebar` block,
   no width, no position. The column takes its width from the content
   area and that is not configurable.

The plugin manager (toggle the plugin on/off, install updates) lives at
`Ctrl+P` → `Plugins` → `Enter`. Inside the panel, `Alt+A` focuses the
subagent list; `j`/`k` move, `Enter` opens a session, `x` aborts.

Each live row is labelled `handle · topic (Model)` — for example
`coder#1 · Searching fo… (Luna)` — with the `↳ <age> · <k> ctx` line
unchanged beneath it. The **topic** is the opencode session title: the
spawn tool sets it from the `description` argument, and where the caller
gave none the title falls back to the opening characters of the task
prompt with a redundant `<agent>: ` prefix stripped before display. The
**model** is the agent's own entry in `~/.config/opencode/llm-models.json`,
shortened to its display name before any parenthesis; an agent with no
configured model renders the row without that parenthesised part at all.
The parts are sized against the panel's actual laid-out width: the
handle is kept whole, the model next, and the topic takes the remainder
and is dropped below a minimum rather than wrapping the row onto a
second line.

## What this gives you that stock opencode doesn't

- **The primary never blocks. Ever.** opencode's native `task` is blocking —
  your terminal sits there. Our `spawn` returns in ~200 ms. Keep typing, ask
  the orchestrator something, fan out three more subagents in parallel. The
  primary is yours, always.

- **A primary that lasts dozens of turns.** Hard tool-gating on the
  orchestrator (it coordinates only — no edits, no shells), an 8 KB cap on
  subagent replies, and a live snapshot of running work injected each turn
  instead of a status-poll tool. Its context stays clean for the long haul.
  When the orchestrator's context does approach the limit, the plugin hands
  the session off to a fresh orchestrator — the threshold is configurable
  (`OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT`, default 80 000 tokens), and
  **endless mode** raises it to a much higher ceiling for a self-restarting
  loop. Both paths share the same handoff mechanism.

- **No MCP servers — and that's the *feature*.** Every MCP server permanently
  injects 1–2 KB of tool descriptions into *every* LLM call. For a 200K
  frontier model: fine. For your 32K local model: **5 % of your window, every
  turn, forever**. We ship custom thin tools instead — `web_search` at ~300 B,
  plus `outline`, `pw`, `gen`. Same capabilities, a fraction of the cost.

- **`outline` over `read`.** Which file defines `processInvoice`? Outline six
  candidates (one line of signatures each) instead of `read`ing all six and
  drowning your model in 40 KB of unrelated bodies. **~95 % token savings**
  vs `read` for orientation, measured.

- **Role-aware prompt slimming.** Roles that do not need `AGENTS.md`
  (`researcher`/`designer`/`gitter`) get it stripped — ~17 KB saved per LLM
  call for those roles. opencode's "you are powered by …" boilerplate is
  stripped globally for all roles.

- **A TUI sidebar that is a *co-pilot*, not a viewer.** Live-tunable subagent
  concurrency, context budget, per-agent sampling params (temperature, top-p,
  min-p, repeat-penalty…), visibility toggles, subagent list always on screen,
  hot-repeat on `[-]`/`[+]`. Every change live on the next LLM call.

- **A structured workflow baked into the system prompt.** Definition → design
  → architecture → milestones → tasks → implementation → review. State lives
  in `AGENTS.md`, so your project is resumable across restarts. Zero
  per-project prompt engineering.

- **Graceful context-limit handling.** When a subagent runs out of context, it
  does not die and it does not hallucinate. The plugin tells *the parent*
  (which still has headroom) so the orchestrator can re-plan. We never
  auto-abort. You are always in charge.

- **Nine consolidated roles**, not 11+. Orchestrator + 8 specialists, each
  with a narrow, complete prompt. We tried more. Fewer was better — small
  models pick decisively when the menu is short.

Add it up: a stock opencode orchestrator turn costs 20–25 K prompt tokens.
Under this plugin: 5–10 K. Your model spends what is left on actual
*thinking* — not on re-reading its own toolbox.

## What a session feels like

```
you: implement a search modal with keyboard shortcuts
orchestrator: spawning coder#1...
              (200 ms later — your turn is back)

you: actually also make sure it works on mobile
orchestrator: noted. I'll have coder#1 cover both, and I'll
              spawn designer#1 for the visual. Slot 2/2 used.

[both subagents working in parallel — you keep typing]

you: how's it going?
orchestrator: coder#1 is at 6 K ctx, editing src/search/modal.tsx.
              designer#1 just finished — output at designs/search.webp.

coder#1 idle: implemented + tests passing. Files: src/search/modal.tsx,
              src/search/modal.test.tsx. Want a reviewer pass?

you: yes
orchestrator: spawning reviewer#1...
```

The primary never blocks. You stay in the driver's seat the entire time.

## Tools

| Tool | Purpose | Who |
|---|---|---|
| `spawn(agent, prompt, description?)` | Start a subagent non-blocking. Returns a handle (`researcher#1`). | Orchestrator |
| `abort(subagent)` | Cooperatively abort and hard-deny further tool calls. User-requested stops. | Orchestrator |
| `list()` | List active subagents. | Orchestrator |
| `todos_open()` | List open tasks from `TODO.md` with their stable id (`T5`) and `accept:` criterion. | All agents |
| `todo_add(title, accept?)` / `todo_edit(id, …)` / `todo_done(id)` | Add / refine / remove a task in `TODO.md`. `todo_done` deletes the completed task — usually the wake-hook does it for you. | The six deliverable roles |
| `web_search(query, numResults?)` | Anonymous web search via Exa (no key, 150/day; an Exa key lifts the cap). | Subagents |
| `forum_search(query, keywords?, numResults?)` | Discussion-forum search (Exa + searxng with forum-only engine bangs). Use for lived user experience; `web_search` for docs/releases/official facts. | Subagents (except `gitter`) |
| `outline(path)` | Top-level declarations of a source file via universal-ctags. ~100 languages, ~95 % token savings vs `read`. | Subagents (except `designer`/`gitter`) |

Subagents are one-shot: **spawn → run → reply → destroyed.** The primary is
woken automatically with the full (capped) result on completion. No
status-poll tool by design — small LLMs would call it in a loop.

### Task tracking that doesn't depend on the model remembering

`TODO.md` is the single source of truth for what's still open in the current
milestone. A deliverable-role subagent is spawned with a stable task id
(`spawn("coder", "T5: implement the export endpoint")`), it ends its reply with
a one-line marker (`DONE: T5`), and the wake-hook removes that task from
`TODO.md` for you — **deterministic, no LLM step**. A task in the file is open;
"done" means the line is gone. Mismatched ids (`spawn for T5` but `DONE: T3` in
the reply) are ignored as hallucinations. The format is fixed:

```
- T5: <task title>
  accept: <one-line, observable "done" criterion>
```

The `T<n>:` prefix on a spawn prompt is opt-in: present it and the
wake-hook auto-removes the task on a matching `DONE:` line; leave it off
(status checks, ad-hoc questions) and the spawn runs without tracking. Any
agent can read fresh state via `todos_open()`; the deliverable roles manage the
list with `todo_add` / `todo_edit` / `todo_done`.

## Agent roles

Nine roles injected by the `config` hook — no per-project
`.opencode/agents/*.md` needed. A project can override any role by defining
one of the same name. Orchestrator is the default primary unless
`default_agent` is explicit.

| Agent | Role | Notes |
|---|---|---|
| `orchestrator` | Primary. Coordinates only. | Restricted to `spawn`/`abort`/`list`. |
| `planner` | Concept/design docs in `plans/`. | No `bash`. Researches current versions first. |
| `coder` | Implements code in thin vertical slices. | Bash, edit, build/test. Catch-all. |
| `debugger` | Diagnoses build/test/runtime errors. | Bash for repro, no `edit`/`write` — fix goes back to `coder`. |
| `reviewer` | Reviews staged work into `reviews/`, iterates on it. | No `bash`. Convention: no source-code edits. |
| `documenter` | Writes/iterates user docs in place (README, `docs/`, changelog). | No `bash`. Convention: no source-code edits. |
| `researcher` | Web research via `web_search` + `forum_search` + `webfetch`. | No `edit`/`write`/`bash`. |
| `designer` | Generates images via [`gen`](#gen--image-generation-no-api-key), researches visual refs on the web. | No `outline`. Convention: no source-code edits. |
| `gitter` | Repo operations matching project's git style. | No `edit`/`write`/`webfetch`/`web_search`/`forum_search`. |

## The TUI sidebar (companion plugin)

[`opencode-agent-intercom-tui`](tui/README.md) is the user-side co-pilot,
installed by the command above. Surfaces the live subagent snapshot and
exposes every runtime knob:

- **Subagent list** — open-session, abort (✕), keyboard navigation.
- **`max subagents [-N+]`** and a per-agent-type context ceiling —
  an agent cycler plus the selected type's ceiling in k tokens, with `★`
  marking a type with its own value and `off` for a ceiling of `0`.
  Writes `~/.config/opencode/agent-intercom.json` as
  `"agentContext": { "<agent>": tokens }`, picked up within ~2 s.
  A type with no entry of its own falls back to the flat legacy
  `maxContext` key in the same file, then to the env var
  `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT`, then to a built-in per-type
  default, then to 40 000. `0` is a real value at every level and means
  the budget is disabled for that type.
- **`thinking [on/off]`** / **`tool details [on/off]`** — opencode's
  built-in visibility toggles.
- **`hide chatter [on/off]`** — hides the plugin's own notices
  (subagent completion messages, handoff kickoffs, doc-summary prompts) from
  the transcript. The text part the plugin posts is stamped `synthetic: true`,
  which opencode's TUI does not render; the model still receives the text
  unchanged, so the orchestrator keeps being woken and keeps receiving its
  subagent results. The task prompt sent to a subagent stays visible by
  design — it is the subagent's entire instruction, not chatter — and tool
  results stay under opencode's own `tool_details_visibility`. Writes
  `~/.config/opencode/agent-intercom.json` as `"hideChatter": true|false`,
  picked up within ~2 s; env var `OPENCODE_AGENT_INTERCOM_HIDE_CHATTER`
  resolves with `1`/`0`. Default `false`. With the switch on, the transcript
  no longer shows why the orchestrator continues — the orchestrator is told
  to relay the substance itself.
- **Per-agent LLM sampling** — temperature, top-p/top-k, max-tokens, plus
  llama.cpp keys (`min_p`, `repeat_penalty`, `chat_template_kwargs`) routed
  through `output.options`. Writes `~/.config/opencode/llm-params.json`.
  Every parameter starts out unset (`not set` in the sidebar) — the plugin's
  roles set none, so nothing is sent until you set it.
- **Per-agent model** — `model [<name>]` cycles the models this opencode
  instance has configured (`/config/providers`, i.e. config + auth +
  `opencode.json` overrides), with a `not set` slot in front of the first
  entry that hands the agent back to opencode's own model. Writes
  `~/.config/opencode/llm-models.json` as
  `{"<agent>": {"providerID": "…", "modelID": "…"}}`; the `chat.message` hook
  applies it by setting `output.message.model`. Its own file, because the
  sampling params file is a number-valued map whose unknown keys are
  forwarded to the provider.
  The choice is applied by two hooks that share the same stored pair. The
  `config` hook writes it into `config.agent[<name>].model` (the
  `providerID/modelID` form opencode resolves an agent's model from), so
  it holds for every prompt of the instance — including ones the message
  hook never sees. That hook runs once at instance bootstrap, so a file
  change lands on the next opencode start. The `chat.message` hook still
  applies the same pair live by setting `output.message.model`, so an
  edit to the file takes effect on the next message without a restart.
  A choice stored for an opencode built-in agent that the project does
  not list in its `opencode.json` `agent` map is applied by the
  `chat.message` hook only — the `config` hook never creates an agent key.
- `[reset current agent]` drops that agent's sampling overrides *and* its
  model choice, returning every row to what opencode resolves.

Every change applies on the next LLM call. No opencode restart — with one
exception on the way back out. Once the `config` hook has pinned a model at
bootstrap, that string is what opencode resolves for the agent, so dropping
the choice again cannot simply fall through to it: the `chat.message` hook
puts back the `model` the pin displaced. For an agent that carried no model
before the pin there is nothing to put back, and dropping its choice takes
effect at the next opencode start.

## CLIs the subagents use

### `pw` — headless Chromium with persistent state

`coder` and `debugger` get a `pw` CLI in their shell — a thin wrapper around
[Playwright](https://playwright.dev) driving a **persistent** headless
Chromium. State survives across calls: navigate once, then `pw screenshot`,
`pw textContent`, `pw click` against the same page in separate shell
invocations.

```sh
pw start
pw goto http://localhost:3000
pw waitForSelector "#app" 5000
pw screenshot /tmp/page.png       # then `read /tmp/page.png`
pw textContent "main"
pw click "button.submit"
pw stop
```

All command names mirror Playwright's
[Page API](https://playwright.dev/docs/api/class-page) 1:1 — an LLM that
knows Playwright already knows `pw`. The escape hatch is
`pw evaluate '<expr>'` (any JS expression) or `pw evaluate --body '<js>'`
(multi-statement). First `pw start` fetches Chromium (~170 MB, one time).
Internally: detached daemon on a Unix socket under `$TMPDIR`.

### `gen` — image generation, no API key

The `designer` gets a `gen` CLI that turns a written brief into an image.
Two free backends, both without keys, with auto-fallback:

1. **Stable Horde** (default) — real SDXL/FLUX workers via
   [stablehorde.net](https://stablehorde.net), anonymous tier. **20–90 s**
   typical at public priority.
2. **Pollinations** — fast (~3–10 s) but only the `sana` model and a
   1024 px anon cap (lifted with `POLLINATIONS_TOKEN`).

```sh
gen "modern SaaS dashboard, dark theme, sidebar + KPI cards, no humans, no logos" \
    --out designs/dashboard.jpg --width 1920 --height 1080 --seed 42
```

Wait time is normal — Horde prints `queue_pos=N wait=Ms done=false` while
polling. The designer is instructed to keep paths under `designs/` and not
embed legibility-critical text in images (the model garbles letters).

## Configuration

All optional. The subagent and context caps usually live in
`~/.config/opencode/agent-intercom.json` (written by the TUI panel); that file
also takes `"searxngUrl"` and `"exaApiKey"`, each overriding its environment variable, and `"forumBangs"` (no env var — the array REPLACES the built-in set rather than extending it). Everything else is environment-variable-driven:

`forumBangs` defaults to `["!st", "!ubuntu", "!su", "!hn", "!lo"]` — Stack Overflow, Ask Ubuntu, Super User, Hacker News, lobste.rs. A non-empty `"forumBangs"` array in the file replaces this set entirely; an empty, missing, or non-array value leaves the defaults in effect. The key exists so a project whose topic lives on a product Discourse instance — `!dpy`, `!caddy`, `!pi` and the like — can list those engines once for the plugin to use.

| Variable | Default | Effect |
|---|---|---|
| `OPENCODE_AGENT_INTERCOM_DEBUG` | on | `"0"` disables logging to `~/.cache/opencode-agent-intercom/debug.log` |
| `OPENCODE_AGENT_INTERCOM_LOG_REQUESTS` | off | `"1"` writes per-LLM-call JSONL to `~/.cache/opencode-agent-intercom/requests.jsonl` (path override: `_LOG_REQUESTS_FILE`) |
| `OPENCODE_AGENT_INTERCOM_MAX_SUBAGENTS` | `1` | Concurrent subagents per primary. `"0"` disables. TUI file overrides. |
| `OPENCODE_AGENT_INTERCOM_MAX_CONTEXT` | `40000` | Subagent context budget (tokens). `"0"` disables. TUI file overrides. |
| `OPENCODE_AGENT_INTERCOM_RESULT_CHARS` | `8000` | Cap on a subagent's final reply forwarded to the primary. `"0"` disables. |
| `OPENCODE_AGENT_INTERCOM_PROJECT_CONTEXT` | on | `"0"` skips the project snapshot prepended to spawn prompts |
| `OPENCODE_AGENT_INTERCOM_RESPECT_TASK_PERMS` | on | `"0"` ignores `permission.task` allowlist in `spawn` |
| `OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH` / `_DISABLE_OUTLINE` / `_DISABLE_FORUM_SEARCH` | off | `"1"` skips that tool |
| `OPENCODE_AGENT_INTERCOM_SKIP_CTAGS` / `_SKIP_CHROMIUM` | off | Installer-only: skip ctags build / Chromium download |
| `EXA_API_KEY` | — | If set, `web_search` uses Exa's paid tier. File key `exaApiKey` overrides. |
| `POLLINATIONS_TOKEN` | — | If set, the `gen` Pollinations fallback uses your account |
| `OPENCODE_AGENT_INTERCOM_ENDLESS_MODE` | off | `"1"` arms endless mode — replaces the orchestrator when its context reaches `endlessContext`, after saving its open points to the project's todo file. `"0"` switches it off. TUI file overrides. |
| `OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT` | `250000` | Orchestrator context threshold (tokens) while endless mode is on. Displaces the plain handoff threshold. `"0"` disables. TUI file overrides. |
| `OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS` | `600000` | How long (ms) one endless cycle waits for the last subagent to finish before abandoning. |
| `OPENCODE_AGENT_INTERCOM_ENDLESS_MAX_CYCLES` | `10` | Cycle ceiling per opencode process. At the ceiling endless mode writes itself off. `"0"` arms no ceiling. |
| `OPENCODE_AGENT_INTERCOM_HIDE_CHATTER` | off | `"1"` hides the plugin's own postings — subagent notices, handoff kickoff, doc-summary prompts — from the transcript. Their text still reaches the model unchanged. `"0"` shows them. TUI file overrides. |

## Endless mode

Endless mode turns the orchestrator handoff into a self-restarting loop. With
the switch on, the orchestrator's context is watched against
`OPENCODE_AGENT_INTERCOM_ENDLESS_CONTEXT` (default 250 000 tokens) — a higher
ceiling than the plain handoff threshold (`OPENCODE_AGENT_INTERCOM_MAX_PRIMARY_CONTEXT`,
default 80 000 tokens), and the one in effect while endless mode is on. When
the ceiling is reached the orchestrator is replaced by a fresh orchestrator
session, which is told to work the project's todo file off; that fresh session
reaches the ceiling in turn and is replaced again, and so on.

A cycle runs in this order:

1. **Trigger.** The orchestrator's turn-end hook sees the context cross
   `endlessContext` and sets a pending latch. `spawn` then refuses new
   subagents from that orchestrator until the cycle ends, so an orchestrator
   that spawns as fast as its subagents finish can never starve the cycle.
2. **Quiesce.** On the orchestrator's `session.idle`, the cycle waits for every
   running subagent in the process to finish, bounded by
   `OPENCODE_AGENT_INTERCOM_ENDLESS_QUIESCE_TIMEOUT_MS` (default 10 minutes).
   A timeout abandons the cycle rather than aborting a working subagent —
   killing real work to save context is the loss the mode exists to prevent.
3. **Save.** The orchestrator is asked to state its open points in plain text;
   the plugin parses the reply and writes one task per point into the
   project's todo file (`TODO.md` / `todos.md`), then reads the file back and
   confirms every id it just wrote is there. The orchestrator itself has no
   file-writing tool (`PRIMARY_TOOLS` is `spawn` / `abort` / `list`), so the
   plugin does the writing on its behalf. Any failure here abandons the cycle
   without replacing the session — replacing the orchestrator after failing
   to save its open points is the data loss the mode exists to prevent.
4. **Replace.** The plain orchestrator handoff runs with an additional kickoff
   block naming the todo file and the confirmed task ids; the old orchestrator
   is archived, the new one starts with the instruction to work the file off.
5. **Work off.** The new orchestrator runs normally — it spawns subagents, the
   wake-hook ticks tasks off via the existing `DONE: T<n>` marker path, its
   context grows, and step 1 applies to it again.

### What bounds the loop

Endless mode is a loop, so it switches itself off rather than waiting for
someone to watch it:

- **Nothing left to do.** When the orchestrator reports no new open points
  *and* the todo file has no open tasks, the mode writes itself off instead
  of starting a session that would have nothing to work on.
- **No progress.** If the open-task count has not fallen after
  `ENDLESS_MAX_STALLED_CYCLES` (2) consecutive cycles, the mode writes
  itself off — the bound against an orchestrator that saves the same points
  every cycle and never finishes one.
- **Cycle ceiling.** `OPENCODE_AGENT_INTERCOM_ENDLESS_MAX_CYCLES` (default
  10) cycles per opencode process. At the ceiling the mode writes itself
  off with a warning toast.
- **Failed-cycle cooldown.** A cycle that abandoned (quiesce timeout, save
  failure, handoff failure) arms a cooldown on that orchestrator so an
  already-over-threshold turn cannot retry on its next message; the cooldown
  lifts on its own.
- **The switch.** Turning the toggle off in the sidebar (or
  `OPENCODE_AGENT_INTERCOM_ENDLESS_MODE=0`) drops the latch at the next
  settings read; a cycle already past the save step still completes, because
  it has written to the todo file and must not leave the orchestrator
  half-replaced.

Every one of these stops writes `endlessMode: false` back to the settings
file (or leaves it alone); none of them deletes a session, aborts a subagent
or removes a task.

## Under the hood

Built for behaviour, not deference: the orchestration pattern is **enforced**,
not requested.

- **Primary tool-gating** — `tool.execute.before` rejects any tool call from
  a primary session other than `spawn`/`abort`/`list` (and denies two `list`
  calls in a row). The primary orchestrates; it cannot read, edit, run commands
  or fetch the web. Subagents are not restricted by this guard — their tool
  limits come from the per-role `permission:` map in `agents.js`, which also
  makes opencode strip the unavailable tools from the LLM schema so the model
  never sees them as options.
- **System-prompt injection** — `experimental.chat.system.transform` prepends
  the orchestration protocol and live subagent snapshot to primary sessions
  and a shorter discipline block to subagents.
- **Per-agent LLM overrides** — the `chat.params` hook merges
  `~/.config/opencode/llm-params.json` live into every request, and the
  `chat.message` hook sets `message.model` from
  `~/.config/opencode/llm-models.json` (TUI panel writes both files).
  `chat.params` cannot carry a model — its output holds only sampling fields.
- **Async spawn** — `spawn` owns subagent session creation (`session.create`
  + `promptAsync`) and returns immediately. The primary stays alive.
- **Wake** — opencode never re-activates an idle primary on its own. The
  `event` hook does, on `session.idle`, pushing the subagent's full (capped)
  result to the parent.
- **Soft-notify on context budget** — escalates over a few LLM turns; after
  three ignored injections, the parent is notified of the denial loop (with
  a TUI toast). Subagent stays alive. Abort is user-only (TUI ✕ or asking
  the orchestrator).
- **Race-safe subagent cap** — `pendingSpawns` reservation in the same turn
  prevents N parallel spawns from all seeing "slot free".

opencode's plugin API has no hook to make `task` itself non-blocking, so
removing every "do it yourself" tool from the primary is the enforcement lever.

## Limitations

- **Abort is best-effort.** `session.abort` is cooperative; the
  `tool.execute.before` hard-deny is the backstop.
- **No mid-flight subagent steering** — by design. Subagents are one-shot.
  Spawn a fresh one with a clearer prompt.
- **Solo-maintainer surface area.** `pw` daemon, `gen` CLI, Exa SSE parser,
  ctags subprocess, four opencode hooks. 86 unit tests, no CI against real
  opencode. Bugs are addressed at hobby-project pace.

## Development

```sh
npm run check   # syntax check (node --check)
npm test        # unit tests (node --test)
```

`npm test` needs Node 22.18 or newer (`devEngines.runtime` in
`package.json`): part of the suite imports the TUI stores from
`tui/src/*.ts` directly, and Node strips those types without a flag only
from that version on. The published package itself is plain ESM and runs on
Node 18 (`engines.node`); the TUI ships as a `node20` bundle under
`tui/dist`.

### Local development loop

With the plugin wired into a test project by path (see
[Project-scoped registration](#project-scoped-registration-that-works)):

- **Server (`src/*.js`)** has no build step. Save the file and restart
  opencode; the change is live.
- **TUI (`tui/src/tui.tsx`)** runs from `tui/dist/tui.js` and needs a build.
  `npm run dev` in `tui/` is `tsup --watch` and rebuilds on every change —
  run it in a separate terminal while working.
- **No hot reload for plugin code.** opencode resolves plugins once at
  instance bootstrap, so a restart is required either way. The live-applying
  settings in the sidebar are runtime knobs, not code.

Before debugging a load or visibility problem, read
[learnings.md](learnings.md) — durable findings about running this plugin
under opencode (plugin resolution at bootstrap, the accepted spec forms,
how to prove a plugin actually loaded, why the TUI half may be missing).

The loop: `npm run dev` in `tui/`, edit, restart opencode.

## License

MIT — see [LICENSE](LICENSE).
