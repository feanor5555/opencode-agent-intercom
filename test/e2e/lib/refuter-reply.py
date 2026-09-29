#!/usr/bin/env python3
"""Reads a refuter's reply against the claim form its prompt sets and prints
`key=value` lines for the driver (`refuter-task.sh`, loaded by mr_load_kv):

  head / head_ok            the `Claims:` line, and whether it counts
                            3 claims — 1 hold, 2 false, 0 not checkable
  claim<n>_line             the reply line for claim n (1..3)
  claim<n>_verdict          holds | false | not checkable | ""
  claim<n>_refs             every path:line on that line
  claim<n>_ref_outside_tools  1 where one of them is not in src/tools.js

Usage: refuter-reply.py <reply.txt>
"""

import re, sys

text = open(sys.argv[1]).read()
lines = [l.strip().strip("`*") for l in text.splitlines()]

head = next((l for l in lines if l.startswith("Claims:")), "")
print("head=" + head.replace("\n", " "))
m = re.match(r"Claims:\s*(\d+)\s*[—–-]+\s*(\d+)\s*holds?,\s*(\d+)\s*false,\s*(\d+)\s*not checkable", head)
print("head_ok=" + ("1" if m and m.groups() == ("3", "1", "2", "0") else "0"))

PATH_LINE = re.compile(r"[\w./-]+\.\w+:\d+")
for n in ("1", "2", "3"):
    line = next(
        (l for l in lines if re.match(rf"^(?:[-*]\s*)?(?:#\s*)?{n}[.):]?\s+(holds|false|not checkable)", l)),
        "",
    )
    verdict = ""
    vm = re.match(rf"^(?:[-*]\s*)?(?:#\s*)?{n}[.):]?\s+(holds|false|not checkable)", line)
    if vm:
        verdict = vm.group(1)
    refs = PATH_LINE.findall(line)
    print(f"claim{n}_line=" + line[:240])
    print(f"claim{n}_verdict=" + verdict)
    print(f"claim{n}_refs=" + " ".join(refs))
    print(f"claim{n}_ref_outside_tools=" + ("1" if any(not r.startswith("src/tools.js:") and "/src/tools.js:" not in r for r in refs) else "0"))
