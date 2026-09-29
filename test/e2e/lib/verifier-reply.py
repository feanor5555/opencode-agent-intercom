#!/usr/bin/env python3
"""Reads a verifier's reply against the check form its prompt sets and prints
`key=value` lines for the driver (`verifier-task.sh`, loaded by mr_load_kv):

  head / head_ok        the `Checks:` line, and whether it parses as
                        `Checks: <n> — <p> pass, <f> fail, <r> not run`
  checks / pass / fail / not_run
                        the four figures of that line, "" where it does not parse
  verdict1              the verdict of the first check line after the head:
                        PASS | FAIL | NOT RUN | ""
  verdict1_line         that line
                        A check line carries its verdict in one of the places
                        the reply form puts it: first on the line after an
                        optional bullet and check label (`1 FAIL — ...`,
                        `- Check 2: NOT RUN ...`), right after a `Verdict:`
                        label, or right after the dash that closes a `Check`
                        title (`Check: <name> — FAIL`). A verdict word anywhere
                        else is prose and is not read.
  pageerror             1 where the reply quotes a `[pageerror]` line
  pageerror_line        the first line that does
  red_or_broken         1 where the reply names red or BROKEN
  no_vision             1 where the reply gives "no vision" as a reason
  any_pass              1 where the head counts a pass or a check line's
                        verdict is PASS

Usage: verifier-reply.py <reply.txt>
"""

import re
import sys

text = open(sys.argv[1]).read()
lines = [l.strip().strip("`*").strip() for l in text.splitlines()]
lines = [l for l in lines if l]

head_index = next((i for i, l in enumerate(lines) if l.startswith("Checks:")), -1)
head = lines[head_index] if head_index >= 0 else ""
print("head=" + head[:240])
m = re.match(
    r"Checks:\s*(\d+)\s*[—–-]+\s*(\d+)\s*pass(?:ed)?,\s*(\d+)\s*fail(?:ed)?,\s*(\d+)\s*not run",
    head,
    re.IGNORECASE,
)
print("head_ok=" + ("1" if m else "0"))
checks, passed, failed, not_run = m.groups() if m else ("", "", "", "")
print("checks=" + checks)
print("pass=" + passed)
print("fail=" + failed)
print("not_run=" + not_run)

VERDICT_WORD = r"(NOT RUN|PASS|FAIL)\b"
VERDICT_PLACES = (
    re.compile(r"\bVerdict\s*:\s*" + VERDICT_WORD, re.IGNORECASE),
    re.compile(r"^(?:[-*•]\s*)?(?:(?:Check\s*)?\d+\s*[.:)]?\s*)?" + VERDICT_WORD),
    re.compile(r"^(?:[-*•]\s*)?Check\b[^—–]*?\s(?:[—–]+|-+)\s*" + VERDICT_WORD),
)


def check_verdict(line):
    """The verdict a check line of the reply form carries, or "" for prose."""
    bare = line.replace("*", "").replace("`", "").strip()
    for place in VERDICT_PLACES:
        found = place.search(bare)
        if found:
            return found.group(1)
    return ""


rest = lines[head_index + 1 :] if head_index >= 0 else lines
verdicts = [(check_verdict(l), l) for l in rest]
verdicts = [(v, l) for v, l in verdicts if v]
verdict, verdict_line = verdicts[0] if verdicts else ("", "")
print("verdict1=" + verdict)
print("verdict1_line=" + verdict_line[:240])

pageerror_line = next((l for l in lines if "[pageerror]" in l), "")
print("pageerror=" + ("1" if pageerror_line else "0"))
print("pageerror_line=" + pageerror_line[:240])
print("red_or_broken=" + ("1" if re.search(r"\bred\b|\bBROKEN\b", text, re.IGNORECASE) else "0"))
print("no_vision=" + ("1" if re.search(r"no vision", text, re.IGNORECASE) else "0"))
any_pass = (passed not in ("", "0")) or any(v == "PASS" for v, _ in verdicts)
print("any_pass=" + ("1" if any_pass else "0"))
