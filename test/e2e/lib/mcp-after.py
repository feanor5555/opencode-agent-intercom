#!/usr/bin/env python3
"""Decide whether tool.execute.after fired for the e2e MCP ping tool.

`mcp-after-task.sh` answers a property of opencode, not of this plugin: did
`tool.execute.after` run for an MCP-registered tool? The only place that is
visible is the plugin's request log (`src/reqlog.js`), whose
`tool.execute.before` / `tool.execute.after` records are written from those
hooks (`src/index.js`) when OPENCODE_AGENT_INTERCOM_LOG_REQUESTS=1.

Usage: mcp-after.py <requests.jsonl> <sessionID>

Prints `key=value` lines and nothing else:

  parsed            1 when at least one record for this session was read
  before_count      tool.execute.before records whose tool is the MCP ping
  after_count       tool.execute.after records whose tool is the MCP ping
  before_tool       the tool name on the first matching before, else empty
  after_tool        the tool name on the first matching after, else empty
  part_count        matching tool parts in `messages` records of this session
  part_tool         the tool name on the first matching part, else empty
  invoked           1 when before, after, or a messages tool-part named it
  verdict           FIRES | DOES_NOT_FIRE | TOOL_NOT_SEEN

FIRES          — at least one `type=tool.execute.after` record for the ping.
DOES_NOT_FIRE  — the ping was invoked (before or a tool part) and after did not
                 write a record.
TOOL_NOT_SEEN  — this session never invoked the ping at all. Distinct from
                 DOES_NOT_FIRE: the hook question cannot be decided.
"""

import json
import sys

SERVER = "e2eping"
TOOL = "ping"


def is_mcp_ping(name):
    if not isinstance(name, str) or not name:
        return False
    n = name.replace("-", "_").replace("/", "_").replace(".", "_").lower()
    if n == TOOL:
        return True
    parts = n.split("_")
    return SERVER in parts and parts[-1] == TOOL


def session_of_messages(record):
    messages = record.get("messages")
    if not isinstance(messages, list):
        return None
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info")
        if isinstance(info, dict) and info.get("sessionID"):
            return info.get("sessionID")
    return None


def tool_parts(record):
    messages = record.get("messages")
    if not isinstance(messages, list):
        return
    for message in messages:
        if not isinstance(message, dict):
            continue
        parts = message.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "tool" or part.get("tool"):
                yield part.get("tool")


def main():
    if len(sys.argv) != 3:
        print("usage: mcp-after.py <requests.jsonl> <sessionID>", file=sys.stderr)
        sys.exit(2)
    path, session_id = sys.argv[1], sys.argv[2]

    parsed = 0
    before_count = 0
    after_count = 0
    before_tool = ""
    after_tool = ""
    part_count = 0
    part_tool = ""

    try:
        handle = open(path)
    except OSError:
        handle = None

    if handle is not None:
        with handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except Exception:
                    continue
                if not isinstance(record, dict):
                    continue
                kind = record.get("type")
                if kind in ("tool.execute.before", "tool.execute.after"):
                    if record.get("sessionID") != session_id:
                        continue
                    parsed = 1
                    if not is_mcp_ping(record.get("tool")):
                        continue
                    if kind.endswith("before"):
                        before_count += 1
                        if not before_tool:
                            before_tool = str(record.get("tool") or "")
                    else:
                        after_count += 1
                        if not after_tool:
                            after_tool = str(record.get("tool") or "")
                    continue
                if kind == "messages":
                    if session_of_messages(record) != session_id:
                        continue
                    parsed = 1
                    for tool in tool_parts(record):
                        if not is_mcp_ping(tool):
                            continue
                        part_count += 1
                        if not part_tool:
                            part_tool = str(tool or "")

    invoked = 1 if (before_count or after_count or part_count) else 0
    if after_count:
        verdict = "FIRES"
    elif invoked:
        verdict = "DOES_NOT_FIRE"
    else:
        verdict = "TOOL_NOT_SEEN"

    print(f"parsed={parsed}")
    print(f"before_count={before_count}")
    print(f"after_count={after_count}")
    print(f"before_tool={before_tool}")
    print(f"after_tool={after_tool}")
    print(f"part_count={part_count}")
    print(f"part_tool={part_tool}")
    print(f"invoked={invoked}")
    print(f"verdict={verdict}")


if __name__ == "__main__":
    main()
