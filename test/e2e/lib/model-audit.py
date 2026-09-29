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

An agent passed to --agent-model is pinned to a model of its own: its turns
are held to that model instead of the run's pin.

Exit codes:
  0  every assistant message names the model pinned for its agent (an off-pin
     turn of an agent passed to --exempt-agent is allowed and reported
     separately)
  1  at least one names another — the banned model is called out as such,
     and an exempt agent on the banned model fails like any other
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


def own_pin_note(offender, agent_models):
    """` (pinned to <ref>)` for an agent with a pin of its own, else empty."""
    return f" (pinned to {offender['expected']})" if offender["agent"] in agent_models else ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", required=True, help="the pinned providerID/modelID")
    parser.add_argument("--banned", default="", help="a model whose appearance is named as such")
    parser.add_argument(
        "--exempt-agent",
        default="",
        help="agents the pin does not reach, space-separated (grounder): an off-pin "
        "turn of one of these is allowed and counted separately, but the banned "
        "model is refused for them too",
    )
    parser.add_argument(
        "--agent-model",
        action="append",
        default=[],
        help="agent=providerID/modelID: that agent's turns are held to this model "
        "instead of --expect; repeatable",
    )
    parser.add_argument("--label", default="run", help="what is being audited, for the evidence line")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    exempt = set(args.exempt_agent.split())
    agent_models = {}
    for pair in args.agent_model:
        agent, sep, ref = pair.partition("=")
        if not sep or not agent or "/" not in ref:
            print(f"--agent-model wants agent=providerID/modelID (got: {pair})")
            return 2
        agent_models[agent] = ref

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
    exempt_turns = Counter()
    for info in messages:
        ref = f"{info['providerID']}/{info['modelID']}"
        tally[ref] += 1
        agent = info.get("mode", "?")
        expected = agent_models.get(agent, args.expect)
        if ref != expected:
            if agent in exempt and ref != args.banned:
                exempt_turns[f"{agent} on {ref}"] += 1
                continue
            offenders.append(
                {
                    "model": ref,
                    "session": info.get("sessionID", "?"),
                    "message": info.get("id", "?"),
                    "agent": agent,
                    "expected": expected,
                }
            )

    seen = ", ".join(f"{ref}={count}" for ref, count in sorted(tally.items()))
    exempt_seen = ", ".join(f"{what}={count}" for what, count in sorted(exempt_turns.items()))
    exempt_note = f" ({exempt_seen})" if exempt_seen else ""
    head = f"{args.label}: {len(messages)} assistant message(s) over {read} capture(s)"
    own_pins = "".join(f", {agent} on {ref}" for agent, ref in sorted(agent_models.items()))
    expectation = f"{args.expect}{own_pins}"

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
        print(f"{head} — answered by: {seen}; expected {expectation} alone{extra}{exempt_note}")
        for offender in offenders[:20]:
            print(
                f"        turn on {offender['model']} — agent {offender['agent']}"
                f"{own_pin_note(offender, agent_models)}, "
                f"session {offender['session']}, message {offender['message']}"
            )
        if len(offenders) > 20:
            print(f"        … and {len(offenders) - 20} more")
        return 1
    if exempt_turns:
        print(
            f"{head} — every turn of a pinned agent answered by {expectation}; "
            f"{sum(exempt_turns.values())} exempt-agent turn(s) allowed{exempt_note}"
        )
        return 0
    print(f"{head} — every one answered by {seen}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
