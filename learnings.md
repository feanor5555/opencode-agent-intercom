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
