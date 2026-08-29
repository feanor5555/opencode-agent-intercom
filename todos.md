# todos.md

Pending actions for the opencode-agent-intercom project. Only open work — no findings, no measurements, no history. When an item lands, delete the line.

## Context (standing constraints, not todos)

- The plugin is wired into `/home/user/testopencode` by absolute path — `plugin` in its `opencode.json` for the server half, `.opencode/tui.json` for the TUI half — deliberately NOT via `npx opencode-agent-intercom-install`, because the installer would wire an npm cache copy and local edits would never reach it.
- The forum search does NOT use a provider-side domain filter.

## Pending

- Implement `concepts/override-visibility.md`: the silent override concept covers both the project-agent-markdown collision (its `permission` merge policy, finding register, toast, log and stable system-prompt block) and the stale customised prompt-file case (contract probes, `PROMPT_CONTRACT` stamp, `{{guide}}` placeholder). It also rewires primary-agent identification away from `detectAgentFromSystem ?? "orchestrator"` to a `chat.message`-driven map plus `default_agent`.
- Untracked subdirectories under `work/` from TUI verification runs: `work/tui-verify-2/` and `work/abort-fix-check/` — decide whether they belong in the tree, get renamed, or are removed.
- The TUI's ceiling-list filter (`tui/src/settings-file.ts:116` `if (agent.mode === "primary") continue;`) and the spawn gate in `src/tools.js:355` (`if (!SPAWNABLE_ROLES.includes(args.agent))`) read on different fields: the TUI filters on `mode !== "primary"` in addition to role membership, while the gate reads the name alone. A project that overrides an installed role's `mode` to `primary` therefore stays spawnable but drops out of the sidebar. Decide on the gate's side whether that divergence should be resolved (gate consults resolved `mode`, or TUI stops filtering by `mode`).
- Tidy-up: `tui/src/settings-file.ts` carries the TUI half's role lists (`AGENT_NAMES`, the prompt-file set, the spawnable set, the per-type budget table) although its header describes it as the on-disk settings store. A dedicated `tui/src/agent-roles.ts` would fit better — move the role lists there and keep `settings-file.ts` to settings I/O.
