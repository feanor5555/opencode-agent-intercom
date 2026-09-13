#!/usr/bin/env python3
"""Read the three context bands and their placement out of the request log.

`context-bands-task.sh` proves what no unit test can reach: that a LIVE
subagent crossing its own context budget is handed the plan band, then the
reserve band, then the lockdown, and that each of those notices arrives in a
CARRIER MESSAGE APPENDED AT THE END of the array opencode hands the model —
not on the subagent's message 0, which is where its only real user message
sits.

The carrier is never persisted: `createTransformMessages` (src/hooks.js) works
on the per-request copy of the message array and opencode never writes it back,
so a session capture cannot show it. The one place it is visible is the
plugin's own request log (`src/reqlog.js`, OPENCODE_AGENT_INTERCOM_LOG_REQUESTS
=1), whose `messages` record is written AFTER the transform hook has run
(src/index.js) and therefore holds the array as the provider received it. This
reader streams that JSONL and turns the records belonging to ONE session into
the flat figures the driver asserts on.

Usage: context-bands.py <requests.jsonl> <sessionID> <dump-prefix>

It writes the first notice text of each band it saw to
`<dump-prefix>.<band>.txt` — plan, reserve, hold, stop — so the driver can
grep the plugin's own words for the literals each criterion names, and a reader
of the run can see what the subagent was actually told. A band that never fired
leaves no file.

Prints `key=value` lines, one per line, and nothing else:

  parsed              1 when at least one record for this session was read
  records             LLM requests logged for this session
  notice_records      of those, the ones carrying a plugin notice part
  band_records        of those, the ones whose notice carries a band
  band_carrier_tail   band notices whose carrier is the LAST message
  band_carrier_msg0   band notices that sat on message 0 instead
  band_carrier_appended  band notices on a message this plugin appended (its id
                      ends in the carrier suffix) rather than on a real one
  band_carrier_user   band notices whose carrier is a `user` message
  band_carrier_synthetic  band notices whose part carries `synthetic: true`
  quiet_records       requests for this session with no notice at all
  first_band          the first band this session was handed: plan / reserve /
                      hold / stop / none
  band_order          the bands in the order they first fired, comma-separated
  <band>_records      requests carrying that band (plan|reserve|hold|stop)
  <band>_record       the 1-based request number its first one rode on
  <band>_index        the carrier's index in that array
  <band>_total        messages in that array
  <band>_is_tail      1 when the carrier was the last message
  <band>_is_msg0      1 when it sat on message 0
  <band>_appended     1 when the carrier is a message this plugin appended
  <band>_role         the carrier's role
  last_record         the last request number logged for this session
  stop_tool_parts     tool parts in the array the lockdown first rode on
  last_tool_parts     tool parts in the last array logged for this session —
                      above `stop_tool_parts` it says the subagent went on
                      calling work tools after the lockdown, equal to it that
                      it attempted none and no denial could be observed
  plan_ctx / reserve_ctx / stop_ctx        the tokens the notice names
  plan_budget / reserve_budget / stop_budget  the budget it names
  plan_left / reserve_left                 the room it says is left
  plan_arith / reserve_arith               1 when left == budget - ctx, to
                      within the 0.1k the figures are rendered at

Figures the text does not carry come back as 0.
"""

import json
import re
import sys

# The literals the three bands and the compaction HOLD are recognised by. Each
# is the head of its own block in `contextLimitNotice` (src/hooks.js); the
# lockdown is matched on its body instead, because its head escalates over the
# turns (STOP / SECOND WARNING / FINAL WARNING) while this line does not.
BANDS = (
    ("plan", "🧭 PLAN YOUR HANDOVER."),
    ("reserve", "⚠️ WRAP UP NOW."),
    ("hold", "⏳ HOLD."),
    ("stop", "Your work tools are now DISABLED"),
)

# The suffix `createTransformMessages` gives the part it pushes, and — on an
# appended carrier — the message that carries it (TURN_NOTICE_SUFFIX,
# src/hooks.js).
CARRIER_SUFFIX = "-agent-intercom-turn"

# The plan and reserve bands name three figures in one sentence; the lockdown
# names two in another. Both renderings come from `tokens()` (src/format.js):
# "36.0k" from 1000 on, the plain integer below it.
BAND_FIGURES = re.compile(
    r"your context has reached (\S+) tokens of the (\S+) budget — about (\S+) left"
)
STOP_FIGURES = re.compile(r"your context has reached (\S+) tokens \(budget (\S+)\)")


def as_tokens(text):
    """"36.0k" -> 36000, "950" -> 950, anything else -> 0."""
    try:
        if text.endswith("k"):
            return int(round(float(text[:-1]) * 1000))
        return int(text)
    except (ValueError, AttributeError):
        return 0


def band_of(text):
    for name, marker in BANDS:
        if marker in text:
            return name
    return ""


def notice_of(message):
    """The plugin's own text part on this message, or None."""
    parts = message.get("parts")
    if not isinstance(parts, list):
        return None
    for part in parts:
        if not isinstance(part, dict):
            continue
        pid = part.get("id")
        if isinstance(pid, str) and pid.endswith(CARRIER_SUFFIX) and part.get("type") == "text":
            return part
    return None


def tool_parts(messages):
    """Tool calls standing in one logged array."""
    total = 0
    for message in messages:
        parts = message.get("parts") if isinstance(message, dict) else None
        if not isinstance(parts, list):
            continue
        total += sum(1 for part in parts if isinstance(part, dict) and part.get("type") == "tool")
    return total


def emit(pairs):
    for key, value in pairs.items():
        print(f"{key}={value}")


def main():
    path, session_id, dump_prefix = sys.argv[1], sys.argv[2], sys.argv[3]

    records = 0
    notice_records = 0
    band_records = 0
    quiet_records = 0
    carrier = {"tail": 0, "msg0": 0, "appended": 0, "user": 0, "synthetic": 0}
    per_band = {}
    order = []
    stop_tool_parts = 0
    last_tool_parts = 0

    try:
        handle = open(path, encoding="utf-8")
    except OSError:
        emit({"parsed": 0, "records": 0, "notice_records": 0, "band_records": 0})
        return

    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or record.get("type") != "messages":
                continue
            messages = record.get("messages")
            if not isinstance(messages, list) or not messages:
                continue
            mine = False
            for message in messages:
                info = message.get("info") if isinstance(message, dict) else None
                if isinstance(info, dict) and info.get("sessionID") == session_id:
                    mine = True
                    break
            if not mine:
                continue

            records += 1
            last_tool_parts = tool_parts(messages)
            found = None
            for index, message in enumerate(messages):
                if not isinstance(message, dict):
                    continue
                part = notice_of(message)
                if part is not None:
                    found = (index, message, part)
            if found is None:
                quiet_records += 1
                continue
            notice_records += 1
            index, message, part = found
            text = part.get("text") if isinstance(part.get("text"), str) else ""
            band = band_of(text)
            if not band:
                continue

            band_records += 1
            info = message.get("info") if isinstance(message.get("info"), dict) else {}
            is_tail = index == len(messages) - 1
            is_msg0 = index == 0
            appended = isinstance(info.get("id"), str) and info["id"].endswith(CARRIER_SUFFIX)
            carrier["tail"] += 1 if is_tail else 0
            carrier["msg0"] += 1 if is_msg0 else 0
            carrier["appended"] += 1 if appended else 0
            carrier["user"] += 1 if info.get("role") == "user" else 0
            carrier["synthetic"] += 1 if part.get("synthetic") is True else 0

            if band not in per_band:
                order.append(band)
                if band == "stop":
                    stop_tool_parts = last_tool_parts
                figures = {
                    "records": 0,
                    "record": records,
                    "index": index,
                    "total": len(messages),
                    "is_tail": 1 if is_tail else 0,
                    "is_msg0": 1 if is_msg0 else 0,
                    "appended": 1 if appended else 0,
                    "role": info.get("role") or "?",
                    "ctx": 0,
                    "budget": 0,
                    "left": 0,
                    "arith": 0,
                }
                hit = BAND_FIGURES.search(text) if band in ("plan", "reserve") else None
                if hit:
                    figures["ctx"] = as_tokens(hit.group(1))
                    figures["budget"] = as_tokens(hit.group(2))
                    figures["left"] = as_tokens(hit.group(3))
                    # The three figures are rendered at 0.1k, so the sum is
                    # checked against that resolution and not exactly.
                    if figures["budget"] and abs(
                        (figures["budget"] - figures["ctx"]) - figures["left"]
                    ) <= 150:
                        figures["arith"] = 1
                hit = STOP_FIGURES.search(text) if band == "stop" else None
                if hit:
                    figures["ctx"] = as_tokens(hit.group(1))
                    figures["budget"] = as_tokens(hit.group(2))
                per_band[band] = figures
                try:
                    with open(f"{dump_prefix}.{band}.txt", "w", encoding="utf-8") as dump:
                        dump.write(text)
                except OSError:
                    pass
            per_band[band]["records"] += 1

    result = {
        "parsed": 1 if records else 0,
        "records": records,
        "notice_records": notice_records,
        "band_records": band_records,
        "quiet_records": quiet_records,
        "band_carrier_tail": carrier["tail"],
        "band_carrier_msg0": carrier["msg0"],
        "band_carrier_appended": carrier["appended"],
        "band_carrier_user": carrier["user"],
        "band_carrier_synthetic": carrier["synthetic"],
        "first_band": order[0] if order else "none",
        "band_order": ",".join(order),
        "last_record": records,
        "stop_tool_parts": stop_tool_parts,
        "last_tool_parts": last_tool_parts,
    }
    for band, _ in BANDS:
        figures = per_band.get(band)
        if figures is None:
            result[f"{band}_records"] = 0
            result[f"{band}_record"] = 0
            result[f"{band}_index"] = 0
            result[f"{band}_total"] = 0
            result[f"{band}_is_tail"] = 0
            result[f"{band}_is_msg0"] = 0
            result[f"{band}_appended"] = 0
            result[f"{band}_role"] = ""
            result[f"{band}_ctx"] = 0
            result[f"{band}_budget"] = 0
            if band in ("plan", "reserve"):
                result[f"{band}_left"] = 0
                result[f"{band}_arith"] = 0
            continue
        result[f"{band}_records"] = figures["records"]
        result[f"{band}_record"] = figures["record"]
        result[f"{band}_index"] = figures["index"]
        result[f"{band}_total"] = figures["total"]
        result[f"{band}_is_tail"] = figures["is_tail"]
        result[f"{band}_is_msg0"] = figures["is_msg0"]
        result[f"{band}_appended"] = figures["appended"]
        result[f"{band}_role"] = figures["role"]
        result[f"{band}_ctx"] = figures["ctx"]
        result[f"{band}_budget"] = figures["budget"]
        if band in ("plan", "reserve"):
            result[f"{band}_left"] = figures["left"]
            result[f"{band}_arith"] = figures["arith"]
    emit(result)


main()
