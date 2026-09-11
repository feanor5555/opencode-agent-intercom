#!/usr/bin/env python3
"""Which model actually answered.

Reads the message-tree captures an end-to-end driver wrote — the JSON a
`GET /session/<id>/message` returns, in any nesting — and compares the model of
every assistant message against the one the run pinned.

opencode stamps `providerID` and `modelID` on every assistant message
(`AssistantMessage`, @opencode-ai/sdk), so this is what answered, not what the
request asked for. The two differ: `applyModelChoices` (src/llmmodel.js) writes
the model from llm-models.json into `config.agent[<name>].model` at bootstrap
and that wins over the `model` a POST names.

Exit codes:
  0  every assistant message names the pinned model
  1  at least one names another — the banned model is called out as such
  2  the captures hold no assistant message at all; nothing was audited

One evidence line on stdout either way, the offending messages listed after it.
"""

import argparse
import json
import sys
from collections import Counter


def walk(node, found):
    """Every assistant message info anywhere in a parsed capture."""
    if isinstance(node, dict):
        if node.get("role") == "assistant" and node.get("providerID") and node.get("modelID"):
            found.append(node)
        for value in node.values():
            walk(value, found)
    elif isinstance(node, list):
        for value in node:
            walk(value, found)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", required=True, help="the pinned providerID/modelID")
    parser.add_argument("--banned", default="", help="a model whose appearance is named as such")
    parser.add_argument("--label", default="run", help="what is being audited, for the evidence line")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()

    messages = []
    read, unreadable = 0, []
    for path in args.files:
        try:
            with open(path) as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            continue
        except Exception as err:
            unreadable.append(f"{path}: {err}")
            continue
        read += 1
        walk(payload, messages)

    tally = Counter()
    offenders = []
    for info in messages:
        ref = f"{info['providerID']}/{info['modelID']}"
        tally[ref] += 1
        if ref != args.expect:
            offenders.append(
                {
                    "model": ref,
                    "session": info.get("sessionID", "?"),
                    "message": info.get("id", "?"),
                    "agent": info.get("mode", "?"),
                }
            )

    seen = ", ".join(f"{ref}={count}" for ref, count in sorted(tally.items()))
    head = f"{args.label}: {len(messages)} assistant message(s) over {read} capture(s)"

    if unreadable:
        print(f"{head} — unreadable capture(s): {'; '.join(unreadable)}")
        return 2
    if not messages:
        print(
            f"{head} — nothing to audit: no assistant message in "
            f"{read} capture(s), so no turn can be shown to have run on {args.expect}"
        )
        return 2
    if offenders:
        banned_hits = sum(1 for o in offenders if o["model"] == args.banned)
        extra = f", {banned_hits} of them on the banned {args.banned}" if banned_hits else ""
        print(f"{head} — answered by: {seen}; expected {args.expect} alone{extra}")
        for offender in offenders[:20]:
            print(
                f"        turn on {offender['model']} — agent {offender['agent']}, "
                f"session {offender['session']}, message {offender['message']}"
            )
        if len(offenders) > 20:
            print(f"        … and {len(offenders) - 20} more")
        return 1
    print(f"{head} — every one answered by {seen}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
