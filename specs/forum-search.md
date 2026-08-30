# Concept: `forum_search` — a forum route for the plugin's web search

Status: wired; this file is the design it is built to. Boundary: the plugin at
`~/opencode-agent-intercom`.
Model: the forum route in `~/.claude/agents/researcher.md` (lines 52–66).

## 1. What the code does today (read, with the lines behind it)

- Two search tools sit beside each other and share one core: `web_search`
  (`src/websearch.js:36`) and `forum_search` (`src/forumsearch.js:108`), registered in
  `src/tools.js:541-542` behind `isWebsearchEnabled()` and `isForumSearchEnabled()`.
- `src/searchcore.js` owns both transports and every pure helper: `callExa`
  (`src/searchcore.js:75`) posting JSON-RPC `tools/call` to
  `const EXA_MCP_URL = "https://mcp.exa.ai/mcp"` (`:18`) with headers from `exaHeaders()`
  (`:28`, `x-api-key` only when a key is configured), `callSearxng` (`:94`) building
  `` `${base}/search?q=…&format=json` ``, and the two-leg concurrent run `runSearchLegs`
  (`:115`) whose `Promise.allSettled` (`:132-135`) keeps either leg from failing the other.
  Timeouts `EXA_TIMEOUT_MS = 30_000` (`:19`) and `SEARXNG_TIMEOUT_MS = 12_000` (`:20`).
- Pure helpers, shared: `normalizeUrl` (`:180`), `parseExaEntries` (`:193`), `searxToEntries`
  (`:222`), `mergeAndDedup` (`:242`), `renderEntries` (`:275`), `legFailureText` (`:168`).
  `searxToEntries` builds `{title, url, published, author, content, score, source}`
  (`:226-234`) — it carries searxng's `score` and **drops searxng's `engine` field**.
- `forum_search` today sends the Exa envelope `forumEnvelope` (`src/forumsearch.js:61`), the
  bare user query behind the bangs `bangQuery` (`:68`), cuts the searxng leg with a relative
  score threshold `cutByScore`/`cutSearxLeg` (`:76`, `:87`, `SCORE_CUT_RATIO = 0.1` at `:58`)
  and merges with a fixed round-robin `interleave` (`:94`).
- Settings resolve file > env > default in `getSettings()` (`src/settings.js:99-150`).
  `forumBangs` is the one array-valued key, validated at `src/settings.js:131-139` (non-empty
  trimmed strings kept, everything else dropped, nothing usable left → the built-in set) and
  read by `getForumBangs()` (`:173`). The built-in set is `DEFAULT_FORUM_BANGS`
  (`src/settings.js:55`).
- Prompt and roles: `RESEARCHER_PROMPT` names both tools (`src/agents.js:96-99`); web access is
  concentrated in the `researcher` role (`src/agents.js:137-145`), and every other role — the
  orchestrator (`src/agents.js:157`) and every subagent — denies `webfetch`, `websearch`,
  `web_search` and `forum_search` via the `NO_WEB_ACCESS` constant (`src/agents.js:143-145`),
  with gitter also naming them explicitly (`src/agents.js:225-226`); the `researcher` role
  description names both (`:201`).
- The stated reason for a custom tool rather than an MCP server is prompt size
  (`src/searchcore.js` header, and `src/websearch.js:5-8`): a server-supplied description
  (~1.5 KB) would land in every LLM call's system prompt. §3.1 and §3.2 are measured against
  that budget.

## 2. Capabilities, measured rather than assumed

Every figure below comes from a call made against the live endpoint or the live searxng
instance (`http://<searxng-host>:30080`, 195 engines), once each.

### 2.1 Exa over MCP: the tool takes a query and a count, and nothing else

`tools/list` against `https://mcp.exa.ai/mcp` returns exactly two tools: `web_search_exa`
(`query`, `numResults`; required `query`) and `web_fetch_exa` (`urls`, `maxCharacters`). The
search tool declares `additionalProperties: false` and carries no domain parameter under any
spelling.

Sending one anyway is **silently ignored, not rejected**: `web_search_exa` with
`query: "rust async runtime comparison"` and `includeDomains: ["forums.truenas.com"]` answered
HTTP 200 with five SEO blog posts and nothing from truenas. A restriction that is accepted and
ignored is worse than one that errors — never send it, and §7 keeps a test on that, since an
ignored parameter leaves no trace at runtime.

Two further properties carry into the design:

- `numResults: 20` is accepted and returns 20 entries — the `max(20)` in the tool schema is the
  plugin's own cap. Above 20 is untested.
- Exa's free MCP tier is rate limited tightly. The route therefore makes **one** Exa call per
  invocation and treats the rate-limit message as a failed leg, not as an empty result set.

### 2.2 What Exa is good at here: the query itself

`web_search_exa`, unrestricted, `numResults: 20`, query

> `forum threads where people report their real experience running kubernetes on raspberry pi`

returned 20 URLs of which **17 were genuine forums or discussion threads**:
`forums.raspberrypi.com` (9), `discuss.kubernetes.io`, `github.com/k3s-io/k3s/issues`, two
Lemmy instances, `forum.linuxfoundation.org`, `linux.org/threads`, `dev.to`, plus three
articles. Exa's neural ranking reads "forum threads where people report their real experience"
and finds forum-shaped pages by itself. **This is the whole mechanism the Exa leg rests on**,
and with no domain parameter on the tool it is also the only one.

A second call confirms the steer is real rather than luck: the query
`"forum thread discussion on reddit.com or forum.proxmox.com about running zfs special vdev in
practice"` returned 6 of 6 hits from `forum.proxmox.com`. Naming domains inside the query prose
steers hard — which is why §3.3 does *not* do it: naming a couple of communities biases every
question toward them, and naming twenty dilutes the semantic vector the steer depends on.

**What the same measurement does and does not settle about host matching.** Of those 20 hits,
**exactly 1 was on the 22-domain list** of `~/.claude/agents/researcher.md:64`. Matching against
that list works against 16 of 17 good threads, whether the match filters them out or merely
ranks them down, because the right forums for that question — `forums.raspberrypi.com`,
`discuss.kubernetes.io` — were never on the list and could not be: the list is finite and the
tail of vendor forums is not. **No curated list of named communities is matched anywhere in this
route**, and none is used to drop a row.

That figure bounds a *curated list of communities*. It says nothing about a *shape* signal that
names no community — `/viewtopic.php`, `/questions/`, a host label `forum` — which matches the
long tail the list cannot enumerate: 7 of those 20 hits carry such a shape and only 1 was on the
list. A shape signal is therefore permitted, under three limits that §3.4 states and §3.5–§3.6
obey: it classifies, it orders **within one leg's own results**, and it **never drops a row**.

### 2.3 What searxng contributes: engine bangs, and what each engine actually returns

Read from the instance's own `/config` (195 engines):

| engine | shortcut | categories | enabled |
|---|---|---|---|
| `stackoverflow` | `st` | it, q&a | yes |
| `askubuntu` | `ubuntu` | it, q&a | yes |
| `superuser` | `su` | it, q&a | yes |
| `hackernews` | `hn` | it | no |
| `lobste.rs` | `lo` | it | no |
| `github` | `gh` | it, repos | yes |

A bang reaches `hackernews` and `lobste.rs` **despite their `enabled: false`**, as
`~/.claude/agents/researcher.md:36` states for bangs generally. No engine whose name contains
`reddit` exists among the 195 — the reason the model's route exists is confirmed on the
instance, not merely quoted. No **general** Stack Exchange engine exists either: the three above
are the whole Stack Exchange reach, and the shortcut `se` on this instance belongs to
`semantic scholar`, an academic paper search. The only other q&a-category engines are
product-specific Discourse instances (`discuss.python`/`dpy`, `caddy.community`/`caddy`,
`pi-hole.community`/`pi`) — too narrow to default to, and exactly what the `forumBangs` key
(§3.8) exists for.

**What each engine returns, per URL, measured:**

| bang | rows on a 3-word query | URL it returns | thread? |
|---|---|---|---|
| `!st` | 10 | `stackoverflow.com/q/<id>` | yes |
| `!su` | 7 | `superuser.com/q/<id>` | yes |
| `!ubuntu` | 6 | `askubuntu.com/q/<id>` | yes |
| `!hn` | 30 | `news.ycombinator.com/item?id=<id>`, 30 of 30 | yes — the discussion page itself |
| `!lo` | 20 | the **submitted external page**, 20 of 20 distinct foreign hosts (`chrisshort.net`, `medium.com`, `github.com`, …) | no — the discussion is one hop away and never in the URL |
| `!gh` | 30 | `github.com/<owner>/<repo>`, **0 of 30** with an `/issues` or `/discussions` path | no — repositories |

So the searxng leg's thread guarantee holds for `!st`, `!ubuntu`, `!su` and `!hn`; `!lo` returns
article URLs it found through a discussion; `!gh` returns repositories, which is a result type
this route's own output contract rejects (§3.8 drops it).

**Query form decides the leg's yield, and prose kills it.** Every bang measurement is on the
same topic through the same five-bang chain, one call each:

| query after the bangs | rows | engines that answered |
|---|---|---|
| `kubernetes raspberry pi` | 73 | so 10, hn 30, lo 20, su 7, ubuntu 6 |
| `running kubernetes raspberry pi` | 45 | so 10, hn 8, lo 20, su 6, ubuntu 1 |
| `kubernetes raspberry pi practice` | 18 | so 2, lo 16 |
| `running kubernetes raspberry pi practice breaks` | 4 | lo 4 |
| `What is it like running Kubernetes on Raspberry Pi in practice, and what breaks?` | 4 | lo 4 |
| `zfs special vdev practice` | 4 | lo 4 |

`unresponsive_engines` was empty in all six. These are keyword engines over site-local indexes
that narrow hard on every added term; one non-topical word ("practice") costs the Stack Exchange
engines four fifths of their rows, and the interrogative frame costs them everything. What
survives a long query is `lobste.rs`, the loosest matcher and the one whose URLs are not
threads. **The leg must be sent two to four topic words** (§3.3); prose is the one form measured
to return nothing usable.

**searxng's `score` is a reciprocal rank, not a relevance level.** In the four-row response
above the scores are `1.0, 0.5, 0.333…, 0.25` — exactly `1/position` within the one engine that
answered. The field is a reciprocal-rank sum over the engines that returned a row: it orders
rows and, when several engines agree on a URL, it raises it. It carries no cross-engine
relevance signal and cannot express "this row is off topic", so no threshold on it can remove an
irrelevant row. It is used for ordering only (§3.5).

Latency of the six-bang chain, measured once: **0.70 s**; `SEARXNG_TIMEOUT_MS = 12_000` is ample.

**`site:` is dead ground here.** `site:reddit.com proxmox zfs experience` returned **0 results**,
with `braveapi`, `dogpile` and `google cse` all suspended: the operator passes through to engines
unchanged and there is no engine left to honour it. **Category selection is not used either** —
`q&a` holds the three engines the bangs already name, `it` adds documentation sources, and a
category name containing `&` has to survive `encodeURIComponent`.

**Is searxng worth calling on this route: yes, as the floor, not as the stronger half.** Four of
its five default engines return thread URLs on their own sites, it costs no key, no quota and
0.7 s, and it is the only leg that still answers when Exa is rate-limited. What it cannot reach
is reddit, Discourse instances and vendor forums — the long tail that carries most lived
experience — and that reach is the Exa leg's job. Neither leg is guaranteed to be the better one
on a given question, which is why §3.6 gives slots to what a leg returned rather than to the leg.

## 3. The design

The model in `researcher.md` puts a curated domain list into the provider call. Here there is no
parameter to put it in (§2.1) and no client-side use for such a list that does not cost more than
it buys (§2.2). What replaces it is the division of labour the two backends already have:
**searxng reaches Stack Exchange and Hacker News by engine, Exa reaches the open tail by query
prose**, and the merge grades what each returned rather than which leg returned it.

Two rules the rest of the design obeys:

1. **Nothing is dropped for being off a list.** No curated domain list, no whitelist, no
   partition by community. Each backend's own ranking is the input order.
2. **Shape may order, never gate.** The community-agnostic thread shape of §3.4 re-orders rows
   inside one leg's own lane and bounds how many non-thread rows a leg may contribute, and it
   never removes a row from the candidate set.

### 3.1 Shape: a separate `forum_search` tool

Recommended. Three shapes were weighed:

| shape | cost | what it forecloses | what it demands of the implementer |
|---|---|---|---|
| **separate `forum_search` tool** (recommended) | two tool descriptions (~460 B) in every subagent system prompt | nothing | a second small tool module; the name must be in the two `deny` lists |
| a `forums: boolean` on `web_search` | no extra tool, but `web_search`'s description must grow to explain when to set it — past the saving | one tool with two query shapes, two `numResults` ceilings and two backend call shapes inside one `execute` | a branchy `execute`, and the model must remember an optional flag it can silently omit |
| prompt rule only, no tool change | free | **impossible**: the envelope, the bang chain and the keyword reduction are provider-call changes, and the researcher has `bash: "deny"` (`src/agents.js:189`) so it cannot make them itself | — |

The deciding argument is the one the source already makes for itself: this plugin buys short
tool descriptions. A tool *name* is the strongest route signal a small model has; an optional
boolean on an existing tool is the weakest, and when the model forgets it the run silently takes
the wrong route leaving no trace. Two short descriptions beat one long one carrying a mode
switch. The routes also differ in the query string sent to *both* backends, in the `numResults`
ceiling and in what the results are for — that is not a flag, it is a second tool wearing one.

### 3.2 Argument schema

```
forum_search(
  query:      string, min 1
              "What experience you are looking for, in prose — the thing, plus what
               people would be reporting about it"
  keywords:   string, optional
              "The 2-4 bare topic words behind the question — no question words, no
               experience words. Example: kubernetes raspberry pi"
  numResults: int 1..20, optional, default 8
)
```

`numResults` runs to 20: the endpoint returns 20 (§2.1) and the route is triage material (§3.7).
Default 8, so both legs are visibly represented.

`keywords` exists because the two legs need opposite query forms and only one of them is
derivable with confidence: Exa wants the prose (§2.2), searxng wants two to four topic words
(§2.3), and the words to remove are semantic ("practice", "breaks") rather than grammatical. The
model that wrote the question knows which words are the topic; a stopword stripper has to guess,
and a wrong guess costs the leg four fifths of its rows.

| how the searxng leg gets its query | cost | what it forecloses | what it demands |
|---|---|---|---|
| **model-supplied `keywords`, derived fallback** (recommended) | ~130 B of tool description; one more argument the model may omit | nothing — the fallback is the derivation-only option | `reduceToKeywords`, plus the argument |
| derivation only, no argument | no prompt cost | the model can never correct a bad reduction | a stopword list that must also strip the route's own experience vocabulary, and is wrong silently |
| the bare `query`, as prose | none | the leg itself: measured 4 rows from the one engine whose URLs are not threads (§2.3) | — |

Description, held near the length of `web_search`'s:

> Search discussion forums and Q&A sites for lived user experience — whether a thing works in
> practice, which settings people actually run, what breaks on them. Use this INSTEAD OF
> `web_search` when the answer has to come from people who ran the thing; use `web_search` for
> documentation, releases, versions and official facts. Returns threads as title, URL and
> excerpt — triage material, then `webfetch` the ones worth reading.

### 3.3 The two provider calls

Both go out concurrently through `runSearchLegs` (`src/searchcore.js:115`), and neither can fail
the other.

**Exa leg.** `callExa("web_search_exa", { query: envelope, numResults: Math.min(20, numResults * 2) })`.
Exactly one Exa call per invocation (§2.1). No domain argument of any kind is sent (§2.1). The
envelope is built in one place and is the measured string:

```
`forum threads where people report their real experience with ${query}`
```

The form verified in §2.2 was this prefix with the topic appended, and it produced 17 forum hits
in 20. A longer tail reads well but is untested and would trade a measured result for an
unmeasured one. No domain name goes into the envelope (§2.2). `numResults * 2`, capped at 20,
over-fetches so the merge in §3.6 has thread-shaped material to draw on after de-duplication.

**searxng leg.** `callSearxng` with the bangs and the keywords:

```
`${bangs.join(" ")} ${keywords}`     // default bangs: !st !ubuntu !su !hn !lo
```

`keywords` is the argument when the model supplied it, otherwise `reduceToKeywords(query)`: a
named pure function that lowercases nothing, strips punctuation at token edges, removes
closed-class stopwords and interrogatives (`what`, `how`, `is`, `it`, `like`, `in`, `and`, `the`,
`a`, `on`, `for`, `to`, `of`, `does`, `do`, `with`, `my`, `your`, …) **and the route's own
experience vocabulary** (`experience`, `practice`, `real`, `actually`, `worth`, `break`,
`breaks`, `broken`, `works`, `working`, `run`, `running`, `people`, `report`, `reports`,
`anyone`, `advice`, `recommend`) — that vocabulary is a closed set this design itself defines,
being the same words §3.9 puts in the prompt and §3.3 puts in the envelope — and then keeps the
**first four** surviving tokens in their original order. Four is the measured ceiling at which
the Stack Exchange engines still answer (§2.3).

Either way the string handed to searxng carries no envelope prose. If `searxngUrl` is unset the
leg does not run, as `web_search` already behaves, and the route degrades to the Exa leg alone.

One call per leg. Re-querying searxng with fewer terms when the first response came back thin was
considered and is not done: it doubles the leg's calls for a case the four-token ceiling already
bounds, and the merge tolerates a thin lane by construction (§3.6).

### 3.4 What counts as a thread

A single definition, written here because both the merge order (§3.6) and the acceptance criteria
(§7) are read against it, and two runs must not invent two rules for the same URLs.

`isThreadUrl(url)` — a pure function over the URL alone, in its own module, true when the host or
the path carries one of these shapes:

| where | shape |
|---|---|
| path | `/viewtopic.php`, `/showthread.php`, `/viewthread.php` |
| path | a `/thread/`, `/threads/`, `/topic/`, `/topics/`, `/forum/`, `/forums/` segment |
| path | `/t/<id>` (Discourse) |
| path | `/questions/`, `/q/<digits>`, `/a/<digits>` (Stack Exchange family, long and short form) |
| path | a `/comments/` segment (reddit and its clones) |
| path | `/issues/<digits>`, `/discussions/<digits>` (issue trackers) |
| path + query | `/item` with an `id=<digits>` query (Hacker News shape) |
| host | a dot-separated label equal to `forum`, `forums`, `board`, `boards`, `community`, `discuss`, `discussion` or `answers`, or a host label beginning `forum` |

The rule names no community: every entry is a URL shape that any host may carry, which is what
separates it from the curated list §2.2 refutes. A repository root, a blog post and a
documentation page match none of them; `news.ycombinator.com/item?id=…` and
`superuser.com/q/…` match; a lobste.rs row, being the submitted external page, matches nothing —
which is the correct verdict on it.

The rule is deliberately incomplete: a Lemmy or Discourse instance with an unusual path shape
will be classified as a non-thread. That costs it order, never presence (§3.6), and the cost is
bounded because a leg's non-thread rows still fill the output when nothing better is left.

### 3.5 The searxng lane

The chain returns up to ~90 rows on a good keyword query (§2.3) and as few as 4 on a bad one,
from one engine. Both cases are handled by the same two operations, and neither is a relevance
filter — `score` cannot express relevance (§2.3):

1. Order the rows by searxng's `score` descending, ties in arrival order. Because `score` is a
   reciprocal rank, this puts every engine's rank-1 row first, then every rank-2 row, and so on.
2. **Cap each engine at 2 rows** (`MAX_ROWS_PER_ENGINE = 2`), by the `engine` field, taking each
   engine's own highest-ranked rows. This is what stops a single loose matcher from filling the
   lane: in the measured 73-row response one engine held 30 rows, and in the thin response one
   engine held 4 of 4.
3. Truncate the lane to `numResults` rows.

| how the searxng lane is bounded | cost | what it forecloses | what it demands |
|---|---|---|---|
| **per-engine cap of 2, ordered by score** (recommended) | a lane of at most 2 × engines rows | nothing; every engine that answered is represented | the `engine` field on searxng entries |
| relative score threshold (a fraction of the top score) | none | it is arithmetically inert: against `1/position` scores a one-tenth threshold keeps positions 1–10 of a single engine, so it removes nothing a cap does not | — |
| top N by score | none | same defect: N rows of the loudest engine | — |

### 3.6 Merge and render

1. `mergeAndDedup(exaEntries, searxEntries)` (`src/searchcore.js:242`): dedupe by `normalizeUrl`,
   richer snippet wins, `sources` records every leg a URL appeared in — a real confidence signal
   when both backends surface the same thread.
2. Split the merged list into two lanes by `source`. Within each lane, stably partition the rows
   the §3.4 shape calls threads ahead of the rest, each group keeping the lane's own order.
   Nothing is removed.
3. Round-robin the two lanes, the Exa lane first (it is the lane whose ordering was measured,
   §2.2), up to `numResults`. A lane may spend at most its **non-thread quota** on rows the shape
   does not call threads: `floor(numResults / 4)` for the searxng lane, unbounded for the Exa
   lane. A lane whose next row is a non-thread and whose quota is spent is skipped for that round.
   The asymmetry is measured, not aesthetic: the Exa leg's non-thread rows were on topic
   (`dev.to` on the asked question), while the searxng leg's non-thread rows came from the
   engine whose URLs are submissions and were off topic.
4. If fewer than `numResults` rows were picked, append the still-unpicked rows in merged order
   until the count is reached. The quota bounds a weak leg's *share*, never the tool's yield.
5. `renderEntries` — the same `Title:/URL:/Published:/Author:/Highlights:` text shape
   (`src/searchcore.js:275`), so nothing downstream learns a second format.
6. Log one line, carrying the per-lane thread count so §7's standing observation is a property of
   every run rather than of someone remembering to look:
   `exa=<n> searxng=<kept>/<raw> merged=<n> dupesRemoved=<n> returned=<n> threads=exa <t>/<n> searxng <t>/<n>`.
7. Both legs dead → `forum_search failed: ${why || "no results"}` via `legFailureText`. An Exa
   answer carrying `isError: true` with the rate-limit text (§2.1) is a failed leg with that
   reason, not an empty result set — searxng still renders.

This is where the case "a leg answered, but with rows the route is not for" is owned: such a leg
keeps its rows in the candidate set, loses its guaranteed share of the output through step 3, and
reappears in step 4 only if nothing better exists.

### 3.7 What the route is not

No page is fetched. Excerpts are triage material and the model is told so in both the tool
description and the prompt; threads worth reading go through `webfetch`, which the researcher
already has (`src/agents.js:96`).

### 3.8 Where the configurable list lives: the searxng bangs

- `DEFAULT_FORUM_BANGS = ["!st", "!ubuntu", "!su", "!hn", "!lo"]`, a `const` in
  `src/settings.js` beside the other defaults. Four of the five return thread URLs; `!lo` is
  carried as a discovery engine (§2.3) whose rows are article URLs and therefore sink under the
  §3.6 order and quota. No `!gh`: it returns repositories, 0 of 30 with an issue or discussion
  path, and a repository is not what this route's output contract offers. No `!se`: on this
  instance that shortcut is Semantic Scholar, and no general Stack Exchange engine exists.
- `~/.config/opencode/agent-intercom.json` carries `"forumBangs": ["!st", "!su", "!dpy"]`.
  `getSettings()` validates it as an array of non-empty strings, trims each, drops anything else,
  and resolves to `DEFAULT_FORUM_BANGS` when nothing usable is left, so the returned object
  always carries the set in effect. `getForumBangs()` reads it.

**Replacement, not union.** The set is a property of *one searxng instance*: another user's may
lack `lobste.rs`, may have `reddit` restored, may name a shortcut differently, and product
Discourse engines like `!dpy`, `!caddy` and `!pi` are worth adding only to a project whose topic
they cover. A union would leave a user unable to drop a bang that does nothing on their instance;
replacement lets them state their instance's reality in one line. The default is documented in
the README so replacing is not guesswork.

A bang the instance does not know is not an error and not a crash: searxng returns nothing for it
and the other engines answer. That soft failure is what makes replacement safe to expose. `!hn`
and `!lo` are `enabled: false` on this instance and reachable *only* because a bang overrides the
flag, so a user with a differently configured instance genuinely needs this lever.

Keeping `!lo` at all is a judgement, not a measurement: its rows never satisfy §3.4, and the
alternative is a four-bang default. It stays because lobsters submissions are practitioner-curated
and reach hosts no other engine here can, and because §3.6 already bounds what they cost — at
`numResults: 8` they can occupy at most 2 slots, and only when nothing thread-shaped is left.

### 3.9 Prompt wording for the `researcher` role

Three lines in `RESEARCHER_PROMPT` (`src/agents.js:96-99`), after the first line:

```
For a question about lived experience — whether something works in practice, which settings
people actually run, what breaks on them, what others hit before you — call `forum_search`
FIRST; it replaces the general search for that question and is never a fallback for one that
came back empty.
For documentation, a release, an announcement, a version or an official fact use
`web_search` — `forum_search` would keep exactly those answers out. A question carrying both
takes `forum_search` first and `web_search` after it for the documented part.
Forum excerpts are triage: pick the threads worth reading and `webfetch` them; a project's
own documentation outranks a third-party page about that project.
```

The prompt decides which of two tools a run takes, so the wording is deliberate:

- "**FIRST**" and "never a fallback for one that came back empty" encode the model's central
  point (`~/.claude/agents/researcher.md:52`): the decision is read off the question before any
  query goes out, so a general search run first "to see whether forums are needed" is the exact
  ordering this forbids.
- The second line is the guard against over-triggering and names the failure directly rather than
  listing categories. It holds on two mechanisms that are measured: the envelope steers Exa
  toward threads (§2.2), and `!st`, `!ubuntu`, `!su` and `!hn` return discussion pages rather
  than release notes (§2.3). A model that knows *why* the route is wrong for a documentation
  question does not take it.
- "**A question carrying both**" is included because it is the common case in this plugin's own
  work — "does library X support Y, and does it hold up in production" — and without it the model
  has to invent a rule.
- The trigger words in the first line ("works in practice", "settings people actually run", "what
  breaks") are the same words the envelope puts into the Exa query, and the same closed set
  `reduceToKeywords` strips out of the searxng query (§3.3). One vocabulary, used three times,
  in the direction each leg needs.

The `researcher` role description (`src/agents.js:189`) names `forum_search` beside `web_search`,
since that string is what the orchestrator reads when choosing an agent.

## 4. Steps

Each step leaves the tree building (`npm run check`) and the suite green (`npm test`), and each
can be handed out alone.

**Step 1 — `engine` on searxng entries.** `searxToEntries` (`src/searchcore.js:222-237`) carries
`engine: (r.engine ?? "").trim()` beside `score`. Additive: `renderEntries` does not print it and
`web_search` does not read it, so `web_search`'s output stays byte-identical.
Depends on: nothing.

**Step 2 — the thread shape.** New module holding `isThreadUrl(url)` per §3.4, pure, no network,
plus its unit tests. Depends on: nothing; can run parallel to step 1.

**Step 3 — the keyword form of the searxng query.** `reduceToKeywords(query)` and the `keywords`
argument in the tool schema and description (§3.2, §3.3); `bangQuery` takes the reduced string.
Depends on: nothing; can run parallel to steps 1 and 2.

**Step 4 — the searxng lane.** Replace `cutByScore`/`cutSearxLeg` (`src/forumsearch.js:76-91`)
with the score ordering, the per-engine cap and the truncation of §3.5; `SCORE_CUT_RATIO` goes.
Depends on: step 1 (the `engine` field is the cap's input).

**Step 5 — the lane merge.** Replace `interleave` (`src/forumsearch.js:94-102`) with the
partition, quota, round-robin and fill of §3.6.
Depends on: steps 2 and 4.

**Step 6 — the bang default.** `DEFAULT_FORUM_BANGS = ["!st", "!ubuntu", "!su", "!hn", "!lo"]`
(`src/settings.js:55`) and its header comment.
Depends on: nothing, but ship it after step 5 so the run that first sees the new set also has the
merge that grades it.

**Step 7 — the log line.** Extend the `forumsearch merge` line with the per-lane thread counts
(§3.6.6), which is what §7's standing observation reads.
Depends on: steps 2 and 5.

**Step 8 — documentation.** The `forum_search` row (`README.md:159`) gains `keywords?`; the
`forumBangs` default (`README.md:306`) is restated with the five bangs and what each returns.
Depends on: steps 3 and 6.

**Step 9 — the live check.** §7's live section, once, after step 8.
Depends on: all of the above.

## 5. Assumptions, and what would show them wrong

- **The envelope keeps steering Exa toward forums.** Measured once, 17 forum hits in 20 (§2.2),
  on one topic; it is a property of a ranking model that can change under us without notice.
  Wrong when **the Exa lane's own returned rows** are mostly non-threads under §3.4 — read off
  the `threads=exa …` field of every run's log line, not off the merged output, which mixes in a
  second leg. If it fails, the Exa leg has lost its only steer and the route is worth
  re-deciding; §2.2 measured what a curated domain list would cost instead.
- **The searxng thread engines answer only to short topic queries.** Measured across six query
  forms (§2.3): 3 topic words → 73 rows from 5 engines, 5 words including one experience word →
  18, prose → 4 from `lobste.rs` alone. Wrong when a run's searxng lane comes back from a single
  engine while `unresponsive_engines` is empty and the keywords were two to four topic words.
- **`reduceToKeywords` produces a usable query when the model omits `keywords`.** The strip list
  is closed and hand-written; a topical word that happens to be in it ("running" in a question
  about a running track) is removed wrongly. Wrong on the same observation as above; the remedy
  is the `keywords` argument the model can always supply.
- **`!hn` returns the discussion page and `!lo` the submission.** Measured 30 of 30
  `news.ycombinator.com/item?id=…` and 20 of 20 foreign hosts (§2.3). Wrong if Hacker News rows
  start arriving with foreign hosts, which would move `!hn` into the same class as `!lo` and cost
  the searxng lane half its thread yield.
- **searxng's `score` is a reciprocal rank and carries no relevance level.** Measured
  `1.0, 0.5, 0.333…, 0.25` on a single-engine response (§2.3). Wrong if a single-engine response
  returns scores that are not `1/position`; the design would then have a relevance signal it
  currently assumes it lacks.
- **The §3.4 shape rule generalises beyond the queries it was written against.** Not measured on
  a second topic. Wrong when the rows a run's log counts as threads are, on reading, not
  discussions, or when plainly discussion-shaped rows are counted as non-threads — read off the
  same live check as the per-lane counts. The rule only orders, so the cost of being wrong is
  ordering, not omission.
- **`numResults: 20` is within the endpoint's ceiling.** Verified at exactly 20; 21 and above
  untested. Wrong if a request for 20 returns fewer on a query with ample hits, or errors.
- **Exa's free MCP rate limit is per endpoint and shared with `web_search`'s calls**, not per
  tool. Not separately verified; the design already assumes the limit is tight — it is why the
  route makes one Exa call. Wrong if a rate-limit message arrives on one tool while the other
  keeps answering.
- **A user's own searxng carries the five default engines.** Verified for
  `http://<searxng-host>:30080`. Wrong when the per-engine breakdown shows fewer than five names.
  It degrades quietly — fewer rows, no error — which is the right failure for an optional
  backend, and §3.8 is the lever for fixing it.
- **A `site:` operator stays useless on our instance.** Measured 0 results with every capable
  engine suspended (§2.3). Wrong if `unresponsive_engines` stops listing `braveapi`, `dogpile`
  and `google cse`. Even then it buys little the bangs do not already give.

## 6. Open, and outside this boundary

- Whether `forum_search` should be offered to roles beyond `researcher` — the planner chooses
  libraries (`src/agents.js:53`) and would plausibly want it. Left as it falls out: only
  `researcher` keeps it (and `web_search`), the same as `webfetch` and `websearch`.
- Ownership of the two things that drift: the bang set and the per-lane thread counts. Both are
  this project's own maintenance. A changed set is recorded in the README's `forumBangs` row
  (`README.md:306`) with what each added engine returns per §2.3's table; a sustained fall in the
  Exa lane's thread count is the §5 falsification and is acted on there, not silently absorbed.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `searxToEntries` carries `engine` and `score` and defaults both on a row that has neither;
  `renderEntries` output for the same entries is unchanged.
- `isThreadUrl`: true for `forums.example.com/viewtopic.php?t=1`, `example.com/questions/12/x`,
  `example.com/q/12`, `discuss.example.org/t/topic/9`, `example.com/r/x/comments/abc`,
  `news.ycombinator.com/item?id=1`, `github.com/o/r/issues/7`, `community.example.net/topic/4`;
  false for `example.com/blog/post`, `github.com/o/r`, `medium.com/@a/b`, `example.com/docs/api`,
  and for a lobste.rs-style submission URL such as `gaultier.github.io/blog/x.html`.
- `reduceToKeywords`: an interrogative experience question reduces to its topic words, at most
  four, in original order; an already-short keyword string passes through unchanged; a query of
  nothing but stopwords reduces to a non-empty fallback (the original query) rather than an empty
  searxng query.
- Query construction: the string handed to `callExa` is the envelope prefix followed by the
  user's `query` verbatim and carries no domain name; the string handed to `callSearxng` starts
  with the configured bangs separated by single spaces, followed by `keywords` when supplied and
  by `reduceToKeywords(query)` when not, and carries no envelope word.
- No domain argument is sent to Exa under any settings (regression guard for §2.1: an ignored
  parameter leaves no trace at runtime, so only a test keeps it out).
- The searxng lane: an 80-row response with one engine holding 30 rows yields at most 2 rows from
  that engine; every engine that answered is represented; the lane is truncated to `numResults`;
  an all-zero-score response does not throw and keeps its rows.
- `getForumBangs()`: no file → the five defaults; a file with `forumBangs` → that array exactly,
  defaults gone (replacement, not union); an empty array, a non-array, an array of non-strings and
  an array with blank strings → the defaults, no throw.
- The merge: with 16 Exa candidates and 4 searxng rows at `numResults: 8`, a searxng lane holding
  no thread-shaped row contributes at most `floor(8 / 4) = 2` rows and the remaining slots go to
  the Exa lane; with both lanes thread-shaped the output alternates, Exa first; a lane's skipped
  rows still appear when the other lane runs out before `numResults`; the result is never shorter
  than `min(numResults, merged.length)`.
- Failure shape: both legs rejected → `forum_search failed: …` naming both reasons; one leg
  rejected → the other's results returned and nothing thrown; an Exa `isError` rate-limit reply
  counts as a failed leg, not as zero results.
- `searxngUrl` unset → no searxng call is attempted and the Exa leg still renders.
- `isForumSearchEnabled()` false → `src/tools.js` exposes no `forum_search` key.

Live, once each, after step 8 — no series, no averaging. One `forum_search` on a genuine
experience question, judged per leg against §3.4 and against the run's own log line:

- **(a) the Exa lane.** A majority of the Exa-sourced rows in the returned set are threads. This
  is the test of the §5 envelope assumption and the only per-leg criterion that grades Exa's
  ranking.
- **(b) the searxng lane.** Its returned rows come from at least two engines when at least two
  answered, no returned row is a repository root, and at most `floor(numResults / 4)` of its rows
  are non-threads. This is the test of the keyword reduction and the per-engine cap.
- **(c) the merged output.** At least half the returned rows are threads, and at least one row
  sits on a host no configured bang engine can produce. The aggregate is reachable here only
  because (b) bounds what a weak leg may contribute; it is the criterion the tool's caller
  experiences, and (a) and (b) are what locate the cause when it fails.
- **(d) the route difference.** One `web_search` on the same question, confirming the two routes
  return materially different result sets — this is what the separate tool name buys — and that
  `web_search`'s own output is unaffected by anything in §4.

The standing observation, as opposed to that one-off gate: every run logs `threads=exa <t>/<n>
searxng <t>/<n>` (§3.6.6). A run whose Exa lane count falls below half falsifies the §5 envelope
assumption; a run whose searxng lane returns rows from one engine only, with
`unresponsive_engines` empty, falsifies the keyword assumption. Neither needs a person to
remember to re-measure.
