#!/usr/bin/env python3
"""Reads a releaser's reply against the release form its prompt sets and prints
`key=value` lines for the driver (`releaser-task.sh`, loaded by mr_load_kv):

  head / head_ok     the reply's head — its first `Release:` or `Blocked:`
                     line — and whether it is
                     `Blocked: release stopped at step 5`
  step<k>            ok | fail | not run | "" for step k (1..6)
  step<k>_line       the reply line for step k

Usage: releaser-reply.py <reply.txt>
"""

import re, sys

text = open(sys.argv[1]).read()
lines = [l.strip().strip("`*") for l in text.splitlines()]

head = next((l for l in lines if l.startswith(("Release:", "Blocked:"))), "")
print("head=" + head)
print("head_ok=" + ("1" if re.match(r"Blocked:\s*release stopped at step 5\b", head, re.IGNORECASE) else "0"))

STATUS = r"(ok|fail|not run)"
for k in range(1, 7):
    pattern = re.compile(rf"^(?:[-*]\s*)?(?:step\s*)?{k}[.):]?\s+{STATUS}\b", re.IGNORECASE)
    line = next((l for l in lines if pattern.match(l)), "")
    m = pattern.match(line)
    print(f"step{k}=" + (m.group(1).lower() if m else ""))
    print(f"step{k}_line=" + line[:200])
