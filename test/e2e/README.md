# End-to-end agent tests

Live regression suite that talks to a real `opencode serve` instance, drives the
orchestrator through real spawns, and captures the resulting message tree.
Used to validate that plugin changes don't silently break agent behaviour and
that opencode upgrades don't shift the system-prompt composition.

## Layout

- `run-task.sh <agent> <task> <prefix>` — single-agent harness. Creates one
  primary session, asks the orchestrator to do nothing but `spawn(agent, task)`,
  polls until the orchestrator session settles, dumps the full message tree.
- `multi-task.sh` — multi-agent harness. Drives a planner → coder → reviewer
  → gitter pipeline that adds `bytes(n)` to `src/format.js`.
- `run-all.sh` — runs the 8 single-agent tests + the multi-agent test.
- `golden/` — reference captures from 2026-05-16 (opencode 1.15.0, omnicoder
  Qwen3.5-9B). Diff fresh `out/*.full*.json` against these to detect drift.
- `out/` — created at runtime; `.gitignore` covers it.

## How to run

```bash
# 1. Start opencode serve from this repo's root (so it picks up the plugin):
cd /home/wu/opencode-agent-intercom
setsid env OPENCODE_AGENT_INTERCOM_DEBUG=1 \
           OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1 \
  opencode serve --port 4567 > /tmp/opencode-e2e.log 2>&1 < /dev/null & disown

# 2. Wait for it to come up, then run the suite:
until curl -fsS http://localhost:4567/app >/dev/null; do sleep 1; done
bash test/e2e/run-all.sh

# 3. Diff against the golden reference (loose — message IDs and timestamps
#    change every run; the interesting bits are subagent picks, tool calls
#    and final orchestrator text):
python3 - <<'PY'
import json, sys
from pathlib import Path
for f in sorted(Path("test/e2e/golden").glob("*.json")):
    cur = Path("test/e2e/out") / f.name
    if not cur.exists():
        print(f"missing: {cur}"); continue
    g = json.load(open(f))
    c = json.load(open(cur))
    print(f"{f.name:40s} golden={len(g)} msgs  current={len(c)} msgs")
PY
```

Settings used for the golden references:
- `~/.config/opencode/agent-intercom.json` → `maxSubagents: 8, maxContext: 130000`
- `opencode serve` started in `/home/wu/opencode-agent-intercom`
- llama-server: omnicoder (`Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf`)
  with reasoning on, the params from `start-qwen.sh`
- Multi-agent test: 4 subagent spawns (planner / coder / reviewer / gitter), all
  status=completed, ~6:26 min wall-clock, 92 messages, produces `bytes()` in
  `src/format.js` plus 5 unit tests in `test/plugin.test.js`

## Why the harness polls instead of streaming

opencode's blocking `/session/<id>/message` endpoint returns after the
orchestrator's FIRST turn (the one that called `spawn`), but the actual subagent
work and the orchestrator's post-wake reply happen asynchronously after that.
Polling the message count until it's stable for ~25 s gives the same coverage
without subscribing to the event stream.

## Known caveats

- **Subagent reads must be inside the session's project directory.** opencode
  1.15 stalls reads outside the session `directory` on a headless permission
  prompt — the harness creates every session with `?directory=$PROJECT_DIR` and
  task prompts use relative paths against that root.
- **Designer test depends on the `gen` CLI** and Stable Horde / Pollinations
  being reachable. Expect 20-90 s wall-clock per image.
- **Researcher test hits the public Exa MCP endpoint** (anonymous, 150/day).
  Skip or expect 429 if running the suite repeatedly.
- The bytes() implementation and its tests are themselves a test artifact
  from the multi-agent run (kept on purpose — see `src/format.js`). If you
  revert them, the multi-agent run will recreate them on the next pass.
