# opencode-agent-intercom

Version 1.7.3. OpenCode plugin that lets the primary agent spawn one-shot subagents non-blocking, wakes it when each finishes, and enforces the orchestrator delegation pattern. Entry point `src/index.js`; loaded by opencode via the host project's `plugin` array.

## Documents

- [README.md](README.md) — what the plugin does and how it is used.
- [learnings.md](learnings.md) — durable findings about running this plugin under opencode. Read this before debugging a load or visibility problem (e.g. opencode resolves external plugins once, at instance bootstrap).
- [work/](work/) — run reports and analyses: check runs, code reviews, research notes, security reviews.
- [concepts/](concepts/) — design concepts and procedures produced for this project.
- [test/e2e/README.md](test/e2e/README.md) — the live `opencode serve` end-to-end harness and its `run-all.sh` driver.

## Checks and tests

- `npm run check` — runs `node --check` over every `src/*.js`.
- `npm test` — runs the `node --test` unit suite under `test/` (concurrency 1). No CI.
- E2E drivers under `test/e2e/` (`run-task.sh`, `multi-task.sh`, `run-all.sh`) talk to a real `opencode serve`; they are opt-in, see `test/e2e/README.md`.

## Installation

The plugin is installed into a test project by an absolute path in that project's `opencode.json` `plugin` array. opencode reads that file once at instance bootstrap, so the opencode instance must be restarted for the plugin to take effect.
