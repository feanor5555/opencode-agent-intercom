#!/usr/bin/env python3
"""Read the successor kickoff and verify its saved task ids."""

import json
import re
import sys

from walk import walk

HEADING = "## Endless mode — work off the todo file"

try:
    payload = json.load(open(sys.argv[1]))
except Exception as err:
    print(f"running|pending|the message list was unreadable: {err}")
    raise SystemExit

expected = [item for item in sys.argv[2].split(",") if item]
hit = next(
    (value for value in walk(payload) if isinstance(value, str) and HEADING in value),
    None,
)
if hit is None:
    print("running|pending|no message on the new session carries the endless kickoff heading yet")
    raise SystemExit

block = hit.split(HEADING, 1)[1]
parts = block.split("\n\n")
head = parts[1] if len(parts) > 1 else block
named = re.findall(r"\bT\d+\b", head)
missing = [item for item in expected if item not in named]
extra = [item for item in named if item not in expected]
first = " ".join(head.split())[:200]
if missing or extra:
    print(
        f"complete|fail|kickoff names {named or 'no id'}; missing "
        f"{missing or 'none'}, not from this save {extra or 'none'} — \"{first}\""
    )
else:
    print(f"complete|pass|kickoff names exactly {named} — \"{first}\"")
