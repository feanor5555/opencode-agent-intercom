# opencode-agent-intercom-tui

> **The cockpit for your local-LLM team. Live.**

Without this panel, your orchestrator knows what's happening — and you don't.

The main [`opencode-agent-intercom`](../README.md) plugin injects a live
subagent snapshot into the orchestrator's *hidden* system prompt. You only
see it if you stop and ask. After a while, you stop asking. You fly blind.

This plugin puts that snapshot — and every runtime knob worth tuning — right
in your opencode sidebar.

```
┌─ ▼ Subagents (2) ──────────────────────────┐
│   coder#1      busy   6.2 K   0:42   [✕]   │
│   designer#1   idle   2.1 K   1:08   [✕]   │
└────────────────────────────────────────────┘
┌─ ▼ Limits ─────────────────────────────────┐
│   max subagents   [-]   3   [+]            │
│   max Token(k)    [-]  40   [+]            │
│   thinking        [on]                     │
│   tool details    [on]                     │
└────────────────────────────────────────────┘
┌─ ▼ LLM params    [<] orchestrator  [>] ────┐
│   temperature    [-]  0.70 [+]   ★         │
│   top_p          [-]  0.90 [+]             │
│   top_k          [-]    40 [+]   ★         │
│   min_p          [-]  0.05 [+]             │
│   repeat_penalty [-]  1.05 [+]             │
│                                            │
│   [reset current agent]                    │
└────────────────────────────────────────────┘
```

## What you can do from here

- **See every subagent, always.** Name, status, context size, age — live. No
  more "what's the coder doing right now?" detours through the orchestrator.

- **Open a subagent's full transcript** in one click. Watch its work.
  Stuck? Hit **✕** to abort. The orchestrator is told *why* and re-plans.

- **Tune the framework live.** `max subagents`, `max Token(k)`, thinking and
  tool-details visibility — change them, the running plugin picks it up in
  ~2 seconds. **No opencode restart.**

- **Sample your model per role.** Different temperature for the
  `orchestrator`, your `coder`, your `designer`. Plus llama.cpp specifics
  (`min_p`, `repeat_penalty`, `chat_template_kwargs`) routed through
  `output.options`. A `★` marks an override; `[reset current agent]` drops
  back to the role's default. **Applies on the next LLM call.** Find the
  sweet spot for *your* model without leaving opencode.

- **Stay oriented.** When a subagent finishes and its session vanishes, the
  panel drops you back into the orchestrator chat — not the home page.

Every change is written to a file under `~/.config/opencode/`. The main
plugin watches. There is nothing else to wire.

## Interaction

**Mouse**

- Click a subagent's **name** → opens its session.
- Click the trailing **✕** → aborts that subagent.
- Click any **▼** section header → collapse / expand.
- Click any `[-]` / `[+]` → adjust value (hold for hot-repeat).

**Keyboard** (focus the panel first — `Alt+A` or click the header)

| Key | Action |
|---|---|
| `Alt+A` | Focus the subagent panel |
| `j` / `k` / arrows | Move selection |
| `Enter` | Open the selected subagent's session |
| `x` (or `d`) | Abort the selected subagent |
| `Esc` | Unfocus the panel |

## Install

The installer for the main plugin
(`npx opencode-agent-intercom-install`, run from your project) adds this TUI
plugin automatically. Restart the opencode TUI to see the panel.

Manual fallback — TUI plugins are registered in
`~/.config/opencode/tui.json` (user-global, **not** `opencode.json`):

```json
{
  "plugin": ["opencode-agent-intercom-tui"]
}
```

Local checkout? Point at the **built file** directly — opencode does not
resolve a TUI plugin from a directory path:

```json
{
  "plugin": ["/path/to/opencode-agent-intercom/tui/dist/tui.js"]
}
```

Run `npm run build` here first.

## Build (contributors)

```sh
npm install
npm run build      # tsup → dist/tui.js
npm run typecheck
```

Runtime deps (`@opentui/*`, `solid-js`, `@opencode-ai/plugin`) are provided
by opencode and marked `external` in the build. They live as
`devDependencies` here only — adding them as `peerDependencies` would
shadow opencode's own copies at runtime and break loading.

## License

MIT — see [LICENSE](../LICENSE).
