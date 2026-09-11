#!/usr/bin/env python3
"""Read one `ask` call and its answer out of a subagent's session.

`ask-task.sh` proves what no unit test can: that a question a running subagent
puts to its caller reaches that caller, and that the caller's answer comes back
as the RESULT OF THE `ask` TOOL CALL rather than as a message the subagent has
to notice. This reader turns one capture of the subagent's session —
`GET /session/<id>/message` — into the flat figures the driver asserts on.

Usage: midrun-ask.py <messages.json> <answer-marker>

`<answer-marker>` is the literal the orchestrator was told to answer with; it is
looked for inside the `ask` call's own output.

Prints `key=value` lines, one per line, and nothing else:

  parsed                1 when the capture was a non-empty message list
  messages              messages in the capture
  ask_calls             `ask` tool calls in the session (the channel allows 1)
  ask_status            the call's own status: completed / running / error
  ask_start             its start, ms epoch
  ask_end               its end, ms epoch (0 while it was still open)
  ask_ms                how long the call was open, ms (0 while open)
  ask_question          1 when the call carried a non-empty question
  answer_prefix         1 when the call's output opens with the answer line
                        `The orchestrator answers:` (src/midrun.js)
  answer_marker         1 when the answer marker is inside that output
  tools_during_ask      other tool calls that started while `ask` was open —
                        0 is the claim that the subagent STOPS and costs nothing
  assistants_during_ask steps that began while `ask` was open — 0, same claim
  tools_after_ask       tool calls started after the answer came back
  assistants_after_ask  steps taken after the answer came back
  tool_names            every tool call's name, in order, comma-separated
"""

import json
import sys

ANSWER_PREFIX = "The orchestrator answers:"


def ms(value):
    return value if isinstance(value, (int, float)) else 0


def emit(pairs):
    for key, value in pairs.items():
        print(f"{key}={value}")


def main():
    path, marker = sys.argv[1], sys.argv[2]
    try:
        with open(path) as handle:
            messages = json.load(handle)
    except Exception:
        messages = None
    if not isinstance(messages, list) or not messages:
        emit({"parsed": 0, "messages": 0, "ask_calls": 0})
        return

    assistants = []
    tools = []
    asks = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        if info.get("role") == "assistant":
            assistants.append(ms((info.get("time") or {}).get("created")))
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            times = state.get("time") if isinstance(state.get("time"), dict) else {}
            output = state.get("output")
            if not isinstance(output, str):
                output = part.get("output") if isinstance(part.get("output"), str) else ""
            payload = state.get("input") if isinstance(state.get("input"), dict) else {}
            call = {
                "tool": str(part.get("tool") or "?"),
                "start": ms(times.get("start")),
                "end": ms(times.get("end")),
                "status": str(state.get("status") or "?"),
                "output": output,
                "question": str(payload.get("question") or "").strip(),
            }
            tools.append(call)
            if call["tool"] == "ask":
                asks.append(call)

    tools.sort(key=lambda call: call["start"])
    result = {
        "parsed": 1,
        "messages": len(messages),
        "ask_calls": len(asks),
        "tool_names": ",".join(call["tool"] for call in tools),
    }
    if not asks:
        result.update(
            {
                "ask_status": "",
                "ask_start": 0,
                "ask_end": 0,
                "ask_ms": 0,
                "ask_question": 0,
                "answer_prefix": 0,
                "answer_marker": 0,
                "tools_during_ask": 0,
                "assistants_during_ask": 0,
                "tools_after_ask": 0,
                "assistants_after_ask": 0,
            }
        )
        emit(result)
        return

    ask = asks[0]
    # While the call is still open the window runs to the capture's own last
    # event, so "during" stays measurable on a session captured mid-wait.
    window_end = ask["end"] or max(
        [call["end"] or call["start"] for call in tools] + assistants + [ask["start"]]
    )
    result.update(
        {
            "ask_status": ask["status"],
            "ask_start": ask["start"],
            "ask_end": ask["end"],
            "ask_ms": (ask["end"] - ask["start"]) if ask["end"] and ask["start"] else 0,
            "ask_question": 1 if ask["question"] else 0,
            "answer_prefix": 1 if ANSWER_PREFIX in ask["output"] else 0,
            "answer_marker": 1 if marker and marker in ask["output"] else 0,
            "tools_during_ask": sum(
                1
                for call in tools
                if call is not ask and ask["start"] < call["start"] < window_end
            ),
            "assistants_during_ask": sum(
                1 for at in assistants if ask["start"] < at < window_end
            ),
            "tools_after_ask": sum(
                1 for call in tools if ask["end"] and call["start"] > ask["end"]
            ),
            "assistants_after_ask": sum(
                1 for at in assistants if ask["end"] and at > ask["end"]
            ),
        }
    )
    emit(result)


main()
