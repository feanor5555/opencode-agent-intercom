#!/usr/bin/env python3
"""Prints a subagent's final reply as the plugin relayed it to the primary:
the `Its result:` block of the wake notice for <handle> in the primary's
captured session, up to the notice's own tail line.

Usage: wake-reply.py <primary messages.json> <handle>

Exit 0 with the text on stdout, 1 where the capture is unreadable or holds no
wake notice with a result for that handle. Used by `lib/role-run.sh`: the
subagent's own session is deleted when it ends, so the wake notice is the one
copy of its reply that is still there after the run.
"""

import json
import sys

RESULT_MARK = "Its result:\n"
# The first line of each tail `completionNotice` (src/notices.js) puts after
# the result.
TAIL_STARTS = (
    "⚠️ This is a DECISION for you",
    "Use this to report back to the user.",
)


def notice_texts(messages):
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        if info.get("role") != "user":
            continue
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                yield part["text"]


def wake_reply(messages, handle):
    head = f'🔔 agent-intercom: your subagent "{handle}"'
    found = None
    for text in notice_texts(messages):
        start = text.find(head)
        if start < 0:
            continue
        mark = text.find(RESULT_MARK, start)
        if mark < 0:
            continue
        lines = []
        for line in text[mark + len(RESULT_MARK):].splitlines():
            if line.startswith(TAIL_STARTS):
                break
            lines.append(line)
        body = "\n".join(lines).strip()
        if body:
            found = body
    return found


def main():
    if len(sys.argv) != 3:
        print("usage: wake-reply.py <primary messages.json> <handle>", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1]) as handle:
            messages = json.load(handle)
    except Exception:
        return 1
    if not isinstance(messages, list):
        return 1
    text = wake_reply(messages, sys.argv[2])
    if text is None:
        return 1
    sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
