#!/usr/bin/env python3
"""The shaped closing line of an endless cycle's wind-down turn.

Reads a message-tree capture — the JSON a `GET /session/<id>/message` returns —
and prints the LAST line in it that opens with `## WIND-DOWN DONE`, the reply
the cycle's wind-down prompt asks the primary for (`WIND_DOWN_PROMPT`,
src/handoff.js). Prints nothing when the tree holds no such line.

Which of the three forms the line carries is what the cycle's V3 reads: over a
file the wind-down subagent left byte-for-byte identical, `— no change` passes
and `— <n> open` is refused (`verifyWindDown`, src/endless.js).

Exit code 0 either way; a capture that does not parse prints nothing.
"""

import json
import re
import sys

SHAPED = re.compile(r"^##\s+WIND-DOWN DONE\b")


def texts(node):
    """Every string that could carry the line, anywhere in the capture."""
    if isinstance(node, dict):
        if isinstance(node.get("text"), str):
            yield node["text"]
        for value in node.values():
            yield from texts(value)
    elif isinstance(node, list):
        for value in node:
            yield from texts(value)


def main():
    if len(sys.argv) < 2:
        return 0
    try:
        with open(sys.argv[1]) as handle:
            payload = json.load(handle)
    except Exception:
        return 0

    found = ""
    for text in texts(payload):
        for line in text.splitlines():
            stripped = line.strip()
            if SHAPED.match(stripped):
                found = stripped
    if found:
        print(found)
    return 0


if __name__ == "__main__":
    sys.exit(main())
