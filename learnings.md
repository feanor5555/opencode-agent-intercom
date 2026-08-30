# Learnings

Durable, hard-won findings about running this plugin under opencode. Current
state only — no history, no rationale for changes. Append new findings at the
end; do not reorder.

## opencode resolves external plugins once, at instance bootstrap

A `plugin` entry added to `opencode.json` while an opencode instance is running
never reaches that instance — it must be restarted.

Evidence: a running `opencode acp` (PID 3291359) logged
`run=174ec834 message=loading path=/home/user/testopencode/opencode.json` at
12:59:54.621 UTC (14:59:54 local). The `plugin` line was written to that file
at 15:06:27 local — 6 min 32 s after the read. The plugin's debug log
(`~/.cache/opencode-agent-intercom/debug.log`) received no `agent-intercom
initialized` line from that instance. The next *fresh* start (`run=2600518b`,
15:10:25 local) initialised the plugin normally.

This is the single most likely cause when a correctly configured plugin "is not
there" — diagnose the staleness of the running instance before changing the
spec.

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-load.md`.

## Accepted plugin spec forms

`isPathPluginSpec` in the installed opencode 1.18.25:

```js
function Jq(q){
  return q.startsWith("file://")
      || q.startsWith(".")
      || w1(q)
}
function w1(q){
  return L.isAbsolute(q) || /^[A-Za-z]:[\\/]/.test(q)
}
```

Accepted forms:

- `file://` URL (three slashes for an absolute path).
- Relative path starting with `.`.
- Bare absolute path.

A single-slash `file:` prefix is NOT matched by `isPathPluginSpec`, but the
spec still loads. The npm-fallback branch accepts it as npm-package-arg
directory syntax; Arborist reifies it into a cache directory literally named
`file:` (`~/.cache/opencode/packages/file:/...`).

The plain absolute path is the clean form and avoids the npm reify and the
`file:` cache directory on every bootstrap. opencode normalises it internally
to `file:///home/user/opencode-agent-intercom`.

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-load.md`.

## An unrecognised plugin spec fails silently

The server-side loader passes an empty `missing` reporter
(`missing(N,V,D){}`), so a plugin that cannot be resolved is dropped with no
log line at any level. Absence of an error therefore proves nothing — the spec
may have been rejected silently.

The TUI-side loader does log it (`xF("tui plugin has no entrypoint", ...)`).

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-load.md`.

## How to prove a plugin actually loaded

Two checks, in increasing strength.

1. **`opencode debug info` in the project directory.** Bootstraps plugins
   without any model call. The plugin's own
   `agent-intercom initialized` line in
   `/home/user/.cache/opencode-agent-intercom/debug.log` (on by default per
   `src/index.js`) increments on every load. Count the lines before and
   after to confirm a delta.

2. **`opencode serve` in the project directory, then
   `GET /experimental/tool/ids`.** Lists the plugin's tools
   (`spawn`, `abort`, `list`, `todos_open`, `todo_done`, `todo_add`,
   `todo_edit`, `web_search`, `outline`).

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-load.md`.

## Reaching the TUI plugin manager

The reason is two-fold, both in our own configuration and packaging.

**1. The TUI reads its plugin list only from the tui config.**
`TuiConfig.loadState` fills `plugin_origins` from
`L(config,"tui")` (i.e. `~/.config/opencode/tui.json(c)`),
`OPENCODE_TUI_CONFIG`, `e("tui", directory)` (walking `<dir>/tui.json` up the
tree), and `.opencode/tui.json` (from any `.opencode` config dir on the way).
A `plugin` entry in `opencode.json` reaches the **server** plugin host only;
the TUI host never sees it. So a project needs its own
`.opencode/tui.json`, e.g.

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/plugin"]
}
```

alongside the `opencode.json` entry. The two halves are configured
separately; the `plugin` line in `opencode.json` must stay.

**2. The tui entry resolver accepts only `exports["./tui"]`** — or, for a
path spec, a **root** `index.{ts,tsx,js,mjs,cjs}`. `package.json` `main` is
explicitly ignored for the tui kind (`if($!=="server")return;` in
`vJ`), and an unresolvable tui entry is dropped silently — the TUI process
emits no plugin diagnostics and `grep -c "no entrypoint"` on
`~/.local/share/opencode/log/opencode.log` returns `0`. A path-spec plugin
**can** serve a TUI part; no npm publish is needed.

**Working shape for this project.**

- `package.json:7` — `exports: { ".": "./src/index.js", "./tui": "./tui/dist/tui.js" }`.
- `package.json:16` — `files` includes `tui/dist` (only relevant for an npm
  tarball).
- Build the TUI half with `npm install && npm run build` in `tui/`
  (tsup, `entry: { tui: "src/tui.tsx" }`, `format: ["esm"]`, `outDir: "dist"`
  → `tui/dist/tui.js`).
- `tui/src/tui.tsx` default-exports `{ id: "agent-intercom.tui", tui }`.
  The validator rejects a default export that carries both a `tui` and a
  `server` key.

**How to prove the TUI half loaded.** Start opencode against the project
directory with an **absolute path** — a positional `.` resolves against the
inherited working directory and silently tests the wrong project. Then
confirm either of:

- the TUI plugin metadata showing `id agent-intercom.tui` with target
  `file:///home/user/opencode-agent-intercom`, or
- `strace` catching the `openat` of `tui/dist/tui.js`.

**What does NOT cause the absence.** Agent tool permissions were cleared as
a non-cause: `opencode debug agent orchestrator` in the project shows all
nine plugin tools enabled (`spawn`, `abort`, `list`, `todos_open`,
`todo_done`, `todo_add`, `todo_edit`, `web_search`, `outline`).

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-visibility.md`.


## Project-scoped registration that works

Three working forms; choose one per project.

1. **`plugin` array in the project's `opencode.json`.** Global and project
   entries merge rather than replace (later sources win only for the same load
   identity; an empty later list does not clear earlier entries).

   ```json
   "plugin": ["/home/user/opencode-agent-intercom"]
   ```

2. **Drop-in file in `.opencode/plugin/` or `.opencode/plugins/`**
   (project), or `~/.config/opencode/plugins/` (global). The loader scans
   `Glob.scan("{plugin,plugins}/*.{ts,js}", { symlink: true })`, so both
   singular and plural directory names are accepted.

3. **npm package name.** opencode installs it itself via `Npm.add()` →
   Arborist `reify()` into `~/.cache/opencode/packages/<sanitized-spec>/`.
   No manual install step required (the docs' claim of `bun install` and
   `~/.cache/opencode/node_modules/` does not match this version's
   implementation).

Source: `/home/user/opencode-agent-intercom/work/research-opencode-plugin-scope.md`.

## Seeing the TUI half of the plugin

The TUI half renders as a right-side sidebar section titled `Subagents (N)`,
where `N` is the running subagent count. The sidebar is its own column beside
the content area (chat occupies the left two thirds; the sidebar does not
overlay the content). Two conditions must both hold for a user to see it:

1. **The sidebar must be activated.** The sidebar is NOT visible by default —
   it ships hidden. The toggle is the opencode command `session.sidebar.toggle`
   (palette entries `"Show sidebar"` / `"Hide sidebar"`, default keybind
   `<leader>b` — i.e. `Ctrl+X` then `b`, description *"in a session to show or
   hide the sidebar panel"*). When the sidebar is already open the palette
   offers only `Hide sidebar`, so a literal search for `show sidebar` returns no
   result — that is expected, not a missing command. Until the user runs the
   toggle the plugin loads successfully but the `Subagents` section never
   paints. Verified in the installed opencode 1.18.25 binary at
   `/home/user/.opencode/bin/opencode`.

2. **A session route must be active.** The `sidebar_content` slot is rendered
   inside the session view (the slot's `session_id` is bound to the active
   session). The home screen has no `sidebar_content` slot, so the section is
   empty on the home screen regardless of the toggle state. Enter or create a
   session first; only then does `Subagents (N)` appear.

**What the section renders** (from the right sidebar at runtime):

- Header `Subagents (N)`, counters `● N running · ✓ M done`.
- Agent rows such as `luna#1` with an `x` abort control and an age below
  (e.g. `4.0s`).
- `max subagents [-] N [+]` and `max Token(k) [-] N [+]` steppers.
- Collapsed sections `[▸] TUI settings`, `[▸] LLM params`, `[▸] Prompts`.

**Layout switches by terminal width, and is not configurable.** opencode
1.18.25 (same logic in 1.18.0, 1.18.4 and 1.17.19) picks one of two layouts by
terminal width:

- **Above 120 columns** the sidebar docks beside the content and the content
  reflows into a narrower column. Nothing is lost. Verified at 160 columns:
  with the sidebar open, each wrapped line continues where the previous one
  broke, and the wrap points match those of a 120-column terminal without a
  sidebar — the sidebar takes its hard-coded 42 columns off the content
  width. The sidebar also becomes visible automatically at this width (the
  internal `sidebar` KV state defaults to `"auto"`).
- **At 120 columns and below** the sidebar is drawn over the content. The
  underlying text keeps its full width and its right-hand part is simply not
  shown. Verified optically at 120, 100, 80 and 60 columns; the behaviour
  does not change anywhere in that range.

Practical consequence: if the sidebar covers the content, widen the terminal
past 120 columns. PuTTY's default of 80 columns is below the threshold.

**Distinguishing overlay from reflow.** Overlay and reflow are told apart by
the line STARTS, not the line ends. A line ending earlier with the sidebar
open proves nothing — that is what reflow looks like too. The test is whether
the following line begins with the words that fell off the end of the
previous one (reflow) or with the same words as in the sidebar-off capture
(overlay, the missing words are gone from the screen).

Evidence: `work/opencode-sidebar-160-{visible,hidden}.png`,
`work/opencode-sidebar-120-{visible,hidden}.png`,
`work/opencode-sidebar-100-{visible,hidden}.png`,
`work/opencode-sidebar-80-{visible,hidden}.png`,
`work/opencode-sidebar-60-{visible,hidden}.png`.

There is no configuration key for sidebar visibility, width, position, overlay
or split — neither in the official docs nor in the `tui.json` schema. The
sidebar's width is hard-coded at 42 columns. The SDK's `layout` field is
`"auto" | "stretch"` and marked deprecated with *"Always uses stretch
layout"*; `tui.json` has only `theme`, `keybinds` and `cursor` blocks, with
no `sidebar` block. The only documented sidebar setting is
`keybinds.sidebar_toggle` (default `<leader>b`). Upstream issue #6086 and
PR #6092 proposed a configurable overlay; neither is supported. The 1.18.0
release notes describe a Desktop v2 layout switch, not a TUI sidebar change —
no official 1.18.x release note describes any TUI sidebar layout change.

Sources: `/home/user/opencode-agent-intercom/work/research-sidebar-layout.md`,
`/home/user/opencode-agent-intercom/work/sidebar-layout-options.md`.

Combined navigation once everything is wired:

- **Plugin manager** — `Ctrl+P` → `Plugins` → `Enter` (palette registry
  `plugins.list`, `namespace: "palette"`; there is NO slash command for it).
  In the dialog `Space` toggles, `Shift+I` installs.
- **Subagents panel** — `Alt+A` focuses it (palette entry *"Focus the
  subagent sidebar panel for keyboard navigation"*). Inside the panel:
  `j`/`k` navigate, `Enter` opens a subagent session, `x` aborts, `Esc`
  unfocuses.
- **Plugin enable state** — `Space` in the Plugins dialog persists to
  `~/.local/state/opencode/kv.json` under key `plugin_enabled`. A cleared
  value here suppresses plugin loading on the next start; unsetting it
  restores the plugin.

Source: `/home/user/opencode-agent-intercom/work/diagnosis-plugin-visibility.md`
(verified against the installed opencode 1.18.25 binary).

## Local development loop with a path-wired test project

Two halves, different reload rules.

- **Server (`src/*.js`)** has no build step. Save the file, restart opencode,
  the change is live.
- **TUI (`tui/src/tui.tsx`)** runs from `tui/dist/tui.js`, so it needs a build.
  `npm run dev` in `tui/` is `tsup --watch` (entry `tui: src/tui.tsx`,
  `format: ["esm"]`, `outDir: "dist"`) and rebuilds on every change. Run it
  in a separate terminal while working.

**No hot reload for plugin code.** opencode resolves plugins once at instance
bootstrap, so a restart is required either way — both halves. The
live-applying settings in the sidebar are runtime knobs, not code.

The loop: `npm run dev` in `tui/`, edit, restart opencode.

## The per-agent model choice needs both hooks, not one

`src/llmmodel.js` applies `~/.config/opencode/llm-models.json` through two
interfaces, because neither covers the case on its own.

`chat.message` (`chatMessageHook`) sets
`output.message.model = { providerID, modelID }` for the current user
message: live, no restart, but per call — a prompt that reaches opencode
without going through the hook re-resolves the agent definition.

The `config` hook (`applyModelChoices`) writes the same choice into
`config.agent[name].model`, as the string `"providerID/modelID"` the
config form takes (`AgentConfig.model` in the opencode SDK types). That
holds for every prompt of the instance, but the hook runs once at
instance bootstrap, so a change to the file lands only on the next
opencode start.

Only agents already present in `config.agent` are touched. A choice
stored for an opencode built-in that the project does not list in its
`opencode.json` `agent` map therefore reaches only the message hook.

## System-prompt injection and opencode's caching

The plugin's `experimental.chat.system.transform` rewrites the array opencode passes in, then `provider/transform.ts:359-360` and `session/llm/request.ts:100-112` shape how that array reaches the provider.

- opencode joins everything it assembled — `agent.prompt`, `input.system` (env / instructions / MCP / skills), `user.system` — into a single string in `system[0]` before the hook fires (`request.ts:56-78`). The hook is handed a one-element array.
- `request.ts:56-78` collapses the array only when the plugin APPENDED to an untouched header (`length > 2 && system[0] === header`). The plugin clears the array and pushes two elements (`src/hooks.js:328-333`), so neither condition holds and order and element count survive verbatim.
- `request.ts:100-112` maps each array element to its own `role: "system"` message. The plugin's `[0]` and `[1]` are two distinct system messages, not one joined blob.
- `provider/transform.ts:359-360` (`applyCaching`) marks the first two system messages and the last two non-system messages. With two elements in the system array, both carry a breakpoint. Each element is its own cache scope: a hit on `[0]` reuses everything in front of it; a miss on `[1]` does not invalidate `[0]`.
- `output.system[0]` (stable mass): agent prompt (`slices.role`), AGENTS.md content (`slices.agentsMd`, kept for orchestrator / coder / debugger / reviewer), the role-specific guide strings from `src/prompts.js`, `projectMd`, and — because `parseOpencodeSystem` (`src/hooks.js:441-465`) takes everything from `Instructions from:` to the end of the joined blob — MCP instructions, skills, and `user.system`. The mass is stable across the turns of a session, given no edit to AGENTS.md / PROJECT.md / the role prompt / `~/.config/opencode/agent-intercom.json`.
- `output.system[1]` (`<env>` block from `src/hooks.js:441-465`, extracted verbatim from opencode's blob). Holds cwd, worktree, platform, git-repo flag, and the only `new Date().toDateString()` in the whole prompt path (`session/system.ts:81`). Element-level breakpoint means a calendar-day rollover or a `cd` costs the ~80 tokens of `<env>`, not the stable mass.
- Per-turn blocks — abort notice, active-subagent snapshot, over-budget STOP — ride on a synthetic text part appended to the last user message (`src/hooks.js:423`, factory at `src/hooks.js:390`), not in the system prompt. They live past the cached prefix and never invalidate it.

Latent caveats:

- A caller that sets `user.system` on a user message would land that text inside element `[0]` (it is captured into the `Instructions from:`…end span). Nothing in this project sets it; opencode never sets it itself. If a future caller does, element `[0]` invalidates per call.
- If opencode's marker strings change, `parseOpencodeSystem` returns `{ role: joined, env: "", agentsMd: "" }` (`src/hooks.js:442`): the rewrite degrades to one element with `<env>` embedded at its front. Per-day invalidation, not a corrupted prompt.

Anthropic-style `ttl: 1h` cache marker: not worth pursuing at the providers in use. DeepSeek (`deepseek-v4-flash`), MiniMax M3 native, and xAI Grok 4.6 cache prefixes automatically with no caller breakpoints or TTL. OpenAI GPT-5.6 Luna only supports `ttl: "30m"`. opencode merges plugin-supplied `providerOptions` rather than overwriting them (`provider/transform.ts:401`), so the setting would reach the provider — it simply has no documented effect at these four. The current two-element split with system breakpoints and a trailing-message synthetic part is what gives the cache its hit surface.

## A text-shaped answer in the primary's transcript is not a tool result

When a verification has to read back what a tool did, an answer that merely
*looks* like a prior tool output is not evidence that the tool ran. In this
project's message history a real call always carries a tool part; a model
echoing an earlier output has parts `step-start`, `text`, `step-finish` and no
tool part at all. Two independent checks catch it:

1. **Inspect the message parts.** A genuine tool result is one of the parts
   on the assistant message; the plain text parts around it are commentary,
   not the call. An answer with only `step-start`, `text`, `step-finish` and
   no tool part is the model reproducing its context verbatim.
2. **Sanity-check any figure that depends on `Date.now()`.** A row whose
   window read `9m left` at one timestamp and `9m left` again two minutes
   later cannot have been rendered twice; identical bytes across a gap no
   real render produces are the fingerprint of a replayed string.

Apply both before treating any text the primary quotes as a tool result.

## Global plugin wiring loads the plugin in every directory

opencode honours `plugin` in the global config at
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json` for the server
half and `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/tui.json` for the TUI
half (`.jsonc` also accepted on either side). Both paths are honoured, and
project `plugin` entries merge with the global ones rather than replace
them — a later entry of the same identity wins, and an empty later list
does not clear earlier entries. An absolute path works identically from
either place; a relative path resolves against the config file that
declared it.

With the absolute plugin path written into both global files, a fresh
`opencode` instance started in an empty scratch directory with no
`opencode.json` and no `.opencode/` loads the plugin normally:
`opencode debug info` reports
`plugins: - file:///home/user/opencode-agent-intercom`, the plugin's debug
log gains an `agent-intercom initialized` line, `opencode serve` serves
the plugin's tool ids (`spawn`, `abort`, `list`, the todo tools,
`web_search`, `outline`), and the TUI sidebar renders the subagent panel
reflecting the global `~/.config/opencode/agent-intercom.json`.

Source: `/home/user/opencode-agent-intercom/work/research-opencode-global-plugin-wiring.md`.
