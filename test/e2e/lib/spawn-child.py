#!/usr/bin/env python3
"""Find the child session id of the spawn whose prompt carries a given marker.

The endless driver gates each cycle on ONE subagent it spawned itself. From the
second cycle on the primary is a successor that is still working its todo file
off, so it spawns subagents of its own at the same time and neither the role nor
the absence of a task-id prefix identifies the driver's subagent any more. The
spawn tool tags its tool call with the child's session id (`toolCtx.metadata`,
src/tools.js), so the marker the driver puts into its own prompt leads to that
one id, and the plugin's `spawned` log line is then matched on it.

Prints `complete|pass|<child session id>` once found, `running|pending|<why>`
while it is not there yet — the shape `poll_verdict` reads.
"""

import json
import sys

from walk import walk

try:
    payload = json.load(open(sys.argv[1]))
except Exception as err:
    print(f"running|pending|the primary message list was unreadable: {err}")
    raise SystemExit

marker = sys.argv[2]

seen = 0
for node in walk(payload):
    if not isinstance(node, dict) or node.get("tool") != "spawn":
        continue
    seen += 1
    prompt = None
    for candidate in (node.get("state"), node):
        if isinstance(candidate, dict) and isinstance(candidate.get("input"), dict):
            value = candidate["input"].get("prompt")
            if isinstance(value, str):
                prompt = value
                break
    if not prompt or marker not in prompt:
        continue
    # The child's id rides on the tool call's own metadata. The spawn tool
    # writes it as `sessionID` (src/tools.js); opencode's own task tool spells
    # the same field `sessionId`, so both are accepted.
    for holder in (node.get("state"), node):
        if not isinstance(holder, dict):
            continue
        meta = holder.get("metadata")
        if not isinstance(meta, dict):
            continue
        child = meta.get("sessionID") or meta.get("sessionId")
        if isinstance(child, str) and child:
            print(f"complete|pass|{child}")
            raise SystemExit
    print(
        "running|pending|the spawn call carrying the marker has no "
        "metadata.sessionID yet"
    )
    raise SystemExit

print(
    f"running|pending|no spawn tool call carrying the marker among {seen} spawn "
    "call(s) on this session yet"
)
