#!/usr/bin/env python3
"""Prints the final reply of a captured session: the text parts of the newest
assistant message that carries any text, joined in order.

Usage: final-reply.py <messages.json>

Exit 0 with the text on stdout, 1 where the capture is unreadable or holds no
assistant text at all. Used by `lib/role-run.sh` where the primary's wake
notice carries no result for the subagent.
"""

import json
import sys


def final_reply(messages):
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        if info.get("role") != "assistant":
            continue
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        texts = [
            part.get("text")
            for part in parts
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
            and part.get("text").strip()
        ]
        if texts:
            return "\n".join(texts)
    return None


def main():
    if len(sys.argv) != 2:
        print("usage: final-reply.py <messages.json>", file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1]) as handle:
            messages = json.load(handle)
    except Exception:
        return 1
    if not isinstance(messages, list):
        return 1
    text = final_reply(messages)
    if text is None:
        return 1
    sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
