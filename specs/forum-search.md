# Concept: `forum_search` — a forum route for the plugin's web search

Status: proposed, not implemented. Boundary: the plugin at `/home/user/opencode-agent-intercom`.
Model: the forum route in `~/.claude/agents/researcher.md` (lines 52–66).

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
  (`:159-166`). `callExa` and `callSearxng` are module-private.
- The tool is registered conditionally: `...(isWebsearchEnabled() ? { web_search: createWebsearchTool() } : {})`
  (`src/tools.js:540`), gated by `OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH` (`src/websearch.js:223-225`).
- `RESEARCHER_PROMPT` is `src/agents.js:93-99`; the `researcher` role is `src/agents.js:189-202`.
  Two roles deny the tool by name: orchestrator `web_search: "deny"` (`src/agents.js:141`)
  and gitter `web_search: "deny"` (`src/agents.js:219`).
- Settings resolve file > env > default in `getSettings()` (`src/settings.js`), and every
  validated key today is either an integer or a string — **there is no array key yet**.
- The stated reason for the custom tool is prompt size: "MCP-server-supplied tool
  descriptions (~1.5 KB) would land in every LLM call's system prompt; we control a short
  description here instead" (`src/websearch.js:5-8`). Any shape decision below is measured
  against that.

## 2. Capabilities, measured rather than assumed

All figures below come from calls made while writing this concept, once each.

### 2.1 Exa's hosted MCP endpoint has no domain filter

`tools/list` against `https://mcp.exa.ai/mcp` returns exactly two tools:

- `web_search_exa` — properties `query`, `numResults`; required `query`.
- `web_fetch_exa` — properties `urls`, `maxCharacters`; required `urls`.

There is no `includeDomains`, no `include_domains`, no domain parameter of any name.

Sending one anyway is **silently ignored, not rejected**. `web_search_exa` with
`query: "rust async runtime comparison"` and `includeDomains: ["forums.truenas.com"]`
answered HTTP 200 with five SEO blog posts (`toolsku.com`, `abrarqasim.com`, `corrode.dev`,
`generalistprogrammer.com`, `reintech.io`) and nothing from truenas. A restriction that is
accepted and ignored is worse than one that errors: do not send it.

`numResults: 20` is accepted and returns 20 entries — the `max(10)` in
`src/websearch.js:243` is the plugin's own cap, not the provider's. Above 20 is untested.

### 2.2 Exa's REST `/search` is not reachable without a paid key

`POST https://api.exa.ai/search` with `includeDomains` and no key answers **HTTP 402**,
`"tag":"X402_PAYMENT_REQUIRED"`, with an x402 on-chain payment offer in `accepts[]`. The
anonymous tier the plugin depends on (`src/websearch.js:13`) does not reach this endpoint.
So a true provider-side domain filter is available only to a user who has paid for a key,
and it cannot be the route's foundation.

### 2.3 What Exa is actually good at here: the prose envelope

`web_search_exa`, unrestricted, `numResults: 20`, query
`"forum threads where people report their real experience running kubernetes on raspberry pi"`
returned 20 URLs of which **17 were genuine forums or discussion threads**:
`forums.raspberrypi.com` (9), `discuss.kubernetes.io`, `github.com/k3s-io/k3s/issues`,
two Lemmy instances, `forum.linuxfoundation.org`, `linux.org/threads`, `dev.to`, plus three
articles. Exa's neural ranking reads "forum threads where people report their real
experience" and finds forum-shaped pages by itself.

**Of those 20, exactly 1 was on the 22-domain list.** That is the decisive measurement of
this concept: applying the curated list as a *filter* to the Exa leg would have thrown away
16 of 17 good threads, because the right forums for that question — `forums.raspberrypi.com`,
`discuss.kubernetes.io` — were never on the list and never could be, the list being finite
and the long tail of vendor forums not.

A second check confirms the steer is real and not luck: the query
`"forum thread discussion on reddit.com or forum.proxmox.com about running zfs special vdev
in practice"` returned 6 of 6 hits from `forum.proxmox.com`.

### 2.4 What searxng contributes: engine bangs, not `site:`

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
  `lobste.rs` **despite their `enabled: false`**, as `~/.claude/agents/researcher.md:36`
  states for bangs generally.
- Engine bangs chain inclusively in one call:
  `!hn !lo !st !ubuntu !su !gh rust async runtime` → 91 results,
  `{askubuntu:1, stackoverflow:10, hackernews:30, lobste.rs:20, github:30}`,
  `unresponsive_engines: []`. A second query gave 81 across all six.
- Latency of that chain, measured once: **0.70 s**. The existing
  `SEARXNG_TIMEOUT_MS = 12_000` (`src/websearch.js:30`) is ample.
- `site:` is dead ground on this instance: `site:reddit.com proxmox zfs experience` returned
  **0 results**, with `braveapi` "access denied", `dogpile` "access denied", `google cse`
  "too many requests" — every general engine that could honour a `site:` operator is
  suspended here. `site:` is therefore not the searxng instrument for this route.
- An early niche query through the chain returned only lobste.rs hits; the per-engine probes
  above show the other five were not broken, the niche query simply had no hits in their
  site-local indexes. Thin per-engine yield is a property of the query.

**Answer to "is searxng worth calling here": yes, and it is the leg that actually carries a
domain restriction.** Its six engines *are* six of the twenty-two domains, at zero key, zero
cost and 0.7 s. Exa alone would lose Stack Overflow, AskUbuntu, SuperUser and GitHub
issue threads as a guaranteed floor.

## 3. The design

The model in `researcher.md` puts the domain list into the provider call. Neither provider
available to this plugin takes one: Exa-over-MCP has no such parameter (§2.1) and searxng's
`site:` is dead here (§2.4). The route is therefore built the other way round, from what each
provider can actually do, and the list changes job.

**The domain list boosts; it never filters.** Filtering was measured and costs 16 of 17 good
threads (§2.3).

### 3.1 Shape: a separate `forum_search` tool

Recommended. Three shapes were weighed:

| shape | cost | what it forecloses | what it demands of the implementer |
|---|---|---|---|
| **separate `forum_search` tool** (recommended) | one extra tool description (~330 B) in every subagent system prompt | nothing | a second small tool module; the tool name must be added to the two `deny` lists |
| a `forums: boolean` on `web_search` | no extra tool, but `web_search`'s description must grow to explain when to set it — realistically past 330 B, so no saving | one tool with two provider call shapes, two `numResults` ceilings and two ranking rules inside one `execute` | a branchy `execute`, and the model must remember an optional flag it can silently omit — the failure mode is invisible |
| prompt rule only, no tool change | free | **impossible**: the bang chain and the query envelope are provider-call changes, and the researcher role has `bash: "deny"` (`src/agents.js:194`) so it cannot make them itself | — |

The deciding argument is the one the file already makes for itself (`src/websearch.js:5-11`):
this plugin buys short tool descriptions. A tool *name* is the strongest selection signal a
small model has; an optional boolean on an existing tool is the weakest, and when the model
forgets it the run silently takes the wrong route with no trace. Two short descriptions beat
one long one carrying a mode switch.

### 3.2 Argument schema

```
forum_search(
  query:      string, min 1
              "What experience you are looking for, in prose — the thing plus what
               people would be reporting about it"
  numResults: int 1..20, optional, default 8
)
```

`numResults` runs to 20, not 10: the route is triage material (§3.6) and the Exa endpoint
returns 20 (§2.1). Default 8 rather than 5, because on-list and off-list forums both have to
fit in the answer.

Description, held near the length of `web_search`'s:

> Search discussion forums and Q&A sites for lived user experience — whether a thing works in
> practice, which settings people actually run, what breaks on them. Use this INSTEAD OF
> `web_search` when the answer has to come from people who ran the thing; use `web_search` for
> documentation, releases, versions and official facts. Returns threads as title, URL and
> excerpt — triage material, then `webfetch` the ones worth reading.

### 3.3 The two provider calls

Both go out concurrently under `Promise.allSettled`, exactly as `src/websearch.js:268-271`.

**Exa leg** — `callExa("web_search_exa", { query: envelope, numResults: Math.min(20, numResults * 2) })`.
No domain argument is sent (§2.1). The envelope is built in one place:

```
`forum threads, discussion posts and user reports where people describe their real
 experience with ${query} — what worked in practice, what broke, which settings they run`
```

This is the only lever the endpoint offers and it was measured to work (§2.3). The domain
list is deliberately **not** spliced into the envelope: 22 domain names in the prose dilute
the semantic vector the envelope depends on.

`numResults * 2` (capped at 20) is over-fetch, so the boost in §3.5 has material to reorder.

**searxng leg** — the existing `callSearxng`, called with a bang-prefixed query:

```
`!hn !lo !st !ubuntu !su !gh ${query}`
```

The user's bare query, not the envelope: these six are keyword engines over their own site
indexes and prose hurts them. The bang set is fixed in the source (§3.7). If `searxngUrl` is
unset the leg does not run, the same as `web_search` today (`src/websearch.js:249`).

### 3.4 Ranking searxng's side

The chain returns 80–90 rows (§2.4) against Exa's 20, so the searxng leg must be cut down
before it is merged or it swamps the answer.

- `searxToEntries` (`src/websearch.js:155-169`) gains one field, `score: Number(r.score) || 0`.
  This is additive: `renderEntries` (`:207-221`) does not print it and `web_search` does not
  read it, so `web_search`'s output is byte-identical.
- `forum_search` sorts its searxng entries by `score` descending and drops everything below
  **one tenth of that response's top score** — the relative threshold, because the absolute
  level depends on how many engines answered (`~/.claude/agents/researcher.md:34`).
- It then keeps at most `numResults * 2` of them.

### 3.5 Merge and render

1. Merge with the existing `mergeAndDedup(exaEntries, searxEntries)` (`src/websearch.js:174-203`)
   — unchanged, dedupe by `normalizeUrl`, richer snippet wins, `sources` records both.
2. Partition each backend's entries into **on-list** and **off-list** by host suffix match
   against the boost list (`host === d || host.endsWith("." + d)`, `www.` stripped).
   Every searxng entry is on-list by construction; the partition only bites on the Exa leg.
3. Order within a backend: its on-list entries in their own rank order, then its off-list
   entries in their own rank order. Neither backend's relevance ordering is otherwise touched.
4. Interleave the two backends round-robin, Exa first. Round-robin, not concatenation:
   otherwise 80 searxng rows bury Exa's reddit and vendor-forum hits, which are the ones
   searxng structurally cannot produce.
5. `slice(0, numResults)`, then `renderEntries` — the same `Title:/URL:/Published:/Author:/Highlights:`
   text shape (`src/websearch.js:206-221`), so nothing downstream learns a second format.
6. Log one line in the shape of `src/websearch.js:308-315`, plus `onList=` / `offList=`.
7. Both legs dead → `forum_search failed: ${why || "no results"}`, mirroring `:299-304`.

### 3.6 What the route is not

No page is fetched. Excerpts are triage material and the model is told so in its description
and its prompt; the threads worth reading go through `webfetch`, which the researcher already
has (`src/agents.js:95`).

### 3.7 Where the domain list lives

Recommended: **hard-coded default in the source, extended (not replaced) from the settings file.**

- `FORUM_DOMAINS` — the 22 domains of `~/.claude/agents/researcher.md:64`, a `const` in the
  new module, grouped by comment as they are grouped there.
- `~/.config/opencode/agent-intercom.json` gains `"forumDomains": ["…"]`. `getSettings()`
  validates it as an array of non-empty strings, trims each, drops the rest, and
  `getForumDomains()` returns the **union** of the built-in list and the configured one,
  deduped, lowercased.

Union rather than replacement, and the reason is that the list boosts rather than filters
(§3): removing a domain from a boost list buys nothing, so replacement semantics would offer
the user only a way to lose reach by mistake. Extension is the only operation with a purpose.

The six searxng bangs stay hard-coded and are **not** configurable. They are searxng engine
shortcuts, not domains; a user cannot invent a bang for a forum the instance has no engine
for, and a wrong bang is not an error, it silently drops one engine from the chain (§2.4).
An instance without those engines simply contributes fewer rows.

This is the first array-valued setting in `src/settings.js`; it needs its own validation
branch, not a reuse of the integer or string ones.

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

Each sentence carries its weight and the wording is deliberate:

- "**FIRST**" and "never a fallback for one that came back empty" encode the model's central
  point (`~/.claude/agents/researcher.md:52`) — the decision is read off the question before
  any query goes out, so a general search run first "to see whether forums are needed" is the
  exact ordering this forbids.
- The second line is the guard against over-triggering, and it names the failure directly
  ("would keep exactly those answers out") rather than merely listing categories: a model
  that knows *why* the route is wrong for a version question does not take it.
- "**A question carrying both**" is included because it is the common case in this plugin's
  work — "does library X support Y, and does it hold up in production" — and without it the
  model has to invent a rule.

The `researcher` role description (`src/agents.js:190-191`) gains a clause naming
`forum_search` beside `web_search`, since that string is what the orchestrator reads when
choosing an agent.

## 4. Steps

Behaviour-neutral first, then additive. Each step leaves the tree building
(`npm run check`) and the suite green (`npm test`), and each can be handed out alone.

**Step 1 — extract the shared search core.** New `src/searchcore.js` holding
`EXA_MCP_URL`, `EXA_TIMEOUT_MS`, `SEARXNG_TIMEOUT_MS`, `exaHeaders`, `parseSseResult`,
`callExa`, `callSearxng`, `normalizeUrl`, `parseExaEntries`, `searxToEntries`,
`mergeAndDedup`, `renderEntries`, moved verbatim. `src/websearch.js` keeps only
`isWebsearchEnabled` and `createWebsearchTool` and imports the rest.
Update `test/exa-api-key.test.js:17` to import `exaHeaders` from `../src/searchcore.js`.
Depends on: nothing. Rationale: `forum_search` needs `callExa` and `callSearxng`, which are
module-private today (`src/websearch.js:79`, `:98`); the alternative — exporting them from
`websearch.js` and importing sideways — makes the `web_search` tool module the owner of the
transports a sibling tool depends on, and that coupling is what a review flags first. The
extraction is ~120 lines moved and no logic changed.

**Step 2 — `score` on searxng entries.** One field in `searxToEntries` (§3.4). Additive.
Depends on: step 1.

**Step 3 — the `forumDomains` setting.** `FORUM_DOMAINS` const, array validation in
`getSettings()`, `getForumDomains()` returning the union (§3.7), plus the header comment
block in `src/settings.js:1-21` that documents every key.
Depends on: nothing; can run parallel to 1 and 2.

**Step 4 — `src/forumsearch.js`.** The tool: envelope, bang chain, threshold, partition,
round-robin, render, failure text (§3.3–§3.5), plus `isForumSearchEnabled()` reading
`OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH`, mirroring `src/websearch.js:223-225`.
Depends on: steps 1, 2, 3.

**Step 5 — wiring.** Register in `src/tools.js` beside line 540; add
`forum_search: "deny"` to the orchestrator (`src/agents.js:141`) and gitter
(`src/agents.js:219`) permission blocks — without this the orchestrator can search and the
delegation pattern the plugin exists to enforce leaks.
Depends on: step 4.

**Step 6 — prompt and role.** The three lines in `RESEARCHER_PROMPT` and the clause in the
`researcher` description (§3.8).
Depends on: step 5, so that the tool the prompt names exists when the prompt ships.

**Step 7 — documentation.** A `forum_search` row in the README tool table
(`README.md:158`), the `forumDomains` key in the configuration section (`README.md:272-274`),
`OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH` in the variable table (`README.md:284`), the
`researcher` row (`README.md:201`), and a `specs/` line in the Documents list of
`CLAUDE.md` — that list names `work/` and `concepts/` and this file sits in neither.
Depends on: step 6.

## 5. Assumptions, and what would show them wrong

- **Exa's MCP schema stays two-tool and filterless.** Taken from a live `tools/list` on the
  date of writing, not from documentation. Wrong if `tools/list` later shows a domain
  property; the observation is that call. If it ever does, the Exa leg switches from prose
  envelope to a real filter and §3.5's partition becomes redundant for that leg.
- **`numResults: 20` is within the endpoint's ceiling.** Verified at 20 exactly; 21 and above
  untested. Wrong if a request for 20 returns fewer than requested on a query with ample
  hits, or errors.
- **A forum route consumes one Exa call against the same anonymous 150/day budget as
  `web_search`** (`src/websearch.js:13`). Not separately verified. Wrong if 402/429 arrives
  measurably earlier once the route is in use than call counting predicts.
- **Exa REST `/search` honours `includeDomains` for a key holder.** Unverifiable here — the
  anonymous probe stops at 402 (§2.2), and no key was available. This is why the REST path is
  *not* in the design; it is named only as a possible later upgrade, and taking it is a cost
  decision that belongs to the user, not to this concept.
- **A user's own searxng carries those six engines.** Verified for
  `http://<searxng-host>:30080`; another instance may have them absent or its
  `hackernews`/`lobste.rs` removed rather than merely disabled. Wrong when the per-engine
  breakdown of `engines[]` in the response shows fewer than six names. It degrades quietly —
  fewer rows, no error — which is the right failure for an optional backend.
- **The 22-domain list is worth keeping at all, given it boosted 1 of 20 Exa hits (§2.3).**
  It is kept because it is what makes searxng's six engines a guaranteed floor and because a
  reddit thread outranking a content-farm article is the behaviour wanted. Wrong if, on real
  queries, the on-list boost is observed to push weaker on-list hits above stronger off-list
  forum threads often enough to be noticed; the remedy then is to drop the partition in §3.5
  step 2 and let each backend's own ranking stand.

## 6. Open, and outside this boundary

- Whether the plugin should ever ship a paid Exa REST path (§2.2) — that is a question of
  spending money and belongs to the user. The design works without it and gains a strictly
  better Exa leg with it; nothing here has to be undone to add it.
- Whether `forum_search` should also be offered to roles other than `researcher` (planner
  chooses libraries at `src/agents.js:53` and would plausibly want it). Left as it falls out:
  every role except orchestrator and gitter gets it, the same as `web_search`.

## 7. What must be tested

Unit, in the existing `node --test` style under `test/`:

- `searxToEntries` carries `score` and defaults it to 0 on a row that has none; `renderEntries`
  output for the same entries is unchanged from before step 2.
- `getForumDomains()`: no file → the 22 built-ins; a file with `forumDomains` → union, deduped,
  no duplicate when a configured domain is already built in; a non-array, an array of
  non-strings and an array with empty strings → those entries dropped, no throw.
- The on-list/off-list partition: `www.` prefix, a subdomain (`old.reddit.com` on-list via
  `reddit.com`), and a look-alike that must **not** match (`notreddit.com`,
  `reddit.com.evil.test`).
- Round-robin interleave with lopsided inputs (20 Exa, 60 searxng) puts Exa first and does not
  starve either; the result is capped at `numResults`.
- The relative score threshold drops a row below one tenth of the top score and keeps one at it.
- Envelope and bang-chain construction: the string handed to `callExa` contains the user query
  and the envelope words; the string handed to `callSearxng` starts with the six bangs and the
  bare query follows, unwrapped.
- Failure shape: both legs rejected → `forum_search failed: …` with both reasons; one leg
  rejected → the other's results returned and nothing thrown.
- `searxngUrl` unset → no searxng call is attempted.
- `isForumSearchEnabled()` false → `src/tools.js` exposes no `forum_search` key.

Live, once, against the real endpoints after step 5 — no series, no averaging:

- One `forum_search` on a genuine experience question; check the merged output contains hits
  from both legs and that at least one is a reddit or vendor-forum URL searxng cannot produce.
- One `web_search` on the same question; confirm its output is byte-identical to what it
  produced before step 1, proving the extraction was behaviour-neutral.
