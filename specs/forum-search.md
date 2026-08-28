# Concept: `forum_search` — a forum route for the plugin's web search

Status: proposed, not implemented. Boundary: the plugin at `/home/user/opencode-agent-intercom`.
Model: the forum route in `~/.claude/agents/researcher.md` (lines 52–66).

**Direction that fixes the shape of this design: no provider-side domain restriction is
wanted.** The route therefore takes its forum orientation from three things only — the query
the plugin builds, what searxng offers natively, and the prompt rule for the `researcher`
role. `includeDomains`, Exa's REST endpoint and the paid advanced MCP tool are out of scope,
and §2.1 records only what was measured about them so the question is not reopened.

## 1. What the code does today (read, with the lines behind it)

- `web_search` is declared in `src/websearch.js:227-318`, args `query` and `numResults`
  (`z.number().int().min(1).max(10).optional()`, `src/websearch.js:239-245`), default 5
  (`const numResults = args.numResults ?? 5`, `:248`).
- Two backends run concurrently and neither can fail the other:
  `const [exaSettled, searxSettled] = await Promise.allSettled([exaTask, searxTask ?? Promise.resolve(null)])`
  (`:268-271`); both dead returns `websearch failed: ${why || "no results"}` (`:303`).
- The Exa transport is `callExa(toolName, args, signal)` (`:79-96`), posting JSON-RPC
  `tools/call` to `const EXA_MCP_URL = "https://mcp.exa.ai/mcp"` (`:28`), tool name
  `"web_search_exa"` (`:253-257`), key via `x-api-key` from `getExaApiKey()` (`:38-47`).
- The searxng transport is `callSearxng(query, signal)` (`:98-108`), building
  `` `${base}/search?q=${encodeURIComponent(query)}&format=json` `` (`:100`) — one plain
  query, no `categories`, no bang, no `site:`.
- Pure and already exported: `normalizeUrl` (`:115`), `parseExaEntries` (`:128`),
  `searxToEntries` (`:155`), `mergeAndDedup` (`:174`), `renderEntries` (`:207`).
  `searxToEntries` keeps `title/url/publishedDate/content` and **drops searxng's `score`**
  (`:159-166`). `mergeAndDedup` is already variadic (`...lists`, `:174`).
  `callExa` and `callSearxng` are module-private.
- The tool is registered conditionally: `...(isWebsearchEnabled() ? { web_search: createWebsearchTool() } : {})`
  (`src/tools.js:540`), gated by `OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH` (`src/websearch.js:223-225`).
- `RESEARCHER_PROMPT` is `src/agents.js:93-99`; the `researcher` role is `src/agents.js:189-202`.
  Two roles deny the tool by name: orchestrator `web_search: "deny"` (`src/agents.js:141`)
  and gitter `web_search: "deny"` (`src/agents.js:219`).
- Settings resolve file > env > default in `getSettings()` (`src/settings.js`), and every
  validated key today is either an integer or a string — **there is no array key yet**.
- The stated reason for the custom tool is prompt size: "MCP-server-supplied tool
  descriptions (~1.5 KB) would land in every LLM call's system prompt; we control a short
  description here instead" (`src/websearch.js:5-8`). The shape decision in §3.1 is measured
  against that.

## 2. Capabilities, measured rather than assumed

Every figure below comes from a call made while writing this concept, once each.

### 2.1 Domain restriction: closed, and recorded so it stays closed

`tools/list` against `https://mcp.exa.ai/mcp` — the URL the plugin already calls — returns
exactly two tools: `web_search_exa` (`query`, `numResults`; required `query`) and
`web_fetch_exa` (`urls`, `maxCharacters`). The search tool declares
`additionalProperties: false` and carries no domain parameter under any spelling.

Sending one anyway is **silently ignored, not rejected**: `web_search_exa` with
`query: "rust async runtime comparison"` and `includeDomains: ["forums.truenas.com"]` answered
HTTP 200 with five SEO blog posts (`toolsku.com`, `abrarqasim.com`, `corrode.dev`,
`generalistprogrammer.com`, `reintech.io`) and nothing from truenas. A restriction that is
accepted and ignored is worse than one that errors — never send it.

The two paths that do offer `includeDomains` are both shut for this plugin:
`web_search_advanced_exa` is reachable only by appending `?tools=web_search_advanced_exa` to
the URL (on the plain URL a call fails `MCP error -32602: Tool … not found`) and answers 401
without auth; `POST https://api.exa.ai/search` answers HTTP 402 with an x402 payment
challenge unauthenticated. Both are out of scope by direction and neither appears in the
design below.

Two by-products of that probing do carry into the design:

- `numResults: 20` on `web_search_exa` is accepted and returns 20 entries — the `max(10)` in
  `src/websearch.js:243` is the plugin's own cap, not the provider's. Above 20 is untested.
- Exa's free MCP tier is rate limited tightly enough that this concept's own verification hit
  it: `"You've hit Exa's free MCP rate limit."` The route must therefore make **one** Exa call
  per invocation, never two, and must treat that message as a failed leg rather than as an
  empty result set.

### 2.2 What Exa is good at here: the query itself

`web_search_exa`, unrestricted, `numResults: 20`, query

> `forum threads where people report their real experience running kubernetes on raspberry pi`

returned 20 URLs of which **17 were genuine forums or discussion threads**:
`forums.raspberrypi.com` (9), `discuss.kubernetes.io`, `github.com/k3s-io/k3s/issues`, two
Lemmy instances, `forum.linuxfoundation.org`, `linux.org/threads`, `dev.to`, plus three
articles. Exa's neural ranking reads "forum threads where people report their real
experience" and finds forum-shaped pages by itself. **This is the whole mechanism the Exa leg
rests on**, and with no domain parameter available it is also the only one.

A second call confirms the steer is real rather than luck: the query
`"forum thread discussion on reddit.com or forum.proxmox.com about running zfs special vdev in
practice"` returned 6 of 6 hits from `forum.proxmox.com`. Naming domains inside the query
prose steers hard — which is why §3.3 does *not* do it: naming a couple of communities biases
every question toward them, and naming twenty dilutes the semantic vector the steer depends on.

The same measurement kills the idea of a curated domain list used client-side. Of those 20
hits, **exactly 1 was on the 22-domain list** of `~/.claude/agents/researcher.md:64`. Filtering
the leg by that list would have discarded 16 of 17 good threads, because the right forums for
that question — `forums.raspberrypi.com`, `discuss.kubernetes.io` — were never on the list and
could not be: the list is finite and the tail of vendor forums is not.

### 2.3 What searxng contributes: engine bangs, not `site:`

Read from our own instance's `/config` (`http://<searxng-host>:30080`, 195 engines):

| engine | shortcut | categories | enabled |
|---|---|---|---|
| `github` | `gh` | it, repos | yes |
| `stackoverflow` | `st` | it, q&a | yes |
| `askubuntu` | `ubuntu` | it, q&a | yes |
| `superuser` | `su` | it, q&a | yes |
| `hackernews` | `hn` | it | **no** |
| `lobste.rs` | `lo` | it | **no** |

No engine whose name contains `reddit` exists among the 195 — the reason the model's route
exists is confirmed on our own instance, not merely quoted.

- Each of the six answers on its own bang: `!st python list comprehension` → 10 hits,
  `!gh react` → 30, `!hn rust` → 30, `!ubuntu apt broken packages` → 10,
  `!su windows path variable` → 10, `!lo rust` → 20. The bang reaches `hackernews` and
  `lobste.rs` **despite their `enabled: false`**, as `~/.claude/agents/researcher.md:36` states
  for bangs generally.
- Engine bangs chain inclusively in one call:
  `!hn !lo !st !ubuntu !su !gh rust async runtime` → 91 results,
  `{askubuntu:1, stackoverflow:10, hackernews:30, lobste.rs:20, github:30}`,
  `unresponsive_engines: []`. A second query gave 81 across all six.
- Latency of that chain, measured once: **0.70 s**. The existing
  `SEARXNG_TIMEOUT_MS = 12_000` (`src/websearch.js:30`) is ample.
- **`site:` is dead ground here.** `site:reddit.com proxmox zfs experience` returned
  **0 results**, with `braveapi` "access denied", `dogpile` "access denied", `google cse`
  "too many requests": every general engine that could honour the operator is suspended on this
  instance. The operator passes through to engines unchanged
  (`~/.claude/agents/researcher.md:36`) — there is simply no engine left to honour it. It is
  therefore not used.
- **Category selection is not used either.** The `q&a` category holds exactly the three
  engines the bangs already name, `it` adds mdn, the arch and gentoo wikis, mankier, docker hub
  and pypi — documentation sources, which is the opposite of what this route wants — and a
  category name containing `&` or a space has to survive `encodeURIComponent` in
  `src/websearch.js:100`. Bangs give the same reach with none of that.
- An early niche query through the chain returned lobste.rs hits only; the per-engine probes
  above show the other five were not broken, the niche query simply had no hits in their
  site-local indexes. Thin per-engine yield is a property of the query, not a fault.

**Is searxng worth calling on this route at all: yes, and it is the stronger half.** Its six
engines search nothing but forums and Q&A sites, so every row it returns is on-target by
construction — a guarantee the Exa leg cannot give. It costs no key, no quota and 0.7 s, and
it is the only leg that still answers when Exa is rate-limited. Without it the route loses
Stack Overflow, AskUbuntu, SuperUser, Hacker News, Lobsters and GitHub issue threads as a
floor. Exa's job beside it is the complement searxng structurally cannot do: reddit, Discourse
instances and vendor forums.

## 3. The design

The model in `researcher.md` puts a curated domain list into the provider call. Here there is
no parameter to put it in (§2.1) and, measured, no client-side use for it that does not cost
more than it buys (§2.2). What replaces it is the division of labour the two backends already
have: **searxng is the domain-bound leg — its engines are the forums — and Exa is the
open leg, steered by the query text alone.**

One rule follows and the rest of the design obeys it: **nothing filters.** No whitelist, no
host matching, no partition. Each backend's own ranking stands, and the only reordering is the
interleave in §3.5 that keeps one loud backend from burying the other.

### 3.1 Shape: a separate `forum_search` tool

Recommended. Three shapes were weighed:

| shape | cost | what it forecloses | what it demands of the implementer |
|---|---|---|---|
| **separate `forum_search` tool** (recommended) | one extra tool description (~330 B) in every subagent system prompt | nothing | a second small tool module; the name must be added to the two `deny` lists |
| a `forums: boolean` on `web_search` | no extra tool, but `web_search`'s description must grow to explain when to set it — realistically past 330 B, so no saving | one tool with two query shapes, two `numResults` ceilings and two backend call shapes inside one `execute` | a branchy `execute`, and the model must remember an optional flag it can silently omit |
| prompt rule only, no tool change | free | **impossible**: the envelope and the bang chain are provider-call changes, and the researcher has `bash: "deny"` (`src/agents.js:194`) so it cannot make them itself | — |

The deciding argument is the one the file already makes for itself (`src/websearch.js:5-11`):
this plugin buys short tool descriptions. A tool *name* is the strongest route signal a small
model has; an optional boolean on an existing tool is the weakest, and when the model forgets
it the run silently takes the wrong route leaving no trace. Two short descriptions beat one
long one carrying a mode switch.

The middle option deserves one more word, because with the domain filter gone it looks cheaper
than before: the two routes now differ in the query string sent to *both* backends, in the
`numResults` ceiling, and in what the results are for (triage vs. answer). That is not a flag,
it is a second tool wearing one.

### 3.2 Argument schema

```
forum_search(
  query:      string, min 1
              "What experience you are looking for, in prose — the thing, plus what
               people would be reporting about it"
  numResults: int 1..20, optional, default 8
)
```

`numResults` runs to 20, not 10: the endpoint returns 20 (§2.1) and the route is triage
material (§3.6). Default 8 rather than 5, so both backends are visibly represented.

Description, held near the length of `web_search`'s:

> Search discussion forums and Q&A sites for lived user experience — whether a thing works in
> practice, which settings people actually run, what breaks on them. Use this INSTEAD OF
> `web_search` when the answer has to come from people who ran the thing; use `web_search` for
> documentation, releases, versions and official facts. Returns threads as title, URL and
> excerpt — triage material, then `webfetch` the ones worth reading.

### 3.3 The two provider calls

Both go out concurrently under `Promise.allSettled`, exactly as `src/websearch.js:268-271`,
and neither can fail the other.

**Exa leg.** `callExa("web_search_exa", { query: envelope, numResults: Math.min(20, numResults * 2) })`
against `EXA_MCP_URL` unchanged (`src/websearch.js:28`). Exactly one Exa call per invocation
(§2.1). No domain argument of any kind is sent (§2.1).

The envelope is built in one place and is the measured string, not a variation of it:

```
`forum threads where people report their real experience with ${query}`
```

The form verified in §2.2 was `… their real experience running kubernetes on raspberry pi`,
i.e. this prefix with the topic appended, and it produced 17 forum hits in 20. The prefix is
kept verbatim for that reason; a longer tail ("what worked in practice, what broke, which
settings they run") reads well but is untested and would trade a measured result for an
unmeasured one. If someone later wants the tail, it is one string constant and §7 says how to
check it.

No domain name is placed in the envelope, for the reason measured in §2.2: naming domains
steers hard, so naming two would bias every question toward them and naming twenty would
dilute the steer entirely.

`numResults * 2`, capped at 20, over-fetches so the interleave in §3.5 has material to draw on
after de-duplication.

**searxng leg.** The existing `callSearxng`, called with a bang-prefixed query:

```
`${bangs.join(" ")} ${query}`     // default bangs: !hn !lo !st !ubuntu !su !gh
```

The user's **bare** query, not the envelope: these six are keyword engines over their own
site-local indexes, and envelope prose only adds words that match nothing. The bang set is
§3.7. If `searxngUrl` is unset the leg does not run, as `web_search` already behaves
(`src/websearch.js:249`), and the route degrades to the Exa leg alone.

### 3.4 Cutting the searxng leg down

The chain returns 80–90 rows (§2.3) against Exa's 20, so it must be cut before merging or it
swamps the answer.

- `searxToEntries` (`src/websearch.js:155-169`) gains one field,
  `score: Number(r.score) || 0`. Additive: `renderEntries` (`:207-221`) does not print it and
  `web_search` does not read it, so `web_search`'s output stays byte-identical.
- `forum_search` sorts its searxng entries by `score` descending and drops everything below
  **one tenth of that response's top score** — a relative threshold, because the absolute
  level depends on how many engines answered (`~/.claude/agents/researcher.md:34`).
- It then keeps at most `numResults * 2` of them.

Note this is a relevance cut inside one backend's own ranking, not a filter across backends.

### 3.5 Merge and render

1. `mergeAndDedup(exaEntries, searxEntries)` (`src/websearch.js:174-203`), unchanged: dedupe by
   `normalizeUrl`, richer snippet wins, `sources` records every leg a URL appeared in — which
   is a real confidence signal when both backends surface the same thread.
2. Interleave the two backends round-robin, Exa first, each in its own rank order. Round-robin
   rather than concatenation: 80 searxng rows would otherwise bury the reddit, Discourse and
   vendor-forum hits, which are exactly what searxng cannot produce. Exa first because it is the
   leg whose ordering was measured (§2.2).
3. `slice(0, numResults)`.
4. `renderEntries` — the same `Title:/URL:/Published:/Author:/Highlights:` text shape
   (`src/websearch.js:206-221`), so nothing downstream learns a second format.
5. Log one line in the shape of `src/websearch.js:308-315`.
6. Both legs dead → `forum_search failed: ${why || "no results"}`, mirroring `:299-304`. An Exa
   answer carrying `isError: true` with the rate-limit text (§2.1) is a failed leg with that
   reason, not an empty result set — searxng still renders.

### 3.6 What the route is not

No page is fetched. Excerpts are triage material and the model is told so in both the tool
description and the prompt; threads worth reading go through `webfetch`, which the researcher
already has (`src/agents.js:95`).

### 3.7 Where the configurable list lives: the bangs, not domains

There is **no domain list in this design** — not in a provider call (§2.1) and not client-side
(§2.2). The question "where does the domain list live" therefore has an answer with one moving
part left, and it is the searxng bang set, because on this route the bangs *are* the domain
restriction: each bang binds one engine that searches one site.

- `FORUM_BANGS = ["!hn", "!lo", "!st", "!ubuntu", "!su", "!gh"]`, a `const` in the new module,
  each verified to answer (§2.3).
- `~/.config/opencode/agent-intercom.json` gains `"forumBangs": ["!hn", "!lo", "!se"]`.
  `getSettings()` validates it as an array of non-empty strings, trims each and drops anything
  else; `getForumBangs()` returns the configured array when it is non-empty, otherwise the
  default.

**Replacement, not union** — the opposite of what a curated domain list would want, and for a
concrete reason: the set is a property of *one searxng instance*. Another user's instance may
lack `lobste.rs`, may have `reddit` restored, may name a shortcut differently. A union would
leave them unable to drop a bang that does nothing on their instance, and replacement lets
them state their instance's reality in one line. The default is documented in the README so
replacing is not guesswork.

A bang the instance does not know is not an error and not a crash: searxng simply returns
nothing for it and the other engines answer. That soft failure is what makes replacement safe
to expose. The `!hn`/`!lo` case shows why the set is worth exposing at all — both are
`enabled: false` on our instance and reachable *only* because a bang overrides the flag, so a
user with a differently configured instance genuinely needs this lever.

This is the first array-valued key in `src/settings.js`; it needs its own validation branch,
not a reuse of the integer or string ones.

### 3.8 Prompt wording for the `researcher` role

Three lines appended to `RESEARCHER_PROMPT` (`src/agents.js:93-99`), after the first line:

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

With the domain filter gone the prompt carries more of the design's weight than it did, so the
wording is deliberate:

- "**FIRST**" and "never a fallback for one that came back empty" encode the model's central
  point (`~/.claude/agents/researcher.md:52`): the decision is read off the question before any
  query goes out, so a general search run first "to see whether forums are needed" is the exact
  ordering this forbids.
- The second line is the guard against over-triggering and names the failure directly — "would
  keep exactly those answers out" — rather than listing categories. The claim is true even
  without a domain filter, because the envelope in §3.3 steers Exa toward threads and the bangs
  bind searxng to six forums: a version number is genuinely not in what comes back. A model
  that knows *why* the route is wrong for a documentation question does not take it.
- "**A question carrying both**" is included because it is the common case in this plugin's own
  work — "does library X support Y, and does it hold up in production" — and without it the
  model has to invent a rule.
- The trigger words in the first line ("works in practice", "settings people actually run",
  "what breaks") are the same words the envelope puts into the Exa query. The model reads them,
  matches them against the question, and the route it then takes searches for the phrasing it
  matched on. That alignment is deliberate and is the closest thing this design has to a
  guarantee that the right route produces forum-shaped results.

The `researcher` role description (`src/agents.js:190-191`) gains a clause naming
`forum_search` beside `web_search`, since that string is what the orchestrator reads when
choosing an agent.

## 4. Steps

Behaviour-neutral first, then additive. Each step leaves the tree building (`npm run check`)
and the suite green (`npm test`), and each can be handed out alone.

**Step 1 — extract the shared search core.** New `src/searchcore.js` holding `EXA_MCP_URL`,
`EXA_TIMEOUT_MS`, `SEARXNG_TIMEOUT_MS`, `exaHeaders`, `parseSseResult`, `callExa`,
`callSearxng`, `normalizeUrl`, `parseExaEntries`, `searxToEntries`, `mergeAndDedup`,
`renderEntries`, moved verbatim. `src/websearch.js` keeps only `isWebsearchEnabled` and
`createWebsearchTool` and imports the rest. Update `test/exa-api-key.test.js:17` to import
`exaHeaders` from `../src/searchcore.js`.
Depends on: nothing. Rationale: `forum_search` needs `callExa` and `callSearxng`, which are
module-private today (`src/websearch.js:79`, `:98`); the alternative — exporting them from
`websearch.js` and importing sideways — makes the `web_search` tool module the owner of the
transports a sibling tool depends on, and that coupling is what a review flags first. About
120 lines moved, no logic changed.

**Step 2 — `score` on searxng entries.** One field in `searxToEntries` (§3.4). Additive.
Depends on: step 1.

**Step 3 — the `forumBangs` setting.** `FORUM_BANGS` const, array validation in
`getSettings()`, `getForumBangs()` (§3.7), plus the header comment block in
`src/settings.js:1-21` that documents every key.
Depends on: nothing; can run parallel to steps 1 and 2.

**Step 4 — `src/forumsearch.js`.** The tool: envelope, bang chain, relative-score cut,
round-robin, render, failure text (§3.3–§3.5), plus `isForumSearchEnabled()` reading
`OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH`, mirroring `src/websearch.js:223-225`.
Depends on: steps 1, 2, 3.

**Step 5 — wiring.** Register in `src/tools.js` beside line 540; add `forum_search: "deny"` to
the orchestrator (`src/agents.js:141`) and gitter (`src/agents.js:219`) permission blocks —
without this the orchestrator can search and the delegation pattern the plugin exists to
enforce leaks.
Depends on: step 4.

**Step 6 — prompt and role.** The three lines in `RESEARCHER_PROMPT` and the clause in the
`researcher` description (§3.8).
Depends on: step 5, so the tool the prompt names exists when the prompt ships.

**Step 7 — documentation.** A `forum_search` row in the README tool table (`README.md:158`),
the `forumBangs` key with its default in the configuration section (`README.md:272-274`),
`OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH` in the variable table (`README.md:284`), the
`researcher` row (`README.md:201`), and a `specs/` line in the Documents list of `CLAUDE.md` —
that list names `work/` and `concepts/` and this file sits in neither.
Depends on: step 6.

## 5. Assumptions, and what would show them wrong

- **The envelope keeps steering Exa toward forums.** Measured once, 17 forum hits in 20 (§2.2),
  on one topic. It is the single mechanism the Exa leg has, and it is a property of a ranking
  model that can change under us without notice. Wrong when a `forum_search` on a plainly
  experience-shaped question returns mostly articles and vendor pages; the observation is the
  live check in §7. If it fails, the Exa leg is worth less than the searxng leg and the honest
  response is to weight the interleave toward searxng, not to add a whitelist — §2.2 measured
  what that costs.
- **`numResults: 20` is within the endpoint's ceiling.** Verified at exactly 20; 21 and above
  untested. Wrong if a request for 20 returns fewer on a query with ample hits, or errors.
- **Exa's free MCP rate limit is per endpoint and shared with `web_search`'s calls**, not per
  tool. Not separately verified. The design already assumes the limit is tight — it is why the
  route makes one Exa call, not two (§2.1). Wrong if a rate-limit message arrives on one tool
  while the other keeps answering.
- **A user's own searxng carries the six default engines.** Verified for
  `http://<searxng-host>:30080`; another instance may lack them, or have `hackernews` and
  `lobste.rs` removed rather than merely disabled. Wrong when the per-engine breakdown of
  `engines[]` shows fewer than six names. It degrades quietly — fewer rows, no error — which is
  the right failure for an optional backend, and §3.7 is the lever for fixing it.
- **The searxng `score` field is present and comparable across engines in one response.** The
  relative one-tenth cut (§3.4) depends on it. Wrong if `score` is absent or zero on rows that
  are plainly relevant; `Number(r.score) || 0` keeps that from throwing, but the cut would then
  discard everything and the remedy is to skip the cut and take the top `numResults * 2` by
  arrival order.
- **A `site:` operator stays useless on our instance.** Measured 0 results with every capable
  engine suspended (§2.3). Wrong if those engines come back — the observation is
  `unresponsive_engines` no longer listing `braveapi`, `dogpile` and `google cse`. Even then it
  buys little the bangs do not already give.

## 6. Open, and outside this boundary

- Whether the plugin should ever gain a paid Exa path (advanced MCP tool or REST, §2.1). Closed
  by direction for this design, and nothing here has to be undone if it is ever reopened: it
  would be a third leg beside these two, not a replacement for either.
- Whether `forum_search` should be offered to roles beyond `researcher` — the planner chooses
  libraries (`src/agents.js:53`) and would plausibly want it. Left as it falls out: every role
  except orchestrator and gitter gets it, the same as `web_search`.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `searxToEntries` carries `score` and defaults it to 0 on a row that has none; `renderEntries`
  output for the same entries is unchanged from before step 2.
- `getForumBangs()`: no file → the six defaults; a file with `forumBangs` → that array exactly,
  defaults gone (replacement, not union); an empty array, a non-array, an array of non-strings
  and an array with blank strings → the defaults, no throw.
- Query construction: the string handed to `callExa` is the envelope prefix followed by the
  user's query verbatim, and carries no domain name; the string handed to `callSearxng` starts
  with the configured bangs, separated by single spaces, with the **bare** user query after them
  and no envelope words.
- No domain argument is sent to Exa under any settings (regression guard for §2.1: an ignored
  parameter leaves no trace at runtime, so only a test keeps it out).
- The relative score cut drops a row below one tenth of the top score and keeps one exactly at
  it; a response where every score is 0 does not throw.
- Round-robin interleave with lopsided inputs (20 Exa, 60 searxng) starts with Exa, starves
  neither, and the result is capped at `numResults`.
- Failure shape: both legs rejected → `forum_search failed: …` naming both reasons; one leg
  rejected → the other's results returned and nothing thrown; an Exa `isError` rate-limit reply
  counts as a failed leg, not as zero results.
- `searxngUrl` unset → no searxng call is attempted and the Exa leg still renders.
- `isForumSearchEnabled()` false → `src/tools.js` exposes no `forum_search` key.

Live, once each, after step 5 — no series, no averaging:

- One `forum_search` on a genuine experience question. Check that both legs contributed, that
  at least one hit is a reddit or Discourse or vendor-forum URL searxng structurally cannot
  produce, and — the real acceptance criterion, since nothing filters — that the **majority of
  returned URLs are threads rather than articles**. This is the standing check on the §5
  envelope assumption and the only evidence that the route works at all.
- One `web_search` on the same question, confirming its output is identical to what it produced
  before step 1 — proof that the extraction was behaviour-neutral, and the side-by-side that
  shows the two routes actually differ.
- If and only if someone wants the longer envelope tail (§3.3): the same question through both
  envelope forms, comparing how many of 20 hits are threads. One comparison, then the string is
  fixed and not revisited.
