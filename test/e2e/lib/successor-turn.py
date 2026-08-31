#!/usr/bin/env python3
"""Capture and inspect the successor's complete first model turn."""

import json
import re
import sys

from walk import walk

try:
    payload = json.load(open(sys.argv[1]))
except Exception as err:
    print(f"running|pending|the successor message list was unreadable: {err}")
    raise SystemExit

expected = [item for item in sys.argv[2].split(",") if item]
expected_set = set(expected)

messages = payload.get("data") if isinstance(payload, dict) else payload
if not isinstance(messages, list):
    print("running|pending|the successor message list carried no messages")
    raise SystemExit

# The server nests each message as {"info": …, "parts": […]}; older shapes put
# the fields on the message itself.
def info_of(message):
    if not isinstance(message, dict):
        return {}
    inner = message.get("info")
    return inner if isinstance(inner, dict) else message

start = next(
    (index for index, message in enumerate(messages) if info_of(message).get("role") == "user"),
    None,
)
if start is None:
    print("running|pending|the successor carries no user message yet — the kickoff has not landed")
    raise SystemExit

turn = []
state = "running"
for message in messages[start + 1 :]:
    info = info_of(message)
    if info.get("role") == "user":
        state = "complete"
        break
    turn.append(message)
    finish = info.get("finish")
    completed = (info.get("time") or {}).get("completed")
    # OpenCode uses both `tool-calls` and `unknown` for non-terminal steps.
    if completed and finish and finish not in {"tool-calls", "unknown"}:
        state = "complete"
        break

# Assert the persisted shape once a completed assistant step is visible. An
# active step can legitimately have no finish yet; a completed one cannot.
assistant_infos = [
    info_of(message) for message in turn if info_of(message).get("role") == "assistant"
]
finish_seen = any("finish" in info for info in assistant_infos)
completed_without_finish = any(
    (info.get("time") or {}).get("completed") and "finish" not in info
    for info in assistant_infos
)
if completed_without_finish or (state == "complete" and not finish_seen):
    print(
        "setup|fail|successor assistant messages carry no info.finish key on a "
        "completed first turn; the persisted message shape no longer supplies "
        "the field used to find the turn boundary"
    )
    raise SystemExit

# The first saved task is the next task by contract. Find spawn tool calls at any
# depth so this stays independent of the server's message-part representation.
prompts = []
for node in walk(turn):
    if not isinstance(node, dict) or node.get("tool") != "spawn":
        continue
    candidates = []
    inner = node.get("state")
    if isinstance(inner, dict):
        candidates.append(inner.get("input"))
    candidates.append(node.get("input"))
    for candidate in candidates:
        if isinstance(candidate, dict) and isinstance(candidate.get("prompt"), str):
            prompts.append(candidate["prompt"])
            break

observed = []
invalid = []
for prompt in prompts:
    first = next((line.strip() for line in prompt.splitlines() if line.strip()), "")
    match = re.match(r"^(T\d+)\s*[:.\-]\s*", first)
    task_id = match.group(1) if match else None
    observed.append((task_id or "?", first[:160]))
    if task_id is None or task_id not in expected_set:
        invalid.append((task_id or "no id", first[:160]))

seen_ids = [task_id for task_id, _ in observed if task_id != "?"]
unmatched = len([task_id for task_id, _ in observed if task_id not in expected_set])
tally = " ".join(f"{task}={seen_ids.count(task)}" for task in expected)
turn_state = "ended" if state == "complete" else "still running at the bound"
tally_text = (
    f"first turn {turn_state} after {len(prompts)} spawn call(s), "
    f"per saved task: {tally}"
)
if unmatched:
    tally_text += f", carrying no saved id: {unmatched}"

first_expected = expected[0] if expected else None
if not prompts:
    if state == "complete":
        print(f"complete|fail|the successor's first turn ended with no spawn tool call — {tally_text}")
    else:
        print("running|pending|no successor spawn tool call has appeared yet")
elif invalid:
    print(f"{state}|fail|spawn prompts {observed}; invalid first lines {invalid} — {tally_text}")
elif first_expected not in seen_ids:
    print(f"{state}|fail|spawn prompts {observed}; first saved task {first_expected} was not spawned — {tally_text}")
else:
    print(f"{state}|pass|spawn prompts carry saved ids on line one: {observed} — {tally_text}")
