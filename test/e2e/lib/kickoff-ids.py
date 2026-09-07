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
# The kickoff carries the todo file's own text (endlessKickoffBlock): task ids
# appear as canonical "- T<n>:" lines in it. The watermark comment
# (<!-- intercom: next-id T<n> -->) and the "reports `DONE: T<n>`" instruction
# are not tasks, so ids are read off the task-line shape rather than every
# T-token, and in file order without duplicates.
named = []
for match in re.findall(r"(?m)^\s*[-*]\s+(T\d+)\s*(?::|—|–|-)", block):
    if match not in named:
        named.append(match)
missing = [item for item in expected if item not in named]
extra = [item for item in named if item not in expected]
first = " ".join(block.split())[:200]
if missing or extra:
    print(
        f"complete|fail|kickoff names {named or 'no id'}; missing "
        f"{missing or 'none'}, not from this save {extra or 'none'} — \"{first}\""
    )
else:
    print(f"complete|pass|kickoff names exactly {named} — \"{first}\"")
