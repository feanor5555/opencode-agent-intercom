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
