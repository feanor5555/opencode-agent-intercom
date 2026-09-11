#!/usr/bin/env python3
"""Read the delivery moment of a mid-run message out of a subagent's session.

`message-task.sh` proves what no unit test can: WHEN a message queued into a
running subagent's session is read. This reader turns one capture of that
session — `GET /session/<id>/message` — into the flat figures the driver
asserts on, so the shell never walks JSON itself.

Every figure is derived from the server's own clock: the framed message carries
`info.time.created`, every tool call carries `state.time.start` / `.end`, and
every step the subagent took is one assistant message with its own
`info.time.created`.

Usage: midrun-message.py <messages.json> <framed-opening>

`<framed-opening>` is the literal the framed block starts with
(`framedAgentMessage`, src/notices.js); the user message carrying it is the
message under test.

Prints `key=value` lines, one per line, and nothing else:

  parsed                 1 when the capture was a non-empty message list
  messages               messages in the capture
  user_messages          user-role messages (briefing + framed message = 2)
  assistant_messages     assistant-role messages, i.e. steps the subagent took
  framed_found           1 when the framed message is in the capture
  framed_time            its creation time, ms epoch
  assistants_before      steps that ran before it landed
  assistants_after       steps that ran after it landed
  inflight_tool          the tool call it landed INSIDE, empty for none
  inflight_start         that call's start, ms epoch
  inflight_end           that call's end, ms epoch (0 while it was still open)
  step_after_inflight_ms ms from that call's end to the next step's start
  tools_total            tool calls in the whole session
  tools_before           tool calls started before the message landed
  tools_after            tool calls started after it landed
  tool_names             every tool call's name, in order, comma-separated
  last_tool_end          the last tool call's end, ms epoch
"""

import json
import sys


def ms(value):
    return value if isinstance(value, (int, float)) else 0


def text_of(part):
    value = part.get("text")
    return value if isinstance(value, str) else ""


def emit(pairs):
    for key, value in pairs.items():
        print(f"{key}={value}")


def main():
    path, opening = sys.argv[1], sys.argv[2]
    try:
        with open(path) as handle:
            messages = json.load(handle)
    except Exception:
        messages = None
    if not isinstance(messages, list) or not messages:
        emit({"parsed": 0, "messages": 0})
        return

    users = []
    assistants = []
    tools = []
    framed_time = 0
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        created = ms((info.get("time") or {}).get("created"))
        role = info.get("role")
        if role == "user":
            users.append(created)
            for part in parts:
                if isinstance(part, dict) and opening in text_of(part):
                    framed_time = created
        elif role == "assistant":
            assistants.append(created)
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            times = state.get("time") if isinstance(state.get("time"), dict) else {}
            tools.append(
                {
                    "tool": str(part.get("tool") or "?"),
                    "start": ms(times.get("start")),
                    "end": ms(times.get("end")),
                }
            )

    tools.sort(key=lambda call: call["start"])
    result = {
        "parsed": 1,
        "messages": len(messages),
        "user_messages": len(users),
        "assistant_messages": len(assistants),
        "framed_found": 1 if framed_time else 0,
        "framed_time": framed_time,
        "tools_total": len(tools),
        "tool_names": ",".join(call["tool"] for call in tools),
        "last_tool_end": max((call["end"] for call in tools), default=0),
    }

    if not framed_time:
        result.update(
            {
                "assistants_before": len(assistants),
                "assistants_after": 0,
                "inflight_tool": "",
                "inflight_start": 0,
                "inflight_end": 0,
                "step_after_inflight_ms": -1,
                "tools_before": len(tools),
                "tools_after": 0,
            }
        )
        emit(result)
        return

    # The call the message landed inside: started before it and had not ended
    # when it landed. An end of 0 is a call still open at capture time, which
    # counts as in flight — that is the very state the claim is about.
    inflight = None
    for call in tools:
        if call["start"] and call["start"] <= framed_time:
            if call["end"] == 0 or call["end"] >= framed_time:
                inflight = call
    result.update(
        {
            "assistants_before": sum(1 for at in assistants if at < framed_time),
            "assistants_after": sum(1 for at in assistants if at > framed_time),
            "inflight_tool": inflight["tool"] if inflight else "",
            "inflight_start": inflight["start"] if inflight else 0,
            "inflight_end": inflight["end"] if inflight else 0,
            "tools_before": sum(1 for call in tools if call["start"] < framed_time),
            "tools_after": sum(1 for call in tools if call["start"] > framed_time),
        }
    )
    # The step boundary itself: the first step that began after the in-flight
    # call returned. A negative figure means there was none to measure.
    gap = -1
    if inflight and inflight["end"]:
        following = [at for at in assistants if at >= inflight["end"]]
        if following:
            gap = min(following) - inflight["end"]
    result["step_after_inflight_ms"] = gap
    emit(result)


main()
