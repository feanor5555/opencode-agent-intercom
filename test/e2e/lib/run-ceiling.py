#!/usr/bin/env python3
"""Read the run-ceiling evidence out of a session capture and the request log.

`run-ceiling-task.sh` proves what no unit test can reach: a live subagent whose
every call and every gap stays inside the two existing watchdog windows is still
cut off on `maxSubagentRunMs`, that the wrap-up band was handed to the provider
before that cut, and that a single long call under the ceiling is left alone.

The wrap-up carrier is never persisted (`createTransformMessages` works on the
per-request copy), so the band is read out of the plugin's request log
(`src/reqlog.js`). The `neither-old` pin is read out of opencode's own
`state.time.start` / `.end` on the subagent's tool parts, not from anything the
plugin reports.

Usage:
  run-ceiling.py <messages.json> <requests.jsonl> <sessionID> <dump-path> \\
                 <max_call_ms> <max_age_ms> <spawn_ms> <wrap_at_ms>

Prints `key=value` lines, one per line, and nothing else.
"""

import json
import sys
from datetime import datetime

WRAP_HEAD = "⏳ RUN CEILING AHEAD."
CARRIER_SUFFIX = "-agent-intercom-turn"


def ms(value):
    return value if isinstance(value, (int, float)) else 0


def parse_ts(value):
    if not isinstance(value, str) or not value:
        return 0
    try:
        text = value[:-1] + "+00:00" if value.endswith("Z") else value
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        return 0


def emit(pairs):
    for key, value in pairs.items():
        print(f"{key}={value}")


def tool_calls(messages):
    calls = []
    if not isinstance(messages, list):
        return calls
    for message in messages:
        if not isinstance(message, dict):
            continue
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            times = state.get("time") if isinstance(state.get("time"), dict) else {}
            start = ms(times.get("start"))
            end = ms(times.get("end"))
            if start <= 0:
                continue
            calls.append(
                {
                    "tool": str(part.get("tool") or "?"),
                    "start": start,
                    "end": end,
                    "status": str(state.get("status") or ""),
                }
            )
    calls.sort(key=lambda call: call["start"])
    return calls


def neither_old(calls, max_call_ms, max_age_ms):
    durations = [call["end"] - call["start"] for call in calls if call["end"] > call["start"]]
    longest_call = max(durations) if durations else 0
    gaps = []
    for prev, nxt in zip(calls, calls[1:]):
        if prev["end"] > prev["start"] and nxt["start"] >= prev["end"]:
            gaps.append(nxt["start"] - prev["end"])
    longest_gap = max(gaps) if gaps else 0
    ok = (
        1
        if len(calls) >= 2
        and longest_call < max_call_ms
        and longest_gap < max_age_ms
        and (not durations or max(durations) < max_call_ms)
        else 0
    )
    return {
        "tools": len(calls),
        "completed_calls": len(durations),
        "longest_call_ms": longest_call,
        "longest_gap_ms": longest_gap,
        "gaps": len(gaps),
        "neither_old": ok,
        "tool_names": ",".join(call["tool"] for call in calls),
    }


def session_of(messages, session_id):
    if not isinstance(messages, list) or not messages:
        return False
    for message in messages:
        info = message.get("info") if isinstance(message, dict) else None
        if isinstance(info, dict) and info.get("sessionID") == session_id:
            return True
    return False


def wrap_text_of(messages):
    # The wrap-up carrier is appended at the end of the per-request array
    # (`tailNoticeCarrier`). Its message id ends with CARRIER_SUFFIX. The spawn
    # prompt may quote WRAP_HEAD as an instruction to the model; that is not
    # the band.
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info") if isinstance(message.get("info"), dict) else {}
        mid = str(info.get("id") or "")
        if not mid.endswith(CARRIER_SUFFIX):
            continue
        parts = message.get("parts") if isinstance(message.get("parts"), list) else []
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "text":
                continue
            text = part.get("text") if isinstance(part.get("text"), str) else ""
            if WRAP_HEAD in text:
                return text
    return ""


def wrap_up(path, session_id, dump_path, spawn_ms, wrap_at_ms):
    records = 0
    wrap_records = 0
    wrap_first_ms = 0
    wrap_first_text = ""
    after_count = 0
    after_after_wrap = 0
    try:
        handle = open(path, encoding="utf-8")
    except OSError:
        return {
            "req_parsed": 0,
            "req_records": 0,
            "wrap_records": 0,
            "wrap_first_ms": 0,
            "wrap_elapsed_ms": 0,
            "wrap_at_or_after": 0,
            "wrap_tool_after": 0,
            "after_count": 0,
        }

    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            kind = record.get("type")
            ts_ms = parse_ts(record.get("ts") or "")
            if kind == "messages":
                messages = record.get("messages")
                if not session_of(messages, session_id):
                    continue
                records += 1
                text = wrap_text_of(messages)
                if not text:
                    continue
                wrap_records += 1
                if wrap_first_ms == 0:
                    wrap_first_ms = ts_ms
                    wrap_first_text = text
            elif kind == "tool.execute.after" and record.get("sessionID") == session_id:
                after_count += 1
                if wrap_first_ms and ts_ms >= wrap_first_ms:
                    after_after_wrap += 1

    if wrap_first_text and dump_path:
        try:
            with open(dump_path, "w", encoding="utf-8") as dump:
                dump.write(wrap_first_text)
                if not wrap_first_text.endswith("\n"):
                    dump.write("\n")
        except OSError:
            pass

    elapsed = wrap_first_ms - spawn_ms if wrap_first_ms and spawn_ms else 0
    at_or_after = 1 if wrap_records and elapsed >= wrap_at_ms else 0
    return {
        "req_parsed": 1 if records else 0,
        "req_records": records,
        "wrap_records": wrap_records,
        "wrap_first_ms": wrap_first_ms,
        "wrap_elapsed_ms": elapsed,
        "wrap_at_or_after": at_or_after,
        "wrap_tool_after": 1 if after_after_wrap else 0,
        "after_count": after_count,
        "after_after_wrap": after_after_wrap,
    }


def main():
    if len(sys.argv) < 9:
        emit({"parsed": 0, "error": "usage"})
        return
    capture, requests, session_id, dump_path = sys.argv[1:5]
    max_call_ms, max_age_ms, spawn_ms, wrap_at_ms = (int(x) for x in sys.argv[5:9])

    try:
        with open(capture, encoding="utf-8") as handle:
            messages = json.load(handle)
    except Exception:
        messages = None
    if not isinstance(messages, list) or not messages:
        emit({"parsed": 0, "messages": 0})
        wrap = wrap_up(requests, session_id, dump_path, spawn_ms, wrap_at_ms)
        emit(wrap)
        return

    calls = tool_calls(messages)
    figures = {"parsed": 1, "messages": len(messages)}
    figures.update(neither_old(calls, max_call_ms, max_age_ms))
    figures.update(wrap_up(requests, session_id, dump_path, spawn_ms, wrap_at_ms))
    emit(figures)


if __name__ == "__main__":
    main()
